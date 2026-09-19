from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from djit.schemas.track import TrackSummary


class PlaylistCreate(BaseModel):
    name: str


class PlaylistSummary(BaseModel):
    id: int
    name: str
    track_count: int
    duration_seconds: float | None = None
    bpm_min: float | None = None
    bpm_max: float | None = None


class PlaylistDetail(PlaylistSummary):
    tracks: list[TrackSummary]


class PlaylistTrackAddRequest(BaseModel):
    track_ids: list[int]


class PlaylistOrderUpdate(BaseModel):
    track_ids: list[int]


class HarmonizePlaylistRequest(BaseModel):
    lock_first: bool = False
    lock_last: bool = False
    bpm_weight: float = 0.5
    bpm_tolerance: float = 4.0
    profile: Literal["build_up", "cruise", "cooldown"] = "cruise"


class HarmonizeTransitionDiagnostic(BaseModel):
    from_track_id: int
    to_track_id: int
    from_key: str | None = None
    to_key: str | None = None
    category: str
    label: str
    compatibility: float


class HarmonizeDiagnosticsPayload(BaseModel):
    transitions: list[HarmonizeTransitionDiagnostic]
    compatibility_score: float
    risky_jumps: int
    energy_trend: Literal["rising", "falling", "flat", "mixed"]


class HarmonizePlaylistResponse(BaseModel):
    playlist_id: int
    track_ids: list[int]  # reordered track IDs (not yet saved)
    applied: bool  # True — reorder persisted to DB
    diagnostics: HarmonizeDiagnosticsPayload
