from __future__ import annotations

import json
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


def test_playlist_crud_and_track_ordering(tmp_path):
    client, session_local = _make_client(tmp_path / "playlists.db")

    db = session_local()
    try:
        t1 = Track(path="/tmp/t1.mp3", title="T1", artist="A", bpm=120, duration_seconds=180)
        t2 = Track(path="/tmp/t2.mp3", title="T2", artist="A", bpm=130, duration_seconds=210)
        db.add_all([t1, t2])
        db.commit()
        db.refresh(t1)
        db.refresh(t2)
    finally:
        db.close()

    create_response = client.post("/api/v1/playlists", json={"name": "Warmup"})
    assert create_response.status_code == 200
    playlist_id = create_response.json()["id"]

    add_response = client.post(
        f"/api/v1/playlists/{playlist_id}/tracks",
        json={"track_ids": [t1.id, t2.id]},
    )
    assert add_response.status_code == 200
    assert add_response.json()["added"] == 2

    detail_response = client.get(f"/api/v1/playlists/{playlist_id}")
    assert detail_response.status_code == 200
    detail = detail_response.json()
    assert detail["track_count"] == 2
    assert detail["duration_seconds"] == 390
    assert detail["bpm_min"] == 120
    assert detail["bpm_max"] == 130

    reorder_response = client.put(
        f"/api/v1/playlists/{playlist_id}/order",
        json={"track_ids": [t2.id, t1.id]},
    )
    assert reorder_response.status_code == 200

    detail_after_order = client.get(f"/api/v1/playlists/{playlist_id}")
    assert detail_after_order.status_code == 200
    ordered_tracks = detail_after_order.json()["tracks"]
    assert [track["id"] for track in ordered_tracks] == [t2.id, t1.id]

    remove_response = client.delete(f"/api/v1/playlists/{playlist_id}/tracks/{t2.id}")
    assert remove_response.status_code == 200

    detail_after_remove = client.get(f"/api/v1/playlists/{playlist_id}")
    assert detail_after_remove.status_code == 200
    assert detail_after_remove.json()["track_count"] == 1

    delete_response = client.delete(f"/api/v1/playlists/{playlist_id}")
    assert delete_response.status_code == 200
    assert delete_response.json() == {"deleted": 1}

    list_response = client.get("/api/v1/playlists")
    assert list_response.status_code == 200
    assert list_response.json() == []


def test_tracks_include_playlist_memberships(tmp_path):
    client, session_local = _make_client(tmp_path / "track_memberships.db")

    db = session_local()
    try:
        track = Track(path="/tmp/multi.mp3", title="Multi", artist="DJ")
        db.add(track)
        db.commit()
        db.refresh(track)

        p1 = Playlist(name="Warmup")
        p2 = Playlist(name="Closing")
        db.add_all([p1, p2])
        db.commit()
        db.refresh(p1)
        db.refresh(p2)

        db.add_all(
            [
                PlaylistTrack(playlist_id=p1.id, track_id=track.id, position=1),
                PlaylistTrack(playlist_id=p2.id, track_id=track.id, position=1),
            ]
        )
        db.commit()
    finally:
        db.close()

    response = client.get("/api/v1/tracks")
    assert response.status_code == 200
    payload = response.json()
    tracks = payload["items"]
    assert payload["total"] == 1
    assert len(tracks) == 1
    memberships = tracks[0]["playlist_memberships"]
    assert {m["name"] for m in memberships} == {"Warmup", "Closing"}


def test_playlist_extract_writes_tracks_m3u_and_manifest(tmp_path):
    client, session_local = _make_client(tmp_path / "extract.db")
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    keep_file = source_dir / "keep.mp3"
    maybe_file = source_dir / "maybe.mp3"
    reject_file = source_dir / "reject.mp3"
    keep_file.write_bytes(b"keep-audio")
    maybe_file.write_bytes(b"maybe-audio")
    reject_file.write_bytes(b"reject-audio")

    db = session_local()
    try:
        keep = Track(
            path=str(keep_file),
            title="Keep Track",
            artist="Artist",
            triage_decision="keep",
            bpm=124,
            key_camelot="8A",
        )
        maybe = Track(
            path=str(maybe_file),
            title="Maybe Track",
            artist="Artist",
            triage_decision="maybe",
        )
        reject = Track(
            path=str(reject_file),
            title="Reject Track",
            artist="Artist",
            triage_decision="reject",
        )
        db.add_all([keep, maybe, reject])
        db.commit()
        db.refresh(keep)
        db.refresh(maybe)
        db.refresh(reject)

        playlist = Playlist(name="USB Warmup")
        db.add(playlist)
        db.commit()
        db.refresh(playlist)
        db.add_all(
            [
                PlaylistTrack(playlist_id=playlist.id, track_id=keep.id, position=1),
                PlaylistTrack(playlist_id=playlist.id, track_id=maybe.id, position=2),
                PlaylistTrack(playlist_id=playlist.id, track_id=reject.id, position=3),
            ]
        )
        db.commit()
        playlist_id = playlist.id
    finally:
        db.close()

    response = client.post(
        f"/api/v1/playlists/{playlist_id}/extract",
        json={"playlist_id": playlist_id, "destination_path": str(tmp_path / "usb")},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["copied"] == 2
    assert payload["skipped"] == 1
    assert payload["provisional"] == 1
    assert payload["errors"] == []

    destination = Path(payload["destination"])
    playlist_path = Path(payload["playlist_path"])
    manifest_path = Path(payload["manifest_path"])
    assert destination.name == "DJ-IT Export"
    assert playlist_path.exists()
    assert manifest_path.exists()

    playlist_lines = playlist_path.read_text(encoding="utf-8").splitlines()
    assert playlist_lines[0] == "#EXTM3U"
    assert len(playlist_lines) == 3
    assert playlist_lines[1].startswith("../Tracks/")
    assert playlist_lines[2].startswith("../Tracks/")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["playlist_name"] == "USB Warmup"
    statuses = {track["title"]: track["status"] for track in manifest["tracks"]}
    assert statuses == {
        "Keep Track": "copied",
        "Maybe Track": "copied",
        "Reject Track": "skipped_triage",
    }
