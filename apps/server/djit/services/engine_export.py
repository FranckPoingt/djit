from __future__ import annotations

from pathlib import Path


def detect_default_engine_library_path() -> Path:
    return Path.home() / "Music" / "Engine Library" / "Database2"
