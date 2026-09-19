from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import Base, Playlist, PlaylistTrack, Track
from djit.database.session import get_db
from djit.main import create_app


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


def test_duplicates_group_and_resolve_flow(tmp_path):
    client, session_local = _make_client(tmp_path / "duplicates.db")

    db = session_local()
    try:
        keep = Track(path="/tmp/keep.mp3", file_hash="hash-1", title="Keep", artist="Artist")
        dup = Track(path="/tmp/dup.mp3", file_hash="hash-1", title="Dup", artist="Artist")
        unique = Track(path="/tmp/unique.mp3", file_hash="hash-2", title="Unique", artist="Artist")
        playlist = Playlist(name="Set")
        dup.triage_decision = "keep"
        keep.genre = None
        dup.genre = "House"
        db.add_all([keep, dup, unique, playlist])
        db.commit()
        db.refresh(keep)
        db.refresh(dup)
        db.refresh(playlist)
        db.add(PlaylistTrack(playlist_id=playlist.id, track_id=dup.id, position=1))
        db.commit()
        keep_id = keep.id
        dup_id = dup.id
    finally:
        db.close()

    groups_response = client.get("/api/v1/duplicates/groups")
    assert groups_response.status_code == 200
    groups = groups_response.json()
    assert len(groups) == 1
    assert groups[0]["file_hash"] == "hash-1"
    assert len(groups[0]["tracks"]) == 2

    resolve_response = client.post(
        "/api/v1/duplicates/resolve",
        json={"keep_track_id": keep_id, "remove_track_ids": [dup_id]},
    )
    assert resolve_response.status_code == 200
    assert resolve_response.json() == {"deleted": 1, "kept_track_id": keep_id}

    with session_local() as db:
        merged = db.query(Track).filter(Track.id == keep_id).one()
        assert merged.genre == "House"
        assert merged.triage_decision == "keep"
        assert db.query(PlaylistTrack).filter(PlaylistTrack.track_id == keep_id).count() == 1

    groups_after = client.get("/api/v1/duplicates/groups")
    assert groups_after.status_code == 200
    assert groups_after.json() == []
