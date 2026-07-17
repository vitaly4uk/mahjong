import uuid

from django.db import models


class GameSession(models.Model):
    """Серверне поле активної партії — без FK на користувача (працює й для
    анонімів). Токен — секрет сесії, живе лише у відповіді /api/game/start.
    """

    class Status(models.TextChoices):
        ACTIVE = 'active', 'Active'
        CLAIMED = 'claimed', 'Claimed'
        EXPIRED = 'expired', 'Expired'

    token = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    level = models.CharField(max_length=16)
    layout = models.JSONField()
    seed = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    claimed_at = models.DateTimeField(null=True, blank=True)
    elapsed_ms = models.PositiveIntegerField(null=True, blank=True)
    won = models.BooleanField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=['created_at'])]

    def __str__(self):
        return f'{self.token} ({self.level}, {self.status})'
