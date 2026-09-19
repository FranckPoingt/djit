"""Graph builder service — pure computation, no I/O.

Builds a track relationship graph from a list of track dicts.
Each track dict is expected to have at minimum:
  id, title, artist, bpm, key_camelot, genre, energy, mood

Edge types
----------
key     — Camelot wheel adjacency (same, ±1 step, relative A↔B of same number)
bpm     — both tracks' BPMs within bpm_tol_pct percent of their average
genre   — non-null genre strings match (case-insensitive strip)
energy  — both have energy, |a - b| <= 1
mood    — non-null mood strings match (case-insensitive strip)
artist  — non-null artist strings match (case-insensitive strip)
"""
from __future__ import annotations

from itertools import combinations
from typing import Any, TypedDict

from djit.schemas.graph import EdgeType, GraphEdge, GraphNode, GraphResponse

# Max tracks to process to stay under O(n²) pain threshold
_MAX_NODES = 2_000

# Top-K edges kept per node to prevent visual clutter
_MAX_EDGES_PER_NODE = 20


# ---------------------------------------------------------------------------
# Camelot helpers (duplicated minimally here to keep service self-contained)
# ---------------------------------------------------------------------------

def _parse_camelot(key: str | None) -> tuple[int, str] | None:
    if not key:
        return None
    key = key.strip().upper()
    if len(key) < 2:
        return None
    mode = key[-1]
    if mode not in ("A", "B"):
        return None
    try:
        num = int(key[:-1])
    except ValueError:
        return None
    if not 1 <= num <= 12:
        return None
    return (num, mode)


def _camelot_adjacent(a: str | None, b: str | None) -> bool:
    """Return True when a and b are the same or one step apart on the Camelot wheel."""
    pa = _parse_camelot(a)
    pb = _parse_camelot(b)
    if pa is None or pb is None:
        return False
    na, ma = pa
    nb, mb = pb
    if na == nb and ma == mb:
        return True  # same key
    if na == nb and ma != mb:
        return True  # relative (A↔B same number)
    if ma == mb and (abs(na - nb) == 1 or abs(na - nb) == 11):
        return True  # ±1 step same mode (with wraparound 12↔1)
    return False


def _camelot_weight(a: str | None, b: str | None) -> float:
    """Weight 1.0 = same key, 0.8 = adjacent (1 step / relative)."""
    pa = _parse_camelot(a)
    pb = _parse_camelot(b)
    if pa is None or pb is None:
        return 0.0
    na, ma = pa
    nb, mb = pb
    if na == nb and ma == mb:
        return 1.0
    return 0.8


# ---------------------------------------------------------------------------
# Track dict type hint (plain dict, no DB dependency)
# ---------------------------------------------------------------------------

class _TrackLikeRequired(TypedDict):
    id: int


class _TrackLike(_TrackLikeRequired, total=False):
    title: str | None
    artist: str | None
    bpm: float | None
    key_camelot: str | None
    genre: str | None
    energy: int | None
    mood: str | None


# ---------------------------------------------------------------------------
# Per-type edge detectors
# ---------------------------------------------------------------------------

def _key_edge(a: _TrackLike, b: _TrackLike) -> GraphEdge | None:
    if _camelot_adjacent(a.get("key_camelot"), b.get("key_camelot")):
        return GraphEdge(
            source=a["id"],
            target=b["id"],
            type="key",
            weight=_camelot_weight(a.get("key_camelot"), b.get("key_camelot")),
        )
    return None


def _bpm_edge(a: _TrackLike, b: _TrackLike, bpm_tol_pct: float) -> GraphEdge | None:
    ba, bb = a.get("bpm"), b.get("bpm")
    if ba is None or bb is None:
        return None
    avg = (ba + bb) / 2.0
    if avg == 0:
        return None
    pct_diff = abs(ba - bb) / avg * 100.0
    if pct_diff <= bpm_tol_pct:
        weight = max(0.0, 1.0 - pct_diff / bpm_tol_pct)
        return GraphEdge(source=a["id"], target=b["id"], type="bpm", weight=round(weight, 3))
    return None


def _genre_edge(a: _TrackLike, b: _TrackLike) -> GraphEdge | None:
    ga, gb = a.get("genre"), b.get("genre")
    if ga and gb and ga.strip().lower() == gb.strip().lower():
        return GraphEdge(source=a["id"], target=b["id"], type="genre", weight=1.0)
    return None


def _energy_edge(a: _TrackLike, b: _TrackLike) -> GraphEdge | None:
    ea, eb = a.get("energy"), b.get("energy")
    if ea is not None and eb is not None and abs(ea - eb) <= 1:
        weight = 1.0 if ea == eb else 0.6
        return GraphEdge(source=a["id"], target=b["id"], type="energy", weight=weight)
    return None


def _mood_edge(a: _TrackLike, b: _TrackLike) -> GraphEdge | None:
    ma, mb = a.get("mood"), b.get("mood")
    if ma and mb and ma.strip().lower() == mb.strip().lower():
        return GraphEdge(source=a["id"], target=b["id"], type="mood", weight=1.0)
    return None


def _artist_edge(a: _TrackLike, b: _TrackLike) -> GraphEdge | None:
    aa, ab = a.get("artist"), b.get("artist")
    if aa and ab and aa.strip().lower() == ab.strip().lower():
        return GraphEdge(source=a["id"], target=b["id"], type="artist", weight=1.0)
    return None


_DETECTORS: dict[EdgeType, Any] = {
    "key": _key_edge,
    "bpm": _bpm_edge,
    "genre": _genre_edge,
    "energy": _energy_edge,
    "mood": _mood_edge,
    "artist": _artist_edge,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_graph(
    tracks: list[_TrackLike],
    types: list[EdgeType] | None = None,
    bpm_tol_pct: float = 5.0,
) -> GraphResponse:
    """Build a GraphResponse from a flat list of track dicts.

    Parameters
    ----------
    tracks:
        List of track dicts. Each must have at minimum an ``id`` key.
    types:
        Edge types to include. Defaults to all six types when None or empty.
    bpm_tol_pct:
        BPM tolerance in percent. Only used for the ``bpm`` edge type.
    """
    if not types:
        types = list(_DETECTORS.keys())

    truncated = False
    if len(tracks) > _MAX_NODES:
        tracks = tracks[:_MAX_NODES]
        truncated = True

    nodes = [
        GraphNode(
            id=t["id"],
            title=t.get("title") or "Unknown",
            artist=t.get("artist") or "Unknown",
            bpm=t.get("bpm"),
            key_camelot=t.get("key_camelot"),
            genre=t.get("genre"),
            energy=t.get("energy"),
            mood=t.get("mood"),
        )
        for t in tracks
    ]

    # Track edge-count per node for the top-K cap
    edge_count: dict[int, int] = {t["id"]: 0 for t in tracks}
    edges: list[GraphEdge] = []

    for a, b in combinations(tracks, 2):
        for etype in types:
            fn = _DETECTORS[etype]
            if etype == "bpm":
                edge = fn(a, b, bpm_tol_pct)
            else:
                edge = fn(a, b)
            if edge is not None:
                src, tgt = edge.source, edge.target
                if (
                    edge_count.get(src, 0) < _MAX_EDGES_PER_NODE
                    and edge_count.get(tgt, 0) < _MAX_EDGES_PER_NODE
                ):
                    edges.append(edge)
                    edge_count[src] = edge_count.get(src, 0) + 1
                    edge_count[tgt] = edge_count.get(tgt, 0) + 1

    return GraphResponse(nodes=nodes, edges=edges, truncated=truncated)
