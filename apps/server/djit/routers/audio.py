from __future__ import annotations

import asyncio
import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import StreamingResponse
import librosa
import numpy as np
from sqlalchemy.orm import Session

try:
    from mutagen import File as MutagenFile
except ModuleNotFoundError:  # pragma: no cover - environment dependent
    MutagenFile = None

from djit.database.models import Track
from djit.database.session import DB_PATH, get_db

router = APIRouter(tags=["audio"])

MISSING_COVER_HEADERS = {
    # Missing embedded artwork is usually stable for a file; cache negative responses.
    "Cache-Control": "public, max-age=3600",
}
MEDIA_CACHE_HEADERS = {"Cache-Control": "private, max-age=86400"}
COVER_CACHE_DIR = Path(
    os.getenv("DJIT_COVER_CACHE_DIR", DB_PATH.parent / "media-cache" / "covers")
)


def _cover_cache_path(file_hash: str | None) -> Path | None:
    if not file_hash:
        return None
    safe_key = hashlib.sha256(file_hash.encode()).hexdigest()
    return COVER_CACHE_DIR / f"{safe_key}.cover"


def _read_cached_cover(cache_path: Path) -> bytes | None:
    try:
        data = cache_path.read_bytes()
        return data or None
    except OSError:
        return None


def _write_cached_cover(cache_path: Path, data: bytes) -> None:
    # ponytail: viewed-only cache has no eviction; add a size cap if it becomes material.
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_bytes(data)
    temporary.replace(cache_path)


def _guess_image_media_type(data: bytes) -> str:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


@lru_cache(maxsize=2048)
def _extract_cover_art(path: Path) -> tuple[bytes, str] | None:
    if MutagenFile is None:
        return None

    try:
        audio = MutagenFile(path)
    except Exception:
        return None
    if audio is None:
        return None

    pictures = getattr(audio, "pictures", None)
    if pictures:
        pic = pictures[0]
        media_type = getattr(pic, "mime", None) or _guess_image_media_type(pic.data)
        return pic.data, media_type

    tags = getattr(audio, "tags", None)
    if tags is None:
        return None

    # MP3/ID3
    getall = getattr(tags, "getall", None)
    if callable(getall):
        apic_frames = getall("APIC")
        if apic_frames:
            frame = apic_frames[0]
            data = bytes(getattr(frame, "data", b""))
            if data:
                media_type = getattr(frame, "mime", None) or _guess_image_media_type(data)
                return data, media_type

    # MP4/M4A
    covr = tags.get("covr") if hasattr(tags, "get") else None
    if covr:
        first = covr[0]
        data = bytes(first)
        media_type = _guess_image_media_type(data)
        return data, media_type

    return None


@lru_cache(maxsize=512)
def _compute_waveform_cached(
    track_path: str,
    points: int,
    mtime_ns: int,
    size: int,
) -> list[float]:
    # mtime_ns and size invalidate the cache when the source file changes.
    _ = mtime_ns
    _ = size

    y, _sr = librosa.load(track_path, sr=8000, mono=True)
    if y.size == 0:
        return [0.0] * points

    abs_y = np.abs(y)
    windows = np.array_split(abs_y, points)
    amps = np.array([float(w.max(initial=0.0)) for w in windows], dtype=float)

    peak = float(amps.max(initial=0.0))
    if peak <= 0:
        return [0.0] * points

    normalized = amps / peak
    return [round(float(v), 4) for v in normalized.tolist()]


def _downsample(data: list[float], target: int) -> list[float]:
    """Average-downsample a waveform array to a smaller number of points."""
    n = len(data)
    if n <= target:
        return data
    windows = np.array_split(np.array(data, dtype=float), target)
    return [round(float(w.mean()), 4) for w in windows]


@router.get("/audio/{track_id}/stream")
async def stream_audio(
    track_id: int,
    range_header: str | None = Header(default=None, alias="Range"),
    db: Session = Depends(get_db),
) -> Response:
    if track_id <= 0:
        raise HTTPException(status_code=404, detail="Track not found")

    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    track_path = Path(track.path)
    if not track_path.exists() or not track_path.is_file():
        raise HTTPException(status_code=404, detail="Track file not found")

    file_size = track_path.stat().st_size
    if file_size <= 0:
        raise HTTPException(status_code=416, detail="Track file is empty")

    media_type = "audio/mpeg"

    if not range_header:
        def iter_full() -> bytes:
            with track_path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    yield chunk

        return StreamingResponse(
            iter_full(),
            status_code=status.HTTP_200_OK,
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
            },
        )

    if not range_header.startswith("bytes="):
        raise HTTPException(status_code=416, detail="Invalid range unit")

    range_value = range_header.replace("bytes=", "", 1).strip()
    start_text, sep, end_text = range_value.partition("-")
    if sep != "-":
        raise HTTPException(status_code=416, detail="Invalid range format")

    try:
        start = int(start_text) if start_text else 0
        end = int(end_text) if end_text else file_size - 1
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="Invalid range values") from exc

    if start < 0 or end < 0 or start > end or end >= file_size:
        raise HTTPException(status_code=416, detail="Range not satisfiable")

    chunk_size = end - start + 1

    def iter_range() -> bytes:
        with track_path.open("rb") as handle:
            handle.seek(start)
            remaining = chunk_size
            while remaining > 0:
                read_size = min(1024 * 1024, remaining)
                data = handle.read(read_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        iter_range(),
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(chunk_size),
        },
    )


@router.get("/audio/{track_id}/cover")
async def cover_art(
    track_id: int,
    db: Session = Depends(get_db),
) -> Response:
    if track_id <= 0:
        raise HTTPException(
            status_code=404,
            detail="Track not found",
            headers=MISSING_COVER_HEADERS,
        )

    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(
            status_code=404,
            detail="Track not found",
            headers=MISSING_COVER_HEADERS,
        )

    cache_path = _cover_cache_path(track.file_hash)
    if cache_path is not None:
        cached = await asyncio.to_thread(_read_cached_cover, cache_path)
        if cached is not None:
            return Response(
                content=cached,
                media_type=_guess_image_media_type(cached),
                headers=MEDIA_CACHE_HEADERS,
            )

    track_path = Path(track.path)
    if not track_path.exists() or not track_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Track file not found",
            headers=MISSING_COVER_HEADERS,
        )

    # Offload to thread so the event loop is not blocked during file I/O.
    # Result is cached in-process via @lru_cache(maxsize=2048) on _extract_cover_art.
    cover = await asyncio.to_thread(_extract_cover_art, track_path)
    if cover is None:
        raise HTTPException(
            status_code=404,
            detail="Cover art not found",
            headers=MISSING_COVER_HEADERS,
        )

    data, media_type = cover
    if cache_path is not None:
        await asyncio.to_thread(_write_cached_cover, cache_path, data)
    return Response(
        content=data,
        media_type=media_type,
        headers=MEDIA_CACHE_HEADERS,
    )


@router.get("/audio/{track_id}/waveform")
async def waveform(
    track_id: int,
    response: Response,
    points: int = 64,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    response.headers.update(MEDIA_CACHE_HEADERS)
    if track_id <= 0:
        raise HTTPException(status_code=404, detail="Track not found")

    if points < 16 or points > 256:
        raise HTTPException(status_code=400, detail="points must be between 16 and 256")

    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Serve pre-computed waveform from DB if available (stored at 96pt).
    if track.waveform_data:
        try:
            stored: list[float] = json.loads(track.waveform_data)
            values = _downsample(stored, points) if len(stored) > points else stored
            return {"track_id": track_id, "points": values, "duration_seconds": track.duration_seconds}
        except Exception:
            pass  # Fall through to live computation on malformed data.

    track_path = Path(track.path)
    if not track_path.exists() or not track_path.is_file():
        raise HTTPException(status_code=404, detail="Track file not found")

    stat = track_path.stat()
    try:
        stored_values = await asyncio.to_thread(
            _compute_waveform_cached,
            str(track_path),
            96,
            int(stat.st_mtime_ns),
            int(stat.st_size),
        )
        track.waveform_data = json.dumps(stored_values)
        db.commit()
    except Exception:
        stored_values = [0.0] * 96

    values = _downsample(stored_values, points)

    return {
        "track_id": track_id,
        "points": values,
        "duration_seconds": track.duration_seconds,
    }
