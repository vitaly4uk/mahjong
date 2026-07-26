"""Player lifetime stats — Python port of static/game/stats.js: pure
transformers over the schemas in `gameplay/schemas.py` (LevelStats/AllStats),
the same porting pattern already used for board.py/generator.py. The server
is the sole source of truth for applyWin/applyLoss: the client no longer
computes these changes itself, it only displays what the server returned.
"""
from .schemas import AllStats, LevelStats

LEVELS = ('easy', 'normal', 'hard')


def empty_all_stats() -> dict:
    """A named function (not a lambda) — used as default= for the
    Profile.stats JSONField, must be serializable in migrations."""
    return AllStats().model_dump(by_alias=True)


BUMP_FIELDS = {
    'start': 'games_started', 'hint': 'hints_total', 'undo': 'undos_total', 'pair': 'pairs_total',
}


def bump_counter(stats: LevelStats, counter: str) -> LevelStats:
    field = BUMP_FIELDS[counter]
    return stats.model_copy(update={field: getattr(stats, field) + 1})


def apply_win(stats: LevelStats, time_ms: int) -> LevelStats:
    current_streak = stats.current_streak + 1
    return stats.model_copy(update={
        'games_played': stats.games_played + 1,
        'games_won': stats.games_won + 1,
        'current_streak': current_streak,
        'best_streak': max(stats.best_streak, current_streak),
        'best_time_ms': time_ms if stats.best_time_ms is None else min(stats.best_time_ms, time_ms),
    })


def apply_loss(stats: LevelStats) -> LevelStats:
    return stats.model_copy(update={'games_played': stats.games_played + 1, 'current_streak': 0})


def _merge_level(server: LevelStats, imported: LevelStats) -> LevelStats:
    # currentStreak from the import is only used if the server has had no
    # real games at this level yet — otherwise the real server-side streak
    # takes precedence over the one brought in from localStorage.
    current_streak = imported.current_streak if server.games_played == 0 else server.current_streak

    best_times = [t for t in (server.best_time_ms, imported.best_time_ms) if t is not None]
    best_time_ms = min(best_times) if best_times else None

    # The legacy localStorage blob had no "started" counter at all
    # (imported.games_started is always 0) — we use imported.games_played as
    # a proxy, otherwise the merged gamesStarted could end up smaller than
    # the merged gamesPlayed (an impossible state: you can't play more games
    # than you started). server.games_started is already always >=
    # server.games_played, so the sum remains a valid upper bound.
    return LevelStats(
        games_started=server.games_started + imported.games_played,
        games_played=server.games_played + imported.games_played,
        games_won=server.games_won + imported.games_won,
        hints_total=server.hints_total + imported.hints_total,
        undos_total=server.undos_total + imported.undos_total,
        pairs_total=server.pairs_total + imported.pairs_total,
        best_time_ms=best_time_ms,
        current_streak=current_streak,
        best_streak=max(server.best_streak, imported.best_streak),
    )


def merge_imported(server: AllStats, imported: AllStats) -> AllStats:
    """Additive merge per level — applied once, during the one-time transfer
    of the localStorage blob to the server (gameplay/api.py:
    POST /api/game/stats/import)."""
    return AllStats(**{
        level: _merge_level(getattr(server, level), getattr(imported, level))
        for level in LEVELS
    })


def update_level_stats(profile, level, mutator) -> AllStats:
    """Reads profile.stats, applies `mutator` to the given level's
    LevelStats, persists the updated blob, and returns the full AllStats —
    the read/mutate/save sequence shared by every gameplay/api.py endpoint
    that touches lifetime stats (start/bump/finish). `mutator` is one of the
    LevelStats -> LevelStats transformers above (bump_counter partial,
    apply_win, apply_loss, ...)."""
    all_stats = AllStats.model_validate(profile.stats)
    setattr(all_stats, level, mutator(getattr(all_stats, level)))
    profile.stats = all_stats.model_dump(by_alias=True)
    profile.save(update_fields=['stats', 'updated_at'])
    return all_stats
