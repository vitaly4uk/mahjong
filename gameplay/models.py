import uuid

from django.conf import settings
from django.db import models

from .stats import empty_all_stats


class Profile(models.Model):
    """Ігрові поля поверх стандартного django.contrib.auth.User — і для
    анонімних гравців (unusable password, автогенерований username,
    gameplay/middleware.py: PlayerIdentityMiddleware), і в майбутньому для
    Google-акаунтів через django-allauth (allauth приєднує SocialAccount до
    вже існуючого User замість зливання окремої моделі-ідентичності).
    """

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='profile')
    # Значення кукі mahjong_player, не User.pk — без розкриття послідовного ID.
    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    stats = models.JSONField(default=empty_all_stats)  # AllStats.model_dump(by_alias=True)
    legacy_imported = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.public_id} (imported={self.legacy_imported})'


class GameSession(models.Model):
    """Серверне поле активної партії. Токен — секрет сесії, живе лише у
    відповіді /api/game/start. `user` — nullable заради безболісної міграції
    існуючої таблиці без бекфілу (сесії живуть 2 години й швидко перетікають);
    новий код завжди проставляє це поле при старті партії.
    """

    class Status(models.TextChoices):
        ACTIVE = 'active', 'Active'
        CLAIMED = 'claimed', 'Claimed'
        EXPIRED = 'expired', 'Expired'

    token = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    level = models.CharField(max_length=16)
    layout = models.JSONField()
    seed = models.CharField(max_length=64)
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
