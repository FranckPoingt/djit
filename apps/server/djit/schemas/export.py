from __future__ import annotations

from pydantic import BaseModel


class ExportRequest(BaseModel):
    playlist_id: int
    engine_library_path: str | None = None


class ExportPathDetection(BaseModel):
    path: str | None
    writable: bool


class ExportCopyRequest(BaseModel):
    playlist_id: int
    destination_path: str


class ExportCopyResult(BaseModel):
    destination: str
    copied: int
    skipped: int
    provisional: int = 0
    playlist_path: str | None = None
    manifest_path: str | None = None
    errors: list[str]
