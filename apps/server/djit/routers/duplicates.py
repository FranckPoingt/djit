from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from djit.database.models import PlaylistTrack, Track
from djit.database.session import get_db
from djit.schemas.duplicates import (
    DuplicateGroupSummary,
    DuplicateResolveRequest,
    DuplicateResolveResponse,
    DuplicateTrackSummary,
)

router = APIRouter(tags=["duplicates"])


@router.get("/duplicates/groups", response_model=list[DuplicateGroupSummary])
async def list_duplicate_groups(db: Session = Depends(get_db)) -> list[DuplicateGroupSummary]:
    tracks = (
        db.query(Track)
        .filter(Track.file_hash.isnot(None))
        .order_by(Track.file_hash.asc(), Track.id.asc())
        .all()
    )

    grouped: dict[str, list[Track]] = defaultdict(list)
    for track in tracks:
        if not track.file_hash:
            continue
        grouped[track.file_hash].append(track)

    duplicate_groups: list[DuplicateGroupSummary] = []
    for file_hash, group_tracks in grouped.items():
        if len(group_tracks) < 2:
            continue
        duplicate_groups.append(
            DuplicateGroupSummary(
                file_hash=file_hash,
                tracks=[
                    DuplicateTrackSummary(
                        id=track.id,
                        title=track.title or "Unknown",
                        artist=track.artist or "Unknown",
                        path=track.path,
                    )
                    for track in group_tracks
                ],
            )
        )

    return duplicate_groups


@router.post("/duplicates/resolve", response_model=DuplicateResolveResponse)
async def resolve_duplicate_group(
    payload: DuplicateResolveRequest,
    db: Session = Depends(get_db),
) -> DuplicateResolveResponse:
    keep_track = db.query(Track).filter(Track.id == payload.keep_track_id).first()
    if not keep_track:
        raise HTTPException(status_code=404, detail="Keep track not found")

    remove_ids = [track_id for track_id in payload.remove_track_ids if track_id != payload.keep_track_id]
    if not remove_ids:
        return DuplicateResolveResponse(deleted=0, kept_track_id=payload.keep_track_id)

    remove_tracks = db.query(Track).filter(Track.id.in_(remove_ids)).all()
    if len(remove_tracks) != len(set(remove_ids)):
        raise HTTPException(status_code=404, detail="One or more duplicate tracks not found")

    keep_hash = keep_track.file_hash
    if not keep_hash:
        raise HTTPException(status_code=400, detail="Keep track has no file hash")

    for track in remove_tracks:
        if track.file_hash != keep_hash:
            raise HTTPException(
                status_code=400,
                detail="All tracks in a resolve operation must share the same file hash",
            )

    affected_playlists: set[int] = set()
    for item in db.query(PlaylistTrack).filter(PlaylistTrack.track_id.in_(remove_ids)).all():
        affected_playlists.add(item.playlist_id)
        existing = (
            db.query(PlaylistTrack)
            .filter(
                PlaylistTrack.playlist_id == item.playlist_id,
                PlaylistTrack.track_id == keep_track.id,
            )
            .first()
        )
        if existing:
            db.delete(item)
        else:
            item.track_id = keep_track.id

    triage_rank = {"reject": 0, "unheard": 1, "problem": 2, "maybe": 3, "keep": 4}
    for track in remove_tracks:
        if triage_rank.get(track.triage_decision, 0) > triage_rank.get(keep_track.triage_decision, 0):
            keep_track.triage_decision = track.triage_decision
        for field in ("title", "artist", "genre", "mood", "energy", "bpm", "bpm_confidence", "key_camelot"):
            if getattr(keep_track, field) in (None, "", "Unknown") and getattr(track, field) not in (None, "", "Unknown"):
                setattr(keep_track, field, getattr(track, field))

    db.query(Track).filter(Track.id.in_(remove_ids)).delete(synchronize_session=False)
    db.flush()
    for playlist_id in affected_playlists:
        items = (
            db.query(PlaylistTrack)
            .filter(PlaylistTrack.playlist_id == playlist_id)
            .order_by(PlaylistTrack.position.asc())
            .all()
        )
        for position, item in enumerate(items, start=1):
            item.position = position
    db.commit()

    return DuplicateResolveResponse(deleted=len(remove_ids), kept_track_id=payload.keep_track_id)
