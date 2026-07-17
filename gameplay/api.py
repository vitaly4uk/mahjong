"""JSON API для server-authoritative партії. Публічний — працює й для
анонімних гравців, авторизація поза скоупом цього етапу. CSRF увімкнено
незалежно від автентифікації: django-ninja >=1.6 прибрав параметр
`NinjaAPI(csrf=True)` — CSRF-перевірка тепер прив'язана до auth-класів на
кшталт `APIKeyCookie` (див. ninja.security.apikey). Тому нижче — свій
"порожній" auth-клас `CsrfOnly`: він нікого не автентифікує (завжди пускає),
але примусово виконує ту саму CSRF-перевірку, що й `APIKeyCookie(csrf=True)`.
Django-сесія/CSRF-кука видається кожному відвідувачу автоматично через
SessionMiddleware/CsrfViewMiddleware.
"""
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone
from ninja import NinjaAPI, Schema
from ninja.errors import HttpError
from ninja.security import APIKeyCookie

from .board import Board, Tile
from .generator import DIFFICULTIES, generate_for_difficulty
from .models import GameSession


class CsrfOnly(APIKeyCookie):
    """Auth-заглушка: не перевіряє жодного ключа/сесії (пускає анонімів), але
    успадкований `_get_key` з `APIKeyCookie(csrf=True)` примусово ганяє
    Django CSRF-перевірку перед кожним запитом."""

    def authenticate(self, request, key):
        return True


api = NinjaAPI(auth=CsrfOnly())

SESSION_TTL = timedelta(hours=2)
RATE_LIMIT_WINDOW_SECONDS = 300
RATE_LIMIT_MAX_STARTS = 30
RATE_LIMIT_MAX_FINISHES = 60


def _client_ip(request):
    return request.META.get('REMOTE_ADDR', 'unknown')


def _rate_limited(request, action, limit):
    """Проста фіксовано-вікнова лічильна квота на IP через Django cache."""
    key = f'gameplay:ratelimit:{action}:{_client_ip(request)}'
    count = cache.get(key, 0)
    if count >= limit:
        return True
    cache.set(key, count + 1, RATE_LIMIT_WINDOW_SECONDS)
    return False


class StartRequest(Schema):
    level: str


class TileOut(Schema):
    x: int
    y: int
    z: int
    kind: str


class StartResponse(Schema):
    token: uuid.UUID
    layout: list[TileOut]


class FinishRequest(Schema):
    token: uuid.UUID
    moves: list[tuple[int, int]]
    outcome: str


class FinishResponse(Schema):
    valid: bool
    reason: str | None = None
    won: bool = False
    elapsed_ms: int | None = None


@api.post('/game/start', response=StartResponse)
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


@api.post('/game/finish', response=FinishResponse)
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
    session.status = GameSession.Status.CLAIMED
    session.claimed_at = timezone.now()
    session.elapsed_ms = elapsed_ms
    session.won = payload.outcome == 'win'
    session.save(update_fields=['status', 'claimed_at', 'elapsed_ms', 'won'])

    return {'valid': True, 'won': session.won, 'elapsed_ms': elapsed_ms}
