"""Unit tests for the graph_builder service.

These tests exercise pure computation — no database or HTTP involved.
"""
from __future__ import annotations

from djit.services.graph_builder import (
    _camelot_adjacent,
    _camelot_weight,
    _artist_edge,
    _bpm_edge,
    _energy_edge,
    _genre_edge,
    _key_edge,
    _mood_edge,
    build_graph,
)


# ---------------------------------------------------------------------------
# Camelot helpers
# ---------------------------------------------------------------------------

def test_camelot_adjacent_same():
    assert _camelot_adjacent("4A", "4A") is True


def test_camelot_adjacent_relative():
    assert _camelot_adjacent("4A", "4B") is True
    assert _camelot_adjacent("4B", "4A") is True


def test_camelot_adjacent_plus_one():
    assert _camelot_adjacent("4A", "5A") is True
    assert _camelot_adjacent("4A", "3A") is True


def test_camelot_adjacent_wraparound():
    assert _camelot_adjacent("12A", "1A") is True
    assert _camelot_adjacent("1A", "12A") is True


def test_camelot_adjacent_far():
    assert _camelot_adjacent("1A", "6A") is False


def test_camelot_adjacent_none():
    assert _camelot_adjacent(None, "4A") is False
    assert _camelot_adjacent("4A", None) is False


def test_camelot_weight_same():
    assert _camelot_weight("4A", "4A") == 1.0


def test_camelot_weight_adjacent():
    assert _camelot_weight("4A", "5A") == 0.8
    assert _camelot_weight("4A", "4B") == 0.8


# ---------------------------------------------------------------------------
# Per-type edge detectors
# ---------------------------------------------------------------------------

def _t(**kwargs):
    """Helper to build a minimal track dict."""
    base = {"id": 1, "title": "T", "artist": "A", "bpm": None,
            "key_camelot": None, "genre": None, "energy": None, "mood": None}
    base.update(kwargs)
    return base


def test_key_edge_adjacent():
    a = _t(id=1, key_camelot="4A")
    b = _t(id=2, key_camelot="5A")
    edge = _key_edge(a, b)
    assert edge is not None
    assert edge.type == "key"
    assert edge.source == 1
    assert edge.target == 2
    assert edge.weight == 0.8


def test_key_edge_same():
    a = _t(id=1, key_camelot="4A")
    b = _t(id=2, key_camelot="4A")
    edge = _key_edge(a, b)
    assert edge is not None
    assert edge.weight == 1.0


def test_key_edge_no_match():
    a = _t(id=1, key_camelot="1A")
    b = _t(id=2, key_camelot="6B")
    assert _key_edge(a, b) is None


def test_key_edge_none_key():
    a = _t(id=1, key_camelot=None)
    b = _t(id=2, key_camelot="4A")
    assert _key_edge(a, b) is None


def test_bpm_edge_within_tolerance():
    a = _t(id=1, bpm=128.0)
    b = _t(id=2, bpm=130.0)
    edge = _bpm_edge(a, b, bpm_tol_pct=5.0)
    assert edge is not None
    assert edge.type == "bpm"
    assert 0.0 <= edge.weight <= 1.0


def test_bpm_edge_outside_tolerance():
    a = _t(id=1, bpm=120.0)
    b = _t(id=2, bpm=140.0)
    assert _bpm_edge(a, b, bpm_tol_pct=5.0) is None


def test_bpm_edge_exact_match():
    a = _t(id=1, bpm=130.0)
    b = _t(id=2, bpm=130.0)
    edge = _bpm_edge(a, b, bpm_tol_pct=5.0)
    assert edge is not None
    assert edge.weight == 1.0


def test_bpm_edge_none():
    a = _t(id=1, bpm=None)
    b = _t(id=2, bpm=130.0)
    assert _bpm_edge(a, b, bpm_tol_pct=5.0) is None


def test_genre_edge_match():
    a = _t(id=1, genre="Techno")
    b = _t(id=2, genre="techno")
    edge = _genre_edge(a, b)
    assert edge is not None
    assert edge.type == "genre"
    assert edge.weight == 1.0


def test_genre_edge_no_match():
    a = _t(id=1, genre="Techno")
    b = _t(id=2, genre="House")
    assert _genre_edge(a, b) is None


def test_genre_edge_none():
    a = _t(id=1, genre=None)
    b = _t(id=2, genre="Techno")
    assert _genre_edge(a, b) is None


def test_energy_edge_equal():
    a = _t(id=1, energy=3)
    b = _t(id=2, energy=3)
    edge = _energy_edge(a, b)
    assert edge is not None
    assert edge.weight == 1.0


def test_energy_edge_adjacent():
    a = _t(id=1, energy=3)
    b = _t(id=2, energy=4)
    edge = _energy_edge(a, b)
    assert edge is not None
    assert edge.weight == 0.6


def test_energy_edge_too_far():
    a = _t(id=1, energy=1)
    b = _t(id=2, energy=5)
    assert _energy_edge(a, b) is None


def test_energy_edge_none():
    a = _t(id=1, energy=None)
    b = _t(id=2, energy=3)
    assert _energy_edge(a, b) is None


def test_mood_edge_match():
    a = _t(id=1, mood="Dark")
    b = _t(id=2, mood="dark")
    edge = _mood_edge(a, b)
    assert edge is not None
    assert edge.type == "mood"


def test_mood_edge_no_match():
    a = _t(id=1, mood="Dark")
    b = _t(id=2, mood="Happy")
    assert _mood_edge(a, b) is None


def test_artist_edge_match():
    a = _t(id=1, artist="Aphex Twin")
    b = _t(id=2, artist="aphex twin")
    edge = _artist_edge(a, b)
    assert edge is not None
    assert edge.type == "artist"


def test_artist_edge_no_match():
    a = _t(id=1, artist="Aphex Twin")
    b = _t(id=2, artist="Burial")
    assert _artist_edge(a, b) is None


# ---------------------------------------------------------------------------
# build_graph integration
# ---------------------------------------------------------------------------

def _make_tracks(n: int) -> list[dict]:
    return [
        {
            "id": i,
            "title": f"Track {i}",
            "artist": "Various",
            "bpm": 128.0 + i * 0.5,
            "key_camelot": f"{(i % 12) + 1}A",
            "genre": "Techno" if i % 2 == 0 else "House",
            "energy": (i % 5) + 1,
            "mood": "Dark" if i % 3 == 0 else "Bright",
        }
        for i in range(n)
    ]


def test_build_graph_returns_all_nodes():
    tracks = _make_tracks(5)
    result = build_graph(tracks)
    assert len(result.nodes) == 5


def test_build_graph_not_truncated_under_limit():
    tracks = _make_tracks(10)
    result = build_graph(tracks)
    assert result.truncated is False


def test_build_graph_truncated_over_limit(monkeypatch):
    import djit.services.graph_builder as gb
    monkeypatch.setattr(gb, "_MAX_NODES", 3)
    tracks = _make_tracks(5)
    result = build_graph(tracks)
    assert len(result.nodes) == 3
    assert result.truncated is True


def test_build_graph_edge_type_filter():
    tracks = [
        _t(id=1, key_camelot="4A", genre="Techno"),
        _t(id=2, key_camelot="5A", genre="House"),
    ]
    result = build_graph(tracks, types=["key"])
    assert all(e.type == "key" for e in result.edges)


def test_build_graph_no_self_edges():
    tracks = _make_tracks(4)
    result = build_graph(tracks)
    for edge in result.edges:
        assert edge.source != edge.target


def test_build_graph_empty():
    result = build_graph([])
    assert result.nodes == []
    assert result.edges == []
    assert result.truncated is False


def test_build_graph_single_track():
    tracks = _make_tracks(1)
    result = build_graph(tracks)
    assert len(result.nodes) == 1
    assert result.edges == []


def test_build_graph_bpm_tolerance():
    tracks = [
        _t(id=1, bpm=128.0),
        _t(id=2, bpm=129.0),  # within 5%
        _t(id=3, bpm=150.0),  # outside 5%
    ]
    result = build_graph(tracks, types=["bpm"], bpm_tol_pct=5.0)
    edge_pairs = {(e.source, e.target) for e in result.edges}
    assert (1, 2) in edge_pairs or (2, 1) in edge_pairs
    assert (1, 3) not in edge_pairs and (3, 1) not in edge_pairs
