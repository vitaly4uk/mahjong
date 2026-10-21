"""Backfills point scores for daily-tournament wins from before the tournament
was ranked by points (0010 dropped score_ms), so past days keep a leaderboard.

Same estimate as 0009: every pair counts without a chain bonus (the move log
was never stored), all other terms are exact. The one difference: the board
layout of old daily rows may already be blanked by purge_sessions, so the pair
count is the fixed 144-tile set (72 pairs) rather than len(layout) // 2; a
blanked shuffle log makes the shuffle penalty a lower bound. Daily games never
fed lifetime stats, so no Profile is touched. Losses stay unscored.
"""
from django.db import migrations

LEVEL_MULTIPLIER = {'easy': 1, 'normal': 2, 'hard': 3}
PAIR_BASE = 10
HINT_PENALTY = 20
UNDO_PENALTY = 10
SHUFFLE_PENALTY = 20
NO_HELP_BONUS_DIVISOR = 2
TIME_BONUS_BASE_SECONDS = 600
PAIRS_ON_BOARD = 72


def estimate_score(session):
    mult = LEVEL_MULTIPLIER[session.level]
    shuffles = len(session.shuffles)
    pair_total = PAIRS_ON_BOARD * PAIR_BASE * mult

    penalties = (
        session.hints * HINT_PENALTY
        + session.undos * UNDO_PENALTY
        + shuffles * SHUFFLE_PENALTY
    ) * mult
    no_help_bonus = (
        pair_total // NO_HELP_BONUS_DIVISOR
        if session.hints == 0 and session.undos == 0 and shuffles == 0 else 0
    )
    elapsed_s = (session.elapsed_ms or 0) // 1000
    time_bonus = max(0, TIME_BONUS_BASE_SECONDS - elapsed_s) * mult
    return max(0, pair_total + no_help_bonus + time_bonus - penalties)


def backfill(apps, schema_editor):
    GameSession = apps.get_model('gameplay', 'GameSession')
    pending = GameSession.objects.filter(
        status='claimed', won=True, daily_date__isnull=False, score__isnull=True,
    )
    for session in pending.iterator():
        GameSession.objects.filter(pk=session.pk).update(score=estimate_score(session))


class Migration(migrations.Migration):
    dependencies = [
        ('gameplay', '0010_daily_rank_by_score'),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
