from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


EdgeType = Literal["key", "bpm", "genre", "energy", "mood", "artist"]


class GraphNode(BaseModel):
    id: int
    title: str
    artist: str
    bpm: float | None = None
    key_camelot: str | None = None
    genre: str | None = None
    energy: int | None = None
    mood: str | None = None


class GraphEdge(BaseModel):
    source: int
    target: int
    type: EdgeType
    weight: float  # 0.0–1.0 similarity


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool = False
