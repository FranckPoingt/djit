from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class LibraryImportResponse(BaseModel):
    status: str
    added: int
    message: str | None = None


class LibraryStatusResponse(BaseModel):
    status: str
    total_tracks: int
    pending_analysis: int
    unheard: int
    scan_folder_path: str | None = None
    scan_total_files: int = 0
    scan_processed_files: int = 0
    scan_added_files: int = 0
    scan_updated_files: int = 0
    scan_skipped_unchanged: int = 0
    scan_skipped_duplicates: int = 0
    scan_errors: int = 0
    scan_last_error: str | None = None


class FolderPickResponse(BaseModel):
    folder_path: str | None


class LibrarySourceSummary(BaseModel):
    name: str
    path: str
    kind: str
    connected: bool
    imported_tracks: int


class FolderEntry(BaseModel):
    name: str
    path: str
    direct_audio_files: int
    imported_tracks: int
    has_children: bool


class FolderBrowseResponse(BaseModel):
    path: str
    parent_path: str | None
    entries: list[FolderEntry]


class FolderPreviewResponse(BaseModel):
    folder_path: str
    audio_files: int
    new_files: int
    existing_files: int
    not_analyzed: int
    estimated_analysis_seconds: int


class LibraryHealthIssue(BaseModel):
    track_id: int
    title: str
    artist: str
    path: str
    reason: str


class LibraryHealthResponse(BaseModel):
    total_tracks: int
    disconnected_sources: int
    missing_files: int
    incomplete_metadata: int
    failed_analysis: int
    duplicate_groups: int
    issues: list[LibraryHealthIssue]


CleanupRecipe = Literal[
    "remove_number_prefix",
    "normalize_whitespace",
    "fix_title_casing",
    "split_artist_title",
    "normalize_genre",
]


class CleanupRequest(BaseModel):
    recipe: CleanupRecipe
    scope: Literal["keep_maybe", "all", "folder"] = "keep_maybe"
    folder_path: str | None = None
    find: str | None = Field(default=None, max_length=100)
    replace: str | None = Field(default=None, max_length=100)


class CleanupChange(BaseModel):
    track_id: int
    title: str
    before: dict[str, str | None]
    after: dict[str, str | None]


class CleanupPreviewResponse(BaseModel):
    recipe: CleanupRecipe
    total_changes: int
    changes: list[CleanupChange]


class CleanupApplyResponse(BaseModel):
    batch_id: int
    updated: int


class CleanupUndoResponse(BaseModel):
    batch_id: int
    restored: int
