from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from djit.schemas.track import AnalysisStatus, TriageDecision


class SavedViewState(BaseModel):
    search: str = ""
    folder_path: str | None = None
    triage_decision: list[TriageDecision] = Field(default_factory=list)
    analysis_status: list[AnalysisStatus] = Field(default_factory=list)
    key_camelot: str | None = None
    mood: str | None = None
    energy_min: int | None = None
    energy_max: int | None = None
    bpm_min: float | None = None
    bpm_max: float | None = None
    sort_by: str = "triage_decision"
    sort_desc: bool = False


class SavedViewSummary(BaseModel):
    id: int
    name: str
    state: SavedViewState
    is_default: bool = False
    track_count: int = 0
    created_at: datetime
    updated_at: datetime


class SavedViewCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    state: SavedViewState
    is_default: bool = False


class SavedViewUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    state: SavedViewState | None = None
    is_default: bool | None = None


class SavedViewFreezeRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class SavedViewFreezeResponse(BaseModel):
    playlist_id: int
    playlist_name: str
    track_count: int
