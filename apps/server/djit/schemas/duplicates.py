from __future__ import annotations

from pydantic import BaseModel


class DuplicateTrackSummary(BaseModel):
    id: int
    title: str
    artist: str
    path: str


class DuplicateGroupSummary(BaseModel):
    file_hash: str
    tracks: list[DuplicateTrackSummary]


class DuplicateResolveRequest(BaseModel):
    keep_track_id: int
    remove_track_ids: list[int]


class DuplicateResolveResponse(BaseModel):
    deleted: int
    kept_track_id: int
