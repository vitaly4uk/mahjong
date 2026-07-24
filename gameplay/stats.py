"""Довічна статистика гравця — Python-порт static/game/stats.js: чисті
трансформери над схемами з `gameplay/schemas.py` (LevelStats/AllStats), той
самий патерн порту, що вже є для board.py/generator.py. Сервер — єдине
джерело істини для applyWin/applyLoss: клієнт більше не рахує ці зміни сам,
лише показує те, що повернув сервер.
"""
from .schemas import AllStats, LevelStats

LEVELS = ('easy', 'normal', 'hard')


def empty_all_stats() -> dict:
    """Іменована функція (не lambda) — використовується як default= для
    Profile.stats JSONField, має бути серіалізовною в міграції."""
    return AllStats().model_dump(by_alias=True)


def bump_started(stats: LevelStats) -> LevelStats:
    return stats.model_copy(update={'games_started': stats.games_started + 1})


BUMP_FIELDS = {'hint': 'hints_total', 'undo': 'undos_total', 'pair': 'pairs_total'}


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
    # currentStreak з імпорту береться лише якщо на сервері для цього рівня
    # ще не було жодної реальної партії — інакше вже реальний server-side
    # стрік важливіший за принесений з localStorage.
    current_streak = imported.current_streak if server.games_played == 0 else server.current_streak

    best_times = [t for t in (server.best_time_ms, imported.best_time_ms) if t is not None]
    best_time_ms = min(best_times) if best_times else None

    # Легасі-блоб з localStorage не мав лічильника стартів узагалі
    # (imported.games_started завжди 0) — використовуємо imported.games_played
    # як проксі, інакше зведений gamesStarted міг би вийти меншим за зведений
    # gamesPlayed (неможливий стан: не можна зіграти більше партій, ніж
    # почати). server.games_started і так завжди >= server.games_played, тож
    # сума лишається коректною верхньою межею.
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
    """Адитивний мердж по кожному рівню — застосовується один раз при
    одноразовому перенесенні localStorage-блоба на сервер (gameplay/api.py:
    POST /api/game/stats/import)."""
    return AllStats(**{
        level: _merge_level(getattr(server, level), getattr(imported, level))
        for level in LEVELS
    })
