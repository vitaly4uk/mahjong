"""Player lifetime stats — Python port of static/game/stats.js: pure
transformers over the schemas in `gameplay/schemas.py` (LevelStats/AllStats),
the same porting pattern already used for board.py/generator.py. The server
is the sole source of truth for applyWin/applyLoss: the client no longer
computes these changes itself, it only displays what the server returned.
"""
from django.db import transaction

from .schemas import AllStats, LevelStats, OverallStats

LEVELS = ('easy', 'normal', 'hard')


def empty_all_stats() -> dict:
    """A named function (not a lambda) — used as default= for the
    Profile.stats JSONField, must be serializable in migrations."""
    return AllStats().model_dump(by_alias=True)


BUMP_FIELDS = {
    'start': 'games_started', 'hint': 'hints_total', 'undo': 'undos_total', 'pair': 'pairs_total',
    'shuffle': 'shuffles_total',
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


def apply_score(stats: OverallStats, score: int, won: bool) -> OverallStats:
    """Folds one finished regular game into the points stats."""
    current_streak = stats.current_streak + 1 if won else 0
    return stats.model_copy(update={
        'games_scored': stats.games_scored + 1,
        'total_score': stats.total_score + score,
        'best_score': max(stats.best_score, score),
        'games_won': stats.games_won + (1 if won else 0),
        'current_streak': current_streak,
        'best_streak': max(stats.best_streak, current_streak),
    })


def apply_best_score(
    best_scores: dict[str, dict[str, int]], board: str, level: str, score: int,
) -> dict[str, dict[str, int]]:
    """Raises the (board, level) record if `score` beats it. A session with no
    board (rows from before the field existed) is not recorded."""
    if not board:
        return best_scores
    per_level = best_scores.get(board, {})
    if score <= per_level.get(level, 0):
        return best_scores
    return {**best_scores, board: {**per_level, level: score}}


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
        # The legacy localStorage blob predates shuffling — imported.shuffles_total
        # is always 0, but the server-side count must still carry through, or
        # the merge would silently reset it.
        shuffles_total=server.shuffles_total + imported.shuffles_total,
        best_time_ms=best_time_ms,
        current_streak=current_streak,
        best_streak=max(server.best_streak, imported.best_streak),
    )


def merge_imported(server: AllStats, imported: AllStats) -> AllStats:
    """Additive merge per level — applied once, during the one-time transfer
    of the localStorage blob to the server (gameplay/api.py:
    POST /api/game/stats/import)."""
    # The legacy blob predates points: only its wins and best streak carry
    # into the overall block (the server's own scores/current streak stay).
    imported_wins = sum(getattr(imported, level).games_won for level in LEVELS)
    imported_best = max(getattr(imported, level).best_streak for level in LEVELS)
    overall = server.overall.model_copy(update={
        'games_won': server.overall.games_won + imported_wins,
        'best_streak': max(server.overall.best_streak, imported_best),
    })
    return AllStats(
        overall=overall,
        **{
            level: _merge_level(getattr(server, level), getattr(imported, level))
            for level in LEVELS
        },
    )


def update_level_stats(
    profile, level, mutator, overall_mutator=None, best_scores_mutator=None,
) -> AllStats:
    """Reads profile.stats, applies `mutator` to the given level's
    LevelStats, persists the updated blob, and returns the full AllStats —
    the read/mutate/save sequence shared by every gameplay/api.py endpoint
    that touches lifetime stats (start/bump/finish). `mutator` is one of the
    LevelStats -> LevelStats transformers above (bump_counter partial,
    apply_win, apply_loss, ...). `overall_mutator`, when given, is an
    OverallStats -> OverallStats transformer (apply_score partial) applied in
    the same locked write; so is `best_scores_mutator`, a dict -> dict
    transformer over AllStats.best_scores (apply_best_score partial).

    Locks the row for the duration of the read-modify-write:
    Profile.stats is a JSONField, so without this two concurrent calls (two
    tabs, or a hint and a pair landing in the same tick) each read the same
    starting blob and the second save silently clobbers the first's
    increment — the same failure mode GameSession.hints/undos avoids next
    door via an F() expression (gameplay/api.py: bump_stat). select_for_update
    re-fetches under the lock rather than trusting the possibly-stale
    `profile` the caller passed in; the fresh blob is copied back onto that
    instance so callers holding onto it still see up-to-date values.
    select_for_update() is a no-op on SQLite (the local/test default), so
    this is real protection only under Postgres in production — harmless
    either way."""
    with transaction.atomic():
        locked = type(profile).objects.select_for_update().get(pk=profile.pk)
        all_stats = AllStats.model_validate(locked.stats)
        setattr(all_stats, level, mutator(getattr(all_stats, level)))
        if overall_mutator is not None:
            all_stats.overall = overall_mutator(all_stats.overall)
        if best_scores_mutator is not None:
            all_stats.best_scores = best_scores_mutator(all_stats.best_scores)
        locked.stats = all_stats.model_dump(by_alias=True)
        locked.save(update_fields=['stats', 'updated_at'])
    profile.stats = locked.stats
    profile.updated_at = locked.updated_at
    return all_stats
