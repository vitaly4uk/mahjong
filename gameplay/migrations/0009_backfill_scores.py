"""Backfills point scores for games finished before scoring existed.

The move log is not stored, so chains (and how many pairs a lost game
cleared) are unrecoverable. Won regular games therefore get the LOWER BOUND of
their real score: every pair counts without a chain bonus, all other terms
(penalties, no-help and time bonus) are exact. Lost games stay unscored.

The formula and its constants are frozen here on purpose (not imported from
gameplay/scoring.py): a historical estimate must not shift when the live
constants are later tuned.

Each estimated game is also folded into its player's `overall` stats block
(gameplay/schemas.py: OverallStats). Only rows with a null `score` are
touched, so the fold happens exactly once per game.
"""
from django.db import migrations

LEVEL_MULTIPLIER = {'easy': 1, 'normal': 2, 'hard': 3}
PAIR_BASE = 10
HINT_PENALTY = 20
UNDO_PENALTY = 10
SHUFFLE_PENALTY = 20
NO_HELP_BONUS_DIVISOR = 2
TIME_BONUS_BASE_SECONDS = 600
LEVELS = ('easy', 'normal', 'hard')


def estimate_score(session):
    mult = LEVEL_MULTIPLIER[session.level]
    shuffles = len(session.shuffles)
    pair_total = (len(session.layout) // 2) * PAIR_BASE * mult

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


def seeded_overall(stats):
    """Same seeding as AllStats._seed_overall, for a blob with no `overall`."""
    blocks = [stats.get(level) or {} for level in LEVELS]
    return {
        'gamesScored': 0, 'totalScore': 0, 'bestScore': 0,
        'gamesWon': sum(b.get('gamesWon', 0) for b in blocks),
        'currentStreak': 0,
        'bestStreak': max(b.get('bestStreak', 0) for b in blocks),
    }


def backfill(apps, schema_editor):
    GameSession = apps.get_model('gameplay', 'GameSession')
    Profile = apps.get_model('gameplay', 'Profile')

    pending = GameSession.objects.filter(
        status='claimed', won=True, daily_date__isnull=True, score__isnull=True,
    )
    totals = {}  # user_id -> [games, total, best]
    for session in pending.iterator():
        score = estimate_score(session)
        GameSession.objects.filter(pk=session.pk).update(score=score)
        if session.user_id is None:
            continue
        games, total, best = totals.get(session.user_id, (0, 0, 0))
        totals[session.user_id] = (games + 1, total + score, max(best, score))

    for profile in Profile.objects.filter(user_id__in=totals):
        games, total, best = totals[profile.user_id]
        stats = profile.stats
        overall = stats.get('overall') or seeded_overall(stats)
        overall['gamesScored'] += games
        overall['totalScore'] += total
        overall['bestScore'] = max(overall['bestScore'], best)
        stats['overall'] = overall
        profile.stats = stats
        profile.save(update_fields=['stats'])


class Migration(migrations.Migration):
    dependencies = [
        ('gameplay', '0008_gamesession_score'),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
