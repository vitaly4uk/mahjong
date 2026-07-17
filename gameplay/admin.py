from django.contrib import admin

from .models import GameSession


@admin.register(GameSession)
class GameSessionAdmin(admin.ModelAdmin):
    list_display = ('token', 'level', 'status', 'won', 'elapsed_ms', 'created_at')
    list_filter = ('level', 'status', 'won')
    readonly_fields = ('token', 'layout', 'seed', 'created_at', 'claimed_at')
