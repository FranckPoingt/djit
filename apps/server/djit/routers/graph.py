from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from djit.database.models import Track
from djit.database.session import get_db
from djit.schemas.graph import EdgeType, GraphResponse
from djit.services.graph_builder import _TrackLike, build_graph
from djit.services.playlist_builder import (
    detect_components,
    order_tracks_greedy,
    find_path,
    _TrackLikePlaylist,
)
from djit.services.harmonizer import HarmonizeProfile

router = APIRouter(tags=["graph"])

_ALL_TYPES: list[EdgeType] = ["key", "bpm", "genre", "energy", "mood", "artist"]


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class PlaylistOrderRequest(BaseModel):
    """Request to order a set of track IDs into a playlist."""
    track_ids: list[int]
    start_id: int | None = None
    key_weight: float = 0.5
    bpm_weight: float = 0.3
    energy_weight: float = 0.2


class PlaylistOrderResponse(BaseModel):
    """Ordered track IDs for playlist creation."""
    ordered_track_ids: list[int]


class PlaylistPathRequest(BaseModel):
    """Request to find optimal path between two tracks."""
    start_id: int
    end_id: int
    key_weight: float = 0.5
    bpm_weight: float = 0.3
    energy_weight: float = 0.2
    bpm_tolerance: float = 5.0
    profile: HarmonizeProfile = "cruise"


class PlaylistPathResponse(BaseModel):
    """Path of track IDs connecting start to end."""
    path: list[int] | None
    found: bool


class ComponentsResponse(BaseModel):
    """Connected components (natural playlist clusters)."""
    components: list[list[int]]
    truncated: bool


@router.get("/graph", response_model=GraphResponse)
def get_graph(
    types: list[EdgeType] = Query(default=_ALL_TYPES),
    bpm_tol: float = Query(default=5.0, ge=0.0, le=50.0),
    filter_ids: list[int] = Query(default_factory=list),
    db: Session = Depends(get_db),
) -> GraphResponse:
    """Return graph nodes and edges for the track library.

    Parameters
    ----------
    types:
        Edge types to include.  Repeat the parameter to include multiple, e.g.
        ``?types=key&types=bpm``.  Defaults to all six types.
    bpm_tol:
        BPM tolerance in percent for the ``bpm`` edge type (default: 5%).
    filter_ids:
        Optional list of track IDs to restrict the graph to a specific subset
        (e.g. the active saved-view).  When empty, the full library is used.
    """
    query = db.query(Track)
    if filter_ids:
        query = query.filter(Track.id.in_(filter_ids))

    tracks = query.order_by(Track.id.asc()).all()

    track_dicts: list[_TrackLike] = [
        {
            "id": t.id,
            "title": t.title,
            "artist": t.artist,
            "bpm": t.bpm,
            "key_camelot": t.key_camelot,
            "genre": t.genre,
            "energy": t.energy,
            "mood": t.mood,
        }
        for t in tracks
    ]

    return build_graph(track_dicts, types=list(types), bpm_tol_pct=bpm_tol)


@router.post("/graph/components", response_model=ComponentsResponse)
def get_components(
    types: list[EdgeType] = Query(default=_ALL_TYPES),
    bpm_tol: float = Query(default=5.0, ge=0.0, le=50.0),
    filter_ids: list[int] = Query(default_factory=list),
    db: Session = Depends(get_db),
) -> ComponentsResponse:
    """Detect connected components (natural playlist clusters).
    
    Uses the same edge detection as /graph but returns grouped track IDs
    representing maximal connected subgraphs. Useful for suggesting playlists.
    
    Parameters
    ----------
    types:
        Edge types to include (same as /graph).
    bpm_tol:
        BPM tolerance in percent (same as /graph).
    filter_ids:
        Optional track ID subset (same as /graph).
    """
    query = db.query(Track)
    if filter_ids:
        query = query.filter(Track.id.in_(filter_ids))

    tracks = query.order_by(Track.id.asc()).all()

    track_dicts: list[_TrackLike] = [
        {
            "id": t.id,
            "title": t.title,
            "artist": t.artist,
            "bpm": t.bpm,
            "key_camelot": t.key_camelot,
            "genre": t.genre,
            "energy": t.energy,
            "mood": t.mood,
        }
        for t in tracks
    ]

    graph_response = build_graph(track_dicts, types=list(types), bpm_tol_pct=bpm_tol)
    node_ids = [n.id for n in graph_response.nodes]
    components_dict = detect_components(node_ids, graph_response.edges)
    
    # Sort components by size descending for UX
    components_list = sorted(
        components_dict.values(),
        key=lambda c: len(c),
        reverse=True
    )
    
    return ComponentsResponse(
        components=components_list,
        truncated=graph_response.truncated
    )


@router.post("/graph/order", response_model=PlaylistOrderResponse)
def order_playlist(
    request: PlaylistOrderRequest,
    types: list[EdgeType] = Query(default=["key", "bpm", "energy"]),
    bpm_tol: float = Query(default=5.0, ge=0.0, le=50.0),
    db: Session = Depends(get_db),
) -> PlaylistOrderResponse:
    """Order a set of track IDs into a smooth playlist progression.
    
    Uses greedy nearest-neighbor selection based on weighted edge criteria
    (key harmonics, BPM continuity, energy flow).
    
    Parameters
    ----------
    request:
        PlaylistOrderRequest with track_ids, optional start_id, and weights.
    types:
        Edge types to consider (defaults to key, bpm, energy for smooth flow).
    bpm_tol:
        BPM tolerance percent.
    """
    if not request.track_ids:
        return PlaylistOrderResponse(ordered_track_ids=[])
    
    # Fetch all track data
    tracks_in_db = db.query(Track).filter(Track.id.in_(request.track_ids)).all()
    all_tracks: dict[int, _TrackLikePlaylist] = {
        t.id: {
            "id": t.id,
            "bpm": t.bpm,
            "key_camelot": t.key_camelot,
            "energy": t.energy,
        }
        for t in tracks_in_db
    }
    
    # Build graph for all library tracks to get edge information
    all_library_tracks = db.query(Track).order_by(Track.id.asc()).all()
    track_dicts: list[_TrackLike] = [
        {
            "id": t.id,
            "title": t.title,
            "artist": t.artist,
            "bpm": t.bpm,
            "key_camelot": t.key_camelot,
            "genre": t.genre,
            "energy": t.energy,
            "mood": t.mood,
        }
        for t in all_library_tracks
    ]
    graph_response = build_graph(track_dicts, types=list(types), bpm_tol_pct=bpm_tol)
    
    edge_weights = {
        "key": request.key_weight,
        "bpm": request.bpm_weight,
        "energy": request.energy_weight,
    }
    
    ordered = order_tracks_greedy(
        request.track_ids,
        all_tracks,
        graph_response.edges,
        start_id=request.start_id,
        edge_weights=edge_weights,
    )
    
    return PlaylistOrderResponse(ordered_track_ids=ordered)


@router.post("/graph/path", response_model=PlaylistPathResponse)
def find_playlist_path(
    request: PlaylistPathRequest,
    types: list[EdgeType] = Query(default=["key", "bpm", "energy"]),
    bpm_tol: float = Query(default=5.0, ge=0.0, le=50.0),
    db: Session = Depends(get_db),
) -> PlaylistPathResponse:
    """Find optimal path between two tracks through the library.
    
    Uses Dijkstra with weighted edges to find the smoothest transition path.
    Useful for building progressive playlists (e.g., slow to energetic).
    
    Parameters
    ----------
    request:
        PlaylistPathRequest with start_id, end_id, and optional weights.
    types:
        Edge types to consider (defaults to key, bpm, energy).
    bpm_tol:
        BPM tolerance percent.
    """
    # Fetch all track data for weights
    all_library_tracks = db.query(Track).order_by(Track.id.asc()).all()
    all_tracks: dict[int, _TrackLikePlaylist] = {
        t.id: {
            "id": t.id,
            "bpm": t.bpm,
            "key_camelot": t.key_camelot,
            "energy": t.energy,
        }
        for t in all_library_tracks
    }
    
    # Build graph
    track_dicts: list[_TrackLike] = [
        {
            "id": t.id,
            "title": t.title,
            "artist": t.artist,
            "bpm": t.bpm,
            "key_camelot": t.key_camelot,
            "genre": t.genre,
            "energy": t.energy,
            "mood": t.mood,
        }
        for t in all_library_tracks
    ]
    graph_response = build_graph(track_dicts, types=list(types), bpm_tol_pct=bpm_tol)
    
    edge_weights = {
        "key": request.key_weight,
        "bpm": request.bpm_weight,
        "energy": request.energy_weight,
    }
    
    path = find_path(
        request.start_id,
        request.end_id,
        all_tracks,
        graph_response.edges,
        edge_weights=edge_weights,
        bpm_tolerance=request.bpm_tolerance,
        profile=request.profile,
    )
    
    return PlaylistPathResponse(
        path=path,
        found=path is not None
    )
