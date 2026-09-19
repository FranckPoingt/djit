from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from djit.database.models import Playlist, PlaylistTrack, Track
from djit.database.session import get_db
from djit.schemas.export import (
    ExportCopyRequest,
    ExportCopyResult,
    ExportPathDetection,
    ExportRequest,
)
from djit.services.engine_export import detect_default_engine_library_path

router = APIRouter(tags=["export"])


def _safe_filename(value: str, fallback: str) -> str:
    safe = "".join(c if c.isalnum() or c in " _-." else "_" for c in value).strip()
    return safe or fallback


def _unique_destination(base: Path) -> Path:
    if not base.exists():
        return base
    stem = base.stem
    suffix = base.suffix
    parent = base.parent
    index = 2
    while True:
        candidate = parent / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
        index += 1


@router.get("/export/engine-dj/detect-path", response_model=ExportPathDetection)
async def detect_export_path() -> ExportPathDetection:
    path = detect_default_engine_library_path()
    return ExportPathDetection(path=str(path), writable=path.exists())


@router.post("/export/engine-dj")
async def export_engine_dj(payload: ExportRequest) -> dict[str, int | str]:
    return {
        "playlist_id": payload.playlist_id,
        "status": "queued",
        "message": "Engine DJ export is not implemented yet.",
    }


def _do_copy(payload: ExportCopyRequest, db: Session) -> ExportCopyResult:
    playlist = db.query(Playlist).filter(Playlist.id == payload.playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")

    safe_name = _safe_filename(playlist.name, f"playlist_{payload.playlist_id}")
    dest_dir = Path(payload.destination_path) / "DJ-IT Export"
    tracks_dir = dest_dir / "Tracks"
    playlists_dir = dest_dir / "Playlists"
    dest_dir.mkdir(parents=True, exist_ok=True)
    tracks_dir.mkdir(parents=True, exist_ok=True)
    playlists_dir.mkdir(parents=True, exist_ok=True)

    items = (
        db.query(Track, PlaylistTrack.position)
        .join(PlaylistTrack, PlaylistTrack.track_id == Track.id)
        .filter(PlaylistTrack.playlist_id == payload.playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .all()
    )

    copied = 0
    skipped = 0
    provisional = 0
    errors: list[str] = []
    manifest_tracks: list[dict[str, object | None]] = []
    playlist_lines = ["#EXTM3U"]

    for track, position in items:
        triage_decision = track.triage_decision or "unheard"
        if triage_decision not in {"keep", "maybe"}:
            skipped += 1
            manifest_tracks.append(
                {
                    "id": track.id,
                    "title": track.title,
                    "artist": track.artist,
                    "original_path": track.path,
                    "copied_path": None,
                    "position": position,
                    "triage_decision": triage_decision,
                    "status": "skipped_triage",
                }
            )
            continue
        if triage_decision == "maybe":
            provisional += 1

        src = Path(track.path)
        if not src.exists():
            skipped += 1
            errors.append(f"{src}: missing")
            manifest_tracks.append(
                {
                    "id": track.id,
                    "title": track.title,
                    "artist": track.artist,
                    "original_path": track.path,
                    "copied_path": None,
                    "position": position,
                    "triage_decision": triage_decision,
                    "status": "missing",
                }
            )
            continue
        filename_source = f"{track.artist or 'Unknown'} - {track.title or src.stem}{src.suffix}"
        dest_file = _unique_destination(tracks_dir / _safe_filename(filename_source, src.name))
        try:
            shutil.copy2(src, dest_file)
            copied += 1
        except OSError as exc:
            errors.append(f"{src.name}: {exc}")
            skipped += 1
            manifest_tracks.append(
                {
                    "id": track.id,
                    "title": track.title,
                    "artist": track.artist,
                    "original_path": track.path,
                    "copied_path": None,
                    "position": position,
                    "triage_decision": triage_decision,
                    "status": "copy_error",
                }
            )
            continue

        relative_track_path = os.path.relpath(dest_file, playlists_dir)
        playlist_lines.append(relative_track_path)
        manifest_tracks.append(
            {
                "id": track.id,
                "title": track.title,
                "artist": track.artist,
                "original_path": track.path,
                "copied_path": str(dest_file),
                "position": position,
                "triage_decision": triage_decision,
                "bpm": track.bpm,
                "key_camelot": track.key_camelot,
                "status": "copied",
            }
        )

    playlist_path = playlists_dir / f"{safe_name}.m3u8"
    playlist_path.write_text("\n".join(playlist_lines) + "\n", encoding="utf-8")
    manifest_path = dest_dir / "djit-export.json"
    manifest_path.write_text(
        json.dumps(
            {
                "playlist_id": playlist.id,
                "playlist_name": playlist.name,
                "destination": str(dest_dir),
                "tracks": manifest_tracks,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    return ExportCopyResult(
        destination=str(dest_dir),
        copied=copied,
        skipped=skipped,
        provisional=provisional,
        playlist_path=str(playlist_path),
        manifest_path=str(manifest_path),
        errors=errors,
    )


@router.post("/export/copy-to-folder", response_model=ExportCopyResult)
async def export_copy_to_folder(
    payload: ExportCopyRequest,
    db: Session = Depends(get_db),
) -> ExportCopyResult:
    """Copy all playlist track files into <destination_path>/<playlist_name>/."""
    return await asyncio.to_thread(_do_copy, payload, db)


@router.post("/playlists/{playlist_id}/extract", response_model=ExportCopyResult)
async def extract_playlist(
    playlist_id: int,
    payload: ExportCopyRequest,
    db: Session = Depends(get_db),
) -> ExportCopyResult:
    if payload.playlist_id != playlist_id:
        raise HTTPException(status_code=400, detail="Playlist id mismatch")
    return await asyncio.to_thread(_do_copy, payload, db)
