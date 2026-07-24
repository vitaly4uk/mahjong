"""Pydantic/ninja-схеми запитів і відповідей для `gameplay/api.py`. Уся
типізація (включно з довічною статистикою) живе тут — `gameplay/stats.py`
лишає собі лише бізнес-логіку (apply_win/apply_loss/merge_imported тощо), яка
оперує цими схемами, а не dict."""
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
    best_time_ms: int | None = Field(None, ge=0, alias='bestTimeMs')
    current_streak: int = Field(0, ge=0, alias='currentStreak')
    best_streak: int = Field(0, ge=0, alias='bestStreak')

    model_config = {'populate_by_name': True}

    @model_validator(mode='after')
    def _clamp_best_streak(self):
        # bestStreak ніколи не має бути меншим за currentStreak — гарантія
        # інваріанта (перевизначає значення), а не просто відхилення
        # бутафорського payload.
        if self.best_streak < self.current_streak:
            self.best_streak = self.current_streak
        return self


class AllStats(Schema):
    easy: LevelStats = LevelStats()
    normal: LevelStats = LevelStats()
    hard: LevelStats = LevelStats()


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


class SessionStateResponse(Schema):
    # 'unknown' — токена немає в БД; 'expired' — і для рядків зі статусом
    # expired, і для active-сесій, що пережили SESSION_TTL (ліниве маркування
    # в БД лишається за finish). elapsed_ms — лише для живої active-сесії.
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
