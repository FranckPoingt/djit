from __future__ import annotations

import asyncio
import time
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import AnalysisBatch, Base, Track
from djit.database import session as database_session
from djit.database.session import get_db
from djit.main import create_app
from djit.routers.analysis import (
    _process_analysis,
    _refresh_batch,
    set_analysis_session_factory,
    stream_analysis_events,
)
from djit.schemas.analysis import AnalysisEvent
from djit.worker.queue import clear_queue, enqueue_many, get_analysis_queue


def test_review_analysis_jumps_ahead_of_background_work():
    async def exercise_queue():
        await clear_queue()
        await enqueue_many(1, [10, 11], "fast", "background")
        await enqueue_many(1, [99], "fast", "review")
        queue = get_analysis_queue()
        return [(await queue.get())[3] for _ in range(3)]

    assert asyncio.run(exercise_queue()) == [99, 10, 11]


def test_analysis_event_stream_bypasses_gzip_buffering():
    response = asyncio.run(stream_analysis_events())

    assert response.headers["content-encoding"] == "identity"


def _make_client(db_path: Path) -> TestClient:
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
    set_analysis_session_factory(testing_session_local)
    return TestClient(app)


def _seed_track(db_path: Path) -> int:
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_local()
    try:
        track = Track(path="/tmp/demo.mp3", title="Demo", artist="Tester")
        db.add(track)
        db.commit()
        db.refresh(track)
        return track.id
    finally:
        db.close()


def _seed_track_with_values(
    db_path: Path,
    *,
    path: str,
    duration_seconds: float | None = None,
) -> int:
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_local()
    try:
        track = Track(
            path=path,
            title="Demo",
            artist="Tester",
            duration_seconds=duration_seconds,
        )
        db.add(track)
        db.commit()
        db.refresh(track)
        return track.id
    finally:
        db.close()


def test_analysis_queue_updates_track_state(tmp_path):
    db_path = tmp_path / "analysis.db"
    client = _make_client(db_path)
    track_id = _seed_track(db_path)

    enqueue_response = client.post("/api/v1/analysis/queue", json={"track_ids": [track_id]})
    assert enqueue_response.status_code == 200
    assert enqueue_response.json() == {
        "batch_id": 1,
        "requested": 1,
        "queued": 1,
        "skipped": 0,
        "queued_track_ids": [track_id],
        "skipped_track_ids": [],
    }

    deadline = time.time() + 2
    payload = None
    while time.time() < deadline:
        track_response = client.get(f"/api/v1/tracks/{track_id}")
        assert track_response.status_code == 200
        payload = track_response.json()
        if payload["analysis_status"] in {"done", "failed"}:
            break
        time.sleep(0.05)

    assert payload is not None
    # For non-existent file path, analysis should fail gracefully.
    assert payload["analysis_status"] == "failed"
    assert payload["bpm"] is None
    assert payload["key_camelot"] == "0A"

    batch_response = client.get("/api/v1/analysis/batch")
    assert batch_response.status_code == 200
    batch = batch_response.json()
    assert batch["status"] == "completed"
    assert batch["total"] == 1
    assert batch["completed"] == 1
    assert batch["failed"] == 1


def test_analysis_queue_skips_tracks_longer_than_twelve_minutes(tmp_path, monkeypatch):
    db_path = tmp_path / "analysis_skip.db"
    client = _make_client(db_path)
    audio_file = tmp_path / "long_mix.mp3"
    audio_file.write_bytes(b"fake-audio-bytes")
    track_id = _seed_track_with_values(
        db_path,
        path=str(audio_file),
        duration_seconds=721,
    )

    def _unexpected_analyze(*_args, **_kwargs):
        raise AssertionError("analyze_track_path should not run for long tracks")

    monkeypatch.setattr("djit.routers.analysis.analyze_track_path", _unexpected_analyze)

    enqueue_response = client.post("/api/v1/analysis/queue", json={"track_ids": [track_id]})
    assert enqueue_response.status_code == 200
    assert enqueue_response.json() == {
        "batch_id": 1,
        "requested": 1,
        "queued": 0,
        "skipped": 1,
        "queued_track_ids": [],
        "skipped_track_ids": [track_id],
    }

    track_response = client.get(f"/api/v1/tracks/{track_id}")
    assert track_response.status_code == 200
    payload = track_response.json()
    assert payload["analysis_status"] == "skipped"
    assert payload["bpm"] is None
    assert payload["key_camelot"] is None

    batch = client.get("/api/v1/analysis/batch").json()
    assert batch["status"] == "completed"
    assert batch["skipped"] == 1


def test_folder_analysis_defaults_to_kept_and_shortlisted_tracks(tmp_path):
    db_path = tmp_path / "folder_analysis.db"
    client = _make_client(db_path)
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_local()
    try:
        db.add_all(
            [
                Track(
                    path="/music/House/keep.mp3",
                    title="Keep",
                    triage_decision="keep",
                ),
                Track(
                    path="/music/House/maybe.mp3",
                    title="Maybe",
                    triage_decision="maybe",
                ),
                Track(
                    path="/music/House/unheard.mp3",
                    title="Unheard",
                    triage_decision="unheard",
                ),
                Track(
                    path="/music/Techno/keep.mp3",
                    title="Elsewhere",
                    triage_decision="keep",
                ),
            ]
        )
        db.commit()
    finally:
        db.close()

    response = client.post(
        "/api/v1/analysis/queue/folder",
        json={"folder_path": "/music/House"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["requested"] == 2
    assert payload["queued"] == 2


def test_paused_batch_completes_when_current_track_finishes(tmp_path):
    db_path = tmp_path / "paused_analysis.db"
    _make_client(db_path)
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_local()
    try:
        track = Track(path="/tmp/paused.mp3", analysis_status="done")
        db.add(track)
        db.flush()
        batch = AnalysisBatch(
            mode="fast",
            scope="selected",
            status="paused",
            track_ids_json=f"[{track.id}]",
            total=1,
            current_track_id=track.id,
        )
        db.add(batch)
        db.commit()
        batch_id = batch.id

        _refresh_batch(db, batch_id, clear_current=True)
        db.refresh(batch)

        assert batch.status == "completed"
        assert batch.current_track_id is None
        assert batch.completed == 1
    finally:
        db.close()


def test_analyze_all_queues_every_eligible_track(tmp_path):
    db_path = tmp_path / "analysis_all.db"
    client = _make_client(db_path)
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    with session_local() as db:
        db.add_all(
            [
                Track(path="/tmp/one.mp3"),
                Track(path="/tmp/two.mp3", analysis_status="failed"),
                Track(path="/tmp/done.mp3", analysis_status="done"),
            ]
        )
        db.commit()

    response = client.post("/api/v1/analysis/queue/all", json={"mode": "fast"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["requested"] == 2
    assert payload["queued"] == 2


def test_analyze_all_requeues_legacy_auto_character_estimates(tmp_path):
    db_path = tmp_path / "analysis_upgrade.db"
    client = _make_client(db_path)
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    with session_local() as db:
        db.add_all(
            [
                Track(
                    path="/tmp/legacy.mp3",
                    analysis_status="done",
                    mood="Hypnotic",
                    energy=6,
                ),
                Track(
                    path="/tmp/manual.mp3",
                    analysis_status="overridden",
                    mood="Hypnotic",
                    energy=9,
                ),
                Track(
                    path="/tmp/current.mp3",
                    analysis_status="done",
                    mood=None,
                    energy=7,
                ),
                Track(path="/tmp/new.mp3", analysis_status="not_analyzed"),
            ]
        )
        db.commit()

    response = client.post("/api/v1/analysis/queue/background", json={"mode": "fast"})

    assert response.status_code == 200
    assert response.json()["requested"] == 2
    assert response.json()["queued"] == 2


def test_background_retries_once_and_excludes_repeated_failures(tmp_path):
    db_path = tmp_path / "analysis_retries.db"
    client = _make_client(db_path)
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    with session_local() as db:
        retry = Track(
            path="/tmp/retry.mp3",
            analysis_status="failed",
            analysis_failures=1,
        )
        quarantined = Track(
            path="/tmp/quarantined.mp3",
            analysis_status="failed",
            analysis_failures=2,
        )
        db.add_all([retry, quarantined])
        db.commit()
        retry_id = retry.id

    response = client.post("/api/v1/analysis/queue/background", json={"mode": "fast"})

    assert response.status_code == 200
    assert response.json()["queued_track_ids"] == [retry_id]


def test_runtime_schema_marks_historical_failures_for_one_retry(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}", future=True)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE tracks ("
            "id INTEGER PRIMARY KEY, path TEXT, analysis_status TEXT)"
        )
        connection.exec_driver_sql(
            "INSERT INTO tracks (path, analysis_status) VALUES "
            "('/tmp/done.mp3', 'done'), ('/tmp/failed.mp3', 'failed')"
        )

    monkeypatch.setattr(database_session, "engine", engine)
    database_session.ensure_runtime_schema()

    with engine.connect() as connection:
        rows = connection.exec_driver_sql(
            "SELECT analysis_status, analysis_failures FROM tracks ORDER BY id"
        ).all()
    assert rows == [("done", 0), ("failed", 1)]


def test_bad_track_does_not_fail_healthy_batch_sibling(tmp_path, monkeypatch):
    db_path = tmp_path / "analysis_isolation.db"
    _make_client(db_path)
    engine = create_engine(f"sqlite:///{db_path}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    bad_file = tmp_path / "bad.mp3"
    good_file = tmp_path / "good.mp3"
    bad_file.write_bytes(b"bad")
    good_file.write_bytes(b"good")
    with session_local() as db:
        bad = Track(path=str(bad_file), analysis_status="pending")
        good = Track(path=str(good_file), analysis_status="pending")
        db.add_all([bad, good])
        db.flush()
        batch = AnalysisBatch(
            mode="fast",
            scope="all",
            status="queued",
            track_ids_json=f"[{bad.id}, {good.id}]",
            total=2,
        )
        db.add(batch)
        db.commit()
        bad_id, good_id, batch_id = bad.id, good.id, batch.id

    def fake_analysis(track_id, _path, _mode):
        return AnalysisEvent(
            track_id=track_id,
            status="failed" if track_id == bad_id else "done",
            bpm=None if track_id == bad_id else 120,
            key_camelot="0A" if track_id == bad_id else "8A",
        )

    monkeypatch.setattr("djit.routers.analysis.ANALYSIS_EXECUTOR", "thread")
    monkeypatch.setattr("djit.routers.analysis.analyze_track_path", fake_analysis)
    asyncio.run(_process_analysis(batch_id, bad_id, "fast"))
    asyncio.run(_process_analysis(batch_id, good_id, "fast"))

    with session_local() as db:
        bad = db.get(Track, bad_id)
        good = db.get(Track, good_id)
        batch = db.get(AnalysisBatch, batch_id)
        assert bad.analysis_status == "failed"
        assert bad.analysis_failures == 1
        assert good.analysis_status == "done"
        assert good.analysis_failures == 0
        assert batch.status == "completed"
        assert batch.failed == 1
