"""JSON API для server-authoritative партії — Router, що монтується в
`config.api.api` під `/game` (кінцеві URL лишаються `/api/game/start`,
`/api/game/finish`). Публічний — працює й для анонімних гравців, авторизація
поза скоупом цього етапу. Auth (і CSRF-захист) успадковується від батьківського
`NinjaAPI(auth=CsrfOnly())` (`config/api.py`) — Router без власного `auth=`
нічого не перевизначає.
"""
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from .board import Board, Tile
from .generator import DIFFICULTIES, generate_for_difficulty
from .models import GameSession
from .schemas import FinishRequest, FinishResponse, StartRequest, StartResponse

router = Router()

SESSION_TTL = timedelta(hours=2)
RATE_LIMIT_WINDOW_SECONDS = 300
RATE_LIMIT_MAX_STARTS = 30
RATE_LIMIT_MAX_FINISHES = 60


def _client_ip(request):
    """Реальна IP клієнта: продакшен йде через Cloudflare Tunnel (див.
    CLAUDE.md), тож REMOTE_ADDR — адреса самого проксі, однакова для всіх
    гравців. CF-Connecting-IP — заголовок, який ставить сам Cloudflare з
    реальною IP клієнта; локально (без Cloudflare) його нема, тож fallback
    на REMOTE_ADDR лишається коректним для dev-сервера.
    """
    return request.META.get('HTTP_CF_CONNECTING_IP') or request.META.get('REMOTE_ADDR', 'unknown')


# Примітка: без окремого CACHES-бекенду (config/settings.py) Django
# використовує LocMemCache — лічильник per-процес, тож ефективний ліміт
# ≈ RATE_LIMIT_MAX_STARTS × кількість gunicorn-воркерів, не точний глобальний
# ліміт. Прийнятно для цього масштабу проєкту; якщо колись знадобиться точний
# ліміт — потрібен спільний кеш-бекенд (Redis/Memcached).
def _rate_limited(request, action, limit):
    """Проста фіксовано-вікнова лічильна квота на IP через Django cache."""
    key = f'gameplay:ratelimit:{action}:{_client_ip(request)}'
    count = cache.get(key, 0)
    if count >= limit:
        return True
    cache.set(key, count + 1, RATE_LIMIT_WINDOW_SECONDS)
    return False


@router.post('/start', response=StartResponse)
def start_game(request, payload: StartRequest):
    if payload.level not in DIFFICULTIES:
        raise HttpError(400, 'unknown level')
    if _rate_limited(request, 'start', RATE_LIMIT_MAX_STARTS):
        raise HttpError(429, 'too many new games, slow down')

    seed = uuid.uuid4().hex
    tiles = generate_for_difficulty(payload.level, seed=seed)
    layout = [{'x': x, 'y': y, 'z': z, 'kind': kind} for x, y, z, kind in tiles]

    session = GameSession.objects.create(level=payload.level, layout=layout, seed=seed)
    return {'token': session.token, 'layout': layout}


@router.post('/finish', response=FinishResponse)
def finish_game(request, payload: FinishRequest):
    if _rate_limited(request, 'finish', RATE_LIMIT_MAX_FINISHES):
        raise HttpError(429, 'too many requests, slow down')

    try:
        session = GameSession.objects.get(token=payload.token)
    except GameSession.DoesNotExist:
        return {'valid': False, 'reason': 'unknown session'}

    if session.status != GameSession.Status.ACTIVE:
        return {'valid': False, 'reason': 'session already claimed'}

    if timezone.now() - session.created_at > SESSION_TTL:
        session.status = GameSession.Status.EXPIRED
        session.save(update_fields=['status'])
        return {'valid': False, 'reason': 'session expired'}

    if payload.outcome not in ('win', 'deadlock'):
        return {'valid': False, 'reason': 'unknown outcome'}

    tiles = [
        Tile(idx, t['x'], t['y'], t['z'], t['kind'])
        for idx, t in enumerate(session.layout)
    ]
    board = Board(tiles)

    for a_idx, b_idx in payload.moves:
        a = board.get_by_idx(a_idx)
        b = board.get_by_idx(b_idx)
        if a is None or b is None or not board.remove_pair(a, b):
            return {'valid': False, 'reason': 'illegal move'}

    if payload.outcome == 'win' and not board.is_won():
        return {'valid': False, 'reason': 'board not fully cleared'}
    if payload.outcome == 'deadlock' and not board.is_deadlocked():
        return {'valid': False, 'reason': 'board is not deadlocked'}

    elapsed_ms = int((timezone.now() - session.created_at).total_seconds() * 1000)

    # Атомарний conditional UPDATE замикає claim-гонку: якщо два finish-запити
    # обидва прочитали status=ACTIVE до того, як хтось встиг записати CLAIMED,
    # у БД реально виконається лише один UPDATE (WHERE status='active'), другий
    # зматчить 0 рядків — ACTIVE->CLAIMED відбувається рівно один раз.
    claimed_count = GameSession.objects.filter(
        token=session.token, status=GameSession.Status.ACTIVE,
    ).update(
        status=GameSession.Status.CLAIMED,
        claimed_at=timezone.now(),
        elapsed_ms=elapsed_ms,
        won=payload.outcome == 'win',
    )
    if claimed_count == 0:
        return {'valid': False, 'reason': 'session already claimed'}

    return {'valid': True, 'won': payload.outcome == 'win', 'elapsed_ms': elapsed_ms}
