from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import Base, Track
from djit.database.session import get_db
from djit.main import create_app
from djit.routers import audio as audio_router


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


def test_audio_stream_supports_range_requests(tmp_path):
    client, session_local = _make_client(tmp_path / "audio.db")

    audio_path = tmp_path / "clip.mp3"
    audio_bytes = b"abcdefghijklmnop"
    audio_path.write_bytes(audio_bytes)

    db = session_local()
    try:
        track = Track(path=str(audio_path), title="Clip", artist="Tester")
        db.add(track)
        db.commit()
        db.refresh(track)
        track_id = track.id
    finally:
        db.close()

    full_response = client.get(f"/api/v1/audio/{track_id}/stream")
    assert full_response.status_code == 200
    assert full_response.content == audio_bytes
    assert full_response.headers["accept-ranges"] == "bytes"

    partial_response = client.get(
        f"/api/v1/audio/{track_id}/stream",
        headers={"Range": "bytes=4-7"},
    )
    assert partial_response.status_code == 206
    assert partial_response.content == audio_bytes[4:8]
    assert partial_response.headers["content-range"] == f"bytes 4-7/{len(audio_bytes)}"
    assert partial_response.headers["accept-ranges"] == "bytes"


def test_audio_stream_missing_file_returns_404(tmp_path):
    client, session_local = _make_client(tmp_path / "audio_missing.db")

    db = session_local()
    try:
        track = Track(path=str(tmp_path / "missing.mp3"), title="Missing", artist="Tester")
        db.add(track)
        db.commit()
        db.refresh(track)
        track_id = track.id
    finally:
        db.close()

    response = client.get(f"/api/v1/audio/{track_id}/stream")
    assert response.status_code == 404


def test_audio_waveform_returns_values(tmp_path, monkeypatch):
    client, session_local = _make_client(tmp_path / "audio_waveform.db")

    audio_path = tmp_path / "clip.mp3"
    audio_path.write_bytes(b"fake-audio-bytes")

    db = session_local()
    try:
        track = Track(
            path=str(audio_path),
            title="Clip",
            artist="Tester",
            duration_seconds=93.0,
        )
        db.add(track)
        db.commit()
        db.refresh(track)
        track_id = track.id
    finally:
        db.close()

    def fake_waveform(*_args: Any, **_kwargs: Any) -> list[float]:
        return [0.1, 0.2, 0.5, 1.0]

    monkeypatch.setattr(audio_router, "_compute_waveform_cached", fake_waveform)

    response = client.get(f"/api/v1/audio/{track_id}/waveform?points=4")
    assert response.status_code == 400

    response = client.get(f"/api/v1/audio/{track_id}/waveform?points=16")
    assert response.status_code == 200
    payload = response.json()
    assert payload["track_id"] == track_id
    assert payload["points"] == [0.1, 0.2, 0.5, 1.0]
    assert payload["duration_seconds"] == 93.0
    assert response.headers["cache-control"] == "private, max-age=86400"

    db = session_local()
    try:
        assert db.get(Track, track_id).waveform_data is not None
    finally:
        db.close()


def test_audio_cover_not_found_returns_404(tmp_path):
    client, session_local = _make_client(tmp_path / "audio_cover.db")

    audio_path = tmp_path / "clip.mp3"
    audio_path.write_bytes(b"fake-audio-without-cover")

    db = session_local()
    try:
        track = Track(path=str(audio_path), title="Clip", artist="Tester")
        db.add(track)
        db.commit()
        db.refresh(track)
        track_id = track.id
    finally:
        db.close()

    response = client.get(f"/api/v1/audio/{track_id}/cover")
    assert response.status_code == 404


def test_audio_cover_persists_without_source_drive(tmp_path, monkeypatch):
    client, session_local = _make_client(tmp_path / "audio_cover_cache.db")
    audio_path = tmp_path / "clip.mp3"
    audio_path.write_bytes(b"audio")
    monkeypatch.setattr(audio_router, "COVER_CACHE_DIR", tmp_path / "covers")
    monkeypatch.setattr(
        audio_router,
        "_extract_cover_art",
        lambda _path: (b"\xff\xd8\xffcover", "image/jpeg"),
    )

    with session_local() as db:
        track = Track(
            path=str(audio_path),
            file_hash="a" * 64,
            title="Clip",
            artist="Tester",
        )
        db.add(track)
        db.commit()
        db.refresh(track)
        track_id = track.id

    first = client.get(f"/api/v1/audio/{track_id}/cover")
    assert first.status_code == 200
    audio_path.unlink()
    monkeypatch.setattr(
        audio_router,
        "_extract_cover_art",
        lambda _path: (_ for _ in ()).throw(AssertionError("source should not be read")),
    )

    cached = client.get(f"/api/v1/audio/{track_id}/cover")
    assert cached.status_code == 200
    assert cached.content == first.content
    assert cached.headers["cache-control"] == "private, max-age=86400"
