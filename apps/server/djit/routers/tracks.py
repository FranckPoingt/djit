from __future__ import annotations

import os
from urllib.parse import quote_plus
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from djit.database.models import Playlist, PlaylistTrack, Track
from djit.database.session import get_db
from djit.schemas.track import (
    AnalysisStatus,
    MetadataMatchResponse,
    MixSuggestion,
    PaginatedTracksResponse,
    ReviewGenreCount,
    ReviewOverviewResponse,
    ReviewSessionResponse,
    TriageDecision,
    TrackBulkUpdate,
    TrackPlaylistMembership,
    TrackSummary,
    TrackUpdate,
)
from djit.schemas.saved_view import SavedViewState
from djit.services.harmonizer import _bpm_distance, _harmonic_distance
from djit.services.track_query import apply_track_filters, apply_track_sort

router = APIRouter(tags=["tracks"])


def _review_query(db: Session, folder_path: str | None = None):
    query = (
        db.query(Track)
        .filter(Track.triage_decision == "unheard")
        .filter(or_(Track.duration_seconds.is_(None), Track.duration_seconds <= 720))
        .filter(~Track.id.in_(db.query(PlaylistTrack.track_id)))
    )
    if folder_path:
        normalized = folder_path.rstrip(os.sep)
        query = query.filter(
            or_(
                Track.path == normalized,
                Track.path.startswith(f"{normalized}{os.sep}", autoescape=True),
            )
        )
    return query


def _track_summaries(db: Session, tracks: list[Track]) -> list[TrackSummary]:
    if not tracks:
        return []
    memberships_by_track: dict[int, list[TrackPlaylistMembership]] = {}
    for track_id, playlist_id, playlist_name in (
        db.query(PlaylistTrack.track_id, Playlist.id, Playlist.name)
        .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
        .filter(PlaylistTrack.track_id.in_([track.id for track in tracks]))
        .all()
    ):
        memberships_by_track.setdefault(track_id, []).append(
            TrackPlaylistMembership(id=playlist_id, name=playlist_name)
        )
    return [
        TrackSummary(
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
            playlist_memberships=memberships_by_track.get(track.id, []),
        )
        for track in tracks
    ]


@router.get("/tracks", response_model=PaginatedTracksResponse)
async def list_tracks(
    limit: int = Query(default=200, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    q: str | None = Query(default=None, max_length=255),
    folder_path: str | None = Query(default=None, max_length=4096),
    triage_decision: list[TriageDecision] = Query(default=[]),
    analysis_status: list[AnalysisStatus] = Query(default=[]),
    key_camelot: str | None = Query(default=None, max_length=8),
    mood: str | None = Query(default=None, max_length=100),
    energy_min: int | None = Query(default=None, ge=0, le=10),
    energy_max: int | None = Query(default=None, ge=0, le=10),
    bpm_min: float | None = Query(default=None, ge=0),
    bpm_max: float | None = Query(default=None, ge=0),
    sort_by: str = Query(default="triage_decision", max_length=40),
    sort_desc: bool = Query(default=False),
    db: Session = Depends(get_db),
) -> PaginatedTracksResponse:
    query = db.query(
        Track.id,
        Track.title,
        Track.artist,
        Track.genre,
        Track.mood,
        Track.energy,
        Track.duration_seconds,
        Track.bpm,
        Track.bpm_confidence,
        Track.key_camelot,
        Track.analysis_status,
        Track.triage_decision,
    )

    state = SavedViewState(
        search=q or "",
        folder_path=folder_path,
        triage_decision=triage_decision,
        analysis_status=analysis_status,
        key_camelot=key_camelot,
        mood=mood,
        energy_min=energy_min,
        energy_max=energy_max,
        bpm_min=bpm_min,
        bpm_max=bpm_max,
        sort_by=sort_by,
        sort_desc=sort_desc,
    )
    query = apply_track_filters(query, state)
    count_query = apply_track_filters(db.query(Track.id), state)

    total = count_query.count()
    track_rows = apply_track_sort(query, state).offset(offset).limit(limit).all()

    if not track_rows:
        return PaginatedTracksResponse(items=[], total=total, offset=offset, limit=limit)

    track_ids = [track_id for track_id, *_ in track_rows]

    membership_rows = (
        db.query(PlaylistTrack.track_id, Playlist.id, Playlist.name)
        .join(Playlist, Playlist.id == PlaylistTrack.playlist_id)
        .filter(PlaylistTrack.track_id.in_(track_ids))
        .all()
    )

    memberships_by_track: dict[int, list[TrackPlaylistMembership]] = {}
    for track_id, playlist_id, playlist_name in membership_rows:
        memberships_by_track.setdefault(track_id, []).append(
            TrackPlaylistMembership(id=playlist_id, name=playlist_name)
        )

    items = [
        TrackSummary(
            id=track_id,
            title=title or "Unknown",
            artist=artist or "Unknown",
            genre=genre,
            mood=mood,
            energy=energy,
            duration_seconds=duration_seconds,
            bpm=bpm,
            bpm_confidence=bpm_confidence,
            key_camelot=key_camelot,
            analysis_status=cast(AnalysisStatus, analysis_status),
            triage_decision=cast(TriageDecision, triage_decision),
            playlist_memberships=memberships_by_track.get(track_id, []),
        )
        for (
            track_id,
            title,
            artist,
            genre,
            mood,
            energy,
            duration_seconds,
            bpm,
            bpm_confidence,
            key_camelot,
            analysis_status,
            triage_decision,
        ) in track_rows
    ]

    return PaginatedTracksResponse(items=items, total=total, offset=offset, limit=limit)


@router.get("/tracks/review-genres", response_model=ReviewOverviewResponse)
async def review_genres(
    folder_path: str | None = Query(default=None, max_length=4096),
    limit: int = Query(default=16, ge=1, le=200),
    db: Session = Depends(get_db),
) -> ReviewOverviewResponse:
    base_query = _review_query(db, folder_path)
    total_eligible = base_query.count()
    unknown_genre = base_query.filter(
        or_(Track.genre.is_(None), func.trim(Track.genre) == "")
    ).count()
    rows = (
        base_query
        .with_entities(Track.genre, func.count(Track.id))
        .filter(Track.genre.is_not(None), func.trim(Track.genre) != "")
        .group_by(Track.genre)
        .order_by(func.count(Track.id).desc(), Track.genre.asc())
        .limit(limit)
        .all()
    )
    return ReviewOverviewResponse(
        total_eligible=total_eligible,
        unknown_genre=unknown_genre,
        genres=[ReviewGenreCount(name=genre, count=count) for genre, count in rows],
    )


@router.get("/tracks/review-session", response_model=ReviewSessionResponse)
async def review_session(
    genre: list[str] = Query(default=[]),
    folder_path: str | None = Query(default=None, max_length=4096),
    seed_track_id: int | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=50),
    db: Session = Depends(get_db),
) -> ReviewSessionResponse:
    selected_genres = list(dict.fromkeys(value.strip() for value in genre if value.strip()))
    if not selected_genres and seed_track_id is not None:
        seed_genre = db.query(Track.genre).filter(Track.id == seed_track_id).scalar()
        if seed_genre:
            selected_genres = [seed_genre]

    query = _review_query(db, folder_path)
    if selected_genres:
        query = query.filter(Track.genre.in_(selected_genres))
    total_eligible = query.count()
    tracks = query.order_by(func.random()).limit(limit).all()
    return ReviewSessionResponse(
        tracks=_track_summaries(db, tracks),
        total_eligible=total_eligible,
        selected_genres=selected_genres,
    )


@router.get("/tracks/{track_id}/mix-suggestions", response_model=list[MixSuggestion])
async def mix_suggestions(
    track_id: int,
    limit: int = Query(default=10, ge=1, le=25),
    db: Session = Depends(get_db),
) -> list[MixSuggestion]:
    seed = db.query(Track).filter(Track.id == track_id).first()
    if not seed:
        raise HTTPException(status_code=404, detail="Track not found")

    candidates = (
        db.query(Track)
        .filter(
            Track.id != track_id,
            Track.triage_decision.in_(["keep", "maybe"]),
        )
        .all()
    )

    def score(candidate: Track) -> float:
        key_cost = _harmonic_distance(seed.key_camelot, candidate.key_camelot) / 3
        bpm_cost = _bpm_distance(seed.bpm, candidate.bpm, tolerance=6)
        if seed.energy is None or candidate.energy is None:
            energy_cost = 0.5
        else:
            energy_cost = min(abs(seed.energy - candidate.energy) / 5, 1)
        return 1 - (0.45 * key_cost + 0.4 * bpm_cost + 0.15 * energy_cost)

    ranked = sorted(candidates, key=score, reverse=True)[:limit]
    suggestions: list[MixSuggestion] = []
    for candidate in ranked:
        candidate_score = max(0, min(100, round(score(candidate) * 100)))
        reasons = []
        if _harmonic_distance(seed.key_camelot, candidate.key_camelot) <= 1:
            reasons.append("compatible key")
        if _bpm_distance(seed.bpm, candidate.bpm, tolerance=6) <= 0.5:
            reasons.append("close BPM")
        if seed.energy is not None and candidate.energy is not None and abs(seed.energy - candidate.energy) <= 1:
            reasons.append("similar energy")
        suggestions.append(
            MixSuggestion(
                track=TrackSummary(
                    id=candidate.id,
                    title=candidate.title or "Unknown",
                    artist=candidate.artist or "Unknown",
                    genre=candidate.genre,
                    mood=candidate.mood,
                    energy=candidate.energy,
                    duration_seconds=candidate.duration_seconds,
                    bpm=candidate.bpm,
                    bpm_confidence=candidate.bpm_confidence,
                    key_camelot=candidate.key_camelot,
                    analysis_status=cast(AnalysisStatus, candidate.analysis_status),
                    triage_decision=cast(TriageDecision, candidate.triage_decision),
                ),
                score=candidate_score,
                reason=", ".join(reasons) or "closest available match",
            )
        )
    return suggestions


@router.get("/tracks/{track_id}/metadata-match", response_model=MetadataMatchResponse)
async def metadata_match(track_id: int, db: Session = Depends(get_db)) -> MetadataMatchResponse:
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")
    query = quote_plus(f"{track.artist or ''} {track.title or ''}".strip())
    return MetadataMatchResponse(
        track_id=track.id,
        search_url=f"https://www.beatport.com/search/tracks?q={query}",
        current={
            "title": track.title,
            "artist": track.artist,
            "genre": track.genre,
            "bpm": track.bpm,
            "key_camelot": track.key_camelot,
        },
    )


@router.get("/tracks/{track_id}", response_model=TrackSummary)
async def get_track(track_id: int, db: Session = Depends(get_db)) -> TrackSummary:
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    memberships = [
        TrackPlaylistMembership(id=playlist_id, name=playlist_name)
        for playlist_id, playlist_name in (
            db.query(Playlist.id, Playlist.name)
            .join(PlaylistTrack, Playlist.id == PlaylistTrack.playlist_id)
            .filter(PlaylistTrack.track_id == track_id)
            .all()
        )
    ]

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
        playlist_memberships=memberships,
    )


@router.patch("/tracks/bulk")
async def bulk_update_tracks(
    payload: TrackBulkUpdate, db: Session = Depends(get_db)
) -> dict[str, int]:
    tracks = db.query(Track).filter(Track.id.in_(payload.track_ids)).all()

    for track in tracks:
        if payload.genre is not None:
            track.genre = payload.genre
        if payload.triage_decision is not None:
            track.triage_decision = payload.triage_decision

    db.commit()
    return {"updated": len(tracks)}


@router.patch("/tracks/{track_id}")
async def update_track(
    track_id: int, payload: TrackUpdate, db: Session = Depends(get_db)
) -> dict[str, int | TrackUpdate]:
    track = db.query(Track).filter(Track.id == track_id).first()
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    if payload.title is not None:
        track.title = payload.title
    if payload.artist is not None:
        track.artist = payload.artist
    if payload.genre is not None:
        track.genre = payload.genre
    if payload.mood is not None:
        track.mood = payload.mood
        track.analysis_status = "overridden"
    if payload.energy is not None:
        track.energy = payload.energy
        track.analysis_status = "overridden"
    if payload.duration_seconds is not None:
        track.duration_seconds = payload.duration_seconds
    if payload.bpm is not None:
        track.bpm = payload.bpm
        track.analysis_status = "overridden"
    if payload.bpm_confidence is not None:
        track.bpm_confidence = payload.bpm_confidence
    if payload.key_camelot is not None:
        track.key_camelot = payload.key_camelot
        track.analysis_status = "overridden"
    if payload.triage_decision is not None:
        track.triage_decision = payload.triage_decision

    db.commit()
    return {"track_id": track_id, "patch": payload}
