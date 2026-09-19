from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class AnalysisQueueRequest(BaseModel):
    track_ids: list[int]
    force_reanalyze: bool = False
    mode: Literal["fast", "deep"] = "fast"
    scope: str = Field(default="selected", max_length=32)
    priority: Literal["review", "normal", "background"] = "normal"


class AnalysisQueueResponse(BaseModel):
    batch_id: int | None = None
    requested: int
    queued: int
    skipped: int
    queued_track_ids: list[int]
    skipped_track_ids: list[int]


class FolderAnalysisQueueRequest(BaseModel):
    folder_path: str
    scope: Literal["keep_maybe", "all"] = "keep_maybe"
    limit: int = Field(default=500, ge=1, le=500)
    mode: Literal["fast", "deep"] = "fast"


class CuratedAnalysisQueueRequest(BaseModel):
    limit: int = Field(default=5000, ge=1, le=10000)
    mode: Literal["fast", "deep"] = "fast"


class AllAnalysisQueueRequest(BaseModel):
    limit: int = Field(default=10000, ge=1, le=10000)
    mode: Literal["fast", "deep"] = "fast"


class AnalysisBatchResponse(BaseModel):
    id: int
    mode: str
    scope: str
    status: str
    total: int
    completed: int
    failed: int
    skipped: int
    current_track_id: int | None = None
    current_track_title: str | None = None
    current_track_artist: str | None = None
    elapsed_seconds: int
    eta_seconds: int | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class AnalysisCandidateResponse(BaseModel):
    count: int
    estimated_seconds: int


class AnalysisEvent(BaseModel):
    track_id: int
    status: str
    bpm: float | None = None
    bpm_confidence: float | None = None
    key_raw: str | None = None
    key_camelot: str | None = None
    mood: str | None = None
    energy: int | None = None
