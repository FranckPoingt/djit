from __future__ import annotations

from pathlib import Path
from time import sleep, time

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import Base
from djit.database.session import get_db
from djit.main import create_app
from djit.routers.library import set_library_scan_session_factory


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
    set_library_scan_session_factory(testing_session_local)
    return TestClient(app)


def _wait_for_scan_to_finish(client: TestClient, timeout_seconds: float = 3) -> dict:
    deadline = time() + timeout_seconds
    last_status = {}

    while time() < deadline:
        response = client.get("/api/v1/library/status")
        assert response.status_code == 200
        last_status = response.json()
        if last_status.get("status") != "scanning":
            return last_status
        sleep(0.05)

    return last_status


def test_import_folder_persists_and_updates_status(tmp_path, monkeypatch):
    client = _make_client(tmp_path / "test.db")

    audio_file = tmp_path / "demo.mp3"
    audio_file.write_bytes(b"fake-audio-bytes")

    monkeypatch.setattr(
        "djit.services.library_scan.extract_metadata",
        lambda _: {"title": "Demo", "artist": "Tester", "genre": "House"},
    )

    import_response = client.post(
        "/api/v1/library/import",
        params={"folder_path": str(tmp_path)},
    )
    assert import_response.status_code == 200
    assert import_response.json()["status"] == "started"

    final_status = _wait_for_scan_to_finish(client)
    assert final_status["status"] == "idle"
    assert final_status["scan_added_files"] == 1
    assert final_status["scan_processed_files"] == 1

    tracks_response = client.get("/api/v1/tracks")
    assert tracks_response.status_code == 200
    payload = tracks_response.json()
    tracks = payload["items"]
    assert payload["total"] == 1
    assert len(tracks) == 1
    assert tracks[0]["title"] == "Demo"
    assert tracks[0]["artist"] == "Tester"
    assert tracks[0]["analysis_status"] == "not_analyzed"

    status_response = client.get("/api/v1/library/status")
    assert status_response.status_code == 200
    status = status_response.json()
    assert status["total_tracks"] == 1
    assert status["pending_analysis"] == 0
    assert status["unheard"] == 1


def test_incremental_rescan_updates_changed_file(tmp_path, monkeypatch):
    client = _make_client(tmp_path / "test_rescan.db")

    audio_file = tmp_path / "demo.mp3"
    audio_file.write_bytes(b"fake-audio-bytes-v1")

    monkeypatch.setattr(
        "djit.services.library_scan.extract_metadata",
        lambda _: {"title": "First Title", "artist": "Tester", "genre": "House"},
    )

    first_import = client.post(
        "/api/v1/library/import",
        params={"folder_path": str(tmp_path)},
    )
    assert first_import.status_code == 200
    _wait_for_scan_to_finish(client)

    audio_file.write_bytes(b"fake-audio-bytes-v2")

    monkeypatch.setattr(
        "djit.services.library_scan.extract_metadata",
        lambda _: {"title": "Updated Title", "artist": "Tester", "genre": "House"},
    )

    second_import = client.post(
        "/api/v1/library/import",
        params={"folder_path": str(tmp_path)},
    )
    assert second_import.status_code == 200
    final_status = _wait_for_scan_to_finish(client)

    assert final_status["scan_updated_files"] == 1
    assert final_status["scan_added_files"] == 0

    tracks_response = client.get("/api/v1/tracks")
    assert tracks_response.status_code == 200
    payload = tracks_response.json()
    tracks = payload["items"]
    assert payload["total"] == 1
    assert len(tracks) == 1
    assert tracks[0]["title"] == "Updated Title"
    assert tracks[0]["artist"] == "Tester"

def test_pick_folder_endpoint_returns_path(monkeypatch, tmp_path):
    client = _make_client(tmp_path / "test.db")
    monkeypatch.setattr("djit.routers.library.pick_folder_path", lambda: "/tmp/music")

    response = client.get("/api/v1/library/pick-folder")
    assert response.status_code == 200
    assert response.json() == {"folder_path": "/tmp/music"}


def test_track_patch_persists_mood_and_energy(tmp_path):
    client = _make_client(tmp_path / "track_patch.db")

    audio_file = tmp_path / "demo.mp3"
    audio_file.write_bytes(b"fake-audio-bytes")

    import_response = client.post(
        "/api/v1/library/import",
        params={"folder_path": str(tmp_path)},
    )
    assert import_response.status_code == 200
    _wait_for_scan_to_finish(client)

    tracks_response = client.get("/api/v1/tracks")
    assert tracks_response.status_code == 200
    payload = tracks_response.json()
    tracks = payload["items"]
    assert payload["total"] == 1
    assert len(tracks) == 1

    track_id = tracks[0]["id"]
    patch_response = client.patch(
        f"/api/v1/tracks/{track_id}",
        json={"mood": "Peak Time", "energy": 8},
    )
    assert patch_response.status_code == 200

    get_response = client.get(f"/api/v1/tracks/{track_id}")
    assert get_response.status_code == 200
    payload = get_response.json()
    assert payload["mood"] == "Peak Time"
    assert payload["energy"] == 8


def test_import_marks_long_tracks_skipped_instead_of_queueing_analysis(tmp_path, monkeypatch):
    client = _make_client(tmp_path / "long_tracks.db")

    audio_file = tmp_path / "long_mix.mp3"
    audio_file.write_bytes(b"fake-audio-bytes")

    monkeypatch.setattr(
        "djit.services.library_scan.extract_metadata",
        lambda _: {
            "title": "Long Mix",
            "artist": "Tester",
            "genre": "House",
            "duration_seconds": 721.0,
        },
    )

    import_response = client.post(
        "/api/v1/library/import",
        params={"folder_path": str(tmp_path)},
    )
    assert import_response.status_code == 200

    final_status = _wait_for_scan_to_finish(client)
    assert final_status["status"] == "idle"
    assert final_status["scan_added_files"] == 1
    assert final_status["pending_analysis"] == 0

    tracks_response = client.get("/api/v1/tracks")
    assert tracks_response.status_code == 200
    payload = tracks_response.json()
    tracks = payload["items"]
    assert payload["total"] == 1
    assert tracks[0]["analysis_status"] == "skipped"
    assert tracks[0]["duration_seconds"] == 721.0


def test_tracks_endpoint_searches_library_text_fields(tmp_path):
    client = _make_client(tmp_path / "search.db")

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from djit.database.models import Track

    engine = create_engine(f"sqlite:///{tmp_path / 'search.db'}", future=True)
    session_local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_local()
    try:
        db.add_all(
            [
                Track(
                    path="/music/volac/my-humps.mp3",
                    title="My Humps",
                    artist="Volac",
                    genre="House",
                ),
                Track(
                    path="/music/ambient/drone.wav",
                    title="Long Drone",
                    artist="Someone",
                    genre="Ambient",
                ),
            ]
        )
        db.commit()
    finally:
        db.close()

    response = client.get("/api/v1/tracks", params={"q": "volac humps"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["title"] == "My Humps"

    no_match = client.get("/api/v1/tracks", params={"q": "volac ambient"})
    assert no_match.status_code == 200
    assert no_match.json()["total"] == 0


def test_sources_browse_preview_and_folder_filter(tmp_path, monkeypatch):
    db_path = tmp_path / "sources.db"
    client = _make_client(db_path)
    music = tmp_path / "Music"
    house = music / "House"
    techno = music / "Techno"
    house.mkdir(parents=True)
    techno.mkdir()
    unrelated = music / "Photos"
    unrelated.mkdir()
    (unrelated / "cover.jpg").write_bytes(b"image")
    (house / "one.mp3").write_bytes(b"one")
    (techno / "two.flac").write_bytes(b"two")

    monkeypatch.setattr(
        "djit.services.library_scan.extract_metadata",
        lambda path: {"title": path.stem, "artist": "Tester", "genre": path.parent.name},
    )
    response = client.post(
        "/api/v1/library/import",
        params={"folder_path": str(music)},
    )
    assert response.status_code == 200
    _wait_for_scan_to_finish(client)

    sources = client.get("/api/v1/library/sources").json()
    source = next(item for item in sources if item["path"] == str(music))
    assert source["connected"] is True
    assert source["imported_tracks"] == 2

    browse = client.get(
        "/api/v1/library/browse", params={"folder_path": str(music)}
    ).json()
    assert [entry["name"] for entry in browse["entries"]] == ["House", "Techno"]
    assert browse["entries"][0]["direct_audio_files"] == 1
    assert browse["entries"][0]["imported_tracks"] == 1

    preview = client.get(
        "/api/v1/library/preview", params={"folder_path": str(music)}
    ).json()
    assert preview["audio_files"] == 2
    assert preview["new_files"] == 0
    assert preview["existing_files"] == 2
    assert preview["not_analyzed"] == 2

    filtered = client.get(
        "/api/v1/tracks", params={"folder_path": str(house)}
    ).json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["title"] == "one"
