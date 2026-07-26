"""Pydantic/ninja request/response schemas for `gameplay/api.py`. All typing
(including lifetime stats) lives here — `gameplay/stats.py` keeps only the
business logic (apply_win/apply_loss/merge_imported etc.) that operates on
these schemas, not on dicts."""
import uuid
from typing import Literal

from ninja import Schema
from pydantic import Field, model_validator


class LevelStats(Schema):
    games_started: int = Field(0, ge=0, alias='gamesStarted')
    games_played: int = Field(0, ge=0, alias='gamesPlayed')
    games_won: int = Field(0, ge=0, alias='gamesWon')
    hints_total: int = Field(0, ge=0, alias='hintsTotal')
    undos_total: int = Field(0, ge=0, alias='undosTotal')
    pairs_total: int = Field(0, ge=0, alias='pairsTotal')
    shuffles_total: int = Field(0, ge=0, alias='shufflesTotal')
    best_time_ms: int | None = Field(None, ge=0, alias='bestTimeMs')
    current_streak: int = Field(0, ge=0, alias='currentStreak')
    best_streak: int = Field(0, ge=0, alias='bestStreak')

    model_config = {'populate_by_name': True}

    @model_validator(mode='after')
    def _clamp_best_streak(self):
        # bestStreak must never be smaller than currentStreak — this enforces
        # the invariant (overrides the value) rather than just rejecting a
        # bogus payload.
        if self.best_streak < self.current_streak:
            self.best_streak = self.current_streak
        return self


class AllStats(Schema):
    easy: LevelStats = LevelStats()
    normal: LevelStats = LevelStats()
    hard: LevelStats = LevelStats()


class StartRequest(Schema):
    level: str
    board: str = 'turtle'


class TileOut(Schema):
    x: int
    y: int
    z: int
    kind: str


class StartResponse(Schema):
    token: uuid.UUID
    layout: list[TileOut]
    # The board's own dimensions (gameplay/layouts.py: Layout.width/height/
    # layers) — sent alongside `layout` so the client doesn't need to
    # re-derive them from the tile coordinates (main.js: applyBoardDims).
    board_width: int
    board_height: int
    board_layers: int
    stats: AllStats


class FinishRequest(Schema):
    token: uuid.UUID
    moves: list[tuple[int, int]]
    outcome: str


class FinishResponse(Schema):
    valid: bool
    reason: str | None = None
    won: bool = False
    elapsed_ms: int | None = None
    stats: AllStats | None = None


class ShuffleRequest(Schema):
    moves: list[tuple[int, int]]


class ShuffleResponse(Schema):
    # {"<idx>": "<kind>"} — the new kind for every tile still on the board
    # (positions unchanged); ninja/pydantic serializes int dict keys as
    # strings, matching how the client indexes `layout` by idx.
    kinds: dict[int, str]
    stats: AllStats


class SessionStateResponse(Schema):
    # 'unknown' — the token isn't in the DB; 'expired' — both for rows with
    # status expired and for active sessions that outlived SESSION_TTL (lazy
    # marking in the DB is left to finish). elapsed_ms — only for a live active session.
    status: Literal['active', 'claimed', 'expired', 'unknown']
    elapsed_ms: int | None = None


class BumpRequest(Schema):
    counter: Literal['hint', 'undo', 'pair']


class BumpResponse(Schema):
    stats: AllStats


class StatsResponse(Schema):
    stats: AllStats
    legacy_import_available: bool


class ImportRequest(Schema):
    stats: AllStats


class ImportResponse(Schema):
    imported: bool
    reason: str | None = None
    stats: AllStats | None = None
