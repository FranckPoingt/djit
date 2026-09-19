#!/usr/bin/env python3
"""Create a history-free public source tree from the current working files."""
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "release" / "djit-source"
# Private experiments reference personal recordings; bundles are rebuilt from source.
EXCLUDED = (
    "apps/server/djit/static/",
    "apps/server/djit/services/analyzer_deno_prototype/",
    "release/",
    ".vscode/",
    "apps/server/media-cache/",
)


def public_path(name: str) -> bool:
    path = Path(name)
    return not (
        name.startswith(EXCLUDED)
        or any(part.startswith(".env") for part in path.parts)
        or path.suffix in {".db", ".sqlite3", ".pem", ".key", ".mp3", ".wav", ".flac"}
        or any(marker in path.name for marker in (".db-", ".sqlite3-"))
    )


def main() -> None:
    if DEST.exists():
        raise SystemExit(f"Destination already exists: {DEST}; move it aside before retrying")
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT
    ).decode().split("\0")
    for name in sorted(set(filter(None, names))):
        source = ROOT / name
        if not public_path(name) or not source.exists():
            continue
        if source.is_symlink():
            raise SystemExit(f"Review symlink before publication: {name}")
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    print(DEST)


if __name__ == "__main__":
    assert public_path("apps/server/djit/main.py")
    assert not public_path("apps/server/djit.db-wal")
    assert not public_path("apps/server/.env.local")
    assert not public_path("apps/server/djit/static/index.html")
    assert not public_path("apps/server/media-cache/artwork.jpg")
    main()
