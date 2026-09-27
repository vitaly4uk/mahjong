"""Retention for GameSession — every game ever started otherwise stays in
the table forever, each row carrying a full 144-tile `layout` JSON blob.
Intended to run on a schedule (dokku cron / host cron), not on every deploy
— see CLAUDE.md and DEPLOY.local.md for the invocation.
"""
from django.core.management.base import BaseCommand
from django.utils import timezone

from gameplay.models import GameSession


class Command(BaseCommand):
    help = (
        'Deletes non-daily GameSession rows older than --days, and blanks '
        '(but keeps) old daily-tournament rows so the leaderboard/lifetime '
        'record stays computable.'
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--days', type=int, default=7,
            help='Age threshold in days (default: 7 — SESSION_TTL is 2h, '
                 'so any session this old is long since finished or abandoned).',
        )
        parser.add_argument(
            '--dry-run', action='store_true',
            help='Report what would change without writing anything.',
        )

    def handle(self, *args, **options):
        cutoff = timezone.now() - timezone.timedelta(days=options['days'])
        dry_run = options['dry_run']

        old = GameSession.objects.filter(created_at__lt=cutoff)
        non_daily = old.filter(daily_date__isnull=True)
        # Daily rows keep score_ms/won/daily_date/user (the lifetime
        # tournament record — see docs/superpowers/specs/
        # 2026-07-28-daily-tournament-design.md) but shed the bulk: the
        # full board layout and the shuffle log, which nothing reads once
        # the game is long over.
        daily_to_blank = old.filter(daily_date__isnull=False).exclude(layout=[], shuffles=[])

        non_daily_count = non_daily.count()
        daily_count = daily_to_blank.count()

        if dry_run:
            self.stdout.write(
                f'Would delete {non_daily_count} non-daily session(s) '
                f'and blank {daily_count} daily session(s) older than {options["days"]} day(s).'
            )
            return

        deleted, _details = non_daily.delete()
        blanked = daily_to_blank.update(layout=[], shuffles=[])

        self.stdout.write(self.style.SUCCESS(
            f'Deleted {deleted} non-daily session row(s), blanked {blanked} daily session row(s) '
            f'(older than {options["days"]} day(s), cutoff {cutoff.isoformat()}).'
        ))
