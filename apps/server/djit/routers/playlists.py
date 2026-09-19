from __future__ import annotations

from typing import cast

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from djit.database.models import Playlist, PlaylistTrack, Track
from djit.database.session import get_db
from djit.schemas.playlist import (
    HarmonizeDiagnosticsPayload,
    HarmonizePlaylistRequest,
    HarmonizePlaylistResponse,
    HarmonizeTransitionDiagnostic,
    PlaylistCreate,
    PlaylistDetail,
    PlaylistOrderUpdate,
    PlaylistSummary,
    PlaylistTrackAddRequest,
)
from djit.services.harmonizer import (
    HarmonizeRequest,
    build_harmonize_diagnostics,
    harmonize,
)
from djit.schemas.track import AnalysisStatus, TriageDecision, TrackSummary

router = APIRouter(tags=["playlists"])


def _to_track_summary(track: Track) -> TrackSummary:
    return TrackSummary(
        id=track.id,
        title=track.title or "Unknown",
        artist=track.artist or "Unknown",
        genre=track.genre,
        mood=track.mood,
        energy=track.energy,
        duration_seconds=track.duration_seconds,
        bpm=track.bpm,
        bpm_confidence=track.bpm_confidence,
        key_camelot=track.key_camelot,
        analysis_status=cast(AnalysisStatus, track.analysis_status),
        triage_decision=cast(TriageDecision, track.triage_decision),
    )


def _get_playlist_or_404(db: Session, playlist_id: int) -> Playlist:
    playlist = db.query(Playlist).filter(Playlist.id == playlist_id).first()
    if not playlist:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


def _playlist_detail(db: Session, playlist: Playlist) -> PlaylistDetail:
    items = (
        db.query(PlaylistTrack, Track)
        .join(Track, Track.id == PlaylistTrack.track_id)
        .filter(PlaylistTrack.playlist_id == playlist.id)
        .order_by(PlaylistTrack.position.asc())
        .all()
    )
    tracks = [_to_track_summary(track) for _, track in items]
    bpm_values = [track.bpm for track in tracks if track.bpm is not None]
    duration_values = [
        track.duration_seconds for track in tracks if track.duration_seconds is not None
    ]
    return PlaylistDetail(
        id=playlist.id,
        name=playlist.name,
        track_count=len(tracks),
        duration_seconds=sum(duration_values) if duration_values else None,
        bpm_min=min(bpm_values) if bpm_values else None,
        bpm_max=max(bpm_values) if bpm_values else None,
        tracks=tracks,
    )


@router.get("/playlists", response_model=list[PlaylistSummary])
async def list_playlists(db: Session = Depends(get_db)) -> list[PlaylistSummary]:
    playlists = db.query(Playlist).order_by(Playlist.created_at.desc()).all()
    return [
        PlaylistSummary(
            id=detail.id,
            name=detail.name,
            track_count=detail.track_count,
            duration_seconds=detail.duration_seconds,
            bpm_min=detail.bpm_min,
            bpm_max=detail.bpm_max,
        )
        for detail in (_playlist_detail(db, playlist) for playlist in playlists)
    ]


@router.post("/playlists", response_model=PlaylistSummary)
async def create_playlist(
    payload: PlaylistCreate,
    db: Session = Depends(get_db),
) -> PlaylistSummary:
    existing = db.query(Playlist).filter(Playlist.name == payload.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Playlist name already exists")

    playlist = Playlist(name=payload.name)
    db.add(playlist)
    db.commit()
    db.refresh(playlist)

    return PlaylistSummary(
        id=playlist.id,
        name=playlist.name,
        track_count=0,
        duration_seconds=None,
        bpm_min=None,
        bpm_max=None,
    )


@router.get("/playlists/{playlist_id}", response_model=PlaylistDetail)
async def get_playlist(playlist_id: int, db: Session = Depends(get_db)) -> PlaylistDetail:
    playlist = _get_playlist_or_404(db, playlist_id)
    return _playlist_detail(db, playlist)


@router.delete("/playlists/{playlist_id}")
async def delete_playlist(playlist_id: int, db: Session = Depends(get_db)) -> dict[str, int]:
    playlist = _get_playlist_or_404(db, playlist_id)
    db.query(PlaylistTrack).filter(PlaylistTrack.playlist_id == playlist_id).delete(
        synchronize_session=False
    )
    db.delete(playlist)
    db.commit()
    return {"deleted": 1}


@router.post("/playlists/{playlist_id}/tracks")
async def add_tracks_to_playlist(
    playlist_id: int,
    payload: PlaylistTrackAddRequest,
    db: Session = Depends(get_db),
) -> dict[str, int]:
    _get_playlist_or_404(db, playlist_id)

    if not payload.track_ids:
        return {"playlist_id": playlist_id, "added": 0}

    existing_track_ids = {
        track_id
        for (track_id,) in db.query(Track.id).filter(Track.id.in_(payload.track_ids)).all()
    }
    if len(existing_track_ids) != len(set(payload.track_ids)):
        raise HTTPException(status_code=404, detail="One or more tracks not found")

    current_items = (
        db.query(PlaylistTrack)
        .filter(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .all()
    )
    existing_in_playlist = {item.track_id for item in current_items}
    next_position = current_items[-1].position + 1 if current_items else 1
    added = 0

    for track_id in payload.track_ids:
        if track_id in existing_in_playlist:
            continue
        db.add(
            PlaylistTrack(
                playlist_id=playlist_id,
                track_id=track_id,
                position=next_position,
            )
        )
        next_position += 1
        added += 1

    db.commit()
    return {"playlist_id": playlist_id, "added": added}


@router.delete("/playlists/{playlist_id}/tracks/{track_id}")
async def remove_track_from_playlist(
    playlist_id: int,
    track_id: int,
    db: Session = Depends(get_db),
) -> dict[str, int]:
    _get_playlist_or_404(db, playlist_id)

    item = (
        db.query(PlaylistTrack)
        .filter(
            PlaylistTrack.playlist_id == playlist_id,
            PlaylistTrack.track_id == track_id,
        )
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Track not in playlist")

    db.delete(item)
    db.commit()

    remaining = (
        db.query(PlaylistTrack)
        .filter(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .all()
    )
    for index, playlist_track in enumerate(remaining, start=1):
        playlist_track.position = index

    db.commit()
    return {"playlist_id": playlist_id, "removed": track_id}


@router.put("/playlists/{playlist_id}/order")
async def reorder_playlist(
    playlist_id: int,
    payload: PlaylistOrderUpdate,
    db: Session = Depends(get_db),
) -> dict[str, int]:
    _get_playlist_or_404(db, playlist_id)

    items = (
        db.query(PlaylistTrack)
        .filter(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .all()
    )
    existing_track_ids = {item.track_id for item in items}
    requested_track_ids = payload.track_ids

    if set(requested_track_ids) != existing_track_ids:
        raise HTTPException(
            status_code=400,
            detail="Order payload must include every track in playlist exactly once",
        )

    item_by_track_id = {item.track_id: item for item in items}
    for index, track_id in enumerate(requested_track_ids, start=1):
        item_by_track_id[track_id].position = index

    db.commit()
    return {"playlist_id": playlist_id, "count": len(requested_track_ids)}


@router.post(
    "/playlists/{playlist_id}/harmonize",
    response_model=HarmonizePlaylistResponse,
)
async def harmonize_playlist(
    playlist_id: int,
    payload: HarmonizePlaylistRequest,
    db: Session = Depends(get_db),
) -> HarmonizePlaylistResponse:
    """Reorder playlist tracks using BPM+key harmonic nearest-neighbour algorithm."""
    _get_playlist_or_404(db, playlist_id)

    items = (
        db.query(PlaylistTrack, Track)
        .join(Track, Track.id == PlaylistTrack.track_id)
        .filter(PlaylistTrack.playlist_id == playlist_id)
        .order_by(PlaylistTrack.position.asc())
        .all()
    )
    if not items:
        return HarmonizePlaylistResponse(
            playlist_id=playlist_id,
            track_ids=[],
            applied=True,
            diagnostics=HarmonizeDiagnosticsPayload(
                transitions=[],
                compatibility_score=100.0,
                risky_jumps=0,
                energy_trend="flat",
            ),
        )

    track_ids = [track.id for _, track in items]
    bpms: list[float | None] = [track.bpm for _, track in items]
    keys: list[str | None] = [track.key_camelot for _, track in items]

    req = HarmonizeRequest(
        track_ids=track_ids,
        bpms=bpms,
        keys=keys,
        lock_first=payload.lock_first,
        lock_last=payload.lock_last,
        bpm_weight=payload.bpm_weight,
        bpm_tolerance=payload.bpm_tolerance,
        profile=payload.profile,
    )
    ordered_ids = harmonize(req)
    diagnostics = build_harmonize_diagnostics(
        track_ids=ordered_ids,
        key_by_track_id={track_id: key for track_id, key in zip(track_ids, keys, strict=True)},
    )

    # Persist the new order
    item_by_track_id = {track.id: pt for pt, track in items}
    for index, track_id in enumerate(ordered_ids, start=1):
        item_by_track_id[track_id].position = index
    db.commit()

    return HarmonizePlaylistResponse(
        playlist_id=playlist_id,
        track_ids=ordered_ids,
        applied=True,
        diagnostics=HarmonizeDiagnosticsPayload(
            transitions=[
                HarmonizeTransitionDiagnostic(
                    from_track_id=t.from_track_id,
                    to_track_id=t.to_track_id,
                    from_key=t.from_key,
                    to_key=t.to_key,
                    category=t.category,
                    label=t.label,
                    compatibility=t.compatibility,
                )
                for t in diagnostics.transitions
            ],
            compatibility_score=diagnostics.compatibility_score,
            risky_jumps=diagnostics.risky_jumps,
            energy_trend=diagnostics.energy_trend,
        ),
    )
