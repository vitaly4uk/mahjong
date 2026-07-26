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
import random
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone
from django.utils.translation import gettext as _
from ninja import Router
from ninja.errors import HttpError

from .board import Board, Tile
from .generator import DIFFICULTIES, generate_for_difficulty, reshuffle_layout
from .layouts import get_layout
from .models import GameSession
from .schemas import (
    AllStats,
    BumpRequest,
    BumpResponse,
    FinishRequest,
    FinishResponse,
    ImportRequest,
    ImportResponse,
    SessionStateResponse,
    ShuffleRequest,
    ShuffleResponse,
    StartRequest,
    StartResponse,
    StatsResponse,
)
from .stats import apply_loss, apply_win, bump_counter, merge_imported, update_level_stats

router = Router(by_alias=True)

SESSION_TTL = timedelta(hours=2)
RATE_LIMIT_WINDOW_SECONDS = 300
RATE_LIMIT_MAX_STARTS = 30
RATE_LIMIT_MAX_FINISHES = 60
RATE_LIMIT_MAX_IMPORTS = 10
RATE_LIMIT_MAX_SHUFFLES = 60


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


def _enforce_rate_limit(request, action, limit):
    if _rate_limited(request, action, limit):
        raise HttpError(429, _('too many requests, slow down'))


def _session_elapsed(session):
    return timezone.now() - session.created_at


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
        raise HttpError(400, _('unknown level'))
    board = get_layout(payload.board)
    if board is None:
        raise HttpError(400, _('unknown board'))
    _enforce_rate_limit(request, 'start', RATE_LIMIT_MAX_STARTS)

    seed = uuid.uuid4().hex
    tiles = generate_for_difficulty(payload.level, board, seed=seed)
    layout = [{'x': x, 'y': y, 'z': z, 'kind': kind} for x, y, z, kind in tiles]

    session = GameSession.objects.create(
        level=payload.level, layout=layout, seed=seed, user=request.profile.user,
    )

    all_stats = update_level_stats(
        request.profile, payload.level, lambda s: bump_counter(s, 'start'),
    )

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

    elapsed = _session_elapsed(session)
    if elapsed > SESSION_TTL:
        # Don't write to the DB — lazy EXPIRED marking is left to finish.
        return {'status': 'expired'}

    return {'status': 'active', 'elapsed_ms': int(elapsed.total_seconds() * 1000)}


@router.post('/{uuid:token}/bump', response=BumpResponse)
def bump_stat(request, token: uuid.UUID, payload: BumpRequest):
    try:
        session = GameSession.objects.select_related('user__profile').get(token=token)
    except GameSession.DoesNotExist:
        raise HttpError(400, _('unknown session')) from None
    if session.status != GameSession.Status.ACTIVE:
        raise HttpError(400, _('session already claimed'))

    profile = _session_profile(request, session)
    all_stats = update_level_stats(
        profile, session.level, lambda s: bump_counter(s, payload.counter),
    )

    return {'stats': all_stats}


def _replay(session, moves):
    """Rebuilds a Board from session.layout and replays `moves` (pairs of
    idx, in removal order), applying session.shuffles at their recorded
    anchors (gameplay/models.py: GameSession.shuffles) — a shuffle only
    changes kinds, never positions, so it can be applied in-place to the
    tiles already on the board. `after_moves` is the move-log length at the
    moment of that shuffle, so applying it right before processing the move
    at that same index reproduces exactly the kinds the client was looking
    at when it made that move. Returns the resulting Board, or None on the
    first illegal move (a corrupted/forged log)."""
    tiles = [
        Tile(idx, t['x'], t['y'], t['z'], t['kind'])
        for idx, t in enumerate(session.layout)
    ]
    board = Board(tiles)
    shuffles_by_anchor = {s['after_moves']: s['kinds'] for s in session.shuffles}

    def apply_shuffle(anchor):
        kinds = shuffles_by_anchor.get(anchor)
        if not kinds:
            return
        for idx_str, kind in kinds.items():
            tile = board.get_by_idx(int(idx_str))
            if tile is not None:
                tile.kind = kind

    apply_shuffle(0)
    for i, (a_idx, b_idx) in enumerate(moves):
        a = board.get_by_idx(a_idx)
        b = board.get_by_idx(b_idx)
        if a is None or b is None or not board.remove_pair(a, b):
            return None
        apply_shuffle(i + 1)
    return board


@router.post('/{uuid:token}/shuffle', response=ShuffleResponse)
def shuffle_game(request, token: uuid.UUID, payload: ShuffleRequest):
    """Reshuffles the kinds of whatever tiles remain on the board — offered
    to the player as an alternative to giving up on a dead end (main.js:
    updateStatus()). Positions never move (the finish move-log is indexed by
    position, gameplay/board.py), and the new arrangement is generated the
    same way as a fresh deal (generator.py: reshuffle_layout) — guaranteed
    solvable, never a repeat dead end."""
    _enforce_rate_limit(request, 'shuffle', RATE_LIMIT_MAX_SHUFFLES)

    try:
        session = GameSession.objects.select_related('user__profile').get(token=token)
    except GameSession.DoesNotExist:
        raise HttpError(400, _('unknown session')) from None
    if session.status != GameSession.Status.ACTIVE:
        raise HttpError(400, _('session already claimed'))
    if _session_elapsed(session) > SESSION_TTL:
        raise HttpError(400, _('session expired'))

    moves = payload.moves
    profile = _session_profile(request, session)

    # Idempotent replay of a duplicate/concurrent request: the client only
    # ever shuffles once per dead end, so a second request with the same
    # move-log length is a retry, not a new shuffle — hand back the mapping
    # already recorded instead of generating (and charging for) another one.
    if session.shuffles and session.shuffles[-1]['after_moves'] == len(moves):
        kinds = {int(idx_str): kind for idx_str, kind in session.shuffles[-1]['kinds'].items()}
        return {'kinds': kinds, 'stats': AllStats.model_validate(profile.stats)}

    board = _replay(session, moves)
    if board is None:
        raise HttpError(400, _('illegal move'))
    if not board.is_deadlocked():
        raise HttpError(400, _('board is not deadlocked'))

    remaining = board.tiles()
    pos_to_idx = {tile.pos(): tile.idx for tile in remaining}
    placement = DIFFICULTIES[session.level]['placement']
    rng = random.Random(uuid.uuid4().hex)
    reshuffled = reshuffle_layout(
        rng, [tile.pos() for tile in remaining], [tile.kind for tile in remaining], placement,
    )
    kinds = {pos_to_idx[(x, y, z)]: kind for x, y, z, kind in reshuffled}

    session.shuffles.append({
        'after_moves': len(moves),
        'kinds': {str(idx): kind for idx, kind in kinds.items()},
    })
    session.save(update_fields=['shuffles'])

    all_stats = update_level_stats(profile, session.level, lambda s: bump_counter(s, 'shuffle'))
    return {'kinds': kinds, 'stats': all_stats}


@router.post('/finish', response=FinishResponse)
def finish_game(request, payload: FinishRequest):
    _enforce_rate_limit(request, 'finish', RATE_LIMIT_MAX_FINISHES)

    try:
        session = GameSession.objects.select_related('user__profile').get(token=payload.token)
    except GameSession.DoesNotExist:
        return {'valid': False, 'reason': _('unknown session')}

    if session.status != GameSession.Status.ACTIVE:
        return {'valid': False, 'reason': _('session already claimed')}

    if _session_elapsed(session) > SESSION_TTL:
        session.status = GameSession.Status.EXPIRED
        session.save(update_fields=['status'])
        return {'valid': False, 'reason': _('session expired')}

    if payload.outcome not in ('win', 'deadlock'):
        return {'valid': False, 'reason': _('unknown outcome')}

    board = _replay(session, payload.moves)
    if board is None:
        return {'valid': False, 'reason': _('illegal move')}

    if payload.outcome == 'win' and not board.is_won():
        return {'valid': False, 'reason': _('board not fully cleared')}
    if payload.outcome == 'deadlock' and not board.is_deadlocked():
        return {'valid': False, 'reason': _('board is not deadlocked')}

    # A fresh reading (not reusing the TTL check's elapsed above) — this one
    # must reflect time up to the actual claim, after move validation.
    elapsed_ms = int(_session_elapsed(session).total_seconds() * 1000)

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
        return {'valid': False, 'reason': _('session already claimed')}

    profile = _session_profile(request, session)
    mutator = (lambda s: apply_win(s, elapsed_ms)) if payload.outcome == 'win' else apply_loss
    all_stats = update_level_stats(profile, session.level, mutator)

    return {
        'valid': True, 'won': payload.outcome == 'win',
        'elapsed_ms': elapsed_ms, 'stats': all_stats,
    }


@router.get('/stats', response=StatsResponse)
def get_stats(request):
    profile = request.profile
    return {
        'stats': AllStats.model_validate(profile.stats),
        'legacy_import_available': not profile.legacy_imported,
    }


@router.post('/stats/import', response=ImportResponse)
def import_stats(request, payload: ImportRequest):
    _enforce_rate_limit(request, 'stats_import', RATE_LIMIT_MAX_IMPORTS)

    profile = request.profile
    if profile.legacy_imported:
        return {'imported': False, 'reason': _('already imported')}

    current = AllStats.model_validate(profile.stats)
    merged = merge_imported(current, payload.stats)
    profile.stats = merged.model_dump(by_alias=True)
    profile.legacy_imported = True
    profile.save(update_fields=['stats', 'legacy_imported', 'updated_at'])

    return {'imported': True, 'stats': merged}
