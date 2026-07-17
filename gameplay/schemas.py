"""Pydantic/ninja-схеми запитів і відповідей для `gameplay/api.py`."""
import uuid

from ninja import Schema


class StartRequest(Schema):
    level: str


class TileOut(Schema):
    x: int
    y: int
    z: int
    kind: str


class StartResponse(Schema):
    token: uuid.UUID
    layout: list[TileOut]


class FinishRequest(Schema):
    token: uuid.UUID
    moves: list[tuple[int, int]]
    outcome: str


class FinishResponse(Schema):
    valid: bool
    reason: str | None = None
    won: bool = False
    elapsed_ms: int | None = None
