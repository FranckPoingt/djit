"""Playlist builder service — graph-based playlist generation.

Provides:
  - Community detection to identify natural playlist clusters
  - Weighted path finding for smooth track progressions
  - Multi-criteria scoring (key harmonics, BPM continuity, energy flow)
"""
from __future__ import annotations

import heapq
from collections import defaultdict
from typing import TypedDict

from djit.schemas.graph import GraphEdge
from djit.services.harmonizer import (
    HarmonizeProfile,
    _bpm_distance,
    _profile_transition_cost,
    _transition_category,
)


class _TrackLikePlaylist(TypedDict, total=False):
    """Minimal track attributes for playlist ordering."""
    id: int
    bpm: float | None
    key_camelot: str | None
    energy: int | None


# ---------------------------------------------------------------------------
# Community Detection (Union-Find based)
# ---------------------------------------------------------------------------

class UnionFind:
    """Simple union-find for connected component detection."""
    
    def __init__(self, n: int):
        self.parent = list(range(n))
        self.rank = [0] * n
    
    def find(self, x: int) -> int:
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])
        return self.parent[x]
    
    def union(self, x: int, y: int) -> None:
        px, py = self.find(x), self.find(y)
        if px == py:
            return
        if self.rank[px] < self.rank[py]:
            px, py = py, px
        self.parent[py] = px
        if self.rank[px] == self.rank[py]:
            self.rank[px] += 1


def detect_components(
    node_ids: list[int],
    edges: list[GraphEdge],
) -> dict[int, list[int]]:
    """Detect connected components using union-find.
    
    Returns a dict mapping component_id -> list of track_ids in that component.
    """
    if not node_ids:
        return {}
    
    # Map track IDs to indices
    id_to_idx = {nid: i for i, nid in enumerate(node_ids)}
    uf = UnionFind(len(node_ids))
    
    # Union all edges
    for edge in edges:
        src_idx = id_to_idx.get(edge.source)
        tgt_idx = id_to_idx.get(edge.target)
        if src_idx is not None and tgt_idx is not None:
            uf.union(src_idx, tgt_idx)
    
    # Group by component root
    components: dict[int, list[int]] = defaultdict(list)
    for idx, nid in enumerate(node_ids):
        root = uf.find(idx)
        components[root].append(nid)
    
    return dict(components)


# ---------------------------------------------------------------------------
# Multi-Weighted Path Finding
# ---------------------------------------------------------------------------

def _edge_weight_multi(
    a: _TrackLikePlaylist,
    b: _TrackLikePlaylist,
    edge_types: set[str],
    key_weight: float = 0.5,
    bpm_weight: float = 0.3,
    energy_weight: float = 0.2,
) -> float:
    """Compute path edge weight combining key, BPM, and energy continuity.
    
    Returns a cost in range [0, 1] where 0 is perfect transition and 1 is worst.
    """
    total_score = 0.0
    
    # Key harmonics penalty (lower is better)
    if "key" in edge_types:
        key_a = a.get("key_camelot")
        key_b = b.get("key_camelot")
        if key_a and key_b:
            # Same key = 0 cost, adjacent = 0.2 cost, far = 0.8 cost
            if key_a == key_b:
                key_cost = 0.0
            elif _is_camelot_adjacent(key_a, key_b):
                key_cost = 0.2
            else:
                key_cost = 0.8
            total_score += key_weight * key_cost
        else:
            total_score += key_weight * 0.5  # unknown keys get middle penalty
    
    # BPM continuity penalty
    if "bpm" in edge_types:
        bpm_a = a.get("bpm")
        bpm_b = b.get("bpm")
        if bpm_a and bpm_b:
            # Penalty scaled by percent difference
            avg = (bpm_a + bpm_b) / 2.0
            if avg > 0:
                pct_diff = abs(bpm_a - bpm_b) / avg * 100.0
                bpm_cost = min(1.0, pct_diff / 50.0)  # cap at 50% diff = cost 1.0
                total_score += bpm_weight * bpm_cost
            else:
                total_score += bpm_weight * 0.5
        else:
            total_score += bpm_weight * 0.5
    
    # Energy continuity penalty
    if "energy" in edge_types:
        energy_a = a.get("energy")
        energy_b = b.get("energy")
        if energy_a is not None and energy_b is not None:
            # Each step of energy difference = 0.2 cost
            energy_cost = min(1.0, abs(energy_a - energy_b) * 0.2)
            total_score += energy_weight * energy_cost
        else:
            total_score += energy_weight * 0.5
    
    # If no edge types matched, return neutral cost
    if not (edge_types & {"key", "bpm", "energy"}):
        total_score = 0.5
    
    return max(0.0, min(1.0, total_score))


def _normalize_weights(edge_weights: dict[str, float] | None) -> tuple[float, float, float]:
    key_w = max(0.0, float((edge_weights or {}).get("key", 0.5)))
    bpm_w = max(0.0, float((edge_weights or {}).get("bpm", 0.3)))
    energy_w = max(0.0, float((edge_weights or {}).get("energy", 0.2)))
    total = key_w + bpm_w + energy_w
    if total <= 0:
        return (0.5, 0.3, 0.2)
    return (key_w / total, bpm_w / total, energy_w / total)


def _pct_bpm_diff(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    avg = (a + b) / 2.0
    if avg <= 0:
        return None
    return abs(a - b) / avg * 100.0


def _is_transition_allowed(
    a: _TrackLikePlaylist,
    b: _TrackLikePlaylist,
    *,
    bpm_tolerance: float,
) -> bool:
    """Hard-gate unusable transitions for path search."""
    key_a = a.get("key_camelot")
    key_b = b.get("key_camelot")
    if key_a and key_b:
        category = _transition_category(key_a, key_b)
        if category == "unscored":
            return False

    # Allow modestly above bpm_tolerance to prevent over-fragmenting the graph.
    max_jump_pct = max(6.0, bpm_tolerance * 1.2)
    bpm_diff = _pct_bpm_diff(a.get("bpm"), b.get("bpm"))
    if bpm_diff is not None and bpm_diff > max_jump_pct:
        return False

    return True


def _transition_cost_profiled(
    a: _TrackLikePlaylist,
    b: _TrackLikePlaylist,
    edge_types: set[str],
    *,
    edge_weights: dict[str, float] | None,
    bpm_tolerance: float,
    profile: HarmonizeProfile,
) -> float:
    """Blend graph evidence with harmonizer transition theory."""
    key_w, bpm_w, energy_w = _normalize_weights(edge_weights)

    evidence_cost = _edge_weight_multi(
        a,
        b,
        edge_types if edge_types else {"key", "bpm", "energy"},
        key_weight=key_w,
        bpm_weight=bpm_w,
        energy_weight=energy_w,
    )

    key_a = a.get("key_camelot")
    key_b = b.get("key_camelot")
    if key_a and key_b:
        category = _transition_category(key_a, key_b)
        key_cost = _profile_transition_cost(category, profile)
    else:
        key_cost = 0.6

    bpm_cost = _bpm_distance(a.get("bpm"), b.get("bpm"), tolerance=bpm_tolerance)

    energy_a = a.get("energy")
    energy_b = b.get("energy")
    if energy_a is not None and energy_b is not None:
        energy_cost = min(1.0, abs(energy_a - energy_b) * 0.2)
    else:
        energy_cost = 0.5

    theory_cost = key_w * key_cost + bpm_w * bpm_cost + energy_w * energy_cost

    return 0.35 * evidence_cost + 0.65 * theory_cost


def find_path(
    start_id: int,
    end_id: int,
    all_tracks: dict[int, _TrackLikePlaylist],
    edges: list[GraphEdge],
    max_length: int | None = None,
    edge_weights: dict[str, float] | None = None,
    bpm_tolerance: float = 5.0,
    profile: HarmonizeProfile = "cruise",
) -> list[int] | None:
    """Find path from start_id to end_id using weighted Dijkstra.
    
    Parameters
    ----------
    start_id
        Track ID to start from
    end_id
        Track ID to end at
    all_tracks
        Dict mapping track_id -> track attributes
    edges
        List of graph edges to consider
    max_length
        If provided, limit path to this many tracks (approximate)
    edge_weights
        Dict with keys "key", "bpm", "energy" mapping to weight values.
        Defaults to equal weights.
    
    Returns
    -------
    List of track IDs forming a path, or None if no path exists.
    """
    if start_id not in all_tracks or end_id not in all_tracks:
        return None
    
    if edge_weights is None:
        edge_weights = {"key": 0.5, "bpm": 0.3, "energy": 0.2}
    
    # Build adjacency from edges
    adj: dict[int, list[tuple[int, float]]] = defaultdict(list)
    edge_types: dict[tuple[int, int], set[str]] = defaultdict(set)
    
    for edge in edges:
        edge_types[(edge.source, edge.target)].add(edge.type)
        edge_types[(edge.target, edge.source)].add(edge.type)
    
    for src, tgt in edge_types.keys():
        src_track = all_tracks.get(src)
        tgt_track = all_tracks.get(tgt)
        if src_track and tgt_track:
            if not _is_transition_allowed(
                src_track,
                tgt_track,
                bpm_tolerance=bpm_tolerance,
            ):
                continue
            edge_type_set = edge_types[(src, tgt)]
            cost = _transition_cost_profiled(
                src_track, tgt_track,
                edge_type_set,
                edge_weights=edge_weights,
                bpm_tolerance=bpm_tolerance,
                profile=profile,
            )
            adj[src].append((tgt, cost))
    
    # Dijkstra with path reconstruction
    dist = {start_id: 0.0}
    parent: dict[int, int | None] = {start_id: None}
    hops = {start_id: 1}
    pq = [(0.0, start_id)]
    
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float("inf")):
            continue
        if u == end_id:
            # Reconstruct path
            path = []
            curr = end_id
            while curr is not None:
                path.append(curr)
                curr = parent.get(curr)
            return path[::-1]
        
        for v, cost in adj[u]:
            if max_length is not None and max_length > 0 and hops.get(u, 1) >= max_length:
                continue
            new_dist = d + cost
            if new_dist < dist.get(v, float("inf")):
                dist[v] = new_dist
                parent[v] = u
                hops[v] = hops.get(u, 1) + 1
                heapq.heappush(pq, (new_dist, v))
    
    return None


# ---------------------------------------------------------------------------
# Greedy Playlist Ordering
# ---------------------------------------------------------------------------

def order_tracks_greedy(
    track_ids: list[int],
    all_tracks: dict[int, _TrackLikePlaylist],
    edges: list[GraphEdge],
    start_id: int | None = None,
    edge_weights: dict[str, float] | None = None,
) -> list[int]:
    """Order a set of tracks using greedy nearest-neighbor from a starting point.
    
    Selects the next unvisited track with the best weighted edge to the current track.
    
    Parameters
    ----------
    track_ids
        Track IDs to order
    all_tracks
        Dict mapping track_id -> track attributes
    edges
        List of graph edges
    start_id
        Which track to start from (defaults to first in list)
    edge_weights
        Dict with "key", "bpm", "energy" weights
    
    Returns
    -------
    Ordered list of track_ids
    """
    if not track_ids:
        return []
    
    if edge_weights is None:
        edge_weights = {"key": 0.5, "bpm": 0.3, "energy": 0.2}
    
    # Build adjacency
    edge_types: dict[tuple[int, int], set[str]] = defaultdict(set)
    for edge in edges:
        edge_types[(edge.source, edge.target)].add(edge.type)
        edge_types[(edge.target, edge.source)].add(edge.type)
    
    # Start from given id or first track
    remaining = set(track_ids)
    if start_id is None:
        start_id = track_ids[0]
    elif start_id not in remaining:
        start_id = track_ids[0]
    
    ordered = [start_id]
    remaining.discard(start_id)
    
    # Greedy: pick nearest neighbor at each step
    while remaining:
        current = ordered[-1]
        current_track = all_tracks.get(current)
        if current_track is None:
            # Can't continue intelligently, just append remaining
            ordered.extend(sorted(remaining))
            break
        
        best_next = None
        best_cost = float("inf")
        
        for candidate in remaining:
            candidate_track = all_tracks.get(candidate)
            if candidate_track is None:
                continue
            
            edge_type_set = edge_types.get((current, candidate), set())
            cost = _edge_weight_multi(
                current_track, candidate_track,
                edge_type_set if edge_type_set else {"key", "bpm", "energy"},
                key_weight=edge_weights.get("key", 0.5),
                bpm_weight=edge_weights.get("bpm", 0.3),
                energy_weight=edge_weights.get("energy", 0.2),
            )
            
            if cost < best_cost:
                best_cost = cost
                best_next = candidate
        
        if best_next is not None:
            ordered.append(best_next)
            remaining.discard(best_next)
        else:
            # No edges found, just take any remaining
            ordered.append(remaining.pop())
    
    return ordered


# ---------------------------------------------------------------------------
# Camelot helpers (duplicated for self-containment)
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


def _is_camelot_adjacent(a: str | None, b: str | None) -> bool:
    """True if keys are same or one step apart on Camelot wheel."""
    pa = _parse_camelot(a)
    pb = _parse_camelot(b)
    if pa is None or pb is None:
        return False
    na, ma = pa
    nb, mb = pb
    if na == nb and ma == mb:
        return True
    if na == nb and ma != mb:
        return True
    if ma == mb and (abs(na - nb) == 1 or abs(na - nb) == 11):
        return True
    return False
