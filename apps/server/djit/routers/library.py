from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from djit.database.models import MetadataChangeBatch, Track
from djit.database.session import SessionLocal, get_db
from djit.schemas.library import (
    CleanupApplyResponse,
    CleanupChange,
    CleanupPreviewResponse,
    CleanupRequest,
    CleanupUndoResponse,
    FolderBrowseResponse,
    FolderEntry,
    FolderPickResponse,
    FolderPreviewResponse,
    LibraryImportResponse,
    LibraryHealthIssue,
    LibraryHealthResponse,
    LibrarySourceSummary,
    LibraryStatusResponse,
)
from djit.services.library_scan import ScanProgressTracker, run_scan_import
from djit.services.scanner import SUPPORTED_EXTENSIONS, scan_folder

router = APIRouter(tags=["library"])
_scan_progress = ScanProgressTracker()
_scan_task: asyncio.Task[None] | None = None
_scan_session_factory = SessionLocal


def set_library_scan_session_factory(session_factory) -> None:
    global _scan_session_factory
    _scan_session_factory = session_factory


def pick_folder_path() -> str | None:
    """Open a native folder picker dialog and return selected path."""
    try:
        import subprocess

        result = subprocess.run(
            [
                "osascript",
                "-e",
                'POSIX path of (choose folder with prompt "Select a DJ library folder")',
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0:
            return result.stdout.strip().rstrip("/") or None
        return None
    except Exception:
        return None


def _scan_import_sync(folder_path: str) -> None:
    db = _scan_session_factory()
    try:
        run_scan_import(folder_path, db, _scan_progress)
    finally:
        db.close()


async def _scan_import_task(folder_path: str) -> None:
    await asyncio.to_thread(_scan_import_sync, folder_path)


@router.post("/library/import", response_model=LibraryImportResponse)
async def import_library(folder_path: str) -> LibraryImportResponse:
    """Start a background library import scan."""
    global _scan_task

    path = Path(folder_path)
    if not path.exists() or not path.is_dir():
        raise HTTPException(status_code=400, detail="Invalid folder path")

    if _scan_task is not None and not _scan_task.done():
        raise HTTPException(status_code=409, detail="A library scan is already running")

    # Mark scan active immediately so clients can start polling without a race.
    _scan_progress.start(folder_path=str(path), total_files=0)
    _scan_task = asyncio.create_task(_scan_import_task(folder_path=str(path)))
    return LibraryImportResponse(status="started", added=0, message="Library scan started")


@router.get("/library/status", response_model=LibraryStatusResponse)
async def library_status(db: Session = Depends(get_db)) -> LibraryStatusResponse:
    """Get library status and background scan progress."""
    total_tracks = db.query(Track).count()
    pending_analysis = (
        db.query(Track)
        .filter(Track.analysis_status.in_(["pending", "analyzing"]))
        .count()
    )
    unheard = db.query(Track).filter(Track.triage_decision == "unheard").count()
    scan_state = _scan_progress.snapshot()

    return LibraryStatusResponse(
        status=scan_state.status,
        total_tracks=total_tracks,
        pending_analysis=pending_analysis,
        unheard=unheard,
        scan_folder_path=scan_state.scan_folder_path,
        scan_total_files=scan_state.scan_total_files,
        scan_processed_files=scan_state.scan_processed_files,
        scan_added_files=scan_state.scan_added_files,
        scan_updated_files=scan_state.scan_updated_files,
        scan_skipped_unchanged=scan_state.scan_skipped_unchanged,
        scan_skipped_duplicates=scan_state.scan_skipped_duplicates,
        scan_errors=scan_state.scan_errors,
        scan_last_error=scan_state.scan_last_error,
    )


@router.get("/library/pick-folder", response_model=FolderPickResponse)
async def pick_library_folder() -> FolderPickResponse:
    folder_path = await asyncio.to_thread(pick_folder_path)
    return FolderPickResponse(folder_path=folder_path)


def _folder_filter(folder_path: str):
    normalized = folder_path.rstrip(os.sep)
    return or_(
        Track.path == normalized,
        Track.path.startswith(f"{normalized}{os.sep}", autoescape=True),
    )


def _source_root(track_path: str) -> Path | None:
    path = Path(track_path)
    volumes_root = Path("/Volumes")
    try:
        relative = path.relative_to(volumes_root)
        if relative.parts:
            return volumes_root / relative.parts[0]
    except ValueError:
        pass

    music_root = Path.home() / "Music"
    try:
        path.relative_to(music_root)
        return music_root
    except ValueError:
        return None


@router.get("/library/health", response_model=LibraryHealthResponse)
def library_health(db: Session = Depends(get_db)) -> LibraryHealthResponse:
    tracks = db.query(Track).order_by(Track.id).all()
    sources = library_sources(db)
    issues: list[LibraryHealthIssue] = []
    missing_files = 0
    incomplete_metadata = 0
    failed_analysis = 0

    for track in tracks:
        reasons: list[str] = []
        if not Path(track.path).is_file():
            missing_files += 1
            reasons.append("file missing or source disconnected")
        if not track.title or not track.artist or track.artist == "Unknown" or not track.genre:
            incomplete_metadata += 1
            reasons.append("metadata incomplete")
        if track.analysis_status == "failed":
            failed_analysis += 1
            reasons.append("analysis failed")
        if reasons and len(issues) < 100:
            issues.append(
                LibraryHealthIssue(
                    track_id=track.id,
                    title=track.title or "Unknown",
                    artist=track.artist or "Unknown",
                    path=track.path,
                    reason=", ".join(reasons),
                )
            )

    duplicate_groups = (
        db.query(Track.file_hash)
        .filter(Track.file_hash.isnot(None))
        .group_by(Track.file_hash)
        .having(func.count(Track.id) > 1)
        .count()
    )
    return LibraryHealthResponse(
        total_tracks=len(tracks),
        disconnected_sources=sum(not source.connected for source in sources),
        missing_files=missing_files,
        incomplete_metadata=incomplete_metadata,
        failed_analysis=failed_analysis,
        duplicate_groups=duplicate_groups,
        issues=issues,
    )


_NUMBER_PREFIX = re.compile(r"^\s*(?:\(?\d{1,3}\)?[\s._-]+)+")


def _cleanup_tracks(db: Session, payload: CleanupRequest) -> list[Track]:
    query = db.query(Track)
    if payload.scope == "keep_maybe":
        query = query.filter(Track.triage_decision.in_(["keep", "maybe"]))
    elif payload.scope == "folder":
        if not payload.folder_path:
            raise HTTPException(status_code=400, detail="Folder scope requires folder_path")
        query = query.filter(_folder_filter(payload.folder_path))
    return query.order_by(Track.id).all()


def _cleanup_changes(db: Session, payload: CleanupRequest) -> list[dict]:
    if payload.recipe == "normalize_genre" and (not payload.find or payload.replace is None):
        raise HTTPException(status_code=400, detail="Genre cleanup requires find and replace")

    changes: list[dict] = []
    for track in _cleanup_tracks(db, payload):
        before = {"title": track.title, "artist": track.artist, "genre": track.genre}
        after = dict(before)
        if payload.recipe == "remove_number_prefix" and track.title:
            after["title"] = _NUMBER_PREFIX.sub("", track.title).strip()
        elif payload.recipe == "normalize_whitespace":
            for field in after:
                if after[field]:
                    after[field] = " ".join(str(after[field]).split())
        elif payload.recipe == "fix_title_casing" and track.title:
            if track.title.isupper() or track.title.islower():
                after["title"] = track.title.title()
        elif payload.recipe == "split_artist_title" and track.title and (not track.artist or track.artist == "Unknown"):
            parts = track.title.split(" - ", 1)
            if len(parts) == 2 and all(part.strip() for part in parts):
                after["artist"], after["title"] = (part.strip() for part in parts)
        elif payload.recipe == "normalize_genre" and track.genre and track.genre.casefold() == payload.find.casefold():
            after["genre"] = payload.replace.strip() or None

        if before != after:
            changes.append(
                {
                    "track_id": track.id,
                    "title": track.title or "Unknown",
                    "before": before,
                    "after": after,
                }
            )
    return changes


@router.post("/library/cleanup/preview", response_model=CleanupPreviewResponse)
async def preview_cleanup(
    payload: CleanupRequest,
    db: Session = Depends(get_db),
) -> CleanupPreviewResponse:
    changes = _cleanup_changes(db, payload)
    return CleanupPreviewResponse(
        recipe=payload.recipe,
        total_changes=len(changes),
        changes=[CleanupChange.model_validate(change) for change in changes[:100]],
    )


@router.post("/library/cleanup/apply", response_model=CleanupApplyResponse)
async def apply_cleanup(
    payload: CleanupRequest,
    db: Session = Depends(get_db),
) -> CleanupApplyResponse:
    changes = _cleanup_changes(db, payload)
    if not changes:
        return CleanupApplyResponse(batch_id=0, updated=0)

    tracks = {
        track.id: track
        for track in db.query(Track).filter(Track.id.in_([change["track_id"] for change in changes])).all()
    }
    for change in changes:
        track = tracks[change["track_id"]]
        for field, value in change["after"].items():
            setattr(track, field, value)

    batch = MetadataChangeBatch(recipe=payload.recipe, changes_json=json.dumps(changes))
    db.add(batch)
    db.commit()
    db.refresh(batch)
    return CleanupApplyResponse(batch_id=batch.id, updated=len(changes))


@router.post("/library/cleanup/{batch_id}/undo", response_model=CleanupUndoResponse)
async def undo_cleanup(batch_id: int, db: Session = Depends(get_db)) -> CleanupUndoResponse:
    batch = db.query(MetadataChangeBatch).filter(MetadataChangeBatch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="Cleanup batch not found")
    if batch.undone_at is not None:
        raise HTTPException(status_code=409, detail="Cleanup batch already undone")

    changes = json.loads(batch.changes_json)
    tracks = {
        track.id: track
        for track in db.query(Track).filter(Track.id.in_([change["track_id"] for change in changes])).all()
    }
    restored = 0
    for change in changes:
        track = tracks.get(change["track_id"])
        if not track:
            continue
        changed = False
        for field, before_value in change["before"].items():
            if getattr(track, field) == change["after"][field]:
                setattr(track, field, before_value)
                changed = True
        restored += int(changed)
    batch.undone_at = datetime.utcnow()
    db.commit()
    return CleanupUndoResponse(batch_id=batch.id, restored=restored)


@router.get("/library/sources", response_model=list[LibrarySourceSummary])
def library_sources(db: Session = Depends(get_db)) -> list[LibrarySourceSummary]:
    roots: set[Path] = set()
    track_rows = db.query(Track.path, Track.drive_id).all()
    track_paths = [path for path, _ in track_rows]
    roots.update(Path(drive_id) for _, drive_id in track_rows if drive_id)
    roots.update(
        root
        for path, drive_id in track_rows
        if not drive_id and (root := _source_root(path)) is not None
    )
    if _scan_progress.snapshot().scan_folder_path:
        roots.add(Path(_scan_progress.snapshot().scan_folder_path or ""))

    sources: list[LibrarySourceSummary] = []
    for root in sorted(roots, key=lambda path: path.name.lower()):
        root_text = str(root)
        imported_tracks = sum(
            1
            for track_path in track_paths
            if track_path == root_text or track_path.startswith(f"{root_text}{os.sep}")
        )
        if imported_tracks == 0:
            continue
        sources.append(
            LibrarySourceSummary(
                name=root.name or root_text,
                path=root_text,
                kind="external" if root_text.startswith("/Volumes/") else "folder",
                connected=root.is_dir(),
                imported_tracks=imported_tracks,
            )
        )
    return sources


@router.get("/library/browse", response_model=FolderBrowseResponse)
def browse_library_folder(
    folder_path: str,
    db: Session = Depends(get_db),
) -> FolderBrowseResponse:
    path = Path(folder_path)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Folder is not connected")

    entries: list[FolderEntry] = []
    try:
        children = sorted(
            (child for child in path.iterdir() if child.is_dir() and not child.name.startswith(".")),
            key=lambda child: child.name.lower(),
        )
    except OSError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    for child in children:
        try:
            contents = list(child.iterdir())
        except OSError:
            continue
        direct_audio_files = sum(
            1
            for item in contents
            if item.is_file()
            and not item.name.startswith("._")
            and item.suffix.lower() in SUPPORTED_EXTENSIONS
        )
        imported_tracks = db.query(Track.id).filter(_folder_filter(str(child))).count()
        if direct_audio_files == 0 and imported_tracks == 0:
            continue
        has_music_children = any(
            db.query(Track.id).filter(_folder_filter(str(item))).first() is not None
            for item in contents
            if item.is_dir() and not item.name.startswith(".")
        )
        entries.append(
            FolderEntry(
                name=child.name,
                path=str(child),
                direct_audio_files=direct_audio_files,
                imported_tracks=imported_tracks,
                has_children=has_music_children,
            )
        )

    parent = None if path == path.parent else str(path.parent)
    return FolderBrowseResponse(path=str(path), parent_path=parent, entries=entries)


@router.get("/library/preview", response_model=FolderPreviewResponse)
def preview_library_folder(
    folder_path: str,
    db: Session = Depends(get_db),
) -> FolderPreviewResponse:
    path = Path(folder_path)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Folder is not connected")

    audio_files = scan_folder(path)
    existing_rows = db.query(Track.path, Track.analysis_status).filter(
        _folder_filter(str(path))
    ).all()
    existing_status = {track_path: status for track_path, status in existing_rows}
    existing_files = sum(1 for file_path in audio_files if str(file_path) in existing_status)
    new_files = len(audio_files) - existing_files
    not_analyzed = new_files + sum(
        1
        for file_path in audio_files
        if existing_status.get(str(file_path)) in {"not_analyzed", "failed"}
    )
    return FolderPreviewResponse(
        folder_path=str(path),
        audio_files=len(audio_files),
        new_files=new_files,
        existing_files=existing_files,
        not_analyzed=not_analyzed,
        estimated_analysis_seconds=round(not_analyzed * 4.9),
    )


@router.post("/library/cleanup-sidecars")
async def cleanup_sidecars(db: Session = Depends(get_db)) -> dict[str, int]:
    """Delete track rows whose filename begins with '._' (macOS AppleDouble sidecars)."""
    sidecar_tracks = db.query(Track).filter(Track.path.like("%/._%" )).all()
    count = 0
    for track in sidecar_tracks:
        from pathlib import Path as _Path
        if _Path(track.path).name.startswith("._"):
            db.delete(track)
            count += 1
    db.commit()
    return {"deleted": count}
