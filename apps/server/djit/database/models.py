from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    path: Mapped[str] = mapped_column(Text, unique=True)
    file_hash: Mapped[str | None] = mapped_column(String(64), default=None, index=True)
    drive_id: Mapped[str | None] = mapped_column(String(255), default=None)
    file_mtime: Mapped[float | None] = mapped_column(Float, default=None)
    file_size: Mapped[int | None] = mapped_column(Integer, default=None)
    waveform_data: Mapped[str | None] = mapped_column(Text, default=None)
    title: Mapped[str | None] = mapped_column(String(255), default=None)
    artist: Mapped[str | None] = mapped_column(String(255), default=None)
    genre: Mapped[str | None] = mapped_column(String(100), default=None)
    mood: Mapped[str | None] = mapped_column(String(100), default=None)
    energy: Mapped[int | None] = mapped_column(Integer, default=None)
    duration_seconds: Mapped[float | None] = mapped_column(Float, default=None)
    bpm: Mapped[float | None] = mapped_column(Float, default=None)
    bpm_confidence: Mapped[float | None] = mapped_column(Float, default=None)
    key_camelot: Mapped[str | None] = mapped_column(String(8), default=None)
    analysis_status: Mapped[str] = mapped_column(String(32), default="not_analyzed")
    analysis_failures: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    triage_decision: Mapped[str] = mapped_column(String(32), default="unheard")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    tracks: Mapped[list[PlaylistTrack]] = relationship(back_populates="playlist")


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id"))
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    position: Mapped[int] = mapped_column(Integer)
    playlist: Mapped[Playlist] = relationship(back_populates="tracks")


class SavedView(Base):
    __tablename__ = "saved_views"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    state_json: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MetadataChangeBatch(Base):
    __tablename__ = "metadata_change_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe: Mapped[str] = mapped_column(String(64))
    changes_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)


class AnalysisBatch(Base):
    __tablename__ = "analysis_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    mode: Mapped[str] = mapped_column(String(16), default="fast")
    scope: Mapped[str] = mapped_column(String(32), default="selected")
    status: Mapped[str] = mapped_column(String(16), default="queued")
    track_ids_json: Mapped[str] = mapped_column(Text)
    total: Mapped[int] = mapped_column(Integer, default=0)
    completed: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    current_track_id: Mapped[int | None] = mapped_column(Integer, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, default=None)
