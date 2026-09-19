from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from djit.database.models import Base
from djit.database.session import get_db
from djit.main import create_app


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
    return TestClient(app)


def test_saved_views_crud(tmp_path):
    client = _make_client(tmp_path / "saved_views.db")

    create_response = client.post(
        "/api/v1/saved-views",
        json={
            "name": "Unheard only",
            "is_default": True,
            "state": {
                "triage_decision": ["unheard"],
                "analysis_status": [],
                "bpm_min": None,
                "bpm_max": None,
                "sort_by": "triage_decision",
                "sort_desc": False,
            },
        },
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["name"] == "Unheard only"
    assert created["is_default"] is True
    assert created["state"]["triage_decision"] == ["unheard"]

    list_response = client.get("/api/v1/saved-views")
    assert list_response.status_code == 200
    views = list_response.json()
    assert len(views) == 1

    view_id = created["id"]
    update_response = client.patch(
        f"/api/v1/saved-views/{view_id}",
        json={
            "name": "Keep first",
            "is_default": False,
            "state": {
                "triage_decision": ["keep"],
                "analysis_status": [],
                "bpm_min": 120,
                "bpm_max": 130,
                "sort_by": "bpm",
                "sort_desc": True,
            },
        },
    )
    assert update_response.status_code == 200
    updated = update_response.json()
    assert updated["name"] == "Keep first"
    assert updated["is_default"] is False
    assert updated["state"]["sort_by"] == "bpm"

    delete_response = client.delete(f"/api/v1/saved-views/{view_id}")
    assert delete_response.status_code == 200
    assert delete_response.json() == {"deleted": 1}

    list_after_delete = client.get("/api/v1/saved-views")
    assert list_after_delete.status_code == 200
    assert list_after_delete.json() == []
