from __future__ import annotations

import hashlib
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Lock

from sqlalchemy.orm import Session

from djit.database.models import Track
from djit.services.analysis_policy import should_skip_analysis_duration
from djit.services.metadata import extract_metadata
from djit.services.scanner import scan_folder


SCAN_PREP_WORKERS = max(1, int(os.getenv("DJIT_SCAN_WORKERS", "8")))
SCAN_COMMIT_BATCH_SIZE = max(1, int(os.getenv("DJIT_SCAN_COMMIT_BATCH_SIZE", "100")))


def compute_file_hash(file_path: Path) -> str:
    """Compute SHA256 hash of a file."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _file_stat(file_path: Path) -> tuple[float, int]:
    """Return (mtime, size) for a path."""
    st = file_path.stat()
    return st.st_mtime, st.st_size


@dataclass
class ScanProgressState:
    status: str = "idle"
    scan_folder_path: str | None = None
    scan_total_files: int = 0
    scan_processed_files: int = 0
    scan_added_files: int = 0
    scan_updated_files: int = 0
    scan_skipped_unchanged: int = 0
    scan_skipped_duplicates: int = 0
    scan_errors: int = 0
    scan_last_error: str | None = None


@dataclass(frozen=True)
class PreparedFile:
    path_key: str
    mtime: float
    size: int
    file_hash: str
    metadata: dict[str, str | float | None] | None
    unchanged_content: bool


class ScanProgressTracker:
    def __init__(self) -> None:
        self._state = ScanProgressState()
        self._lock = Lock()

    def snapshot(self) -> ScanProgressState:
        with self._lock:
            return replace(self._state)

    def start(self, folder_path: str, total_files: int) -> None:
        with self._lock:
            self._state = ScanProgressState(
                status="scanning",
                scan_folder_path=folder_path,
                scan_total_files=total_files,
            )

    def mark_processed(self) -> None:
        with self._lock:
            self._state.scan_processed_files += 1

    def mark_added(self) -> None:
        with self._lock:
            self._state.scan_added_files += 1

    def mark_updated(self) -> None:
        with self._lock:
            self._state.scan_updated_files += 1

    def mark_skipped_unchanged(self) -> None:
        with self._lock:
            self._state.scan_skipped_unchanged += 1

    def mark_skipped_duplicate(self) -> None:
        with self._lock:
            self._state.scan_skipped_duplicates += 1

    def mark_error(self, error: Exception) -> None:
        with self._lock:
            self._state.scan_errors += 1
            self._state.scan_last_error = str(error)

    def finish(self) -> None:
        with self._lock:
            self._state.status = "idle"

    def fail(self, error: Exception) -> None:
        with self._lock:
            self._state.status = "error"
            self._state.scan_last_error = str(error)


def _metadata_text(metadata: dict[str, str | float | None], key: str) -> str | None:
    value = metadata.get(key)
    return value if isinstance(value, str) else None


def _metadata_float(metadata: dict[str, str | float | None], key: str) -> float | None:
    value = metadata.get(key)
    return float(value) if isinstance(value, (int, float)) else None


def _prepare_file(
    file_path: Path,
    path_key: str,
    mtime: float,
    size: int,
    existing_hash: str | None,
) -> PreparedFile:
    file_hash = compute_file_hash(file_path)
    unchanged_content = existing_hash is not None and existing_hash == file_hash
    metadata = None if unchanged_content else extract_metadata(file_path)
    return PreparedFile(
        path_key=path_key,
        mtime=mtime,
        size=size,
        file_hash=file_hash,
        metadata=metadata,
        unchanged_content=unchanged_content,
    )


def run_scan_import(folder_path: str, db: Session, tracker: ScanProgressTracker) -> None:
    path = Path(folder_path)
    audio_files = scan_folder(path)
    tracker.start(folder_path=str(path), total_files=len(audio_files))
    try:
        # ── Batch load all known tracks into memory — 2 queries for entire library ──
        all_paths = [str(f) for f in audio_files]
        if all_paths:
            db.query(Track).filter(
                Track.path.in_(all_paths), Track.drive_id.is_(None)
            ).update({Track.drive_id: str(path)}, synchronize_session=False)
            db.commit()
        existing_by_path: dict[str, Track] = {
            t.path: t
            for t in db.query(Track).filter(Track.path.in_(all_paths)).all()
        }
        all_hashes: set[str] = {
            h for (h,) in db.query(Track.file_hash).filter(Track.file_hash.isnot(None)).all()
        }

        files_to_prepare: list[tuple[Path, str, float, int, str | None]] = []

        for file_path in audio_files:
            try:
                mtime, size = _file_stat(file_path)
                path_key = str(file_path)
                existing = existing_by_path.get(path_key)

                if existing is not None:
                    # Fast-skip: mtime+size match means file content cannot have changed.
                    if existing.file_mtime == mtime and existing.file_size == size:
                        tracker.mark_processed()
                        tracker.mark_skipped_unchanged()
                        continue

                files_to_prepare.append(
                    (file_path, path_key, mtime, size, existing.file_hash if existing else None)
                )
            except Exception as error:
                tracker.mark_processed()
                tracker.mark_error(error)

        pending_new_tracks: list[Track] = []
        pending_writes = 0

        def flush_batch() -> None:
            nonlocal pending_writes, pending_new_tracks
            if pending_writes == 0:
                return
            if pending_new_tracks:
                db.flush()
                pending_new_tracks = []
            db.commit()
            pending_writes = 0

        with ThreadPoolExecutor(max_workers=SCAN_PREP_WORKERS) as executor:
            futures = [
                executor.submit(_prepare_file, file_path, path_key, mtime, size, existing_hash)
                for file_path, path_key, mtime, size, existing_hash in files_to_prepare
            ]

            for future in as_completed(futures):
                try:
                    prepared = future.result()
                    existing = existing_by_path.get(prepared.path_key)
                    if existing is not None:
                        duration_seconds = None
                        if prepared.unchanged_content:
                            # Only touch/backup changed, not real content; just update stat.
                            existing.file_mtime = prepared.mtime
                            existing.file_size = prepared.size
                            tracker.mark_skipped_unchanged()
                            pending_writes += 1
                        else:
                            metadata = prepared.metadata or {}
                            duration_seconds = _metadata_float(metadata, "duration_seconds")
                            analysis_status = (
                                "skipped"
                                if should_skip_analysis_duration(duration_seconds)
                                else "not_analyzed"
                            )
                            existing.file_hash = prepared.file_hash
                            existing.drive_id = str(path)
                            existing.file_mtime = prepared.mtime
                            existing.file_size = prepared.size
                            existing.title = _metadata_text(metadata, "title")
                            existing.artist = _metadata_text(metadata, "artist")
                            existing.genre = _metadata_text(metadata, "genre")
                            existing.duration_seconds = duration_seconds
                            existing.analysis_status = analysis_status
                            existing.waveform_data = None
                            all_hashes.add(prepared.file_hash)
                            tracker.mark_updated()
                            pending_writes += 1
                    elif prepared.file_hash in all_hashes:
                        tracker.mark_skipped_duplicate()
                    else:
                        metadata = prepared.metadata or {}
                        duration_seconds = _metadata_float(metadata, "duration_seconds")
                        analysis_status = (
                            "skipped"
                            if should_skip_analysis_duration(duration_seconds)
                            else "not_analyzed"
                        )
                        new_track = Track(
                            path=prepared.path_key,
                            file_hash=prepared.file_hash,
                            drive_id=str(path),
                            file_mtime=prepared.mtime,
                            file_size=prepared.size,
                            title=_metadata_text(metadata, "title"),
                            artist=_metadata_text(metadata, "artist"),
                            genre=_metadata_text(metadata, "genre"),
                            duration_seconds=duration_seconds,
                            analysis_status=analysis_status,
                        )
                        db.add(new_track)
                        pending_new_tracks.append(new_track)
                        all_hashes.add(prepared.file_hash)
                        tracker.mark_added()
                        pending_writes += 1

                    tracker.mark_processed()

                    if pending_writes >= SCAN_COMMIT_BATCH_SIZE:
                        flush_batch()
                except Exception as error:
                    tracker.mark_processed()
                    tracker.mark_error(error)

        flush_batch()

        tracker.finish()
    except Exception as error:
        db.rollback()
        tracker.fail(error)
