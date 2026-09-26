# Server-authoritative gameplay (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move field generation and the round-result check to the server (a django-ninja API in a new `gameplay/` app) for all players, including anonymous ones — so the client can no longer fake the field, the win, or the time.

**Architecture:** The server generates a guaranteed-solvable field (`gameplay/generator.py`, a Python port of `static/game/generator.js`, with no requirement for bit-for-bit parity with the JS) and stores it in a `GameSession` (a token session, not tied to a user). The client renders this field, plays locally (the client-side `static/game/board.js` remains for interactivity) and keeps a log of removed pairs by index. On finish, the server replays the log against the stored field (`gameplay/board.py`, a Python port of the freedom rule) and computes the time itself (`server_now − created_at`) — this is the anti-cheat mechanism. The client-side `generator.js`/`simulate.js` are removed as dead code.

**Tech Stack:** Django 6.0, django-ninja (typed API), PostgreSQL (already linked in production), Phaser 3.90 (client), Node test runner (JS tests), Django `TestCase` (Python tests).

## Global Constraints

- Ukrainian comments/docstrings in the new Python code — consistent with the repository's style (all existing comments in `static/game/*.js` are in Ukrainian).
- No PRNG bit-for-bit parity between `gameplay/generator.py` and `static/game/generator.js` is needed — the server is the single source of the field; the generator's only requirement is guaranteed solvability.
- Authorization, `PlayerStats`, leaderboard — **out of scope for this plan** (separate future plans).
- Tests: `uv run manage.py test` (Python) and `node --test 'tests/*.test.js'` (JS) must pass after each task, where applicable.
- Do not use an offline fallback to client-side generation — if `POST /api/game/start` fails, the game does not start (show an error).

---

### Task 1: `gameplay/board.py` — Python port of the freedom rule for replay

**Files:**
- Create: `gameplay/__init__.py` (empty)
- Create: `gameplay/board.py`
- Create: `gameplay/tests.py`

**Interfaces:**
- Produces: `gameplay.board.WIDTH`, `HEIGHT`, `LAYERS` (int), `target_positions() -> list[tuple[int,int,int]]`, `is_free_position(occupied, x, y, z) -> bool` (occupied — anything supporting `in` on an `(x,y,z)` tuple), a `Tile(idx, x, y, z, kind)` class with a `.pos() -> (x,y,z)` method, a `Board(tiles: Iterable[Tile])` class with methods `tiles()`, `get_by_idx(idx)`, `is_free(tile)`, `can_match(a,b)`, `remove_pair(a,b) -> bool`, `find_matching_pair() -> (Tile,Tile)|None`, a `remaining` property, methods `is_won()`, `is_deadlocked()`.

- [ ] **Step 1: Create the `gameplay/` app and write `board.py`**

`gameplay/__init__.py`:
```python
```
(empty file)

`gameplay/board.py`:
```python
"""Python port of static/game/board.js: the freedom rule (nothing on top +
free left/right side), pair matching, pair removal. The server uses this as
the authoritative check when replaying the move log (gameplay/api.py) — unlike
the client-side board.js, tiles here are indexed (idx = position in the
layout array that the server handed to the client at round start), because
the client sends the move log by these indices, not by objects."""

WIDTH = 12
HEIGHT = 8
LAYERS = 3

# The same "Turtle" layout as in static/game/board.js (description is there).
# '#' — cell present, '.' — empty; rows y=0..7, columns x=0..11.
_LAYER_BITMAPS = [
    ['############', '..########..', '.##########.', '############',
     '############', '.##########.', '..########..', '############'],
    ['............', '...######...', '...######...', '...######...',
     '...######...', '...######...', '...######...', '............'],
    ['............', '............', '....####....', '....####....',
     '....####....', '....####....', '............', '............'],
]


def target_positions():
    """136 target positions of the Turtle layout as (x, y, z) tuples."""
    out = []
    for z in range(LAYERS):
        for y in range(HEIGHT):
            for x in range(WIDTH):
                if _LAYER_BITMAPS[z][y][x] == '#':
                    out.append((x, y, z))
    return out


_TOTAL = len(target_positions())
if _TOTAL != 136:
    raise RuntimeError(f'target_positions: expected 136 positions, got {_TOTAL}')


def is_free_position(occupied, x, y, z):
    """occupied — anything supporting `in` on an (x, y, z) tuple (set/dict)."""
    if (x, y, z + 1) in occupied:
        return False
    return (x - 1, y, z) not in occupied or (x + 1, y, z) not in occupied


class Tile:
    __slots__ = ('idx', 'x', 'y', 'z', 'kind')

    def __init__(self, idx, x, y, z, kind):
        self.idx = idx
        self.x = x
        self.y = y
        self.z = z
        self.kind = kind

    def pos(self):
        return (self.x, self.y, self.z)


class Board:
    def __init__(self, tiles):
        self.by_pos = {}
        self.by_idx = {}
        for tile in tiles:
            self.by_pos[tile.pos()] = tile
            self.by_idx[tile.idx] = tile

    def tiles(self):
        return list(self.by_pos.values())

    def get_by_idx(self, idx):
        return self.by_idx.get(idx)

    def is_free(self, tile):
        if self.by_pos.get(tile.pos()) is not tile:
            return False
        return is_free_position(self.by_pos, tile.x, tile.y, tile.z)

    def can_match(self, a, b):
        return a is not b and a.kind == b.kind and self.is_free(a) and self.is_free(b)

    def remove_pair(self, a, b):
        if not self.can_match(a, b):
            return False
        del self.by_pos[a.pos()]
        del self.by_pos[b.pos()]
        del self.by_idx[a.idx]
        del self.by_idx[b.idx]
        return True

    def find_matching_pair(self):
        seen = {}
        for tile in self.by_pos.values():
            if not self.is_free(tile):
                continue
            partner = seen.get(tile.kind)
            if partner is not None:
                return partner, tile
            seen[tile.kind] = tile
        return None

    @property
    def remaining(self):
        return len(self.by_pos)

    def is_won(self):
        return len(self.by_pos) == 0

    def is_deadlocked(self):
        return len(self.by_pos) > 0 and self.find_matching_pair() is None
```

- [ ] **Step 2: Write tests for the freedom rule**

`gameplay/tests.py` (start of file):
```python
from django.test import TestCase

from .board import Board, Tile, is_free_position, target_positions


class BoardRuleTests(TestCase):
    def test_target_positions_is_136(self):
        self.assertEqual(len(target_positions()), 136)

    def test_is_free_position_blocked_by_tile_above(self):
        occupied = {(0, 0, 0), (0, 0, 1)}
        self.assertFalse(is_free_position(occupied, 0, 0, 0))

    def test_is_free_position_blocked_both_sides(self):
        occupied = {(1, 0, 0), (0, 0, 0), (2, 0, 0)}
        self.assertFalse(is_free_position(occupied, 1, 0, 0))

    def test_is_free_position_free_with_one_open_side(self):
        occupied = {(1, 0, 0), (0, 0, 0)}
        self.assertTrue(is_free_position(occupied, 1, 0, 0))

    def test_remove_pair_and_find_matching_pair(self):
        tiles = [Tile(0, 0, 0, 0, 'Man1'), Tile(1, 1, 0, 0, 'Man1')]
        board = Board(tiles)
        pair = board.find_matching_pair()
        self.assertIsNotNone(pair)
        self.assertTrue(board.remove_pair(*pair))
        self.assertTrue(board.is_won())

    def test_remove_pair_rejects_non_matching_and_covered(self):
        bottom = Tile(0, 0, 0, 0, 'Man1')
        top = Tile(1, 0, 0, 1, 'Pin1')
        board = Board([bottom, top])
        self.assertFalse(board.remove_pair(bottom, top))  # different kind
        self.assertFalse(board.is_free(bottom))  # covered from above

    def test_is_deadlocked_when_no_free_pair_exists(self):
        blocked_man = Tile(0, 1, 0, 0, 'Man1')
        pin1 = Tile(1, 0, 0, 0, 'Pin1')
        pin2 = Tile(2, 2, 0, 0, 'Pin2')
        free_man = Tile(3, 4, 4, 0, 'Man1')
        board = Board([pin1, blocked_man, pin2, free_man])
        self.assertIsNone(board.find_matching_pair())
        self.assertTrue(board.is_deadlocked())
        self.assertFalse(board.is_won())
```

- [ ] **Step 3: Create the app and register it in `INSTALLED_APPS`**

Edit `config/settings.py`:
```python
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'gameplay',
]
```

- [ ] **Step 4: Run the tests**

Run: `uv run manage.py test gameplay -v 2`
Expected: all `BoardRuleTests` PASS (0 errors).

- [ ] **Step 5: Commit**

```bash
git add gameplay/__init__.py gameplay/board.py gameplay/tests.py config/settings.py
git commit -m "feat: add gameplay app with server-side board rule port"
```

---

### Task 2: `gameplay/generator.py` — server-side generation of a solvable field

**Files:**
- Modify: `gameplay/tests.py` (add `GeneratorTests`)
- Create: `gameplay/generator.py`

**Interfaces:**
- Consumes: `gameplay.board.target_positions`, `is_free_position`, `Board`, `Tile` (from Task 1).
- Produces: `gameplay.generator.KINDS` (list[str], 34 elements), `DIFFICULTIES` (dict level → `{'placement': str, 'pair_scheduling': str}`), `generate_layout(rng, placement='uniform', pair_scheduling='random') -> list[tuple[int,int,int,str]]`, `generate_for_difficulty(level, seed=None) -> list[tuple[int,int,int,str]]` (136 `(x, y, z, kind)` tuples).

- [ ] **Step 1: Write `gameplay/generator.py`**

```python
"""Python port of the static/game/generator.js logic: generates a guaranteed-
solvable field by simulating the game in reverse (random free pairs are
removed from the full shape; the recorded order = the solution). Bit-for-bit
parity with the JS generator is NOT required — the server is the single
source of the field, the client only renders it; so there is no need for an
identical PRNG. Likewise, the winRateBand calibration (static/game/
simulate.js) is deliberately not ported: for anti-cheat purposes at this
stage, a guarantee of solvability is enough — level difficulty is emulated
only via placement/pair_scheduling.
"""
import random

from .board import is_free_position, target_positions

KINDS = [
    f'{suit}{i}'
    for suit in ('Man', 'Pin', 'Sou')
    for i in range(1, 10)
] + ['Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun']

DIFFICULTIES = {
    'easy': {'placement': 'surface', 'pair_scheduling': 'random'},
    'normal': {'placement': 'uniform', 'pair_scheduling': 'random'},
    'hard': {'placement': 'layered', 'pair_scheduling': 'grouped'},
}

MAX_ATTEMPTS = 100
SURFACE_ADJACENCY_BIAS = 1


def _shuffle(items, rng):
    items = list(items)
    for i in range(len(items) - 1, 0, -1):
        j = int(rng.random() * (i + 1))
        items[i], items[j] = items[j], items[i]
    return items


def _pick(items, rng):
    return items[int(rng.random() * len(items))]


def _expand(kind_pairs):
    out = []
    for kind, pairs in kind_pairs:
        out.extend([kind] * pairs)
    return out


def _build_pair_kinds(rng, pair_scheduling='random'):
    kinds = _shuffle(KINDS, rng)
    kind_pairs = [(k, 2) for k in kinds]

    if pair_scheduling == 'grouped':
        return _expand(kind_pairs)

    if pair_scheduling == 'split':
        bottom, top = [], []
        for kind, pairs in kind_pairs:
            half = pairs // 2
            bottom.extend([kind] * half)
            top.extend([kind] * (pairs - half))
        return _shuffle(bottom, rng) + _shuffle(top, rng)

    return _shuffle(_expand(kind_pairs), rng)


def is_adjacent(a, b):
    return a[2] == b[2] and abs(a[0] - b[0]) + abs(a[1] - b[1]) == 1


def _pick_surface_pair(free, rng):
    max_z = max(p[2] for p in free)
    top_free = [p for p in free if p[2] == max_z]
    if len(top_free) == 1:
        a = top_free[0]
        rest = [p for p in free if p != a]
        return a, _pick(rest, rng)
    if rng.random() < SURFACE_ADJACENCY_BIAS:
        adjacent_pairs = [
            (top_free[i], top_free[j])
            for i in range(len(top_free))
            for j in range(i + 1, len(top_free))
            if is_adjacent(top_free[i], top_free[j])
        ]
        if adjacent_pairs:
            return _pick(adjacent_pairs, rng)
    shuffled = _shuffle(top_free, rng)
    return shuffled[0], shuffled[1]


def _pick_spread_pair(free, rng, require_layer_split):
    a = _pick(free, rng)
    candidates = [p for p in free if p != a and not is_adjacent(p, a)]
    if require_layer_split:
        cross_layer = [p for p in candidates if p[2] != a[2]]
        if cross_layer:
            candidates = cross_layer
    if not candidates:
        candidates = [p for p in free if p != a]
    return a, _pick(candidates, rng)


def _try_generate(rng, placement='uniform', pair_scheduling='random'):
    occupied = set(target_positions())
    pair_kinds = _build_pair_kinds(rng, pair_scheduling)
    tiles = []
    while occupied:
        free = [p for p in occupied if is_free_position(occupied, *p)]
        # Dead end: tiles remain, but fewer than two are free — signal a
        # regeneration (the same condition as in generator.js).
        if len(free) < 2:
            return None
        if placement == 'surface':
            a, b = _pick_surface_pair(free, rng)
        else:
            a, b = _pick_spread_pair(free, rng, placement == 'layered')
        kind = pair_kinds.pop()
        tiles.append((a[0], a[1], a[2], kind))
        tiles.append((b[0], b[1], b[2], kind))
        occupied.discard(a)
        occupied.discard(b)
    return tiles


def generate_layout(rng, placement='uniform', pair_scheduling='random'):
    for _ in range(MAX_ATTEMPTS):
        tiles = _try_generate(rng, placement, pair_scheduling)
        if tiles is not None:
            return tiles
    raise RuntimeError('generate_layout: failed to avoid a dead end in 100 attempts')


def generate_for_difficulty(level, seed=None):
    """Returns a solvable field for a difficulty level: a list of 136
    (x, y, z, kind) tuples."""
    preset = DIFFICULTIES[level]
    rng = random.Random(seed)
    return generate_layout(rng, **preset)
```

- [ ] **Step 2: Write solvability tests (solver-verifier)**

Add to `gameplay/tests.py` (after the imports at the top of the file, update the import line and add the class):
```python
from .generator import DIFFICULTIES, generate_for_difficulty
```

```python
def _solve(tiles):
    """Greedy solver: removes any legal pair for as long as possible.
    True if the board is fully cleared — proves the field is solvable."""
    board = Board([Tile(i, x, y, z, kind) for i, (x, y, z, kind) in enumerate(tiles)])
    while board.remaining > 0:
        pair = board.find_matching_pair()
        if pair is None:
            return False
        board.remove_pair(*pair)
    return True


class GeneratorTests(TestCase):
    def test_generated_layout_is_solvable_across_seeds(self):
        for level in DIFFICULTIES:
            for seed in range(30):
                tiles = generate_for_difficulty(level, seed=seed)
                self.assertEqual(len(tiles), 136, f'{level} seed={seed}: expected 136 tiles')
                self.assertTrue(_solve(tiles), f'{level} seed={seed}: field is not solvable')

    def test_generated_layout_is_authentic_deck(self):
        tiles = generate_for_difficulty('normal', seed=1)
        kinds = [kind for _, _, _, kind in tiles]
        self.assertEqual(len(kinds), 136)
        for kind in set(kinds):
            self.assertEqual(kinds.count(kind), 4, f'{kind}: expected 4 copies')

    def test_generate_for_difficulty_deterministic_by_seed(self):
        a = generate_for_difficulty('hard', seed=42)
        b = generate_for_difficulty('hard', seed=42)
        self.assertEqual(a, b)
```

- [ ] **Step 3: Run the tests**

Run: `uv run manage.py test gameplay -v 2`
Expected: `BoardRuleTests` and `GeneratorTests` — all PASS. (900 generations — 3 levels × 30 seeds — may take a few seconds, which is expected.)

- [ ] **Step 4: Commit**

```bash
git add gameplay/generator.py gameplay/tests.py
git commit -m "feat: add server-side solvable layout generator"
```

---

### Task 3: `GameSession` model and migration

**Files:**
- Create: `gameplay/models.py`
- Create: `gameplay/admin.py`
- Create: `gameplay/migrations/0001_initial.py` (generated by `makemigrations`)

**Interfaces:**
- Produces: `gameplay.models.GameSession` — fields `token` (UUID, PK), `level` (str), `layout` (JSON, list of `{x,y,z,kind}`), `seed` (str), `created_at` (datetime, auto), `status` (`active`/`claimed`/`expired`), `claimed_at` (datetime|None), `elapsed_ms` (int|None), `won` (bool|None).

- [ ] **Step 1: Write the model**

`gameplay/models.py`:
```python
import uuid

from django.db import models


class GameSession(models.Model):
    """The server-side field of an active round — no FK to a user (works for
    anonymous players too). The token is the session secret, and only ever
    appears in the /api/game/start response.
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
```

- [ ] **Step 2: Register in the admin**

`gameplay/admin.py`:
```python
from django.contrib import admin

from .models import GameSession


@admin.register(GameSession)
class GameSessionAdmin(admin.ModelAdmin):
    list_display = ('token', 'level', 'status', 'won', 'elapsed_ms', 'created_at')
    list_filter = ('level', 'status', 'won')
    readonly_fields = ('token', 'layout', 'seed', 'created_at', 'claimed_at')
```

- [ ] **Step 3: Generate and run the migration**

Run: `uv run manage.py makemigrations gameplay`
Expected: `gameplay/migrations/0001_initial.py` created (creates `GameSession`).

Run: `uv run manage.py migrate`
Expected: `Applying gameplay.0001_initial... OK`.

- [ ] **Step 4: Commit**

```bash
git add gameplay/models.py gameplay/admin.py gameplay/migrations/
git commit -m "feat: add GameSession model for server-authoritative sessions"
```

---

### Task 4: django-ninja API — `/api/game/start` and `/api/game/finish`

**Files:**
- Create: `gameplay/api.py`
- Modify: `gameplay/tests.py` (add `GameApiTests`)
- Modify: `config/urls.py`

**Interfaces:**
- Consumes: `gameplay.board.Board`, `Tile` (Task 1); `gameplay.generator.DIFFICULTIES`, `generate_for_difficulty` (Task 2); `gameplay.models.GameSession` (Task 3).
- Produces: `gameplay.api.api` (an `NinjaAPI` instance) — HTTP `POST /api/game/start` (body `{level: str}` → `{token: uuid, layout: [{x,y,z,kind}, ...]}`), `POST /api/game/finish` (body `{token: uuid, moves: [[int,int], ...], outcome: "win"|"deadlock"}` → `{valid: bool, reason: str|None, won: bool, elapsed_ms: int|None}`).

- [ ] **Step 1: Install django-ninja**

Run: `uv add django-ninja`
Expected: `pyproject.toml`/`uv.lock` updated, `django-ninja` installed.

- [ ] **Step 2: Write `gameplay/api.py`**

```python
"""JSON API for the server-authoritative round. Public (auth=None) — works
for anonymous players too, authorization is out of scope for this stage.
CSRF is enabled (csrf=True) regardless of auth — a Django session/CSRF
cookie is issued to every visitor automatically via SessionMiddleware/
CsrfViewMiddleware.
"""
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone
from ninja import NinjaAPI, Schema
from ninja.errors import HttpError

from .board import Board, Tile
from .generator import DIFFICULTIES, generate_for_difficulty
from .models import GameSession

api = NinjaAPI(csrf=True)

SESSION_TTL = timedelta(hours=2)
RATE_LIMIT_WINDOW_SECONDS = 300
RATE_LIMIT_MAX_STARTS = 30
RATE_LIMIT_MAX_FINISHES = 60


def _client_ip(request):
    return request.META.get('REMOTE_ADDR', 'unknown')


def _rate_limited(request, action, limit):
    """A simple fixed-window per-IP counter quota via the Django cache."""
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
```

- [ ] **Step 3: Wire up the router in `config/urls.py`**

Replace the contents of `config/urls.py`:
```python
from django.contrib import admin
from django.urls import path
from django.views.generic import TemplateView

from config import views
from gameplay.api import api as gameplay_api

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/background/', views.background, name='background'),
    path('api/', gameplay_api.urls),
    path('', TemplateView.as_view(template_name='game.html'), name='home'),
]
```

- [ ] **Step 4: Write the API tests**

Add to `gameplay/tests.py` (update the imports at the top of the file, add the class):
```python
import uuid

from django.test import Client

from .api import api as gameplay_api  # noqa: F401 (registers the router when the test module is imported)
```

```python
class GameApiTests(TestCase):
    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _win_moves(self, layout):
        """A legal full solution for the given layout — via a greedy
        solver; returns the pair-index log in the format finish expects."""
        tiles = [Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(layout)]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        return moves

    def test_start_returns_136_tile_layout_and_valid_token(self):
        data = self._start()
        self.assertEqual(len(data['layout']), 136)
        uuid.UUID(data['token'])  # does not raise ValueError

    def test_start_rejects_unknown_level(self):
        response = self.client.post(
            '/api/game/start', data={'level': 'impossible'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_finish_accepts_valid_full_solution(self):
        data = self._start()
        moves = self._win_moves(data['layout'])
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = response.json()
        self.assertTrue(body['valid'], body)
        self.assertTrue(body['won'])
        self.assertIsInstance(body['elapsed_ms'], int)

    def test_finish_rejects_illegal_move(self):
        data = self._start()
        layout = data['layout']
        # Deliberately illegal pair: two tiles of different kinds (if they
        # happen to match by kind — take a different second tile). Reliably
        # illegal regardless of the generated layout, unlike an arbitrary [0,1].
        second_idx = next(
            i for i in range(1, len(layout)) if layout[i]['kind'] != layout[0]['kind']
        )
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [[0, second_idx]], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_finish_rejects_fake_win_without_clearing_board(self):
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_finish_rejects_replay_of_claimed_session(self):
        data = self._start()
        moves = self._win_moves(data['layout'])
        payload = {'token': data['token'], 'moves': moves, 'outcome': 'win'}
        first = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertTrue(first.json()['valid'])
        second = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertFalse(second.json()['valid'])

    def test_finish_rejects_unknown_token(self):
        response = self.client.post(
            '/api/game/finish',
            data={'token': str(uuid.uuid4()), 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_missing_csrf_token_is_rejected_when_enforced(self):
        # The Django test Client disables the CSRF check by default — here
        # we turn it on explicitly, to prove that NinjaAPI(csrf=True) really
        # protects the endpoint, not just sits in the config.
        strict_client = Client(enforce_csrf_checks=True)
        response = strict_client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)
```

- [ ] **Step 5: Run the tests**

Run: `uv run manage.py test gameplay -v 2`
Expected: all `BoardRuleTests`, `GeneratorTests`, `GameApiTests` — PASS.

- [ ] **Step 6: Manual check via the dev server**

Run:
```bash
uv run manage.py runserver &
sleep 2
curl -s -X POST http://127.0.0.1:8000/api/game/start -H 'Content-Type: application/json' -d '{"level":"easy"}' | head -c 300
kill %1
```
Expected: JSON with `"token"` (UUID) and `"layout"` (136 `{x,y,z,kind}` elements).

- [ ] **Step 7: Commit**

```bash
git add gameplay/api.py gameplay/tests.py config/urls.py pyproject.toml uv.lock
git commit -m "feat: add server-authoritative game start/finish API"
```

---

### Task 5: Client — `static/game/sync.js` (a thin HTTP client to the API)

**Files:**
- Create: `static/game/sync.js`
- Modify: `templates/game.html`

**Interfaces:**
- Consumes: `window.MAHJONG_CSRF` (string, injected in the template).
- Produces: `startGame(level: string) -> Promise<{token: string, layout: {x,y,z,kind}[]}>`, `finishGame(token: string, moves: [number,number][], outcome: 'win'|'deadlock') -> Promise<{valid: boolean, reason: string|null, won: boolean, elapsedMs: number|null}>`.

- [ ] **Step 1: Inject the CSRF token into the template**

In `templates/game.html`, before loading Phaser (line 148), add:
```html
<script>window.MAHJONG_CSRF = '{{ csrf_token }}';</script>
<script src="{% static 'vendor/phaser.min.js' %}"></script>
<script type="module" src="{% static 'game/main.js' %}"></script>
```

- [ ] **Step 2: Write `static/game/sync.js`**

```javascript
// Client to the server-side game API (gameplay/api.py): starting a round
// (the server generates the field and tracks it) and finishing it (the
// server replays the move log and computes the time itself) — see
// docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md.
// The CSRF token is taken from window.MAHJONG_CSRF (injected in templates/game.html).

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': window.MAHJONG_CSRF,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

// Returns { token, layout: [{x,y,z,kind}, ...] } — rendering takes positions
// from layout, and a tile's index in this array is its identifier for the moves log.
export async function startGame(level) {
  return postJson('/api/game/start', { level });
}

// moves — an array of pairs [idxA, idxB] (indices into the layout array from
// startGame, in the order pairs were removed). outcome — 'win' or 'deadlock'.
export async function finishGame(token, moves, outcome) {
  const data = await postJson('/api/game/finish', { token, moves, outcome });
  return {
    valid: data.valid,
    reason: data.reason ?? null,
    won: data.won,
    elapsedMs: data.elapsed_ms,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add static/game/sync.js templates/game.html
git commit -m "feat: add client for server-authoritative game API"
```

---

### Task 6: Remove client-side generation (`generator.js`, `simulate.js`) and move `KINDS`

**Files:**
- Modify: `static/game/board.js`
- Delete: `static/game/generator.js`
- Delete: `static/game/simulate.js`
- Delete: `tests/generator.test.js`
- Delete: `tests/simulate.test.js`

**Interfaces:**
- Produces: `static/game/board.js` now additionally exports `KINDS` (list[string], 34 elements — the same list that used to live in `generator.js`).

- [ ] **Step 1: Move `KINDS` into `board.js`**

Add at the top of `static/game/board.js` (before `export const WIDTH = 12;`):
```javascript
// Domain of tile kinds: 34 authentic riichi kinds (used to live in the
// now-deleted static/game/generator.js — generation is now server-side, gameplay/generator.py).
export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

```

- [ ] **Step 2: Delete the dead modules and tests**

Run:
```bash
git rm static/game/generator.js static/game/simulate.js tests/generator.test.js tests/simulate.test.js
```

- [ ] **Step 3: Run the JS tests**

Run: `node --test 'tests/*.test.js'`
Expected: `board.test.js` and `stats.test.js` PASS; `generator.test.js`/`simulate.test.js` no longer exist (do not run).

- [ ] **Step 4: Commit**

```bash
git add static/game/board.js
git commit -m "chore: remove dead client-side generator/simulate modules, move KINDS to board.js"
```

---

### Task 7: `main.js` — integrating start/finish via the server API

**Files:**
- Modify: `static/game/main.js`

**Interfaces:**
- Consumes: `startGame`, `finishGame` from `static/game/sync.js` (Task 5); `KINDS` now from `static/game/board.js` (Task 6).

- [ ] **Step 1: Update the imports**

Replace lines 1-2 of `static/game/main.js`:
```javascript
import { WIDTH, LAYERS, Board } from './board.js';
import { generateForDifficulty, KINDS } from './generator.js';
```
with:
```javascript
import { WIDTH, LAYERS, Board, KINDS } from './board.js';
import { startGame as apiStartGame, finishGame as apiFinishGame } from './sync.js';
```

- [ ] **Step 2: Initialize session/move-log state in `create()`**

In `create()` (right after `this.bgCredit = null;`, near line 226), add:
```javascript
    this.sessionToken = null;
    this.movesLog = [];
```

- [ ] **Step 3: Rewrite `startGame(level)` as an async request to the server**

Replace the `startGame(level)` method (lines 436-456):
```javascript
  async startGame(level) {
    this.currentLevel = level;
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;
    this.statusText.setText('⏳ Generating layout…');
    this.loadBackground();
    this.closeAllModals();

    let data;
    try {
      data = await apiStartGame(level);
    } catch {
      this.statusText.setText('⚠️ Could not start the game — check your connection');
      return;
    }

    this.sessionToken = data.token;
    this.movesLog = [];
    const tiles = data.layout.map((t, idx) => ({ ...t, idx }));
    this.board = new Board(tiles);
    for (const tile of this.board.tiles()) this.addTileSprite(tile);

    this.registry.set('gameHints', 0);
    this.registry.set('gameUndos', 0);
    this.registry.set('gamePairs', 0);
    this.registry.set('gameStartMs', Date.now());
    this.registry.set('gameElapsedMs', 0);
    this.registry.set('gameFinished', false);
    this.renderStats();

    this.updateStatus();
  }
```

- [ ] **Step 4: Track the move log in `removePair`**

In `removePair(a, b)` (lines 829-863), right after `if (!this.board.removePair(a, b)) return;`, add:
```javascript
    this.movesLog.push([a.idx, b.idx]);
```
(the line becomes:)
```javascript
  removePair(a, b) {
    if (!this.board.removePair(a, b)) return;
    this.movesLog.push([a.idx, b.idx]);
    this.selected = null;
    this.bumpCounter('gamePairs', 'pairsTotal');
```

- [ ] **Step 5: Sync the log on undo**

In `undo()` (lines 919-926), right after `const pair = this.board.undo(); if (!pair) return;`, add `this.movesLog.pop();`:
```javascript
  undo() {
    const pair = this.board.undo();
    if (!pair) return;
    this.movesLog.pop();
    this.deselect();
    for (const tile of pair) this.animateUndoTile(tile);
    this.bumpCounter('gameUndos', 'undosTotal');
    this.updateStatus();
  }
```

- [ ] **Step 6: Rewrite `finishGame(won)` — verification via the server before crediting**

Replace the `finishGame(won)` method (lines 551-564):
```javascript
  // Credits a finished round (win or deadlock) exactly once — only after
  // the server has confirmed the move log by replay (anti-cheat,
  // docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md).
  // Local lifetime stats update only on a confirmed result; the server
  // time (elapsedMs) is the source of truth, not the client's.
  async finishGame(won) {
    if (this.registry.get('gameFinished')) return;
    this.registry.set('gameFinished', true);

    const outcome = won ? 'win' : 'deadlock';
    let result;
    try {
      result = await apiFinishGame(this.sessionToken, this.movesLog, outcome);
    } catch {
      this.statusText.setText('⚠️ Could not confirm the round result');
      this.openStatsModal('⚠️ Round was not confirmed by the server');
      return;
    }

    if (!result.valid) {
      this.statusText.setText('⚠️ Round was not confirmed by the server');
      this.openStatsModal('⚠️ Round was not confirmed by the server');
      return;
    }

    this.registry.set('gameElapsedMs', result.elapsedMs);
    const updated = result.won
      ? applyWin(this.lifetimeStats(), result.elapsedMs)
      : applyLoss(this.lifetimeStats());
    this.updateLifetimeStats(updated);
    this.playEndEffect(result.won, () => {
      this.openStatsModal(result.won ? '🎉 Victory!' : '🚫 Deadlock — no moves left');
    });
  }
```

- [ ] **Step 7: Manual browser check (Claude-in-Chrome)**

Start the dev server (`uv run manage.py runserver`), open `http://127.0.0.1:8000/`, wait for the field (now loads from the server — status briefly shows "⏳ Generating layout…"), play a few pairs, undo, take the round to victory/deadlock. Check in the network console (`read_network_requests`) that `POST /api/game/start` and `POST /api/game/finish` were sent and returned `200` with `"valid": true`.
Expected: the game renders, the modal's stats update after victory/deadlock, no console errors.

- [ ] **Step 8: Commit**

```bash
git add static/game/main.js
git commit -m "feat: wire client to server-authoritative game start/finish"
```

---

### Task 8: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the "Game Structure" section**

In `CLAUDE.md`, in the list of game files:
- Remove the line about `static/game/generator.js` (deleted).
- Add a new entry: `gameplay/` — a Django app for server-side field generation and anti-cheat round validation (`board.py`, `generator.py` — Python ports of the client-side modules with no requirement for PRNG bit-for-bit parity; `models.py: GameSession` — a token session not tied to a user; `api.py` — django-ninja, `POST /api/game/start`/`POST /api/game/finish`, move-log replay, server-side time). See `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`.
- Clarify the description of `static/game/board.js`: now it remains only for client-side interactivity (render/clicks/undo/deadlock detection); the authoritative check is on the server (`gameplay/board.py`), the field comes from `POST /api/game/start`, not a local generator.
- Clarify the description of `static/game/main.js`: starting and finishing a round go through `static/game/sync.js` (HTTP to `gameplay/api.py`); without network access the game does not start (no offline fallback to local generation).

- [ ] **Step 2: Update the "Tests" section**

Add after the existing paragraph about `node --test`:
```markdown
Server-side logic (`gameplay/`: field generation, freedom rule, anti-cheat
round validation via the django-ninja API) — via Django tests:

```
uv run manage.py test gameplay
```
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document server-authoritative gameplay in CLAUDE.md"
```

---

### Task 9: Full end-to-end check

**Files:** (changes nothing — verification only)

- [ ] **Step 1: Full run of the Python tests**

Run: `uv run manage.py test`
Expected: all tests (`gameplay`) — PASS, 0 failures/errors.

- [ ] **Step 2: Full run of the JS tests**

Run: `node --test 'tests/*.test.js'`
Expected: `board.test.js`, `stats.test.js` — PASS. The files `generator.test.js`, `simulate.test.js` are absent (deleted in Task 6).

- [ ] **Step 3: Manual anti-cheat check**

Start the dev server, via `curl`/browser console:
```bash
uv run manage.py runserver &
sleep 2
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/game/start -H 'Content-Type: application/json' -d '{"level":"easy"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s -X POST http://127.0.0.1:8000/api/game/finish -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"moves\":[[0,1]],\"outcome\":\"win\"}"
kill %1
```
Expected: `{"valid":false,"reason":"illegal move","won":false,"elapsed_ms":null}` (or `"board not fully cleared"` if `[0,1]` happens to be a legal pair — the `test_finish_rejects_illegal_move` test in Task 4 covers this more reliably via a controlled layout).

- [ ] **Step 4: Browser check of the full game cycle**

Via Claude-in-Chrome: open `/`, play a round on each of the three levels (easy/normal/hard) to victory or deadlock, confirm that the stats (the "📊 Stats" modal) update correctly only after server confirmation.

---

## Plan self-check note

- **Spec coverage:** server-side generation (Task 2, 4), replay/validation (Task 4), server-side time (Task 4 `elapsed_ms`), one-time claim (Task 4 `status` check + test), works for anonymous users (model with no FK to User), removal of dead client-side code (Task 6), client integration (Task 5, 7), documentation (Task 8) — all covered.
- **Type consistency:** `Tile(idx, x, y, z, kind)` and `Board` with the same signature are used in `gameplay/board.py` (Task 1), the `gameplay/generator.py` tests (Task 2), and `gameplay/api.py`/its tests (Task 4). The client-side `movesLog` format `[idx, idx]` (an array, not a tuple — JSON) matches `moves: list[tuple[int,int]]` on the server (Pydantic accepts a 2-element array as a tuple). `elapsed_ms` (Python/JSON) → `elapsedMs` (JS, `sync.js` translates the key).
- **Scope:** authorization/leaderboard/stats sync are deliberately out of scope — separate future plans (see the project memory `auth-and-anticheat-roadmap`).
