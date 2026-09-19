"""Tests for playlist harmonize endpoint and harmonizer algorithm."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import Base, Playlist, PlaylistTrack, Track
from djit.database.session import get_db
from djit.main import create_app
from djit.services.harmonizer import (
    HarmonizeRequest,
    _transition_category,
    build_harmonize_diagnostics,
    _harmonic_distance,
    harmonize,
)


# ---------------------------------------------------------------------------
# Unit tests for the harmonizer algorithm
# ---------------------------------------------------------------------------

def test_harmonic_distance_same():
    assert _harmonic_distance("4A", "4A") == 0


def test_harmonic_distance_relative():
    assert _harmonic_distance("4A", "4B") == 1


def test_harmonic_distance_adjacent_same_mode():
    assert _harmonic_distance("4A", "5A") == 1
    assert _harmonic_distance("4A", "3A") == 1


def test_harmonic_distance_wraparound():
    assert _harmonic_distance("12A", "1A") == 1


def test_harmonic_distance_unknown():
    assert _harmonic_distance(None, "4A") == 3
    assert _harmonic_distance("4A", None) == 3
    assert _harmonic_distance(None, None) == 3


def test_transition_category_labels():
    assert _transition_category("4A", "4A") == "perfect_match"
    assert _transition_category("4A", "4B") == "mood_change"
    assert _transition_category("4A", "5A") == "energy_boost_plus"
    assert _transition_category("4A", "6A") == "energy_boost_plus_plus"
    assert _transition_category("4A", "7A") == "energy_boost_plus_plus_plus"
    assert _transition_category("4A", "3A") == "energy_drop_minus"
    assert _transition_category("4A", "2A") == "energy_drop_minus_minus"
    assert _transition_category("4A", "1A") == "energy_drop_minus_minus_minus"
    assert _transition_category("4A", "9A") == "unscored"


def test_harmonize_single():
    """Single track returns unchanged."""
    req = HarmonizeRequest(track_ids=[1], bpms=[120.0], keys=["4A"])
    assert harmonize(req) == [1]


def test_harmonize_preserves_all_ids():
    """All original track IDs must appear exactly once."""
    ids = [10, 20, 30, 40, 50]
    bpms = [128.0, 126.0, 130.0, 120.0, 124.0]
    keys = ["8B", "8A", "9B", "7A", "8B"]
    req = HarmonizeRequest(track_ids=ids, bpms=bpms, keys=keys)
    result = harmonize(req)
    assert sorted(result) == sorted(ids)
    assert len(result) == len(ids)


def test_harmonize_lock_first():
    ids = [10, 20, 30]
    bpms = [128.0, 130.0, 120.0]
    keys = ["8B", "8A", "4A"]
    req = HarmonizeRequest(track_ids=ids, bpms=bpms, keys=keys, lock_first=True)
    result = harmonize(req)
    assert result[0] == 10


def test_harmonize_lock_last():
    ids = [10, 20, 30]
    bpms = [128.0, 130.0, 120.0]
    keys = ["8B", "8A", "4A"]
    req = HarmonizeRequest(track_ids=ids, bpms=bpms, keys=keys, lock_last=True)
    result = harmonize(req)
    assert result[-1] == 30


def test_harmonize_lock_both():
    ids = [10, 20, 30, 40]
    bpms = [128.0, 130.0, 120.0, 126.0]
    keys = ["8B", "8A", "4A", "7B"]
    req = HarmonizeRequest(
        track_ids=ids, bpms=bpms, keys=keys, lock_first=True, lock_last=True
    )
    result = harmonize(req)
    assert result[0] == 10
    assert result[-1] == 40
    assert sorted(result) == sorted(ids)


def test_harmonize_key_heavy_prefers_adjacent_keys():
    """With bpm_weight=0, algorithm should prefer harmonically adjacent keys."""
    # Keys 4A->5A->6A are all distance 1 from each other and should be sorted together
    ids = [1, 2, 3, 4]
    bpms = [128.0] * 4
    keys = ["4A", "6A", "5A", "2A"]  # 4A and 5A are closer to each other
    req = HarmonizeRequest(
        track_ids=ids,
        bpms=bpms,
        keys=keys,
        bpm_weight=0.0,
    )
    result = harmonize(req)
    # 4A and 5A should be adjacent in result
    pos_4a = result.index(1)  # id=1 has key 4A
    pos_5a = result.index(3)  # id=3 has key 5A
    assert abs(pos_4a - pos_5a) == 1


def test_harmonize_profile_changes_ordering_bias():
    ids = [1, 2, 3]
    bpms = [128.0, 128.0, 128.0]
    keys = ["4A", "5A", "3A"]
    build_up = harmonize(
        HarmonizeRequest(
            track_ids=ids,
            bpms=bpms,
            keys=keys,
            lock_first=True,
            profile="build_up",
            bpm_weight=0.0,
        )
    )
    cooldown = harmonize(
        HarmonizeRequest(
            track_ids=ids,
            bpms=bpms,
            keys=keys,
            lock_first=True,
            profile="cooldown",
            bpm_weight=0.0,
        )
    )
    # Build-up should pick + first; cooldown should pick - first.
    assert build_up[1] == 2
    assert cooldown[1] == 3


def test_build_harmonize_diagnostics_metrics():
    diagnostics = build_harmonize_diagnostics(
        track_ids=[1, 2, 3],
        key_by_track_id={1: "4A", 2: "5A", 3: "6A"},
    )
    assert diagnostics.compatibility_score > 0
    assert diagnostics.risky_jumps == 0
    assert diagnostics.energy_trend == "rising"
    assert len(diagnostics.transitions) == 2


# ---------------------------------------------------------------------------
# Integration test: endpoint
# ---------------------------------------------------------------------------

def _make_client(db_path: Path) -> tuple[TestClient, sessionmaker]:
    app = create_app()
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    testing_session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db: Session = testing_session_local()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app), testing_session_local


def test_harmonize_endpoint(tmp_path):
    client, session_local = _make_client(tmp_path / "harm.db")

    db = session_local()
    try:
        tracks = [
            Track(path=f"/tmp/t{i}.mp3", title=f"T{i}", artist="A", bpm=b, key_camelot=k)
            for i, (b, k) in enumerate(
                [(128, "8B"), (126, "8A"), (130, "9B"), (120, "7A")], start=1
            )
        ]
        db.add_all(tracks)
        db.commit()
        for t in tracks:
            db.refresh(t)
        playlist = Playlist(name="Harm")
        db.add(playlist)
        db.commit()
        db.refresh(playlist)
        for pos, track in enumerate(tracks, start=1):
            db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=pos))
        db.commit()
        playlist_id = playlist.id
        original_ids = [t.id for t in tracks]
    finally:
        db.close()

    resp = client.post(
        f"/api/v1/playlists/{playlist_id}/harmonize",
        json={"lock_first": False, "lock_last": False, "bpm_weight": 0.5, "bpm_tolerance": 4.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["applied"] is True
    assert sorted(data["track_ids"]) == sorted(original_ids)
    assert len(data["track_ids"]) == 4
    assert "diagnostics" in data
    assert isinstance(data["diagnostics"]["transitions"], list)

    # Verify DB order was persisted
    detail = client.get(f"/api/v1/playlists/{playlist_id}").json()
    assert [t["id"] for t in detail["tracks"]] == data["track_ids"]


def test_harmonize_endpoint_lock_first(tmp_path):
    client, session_local = _make_client(tmp_path / "harm_lock.db")

    db = session_local()
    try:
        tracks = [
            Track(path=f"/tmp/lk{i}.mp3", title=f"LK{i}", artist="A", bpm=128.0, key_camelot=k)
            for i, k in enumerate(["2A", "8B", "6A", "4B"], start=1)
        ]
        db.add_all(tracks)
        db.commit()
        for t in tracks:
            db.refresh(t)
        playlist = Playlist(name="Lock")
        db.add(playlist)
        db.commit()
        db.refresh(playlist)
        for pos, track in enumerate(tracks, start=1):
            db.add(PlaylistTrack(playlist_id=playlist.id, track_id=track.id, position=pos))
        db.commit()
        playlist_id = playlist.id
        first_id = tracks[0].id
    finally:
        db.close()

    resp = client.post(
        f"/api/v1/playlists/{playlist_id}/harmonize",
        json={"lock_first": True, "bpm_weight": 0.3},
    )
    assert resp.status_code == 200
    assert resp.json()["track_ids"][0] == first_id
