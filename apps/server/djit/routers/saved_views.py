from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from djit.database.models import Playlist, PlaylistTrack, SavedView, Track
from djit.database.session import get_db
from djit.schemas.saved_view import (
    SavedViewCreate,
    SavedViewFreezeRequest,
    SavedViewFreezeResponse,
    SavedViewState,
    SavedViewSummary,
    SavedViewUpdate,
)
from djit.services.track_query import apply_track_filters, apply_track_sort

router = APIRouter(tags=["saved-views"])


def _to_summary(view: SavedView, db: Session) -> SavedViewSummary:
    state = SavedViewState.model_validate(json.loads(view.state_json))
    return SavedViewSummary(
        id=view.id,
        name=view.name,
        state=state,
        is_default=view.is_default,
        track_count=apply_track_filters(db.query(Track.id), state).count(),
        created_at=view.created_at,
        updated_at=view.updated_at,
    )


@router.get("/saved-views", response_model=list[SavedViewSummary])
async def list_saved_views(db: Session = Depends(get_db)) -> list[SavedViewSummary]:
    views = db.query(SavedView).order_by(SavedView.created_at.desc()).all()
    return [_to_summary(view, db) for view in views]


@router.post(
    "/saved-views",
    response_model=SavedViewSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_saved_view(
    payload: SavedViewCreate,
    db: Session = Depends(get_db),
) -> SavedViewSummary:
    existing = db.query(SavedView).filter(SavedView.name == payload.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Saved view name already exists")

    if payload.is_default:
        db.query(SavedView).update({SavedView.is_default: False})

    view = SavedView(
        name=payload.name,
        state_json=payload.state.model_dump_json(),
        is_default=payload.is_default,
    )
    db.add(view)
    db.commit()
    db.refresh(view)
    return _to_summary(view, db)


@router.patch("/saved-views/{view_id}", response_model=SavedViewSummary)
async def update_saved_view(
    view_id: int,
    payload: SavedViewUpdate,
    db: Session = Depends(get_db),
) -> SavedViewSummary:
    view = db.query(SavedView).filter(SavedView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Saved view not found")

    if payload.name is not None and payload.name != view.name:
        existing = db.query(SavedView).filter(SavedView.name == payload.name).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail="Saved view name already exists",
            )
        view.name = payload.name

    if payload.state is not None:
        view.state_json = payload.state.model_dump_json()

    if payload.is_default is not None:
        if payload.is_default:
            db.query(SavedView).update({SavedView.is_default: False})
        view.is_default = payload.is_default

    db.commit()
    db.refresh(view)
    return _to_summary(view, db)


@router.post("/saved-views/{view_id}/freeze", response_model=SavedViewFreezeResponse)
async def freeze_saved_view(
    view_id: int,
    payload: SavedViewFreezeRequest,
    db: Session = Depends(get_db),
) -> SavedViewFreezeResponse:
    view = db.query(SavedView).filter(SavedView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Saved view not found")

    playlist_name = (payload.name or view.name).strip()
    if db.query(Playlist).filter(Playlist.name == playlist_name).first():
        raise HTTPException(status_code=409, detail="Playlist name already exists")

    state = SavedViewState.model_validate(json.loads(view.state_json))
    track_ids = [
        track_id
        for (track_id,) in apply_track_sort(
            apply_track_filters(db.query(Track.id), state), state
        ).all()
    ]
    playlist = Playlist(name=playlist_name)
    db.add(playlist)
    db.flush()
    db.add_all(
        PlaylistTrack(playlist_id=playlist.id, track_id=track_id, position=position)
        for position, track_id in enumerate(track_ids, start=1)
    )
    db.commit()
    return SavedViewFreezeResponse(
        playlist_id=playlist.id,
        playlist_name=playlist.name,
        track_count=len(track_ids),
    )


@router.delete("/saved-views/{view_id}")
async def delete_saved_view(view_id: int, db: Session = Depends(get_db)) -> dict[str, int]:
    view = db.query(SavedView).filter(SavedView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Saved view not found")

    db.delete(view)
    db.commit()
    return {"deleted": 1}
