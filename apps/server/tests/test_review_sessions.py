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


def test_review_session_uses_the_full_library_and_selected_genre(tmp_path):
    client, session_local = _make_client(tmp_path / "review.db")
    with session_local() as db:
        db.add_all(
            Track(
                path=f"/music/house-{index}.mp3",
                title=f"House {index}",
                genre="House",
            )
            for index in range(230)
        )
        funk_tracks = [
            Track(
                path=f"/music/funk-{index}.mp3",
                title=f"Funk {index}",
                genre="Funk",
            )
            for index in range(30)
        ]
        db.add_all(funk_tracks)
        db.flush()
        playlist = Playlist(name="Already sorted")
        db.add(playlist)
        db.flush()
        db.add(PlaylistTrack(playlist_id=playlist.id, track_id=funk_tracks[0].id, position=0))
        db.commit()

    response = client.get("/api/v1/tracks/review-session?genre=Funk&limit=25")
    assert response.status_code == 200
    payload = response.json()
    assert payload["total_eligible"] == 29
    assert payload["selected_genres"] == ["Funk"]
    assert len(payload["tracks"]) == 25
    assert {track["genre"] for track in payload["tracks"]} == {"Funk"}

    overview = client.get("/api/v1/tracks/review-genres").json()
    assert overview["total_eligible"] == 259
    assert overview["unknown_genre"] == 0
    assert overview["genres"][:2] == [
        {"name": "House", "count": 230},
        {"name": "Funk", "count": 29},
    ]
