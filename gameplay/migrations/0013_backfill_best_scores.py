"""Backfills `GameSession.board` and each player's per-board best scores
(AllStats.best_scores) for regular games finished before the board was stored.

The board is recovered by matching the session's tile positions against every
layout in layouts/*.layout; a row that matches none (layout since removed or
already blanked by purge_sessions) keeps a blank board and is skipped. Only
scored regular games feed the records, like `overall`; daily rows get their
board too but never touch lifetime stats.
"""
from django.db import migrations

from gameplay.layouts import load_layouts


def _positions_index():
    return {
        frozenset(layout.positions): slug for slug, layout in load_layouts().items()
    }


def backfill(apps, schema_editor):
    GameSession = apps.get_model('gameplay', 'GameSession')
    Profile = apps.get_model('gameplay', 'Profile')

    index = _positions_index()
    records = {}  # user_id -> {board: {level: best}}
    for session in GameSession.objects.filter(board='').iterator():
        if not session.layout:
            continue
        positions = frozenset((t['x'], t['y'], t['z']) for t in session.layout)
        board = index.get(positions)
        if board is None:
            continue
        GameSession.objects.filter(pk=session.pk).update(board=board)
        if (
            session.status != 'claimed' or session.daily_date is not None
            or session.score is None or session.user_id is None
        ):
            continue
        per_level = records.setdefault(session.user_id, {}).setdefault(board, {})
        per_level[session.level] = max(per_level.get(session.level, 0), session.score)

    for profile in Profile.objects.filter(user_id__in=records):
        stats = profile.stats
        best = stats.get('bestScores') or {}
        for board, levels in records[profile.user_id].items():
            per_level = best.setdefault(board, {})
            for level, score in levels.items():
                per_level[level] = max(per_level.get(level, 0), score)
        stats['bestScores'] = best
        profile.stats = stats
        profile.save(update_fields=['stats'])


class Migration(migrations.Migration):
    dependencies = [
        ('gameplay', '0012_gamesession_board'),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
