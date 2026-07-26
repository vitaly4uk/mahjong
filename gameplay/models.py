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

    class Meta:
        indexes = [models.Index(fields=['created_at'])]

    def __str__(self):
        return f'{self.token} ({self.level}, {self.status})'
