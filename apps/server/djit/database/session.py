from __future__ import annotations

from pathlib import Path
import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
import sqlalchemy

DB_PATH = Path(os.environ.get("DJIT_DB_PATH", Path(__file__).resolve().parents[2] / "djit.db"))
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


@sqlalchemy.event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _connection_record) -> None:
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency for database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_runtime_schema() -> None:
    """Apply additive desktop-safe migrations to existing SQLite libraries."""
    with engine.begin() as connection:
        columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(tracks)")
        }
        if "analysis_failures" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE tracks ADD COLUMN analysis_failures "
                "INTEGER NOT NULL DEFAULT 0"
            )
            connection.exec_driver_sql(
                "UPDATE tracks SET analysis_failures = 1 "
                "WHERE analysis_status = 'failed'"
            )
