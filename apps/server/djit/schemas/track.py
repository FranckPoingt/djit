from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


AnalysisStatus = Literal[
    "not_analyzed",
    "pending",
    "analyzing",
    "done",
    "failed",
    "skipped",
    "overridden",
]
TriageDecision = Literal["unheard", "keep", "maybe", "reject", "problem"]


class TrackPlaylistMembership(BaseModel):
    id: int
    name: str


class TrackSummary(BaseModel):
    id: int
    title: str
    artist: str
    genre: str | None = None
    mood: str | None = None
    energy: int | None = None
    duration_seconds: float | None = None
    bpm: float | None = None
    bpm_confidence: float | None = None
    key_camelot: str | None = None
    analysis_status: AnalysisStatus = "not_analyzed"
    triage_decision: TriageDecision = "unheard"
    playlist_memberships: list[TrackPlaylistMembership] = Field(default_factory=list)


class TrackUpdate(BaseModel):
    title: str | None = None
    artist: str | None = None
    genre: str | None = None
    mood: str | None = None
    energy: int | None = None
    duration_seconds: float | None = None
    triage_decision: TriageDecision | None = None
    bpm: float | None = None
    bpm_confidence: float | None = None
    key_camelot: str | None = None


class TrackBulkUpdate(BaseModel):
    track_ids: list[int]
    genre: str | None = None
    triage_decision: TriageDecision | None = None


class PaginatedTracksResponse(BaseModel):
    items: list[TrackSummary]
    total: int
    offset: int
    limit: int


class ReviewGenreCount(BaseModel):
    name: str
    count: int


class ReviewOverviewResponse(BaseModel):
    total_eligible: int
    unknown_genre: int
    genres: list[ReviewGenreCount]


class ReviewSessionResponse(BaseModel):
    tracks: list[TrackSummary]
    total_eligible: int
    selected_genres: list[str]


class MixSuggestion(BaseModel):
    track: TrackSummary
    score: int
    reason: str


class MetadataMatchResponse(BaseModel):
    track_id: int
    provider: Literal["beatport"] = "beatport"
    search_url: str
    current: dict[str, str | float | None]
    automatic_lookup_available: bool = False
