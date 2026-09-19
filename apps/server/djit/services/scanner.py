from __future__ import annotations

from pathlib import Path


SUPPORTED_EXTENSIONS = {".mp3", ".flac", ".wav", ".aac", ".aiff", ".m4a", ".ogg", ".wma"}


def discover_audio_files(root: Path) -> list[Path]:
    """Recursively find all supported audio files in a directory."""
    if not root.is_dir():
        return []

    results: list[Path] = []
    for p in root.rglob("*"):
        # Skip macOS AppleDouble resource-fork sidecars (._filename)
        if p.name.startswith("._"):
            continue
        if p.suffix.lower() in SUPPORTED_EXTENSIONS and p.is_file():
            results.append(p)
    return results


def scan_folder(root: Path) -> list[Path]:
    """Alias for discover_audio_files"""
    return discover_audio_files(root)
