from __future__ import annotations

import os

from sqlalchemy import or_
from sqlalchemy.orm import Query

from djit.database.models import Track
from djit.schemas.saved_view import SavedViewState


def apply_track_filters(query: Query, state: SavedViewState) -> Query:
    if state.folder_path:
        folder = state.folder_path.rstrip(os.sep)
        query = query.filter(
            or_(
                Track.path == folder,
                Track.path.startswith(f"{folder}{os.sep}", autoescape=True),
            )
        )

    for term in (part for part in state.search.strip().split() if part):
        pattern = f"%{term}%"
        query = query.filter(
            or_(
                Track.title.ilike(pattern),
                Track.artist.ilike(pattern),
                Track.genre.ilike(pattern),
                Track.mood.ilike(pattern),
                Track.key_camelot.ilike(pattern),
                Track.path.ilike(pattern),
            )
        )

    if state.triage_decision:
        query = query.filter(Track.triage_decision.in_(state.triage_decision))
    if state.analysis_status:
        query = query.filter(Track.analysis_status.in_(state.analysis_status))
    if state.key_camelot:
        query = query.filter(Track.key_camelot == state.key_camelot)
    if state.mood:
        query = query.filter(Track.mood == state.mood)
    if state.energy_min is not None:
        query = query.filter(Track.energy >= state.energy_min)
    if state.energy_max is not None:
        query = query.filter(Track.energy <= state.energy_max)
    if state.bpm_min is not None:
        query = query.filter(Track.bpm >= state.bpm_min)
    if state.bpm_max is not None:
        query = query.filter(Track.bpm <= state.bpm_max)
    return query


def apply_track_sort(query: Query, state: SavedViewState) -> Query:
    columns = {
        "title": Track.title,
        "artist": Track.artist,
        "genre": Track.genre,
        "mood": Track.mood,
        "energy": Track.energy,
        "bpm": Track.bpm,
        "key_camelot": Track.key_camelot,
        "analysis_status": Track.analysis_status,
        "triage_decision": Track.triage_decision,
        "duration_seconds": Track.duration_seconds,
    }
    column = columns.get(state.sort_by, Track.triage_decision)
    return query.order_by(column.desc() if state.sort_desc else column.asc(), Track.id.asc())
