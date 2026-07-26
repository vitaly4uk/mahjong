"""JSON API for server-authoritative games — a Router mounted into
`config.api.api` under `/game` (the final URLs remain `/api/game/start`,
`/api/game/finish`, ...). Public — works for anonymous players too: player
identity (Profile/User) is resolved in `gameplay/middleware.py`
(PlayerIdentityMiddleware) and available here as `request.profile`. Auth (and
CSRF protection) is inherited from the parent `NinjaAPI(auth=CsrfOnly())`
(`config/api.py`) — a Router without its own `auth=` doesn't override
anything. `Router(by_alias=True)` — all response schemas are serialized with
camelCase field aliases (`gamesPlayed`, not `games_played`), as the client
expects.
"""
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from .board import Board, Tile
from .generator import DIFFICULTIES, generate_for_difficulty
from .layouts import get_layout
from .models import GameSession
from .schemas import (
    AllStats, BumpRequest, BumpResponse, FinishRequest, FinishResponse, ImportRequest,
    ImportResponse, SessionStateResponse, StartRequest, StartResponse, StatsResponse,
)
from .stats import apply_loss, apply_win, bump_counter, bump_started, merge_imported

router = Router(by_alias=True)

SESSION_TTL = timedelta(hours=2)
RATE_LIMIT_WINDOW_SECONDS = 300
RATE_LIMIT_MAX_STARTS = 30
RATE_LIMIT_MAX_FINISHES = 60
RATE_LIMIT_MAX_IMPORTS = 10


def _client_ip(request):
    """The client's real IP: production goes through Cloudflare Tunnel (see
    CLAUDE.md), so REMOTE_ADDR is the proxy's own address, the same for every
    player. CF-Connecting-IP is the header Cloudflare itself sets with the
    real client IP; locally (without Cloudflare) it's absent, so falling back
    to REMOTE_ADDR remains correct for the dev server.
    """
    return request.META.get('HTTP_CF_CONNECTING_IP') or request.META.get('REMOTE_ADDR', 'unknown')


# Note: without a dedicated CACHES backend (config/settings.py), Django uses
# LocMemCache — a per-process counter, so the effective limit is
# ≈ RATE_LIMIT_MAX_STARTS × the number of gunicorn workers, not an exact
# global limit. Acceptable at this project's scale; if an exact limit is ever
# needed, a shared cache backend (Redis/Memcached) is required.
def _rate_limited(request, action, limit):
    """A simple fixed-window per-IP rate quota via Django cache."""
    key = f'gameplay:ratelimit:{action}:{_client_ip(request)}'
    count = cache.get(key, 0)
    if count >= limit:
        return True
    cache.set(key, count + 1, RATE_LIMIT_WINDOW_SECONDS)
    return False


def _session_profile(request, session):
    """The player who STARTED this game (session.user), not necessarily the
    one making the current request — the semantically correct attribution
    for stats. Falls back to request.profile only for the transitional
    period (active sessions created before this release, still without a
    linked user)."""
    if session.user_id:
        return session.user.profile
    return request.profile


@router.post('/start', response=StartResponse)
def start_game(request, payload: StartRequest):
    if payload.level not in DIFFICULTIES:
        raise HttpError(400, 'unknown level')
    board = get_layout(payload.board)
    if board is None:
        raise HttpError(400, 'unknown board')
    if _rate_limited(request, 'start', RATE_LIMIT_MAX_STARTS):
        raise HttpError(429, 'too many new games, slow down')

    seed = uuid.uuid4().hex
    tiles = generate_for_difficulty(payload.level, board, seed=seed)
    layout = [{'x': x, 'y': y, 'z': z, 'kind': kind} for x, y, z, kind in tiles]

    session = GameSession.objects.create(
        level=payload.level, layout=layout, seed=seed, user=request.profile.user,
    )

    profile = request.profile
    all_stats = AllStats.model_validate(profile.stats)
    level_stats = bump_started(getattr(all_stats, payload.level))
    setattr(all_stats, payload.level, level_stats)
    profile.stats = all_stats.model_dump(by_alias=True)
    profile.save(update_fields=['stats', 'updated_at'])

    return {
        'token': session.token, 'layout': layout, 'stats': all_stats,
        'board_width': board.width, 'board_height': board.height, 'board_layers': board.layers,
    }


@router.get('/{uuid:token}', response=SessionStateResponse)
def session_state(request, token: uuid.UUID):
    """Session state for resuming a game after a page reload (the client
    keeps token+layout+move log in localStorage — main.js). The token-UUID
    itself is the session secret (the same principle as in bump), no extra
    authorization needed; GET doesn't go through CsrfOnly's CSRF check.
    Always 200 with a status field — the client needs a branch, not an
    exception."""
    try:
        session = GameSession.objects.get(token=token)
    except GameSession.DoesNotExist:
        return {'status': 'unknown'}

    if session.status != GameSession.Status.ACTIVE:
        return {'status': session.status}

    elapsed = timezone.now() - session.created_at
    if elapsed > SESSION_TTL:
        # Don't write to the DB — lazy EXPIRED marking is left to finish.
        return {'status': 'expired'}

    return {'status': 'active', 'elapsed_ms': int(elapsed.total_seconds() * 1000)}


@router.post('/{uuid:token}/bump', response=BumpResponse)
def bump_stat(request, token: uuid.UUID, payload: BumpRequest):
    try:
        session = GameSession.objects.select_related('user__profile').get(token=token)
    except GameSession.DoesNotExist:
        raise HttpError(400, 'unknown session')
    if session.status != GameSession.Status.ACTIVE:
        raise HttpError(400, 'session already claimed')

    profile = _session_profile(request, session)
    all_stats = AllStats.model_validate(profile.stats)
    updated = bump_counter(getattr(all_stats, session.level), payload.counter)
    setattr(all_stats, session.level, updated)
    profile.stats = all_stats.model_dump(by_alias=True)
    profile.save(update_fields=['stats', 'updated_at'])

    return {'stats': all_stats}


@router.post('/finish', response=FinishResponse)
def finish_game(request, payload: FinishRequest):
    if _rate_limited(request, 'finish', RATE_LIMIT_MAX_FINISHES):
        raise HttpError(429, 'too many requests, slow down')

    try:
        session = GameSession.objects.select_related('user__profile').get(token=payload.token)
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

    # An atomic conditional UPDATE closes the claim race: if two finish
    # requests both read status=ACTIVE before either managed to write
    # CLAIMED, only one UPDATE (WHERE status='active') actually takes effect
    # in the DB — the other matches 0 rows. ACTIVE->CLAIMED happens exactly once.
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

    profile = _session_profile(request, session)
    all_stats = AllStats.model_validate(profile.stats)
    level_stats = getattr(all_stats, session.level)
    updated = apply_win(level_stats, elapsed_ms) if payload.outcome == 'win' else apply_loss(level_stats)
    setattr(all_stats, session.level, updated)
    profile.stats = all_stats.model_dump(by_alias=True)
    profile.save(update_fields=['stats', 'updated_at'])

    return {'valid': True, 'won': payload.outcome == 'win', 'elapsed_ms': elapsed_ms, 'stats': all_stats}


@router.get('/stats', response=StatsResponse)
def get_stats(request):
    profile = request.profile
    return {
        'stats': AllStats.model_validate(profile.stats),
        'legacy_import_available': not profile.legacy_imported,
    }


@router.post('/stats/import', response=ImportResponse)
def import_stats(request, payload: ImportRequest):
    if _rate_limited(request, 'stats_import', RATE_LIMIT_MAX_IMPORTS):
        raise HttpError(429, 'too many requests, slow down')

    profile = request.profile
    if profile.legacy_imported:
        return {'imported': False, 'reason': 'already imported'}

    current = AllStats.model_validate(profile.stats)
    merged = merge_imported(current, payload.stats)
    profile.stats = merged.model_dump(by_alias=True)
    profile.legacy_imported = True
    profile.save(update_fields=['stats', 'legacy_imported', 'updated_at'])

    return {'imported': True, 'stats': merged}
