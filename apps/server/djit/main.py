from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from djit.routers.analysis import router as analysis_router
from djit.routers.analysis import (
    set_analysis_session_factory,
    start_analysis_worker,
    stop_analysis_worker,
)
from djit.database.models import Base
from djit.database.session import SessionLocal, engine, ensure_runtime_schema
from djit.routers.audio import router as audio_router
from djit.routers.duplicates import router as duplicates_router
from djit.routers.export import router as export_router
from djit.routers.graph import router as graph_router
from djit.routers.library import router as library_router
from djit.routers.library import set_library_scan_session_factory
from djit.routers.playlists import router as playlists_router
from djit.routers.saved_views import router as saved_views_router
from djit.routers.tracks import router as tracks_router


def create_app() -> FastAPI:
    app = FastAPI(title="DJ-IT API", version="0.1.0")
    gzip_min_size = int(os.getenv("DJIT_API_GZIP_MIN_SIZE", "512"))

    # Ensure application loggers emit INFO-level worker progress messages.
    logging.getLogger("djit").setLevel(logging.INFO)
    logging.getLogger("djit.routers.analysis").setLevel(logging.INFO)

    set_analysis_session_factory(SessionLocal)
    set_library_scan_session_factory(SessionLocal)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://localhost:8000", "http://localhost:8001"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=max(128, gzip_min_size))

    app.include_router(library_router, prefix="/api/v1")
    app.include_router(tracks_router, prefix="/api/v1")
    app.include_router(analysis_router, prefix="/api/v1")
    app.include_router(audio_router, prefix="/api/v1")
    app.include_router(duplicates_router, prefix="/api/v1")
    app.include_router(playlists_router, prefix="/api/v1")
    app.include_router(saved_views_router, prefix="/api/v1")
    app.include_router(export_router, prefix="/api/v1")
    app.include_router(graph_router, prefix="/api/v1")

    @app.on_event("startup")
    async def startup_analysis_worker() -> None:
        Base.metadata.create_all(bind=engine)
        ensure_runtime_schema()
        await start_analysis_worker()

    @app.on_event("shutdown")
    async def shutdown_analysis_worker() -> None:
        await stop_analysis_worker()

    @app.get("/api/v1/health")
    async def healthcheck() -> dict[str, str | bool]:
        return {"ok": True, "app": "djit-server"}

    static_dir = Path(__file__).parent / "static"
    if static_dir.exists():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app


app = create_app()
