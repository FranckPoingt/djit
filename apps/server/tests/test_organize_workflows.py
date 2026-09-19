from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import Base, Track
from djit.database.session import get_db
from djit.main import create_app


def _make_client(db_path: Path) -> tuple[TestClient, sessionmaker]:
    app = create_app()
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db: Session = session_local()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app), session_local


def test_live_view_uses_full_library_and_freezes_playlist(tmp_path):
    client, session_local = _make_client(tmp_path / "live.db")
    with session_local() as db:
        db.add_all(
            Track(
                path=f"/tmp/{index}.mp3",
                title=f"Track {index}",
                artist="Artist",
                triage_decision="keep" if index < 250 else "reject",
            )
            for index in range(300)
        )
        db.commit()

    response = client.post(
        "/api/v1/saved-views",
        json={
            "name": "Curated",
            "state": {"triage_decision": ["keep"], "sort_by": "title"},
        },
    )
    assert response.status_code == 201
    view = response.json()
    assert view["track_count"] == 250

    filtered = client.get("/api/v1/tracks?triage_decision=keep&limit=200")
    assert filtered.status_code == 200
    assert filtered.json()["total"] == 250

    frozen = client.post(f"/api/v1/saved-views/{view['id']}/freeze", json={})
    assert frozen.status_code == 200
    assert frozen.json()["track_count"] == 250


def test_cleanup_preview_apply_and_safe_undo(tmp_path):
    client, session_local = _make_client(tmp_path / "cleanup.db")
    with session_local() as db:
        db.add(
            Track(
                path="/tmp/numbered.mp3",
                title="01. Artist - Track",
                artist="Unknown",
                triage_decision="maybe",
            )
        )
        db.commit()

    request = {"recipe": "remove_number_prefix", "scope": "keep_maybe"}
    preview = client.post("/api/v1/library/cleanup/preview", json=request)
    assert preview.status_code == 200
    assert preview.json()["changes"][0]["after"]["title"] == "Artist - Track"

    applied = client.post("/api/v1/library/cleanup/apply", json=request)
    assert applied.status_code == 200
    batch_id = applied.json()["batch_id"]
    assert applied.json()["updated"] == 1

    undone = client.post(f"/api/v1/library/cleanup/{batch_id}/undo")
    assert undone.status_code == 200
    assert undone.json()["restored"] == 1
    with session_local() as db:
        assert db.query(Track).one().title == "01. Artist - Track"


def test_health_and_mix_suggestions(tmp_path):
    client, session_local = _make_client(tmp_path / "health.db")
    audio = tmp_path / "seed.mp3"
    audio.write_bytes(b"audio")
    with session_local() as db:
        db.add_all(
            [
                Track(path=str(audio), title="Seed", artist="DJ", genre="House", bpm=124, key_camelot="8A", energy=5, triage_decision="keep"),
                Track(path=str(tmp_path / "missing.mp3"), title="Match", artist="DJ", bpm=125, key_camelot="8A", energy=5, triage_decision="maybe"),
                Track(path=str(tmp_path / "far.mp3"), title="Far", artist="DJ", bpm=170, key_camelot="2B", energy=10, triage_decision="keep"),
            ]
        )
        db.commit()
        seed_id = db.query(Track).filter(Track.title == "Seed").one().id

    health = client.get("/api/v1/library/health")
    assert health.status_code == 200
    assert health.json()["missing_files"] == 2

    suggestions = client.get(f"/api/v1/tracks/{seed_id}/mix-suggestions")
    assert suggestions.status_code == 200
    assert suggestions.json()[0]["track"]["title"] == "Match"
