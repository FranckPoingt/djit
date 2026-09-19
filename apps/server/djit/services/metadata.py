from __future__ import annotations

from pathlib import Path

try:
    from mutagen.easyid3 import EasyID3
except ImportError:
    EasyID3 = None

try:
    from mutagen.flac import FLAC
except ImportError:
    FLAC = None

try:
    from mutagen.mp4 import MP4
except ImportError:
    MP4 = None

try:
    from mutagen.oggvorbis import OggVorbis
except ImportError:
    OggVorbis = None


def _safe_get_tag(tags: dict, key: str, default: str | None = None) -> str | None:
    """Safely extract a single tag value from mutagen tags (handles lists and empty values)"""
    value = tags.get(key)
    if value:
        if isinstance(value, list) and len(value) > 0:
            return str(value[0])
        elif isinstance(value, str):
            return value
    return default


def extract_metadata(path: Path) -> dict[str, str | float | None]:
    """Extract metadata from audio file using mutagen"""
    try:
        suffix = path.suffix.lower()
        
        if suffix == ".mp3" and EasyID3:
            try:
                audio = EasyID3(path)
                duration = None
                try:
                    from mutagen.mp3 import MP3

                    duration = float(MP3(path).info.length)
                except Exception:
                    duration = None
                return {
                    "title": _safe_get_tag(audio, "title", path.stem),
                    "artist": _safe_get_tag(audio, "artist", "Unknown"),
                    "genre": _safe_get_tag(audio, "genre"),
                    "duration_seconds": duration,
                }
            except Exception:
                pass
        
        elif suffix == ".flac" and FLAC:
            try:
                audio = FLAC(path)
                return {
                    "title": _safe_get_tag(audio, "title", path.stem),
                    "artist": _safe_get_tag(audio, "artist", "Unknown"),
                    "genre": _safe_get_tag(audio, "genre"),
                    "duration_seconds": float(audio.info.length)
                    if getattr(audio, "info", None)
                    else None,
                }
            except Exception:
                pass
        
        elif suffix in {".m4a", ".mp4"} and MP4:
            try:
                audio = MP4(path)
                tags = audio.tags or {}
                return {
                    "title": _safe_get_tag(tags, "\xa9nam", path.stem),
                    "artist": _safe_get_tag(tags, "\xa9ART", "Unknown"),
                    "genre": _safe_get_tag(tags, "\xa9gen"),
                    "duration_seconds": float(audio.info.length)
                    if getattr(audio, "info", None)
                    else None,
                }
            except Exception:
                pass
        
        elif suffix == ".ogg" and OggVorbis:
            try:
                audio = OggVorbis(path)
                return {
                    "title": _safe_get_tag(audio, "title", path.stem),
                    "artist": _safe_get_tag(audio, "artist", "Unknown"),
                    "genre": _safe_get_tag(audio, "genre"),
                    "duration_seconds": float(audio.info.length)
                    if getattr(audio, "info", None)
                    else None,
                }
            except Exception:
                pass
    
    except Exception:
        pass
    
    # Fallback: use filename as title
    return {
        "title": path.stem,
        "artist": "Unknown",
        "genre": None,
        "duration_seconds": None,
    }


def read_metadata(path: Path) -> dict[str, str | float | None]:
    """Alias for extract_metadata for backwards compatibility"""
    return extract_metadata(path)
