import uuid

from django.conf import settings
from django.db import models

from .stats import empty_all_stats


class Profile(models.Model):
    """Game fields on top of the standard django.contrib.auth.User — both for
    anonymous players (unusable password, auto-generated username,
    gameplay/middleware.py: PlayerIdentityMiddleware) and, in the future, for
    Google accounts via django-allauth (allauth attaches a SocialAccount to an
    existing User rather than merging in a separate identity model).
    """

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='profile',
    )
    # Value of the mahjong_player cookie, not User.pk — avoids exposing a sequential ID.
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    stats = models.JSONField(default=empty_all_stats)  # AllStats.model_dump(by_alias=True)
    # Player-chosen display name; '' = fall back to the auto-generated
    # nickname (gameplay/daily.py: nickname_for). Deliberately NOT unique —
    # this is cosmetic, not a login. It also doubles as the DiceBear avatar
    # seed (static/game/avatar.js) — whatever is shown as the name IS the seed.
    display_name = models.CharField(max_length=24, blank=True, default='')
    legacy_imported = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.public_id} (imported={self.legacy_imported})'


class GameSession(models.Model):
    """Server-side state of an active game. The token is the session secret,
    only ever present in the /api/game/start response. `user` is nullable for
    a painless migration of the existing table with no backfill (sessions
    live 2 hours and turn over quickly); new code always sets this field when
    a game starts.
    """

    class Status(models.TextChoices):
        ACTIVE = 'active', 'Active'
        CLAIMED = 'claimed', 'Claimed'
        EXPIRED = 'expired', 'Expired'

    token = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    level = models.CharField(max_length=16)
    layout = models.JSONField()
    seed = models.CharField(max_length=64)
    # Shuffle events applied during the game, in order:
    # [{"after_moves": int, "kinds": {"<idx>": "<kind>"}}, ...]. `after_moves`
    # is the move-log length at the moment of the shuffle (the replay anchor
    # — see gameplay/api.py: _replay); `kinds` remaps the tiles still on the
    # board at that point to their new kind, positions unchanged. Existing
    # rows backfill to [] (sessions live 2h and turn over quickly).
    shuffles = models.JSONField(default=list)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='sessions',
        null=True, blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    claimed_at = models.DateTimeField(null=True, blank=True)
    elapsed_ms = models.PositiveIntegerField(null=True, blank=True)
    won = models.BooleanField(null=True, blank=True)
    # Server-authoritative penalty counters (gameplay/api.py: bump_stat), used
    # only to compute score_ms for daily tournament sessions — never trusted
    # from the client. Harmless unused columns on regular (non-daily) games.
    hints = models.PositiveIntegerField(default=0)
    undos = models.PositiveIntegerField(default=0)
    # None = a regular free-play game; a date = a daily-tournament attempt for
    # that local calendar day (gameplay/daily.py: daily_challenge). This IS the
    # is-daily marker — no separate boolean.
    daily_date = models.DateField(null=True, blank=True)
    # Set on a winning daily claim only (gameplay/api.py: finish_game) —
    # elapsed_ms plus hint/undo penalties (gameplay/daily.py:
    # HINT_PENALTY_MS/UNDO_PENALTY_MS). Stays null for regular games and for
    # daily losses/deadlocks, so those never appear on the leaderboard
    # (gameplay/api.py: daily_info's `won=True` filter).
    score_ms = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        constraints = [
            # A lost/expired daily attempt may be retried (gameplay/api.py:
            # start_daily) — any number of non-winning rows per user per day
            # are allowed. Only a WIN locks the day: at most one row with
            # won=True per (user, daily_date).
            models.UniqueConstraint(
                fields=['user', 'daily_date'],
                condition=models.Q(daily_date__isnull=False) & models.Q(won=True),
                name='one_daily_win_per_user_per_day',
            ),
        ]
        indexes = [
            models.Index(fields=['created_at']),
            models.Index(fields=['daily_date', 'score_ms']),
        ]

    def __str__(self):
        return f'{self.token} ({self.level}, {self.status})'
