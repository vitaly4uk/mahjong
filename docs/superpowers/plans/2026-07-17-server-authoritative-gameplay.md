# Server-authoritative gameplay (Етап 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести генерацію поля й перевірку результату партії на сервер (django-ninja API в новому застосунку `gameplay/`) для всіх гравців, включно з анонімними, — щоб клієнт більше не міг підробити ні поле, ні перемогу, ні час.

**Architecture:** Сервер генерує гарантовано розв'язне поле (`gameplay/generator.py`, Python-порт `static/game/generator.js`, без вимоги бітового паритету з JS) і зберігає його в `GameSession` (токен-сесія, без прив'язки до користувача). Клієнт рендерить це поле, грає локально (клієнтський `static/game/board.js` лишається для інтерактиву) і веде лог знятих пар за індексами. На фініші сервер реплеїть лог проти збереженого поля (`gameplay/board.py`, Python-порт правила вільності) і сам рахує час (`server_now − created_at`) — це і є анти-чит. Клієнтські `generator.js`/`simulate.js` видаляються як мертвий код.

**Tech Stack:** Django 6.0, django-ninja (типізований API), PostgreSQL (уже прилінкований на проді), Phaser 3.90 (клієнт), Node test runner (JS-тести), Django `TestCase` (Python-тести).

## Global Constraints

- Українські коментарі/докстрінги в новому Python-коді — узгоджено зі стилем репозиторію (усі наявні коментарі в `static/game/*.js` — українською).
- Жодного бітового паритету PRNG між `gameplay/generator.py` і `static/game/generator.js` не потрібно — сервер є єдиним джерелом поля; єдина вимога до генератора — гарантована розв'язність.
- Авторизація, `PlayerStats`, лідерборд — **поза скоупом цього плану** (окремі майбутні плани).
- Тести: `uv run manage.py test` (Python) і `node --test 'tests/*.test.js'` (JS) мають проходити після кожного завдання, де це застосовно.
- Не використовувати офлайн-фолбек на клієнтську генерацію — якщо `POST /api/game/start` не вдався, гра не починається (показуємо помилку).

---

### Task 1: `gameplay/board.py` — Python-порт правила вільності для реплею

**Files:**
- Create: `gameplay/__init__.py` (порожній)
- Create: `gameplay/board.py`
- Create: `gameplay/tests.py`

**Interfaces:**
- Produces: `gameplay.board.WIDTH`, `HEIGHT`, `LAYERS` (int), `target_positions() -> list[tuple[int,int,int]]`, `is_free_position(occupied, x, y, z) -> bool` (occupied — будь-що з підтримкою `in` за `(x,y,z)` кортежем), клас `Tile(idx, x, y, z, kind)` з методом `.pos() -> (x,y,z)`, клас `Board(tiles: Iterable[Tile])` з методами `tiles()`, `get_by_idx(idx)`, `is_free(tile)`, `can_match(a,b)`, `remove_pair(a,b) -> bool`, `find_matching_pair() -> (Tile,Tile)|None`, властивістю `remaining`, методами `is_won()`, `is_deadlocked()`.

- [ ] **Step 1: Створити застосунок `gameplay/` і написати `board.py`**

`gameplay/__init__.py`:
```python
```
(порожній файл)

`gameplay/board.py`:
```python
"""Python-порт static/game/board.js: правило вільності (ніхто зверху + вільний
лівий/правий бік), матчинг пар, зняття пари. Сервер використовує це як
авторитетну перевірку при реплеї логу ходів (gameplay/api.py) — на відміну
від клієнтського board.js, тут кістки індексовані (idx = позиція в масиві
layout, який сервер віддав клієнту при старті партії), бо клієнт шле лог
ходів саме за цими індексами, а не за об'єктами."""

WIDTH = 12
HEIGHT = 8
LAYERS = 3

# Та сама розкладка "Turtle", що й у static/game/board.js (опис — там-таки).
# '#' — клітинка є, '.' — порожньо; рядки y=0..7, колонки x=0..11.
_LAYER_BITMAPS = [
    ['############', '..########..', '.##########.', '############',
     '############', '.##########.', '..########..', '############'],
    ['............', '...######...', '...######...', '...######...',
     '...######...', '...######...', '...######...', '............'],
    ['............', '............', '....####....', '....####....',
     '....####....', '....####....', '............', '............'],
]


def target_positions():
    """136 цільових позицій Turtle-розкладки як (x, y, z) кортежі."""
    out = []
    for z in range(LAYERS):
        for y in range(HEIGHT):
            for x in range(WIDTH):
                if _LAYER_BITMAPS[z][y][x] == '#':
                    out.append((x, y, z))
    return out


_TOTAL = len(target_positions())
if _TOTAL != 136:
    raise RuntimeError(f'target_positions: очікувано 136 позицій, отримано {_TOTAL}')


def is_free_position(occupied, x, y, z):
    """occupied — будь-що з підтримкою `in` за (x, y, z) кортежем (set/dict)."""
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

- [ ] **Step 2: Написати тести правила вільності**

`gameplay/tests.py` (початок файлу):
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
        self.assertFalse(board.remove_pair(bottom, top))  # різний вид
        self.assertFalse(board.is_free(bottom))  # накрита зверху

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

- [ ] **Step 3: Створити застосунок і зареєструвати в `INSTALLED_APPS`**

Відредагувати `config/settings.py`:
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

- [ ] **Step 4: Прогнати тести**

Run: `uv run manage.py test gameplay -v 2`
Expected: усі тести `BoardRuleTests` PASS (0 errors).

- [ ] **Step 5: Commit**

```bash
git add gameplay/__init__.py gameplay/board.py gameplay/tests.py config/settings.py
git commit -m "feat: add gameplay app with server-side board rule port"
```

---

### Task 2: `gameplay/generator.py` — серверна генерація розв'язного поля

**Files:**
- Modify: `gameplay/tests.py` (додати `GeneratorTests`)
- Create: `gameplay/generator.py`

**Interfaces:**
- Consumes: `gameplay.board.target_positions`, `is_free_position`, `Board`, `Tile` (з Task 1).
- Produces: `gameplay.generator.KINDS` (list[str], 34 елементи), `DIFFICULTIES` (dict рівень → `{'placement': str, 'pair_scheduling': str}`), `generate_layout(rng, placement='uniform', pair_scheduling='random') -> list[tuple[int,int,int,str]]`, `generate_for_difficulty(level, seed=None) -> list[tuple[int,int,int,str]]` (136 кортежів `(x, y, z, kind)`).

- [ ] **Step 1: Написати `gameplay/generator.py`**

```python
"""Python-порт логіки static/game/generator.js: генерація гарантовано
розв'язного поля симуляцією зворотної гри (з повної форми знімаються
випадкові вільні пари; записаний порядок = розв'язок). Бітовий паритет із
JS-генератором НЕ потрібен — сервер є єдиним джерелом поля, клієнт лише
рендерить його; тому нема потреби в ідентичному PRNG. Так само свідомо не
портується winRateBand-калібрування (static/game/simulate.js): для
антирід-обстеження на цьому етапі достатньо гарантії розв'язності —
складність рівнів емулюється лише через placement/pair_scheduling.
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
        # Глухий кут: лишилися кості, але вільних менше двох — сигналізуємо
        # перегенерацію (та сама умова, що в generator.js).
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
    raise RuntimeError('generate_layout: не вдалося уникнути глухого кута за 100 спроб')


def generate_for_difficulty(level, seed=None):
    """Повертає розв'язне поле для рівня складності: список зі 136 кортежів
    (x, y, z, kind)."""
    preset = DIFFICULTIES[level]
    rng = random.Random(seed)
    return generate_layout(rng, **preset)
```

- [ ] **Step 2: Написати тести розв'язності (солвер-верифікатор)**

Додати в `gameplay/tests.py` (після імпортів на початку файлу оновити імпорт-рядок і додати клас):
```python
from .generator import DIFFICULTIES, generate_for_difficulty
```

```python
def _solve(tiles):
    """Жадібний солвер: знімає будь-яку легальну пару, поки можливо.
    True, якщо дошка повністю розібрана — доводить розв'язність поля."""
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
                self.assertEqual(len(tiles), 136, f'{level} seed={seed}: очікувано 136 кісток')
                self.assertTrue(_solve(tiles), f'{level} seed={seed}: поле нерозв\'язне')

    def test_generated_layout_is_authentic_deck(self):
        tiles = generate_for_difficulty('normal', seed=1)
        kinds = [kind for _, _, _, kind in tiles]
        self.assertEqual(len(kinds), 136)
        for kind in set(kinds):
            self.assertEqual(kinds.count(kind), 4, f'{kind}: очікувано 4 копії')

    def test_generate_for_difficulty_deterministic_by_seed(self):
        a = generate_for_difficulty('hard', seed=42)
        b = generate_for_difficulty('hard', seed=42)
        self.assertEqual(a, b)
```

- [ ] **Step 3: Прогнати тести**

Run: `uv run manage.py test gameplay -v 2`
Expected: `BoardRuleTests` і `GeneratorTests` — усі PASS. (900 генерацій — 3 рівні × 30 сідів — можуть зайняти кілька секунд, це очікувано.)

- [ ] **Step 4: Commit**

```bash
git add gameplay/generator.py gameplay/tests.py
git commit -m "feat: add server-side solvable layout generator"
```

---

### Task 3: `GameSession` модель і міграція

**Files:**
- Create: `gameplay/models.py`
- Create: `gameplay/admin.py`
- Create: `gameplay/migrations/0001_initial.py` (генерується `makemigrations`)

**Interfaces:**
- Produces: `gameplay.models.GameSession` — поля `token` (UUID, PK), `level` (str), `layout` (JSON, list of `{x,y,z,kind}`), `seed` (str), `created_at` (datetime, auto), `status` (`active`/`claimed`/`expired`), `claimed_at` (datetime|None), `elapsed_ms` (int|None), `won` (bool|None).

- [ ] **Step 1: Написати модель**

`gameplay/models.py`:
```python
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
```

- [ ] **Step 2: Реєстрація в адмінці**

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

- [ ] **Step 3: Згенерувати й прогнати міграцію**

Run: `uv run manage.py makemigrations gameplay`
Expected: створено `gameplay/migrations/0001_initial.py` (створює `GameSession`).

Run: `uv run manage.py migrate`
Expected: `Applying gameplay.0001_initial... OK`.

- [ ] **Step 4: Commit**

```bash
git add gameplay/models.py gameplay/admin.py gameplay/migrations/
git commit -m "feat: add GameSession model for server-authoritative sessions"
```

---

### Task 4: django-ninja API — `/api/game/start` і `/api/game/finish`

**Files:**
- Create: `gameplay/api.py`
- Modify: `gameplay/tests.py` (додати `GameApiTests`)
- Modify: `config/urls.py`

**Interfaces:**
- Consumes: `gameplay.board.Board`, `Tile` (Task 1); `gameplay.generator.DIFFICULTIES`, `generate_for_difficulty` (Task 2); `gameplay.models.GameSession` (Task 3).
- Produces: `gameplay.api.api` (an `NinjaAPI` instance) — HTTP `POST /api/game/start` (body `{level: str}` → `{token: uuid, layout: [{x,y,z,kind}, ...]}`), `POST /api/game/finish` (body `{token: uuid, moves: [[int,int], ...], outcome: "win"|"deadlock"}` → `{valid: bool, reason: str|None, won: bool, elapsed_ms: int|None}`).

- [ ] **Step 1: Встановити django-ninja**

Run: `uv add django-ninja`
Expected: `pyproject.toml`/`uv.lock` оновлені, `django-ninja` встановлено.

- [ ] **Step 2: Написати `gameplay/api.py`**

```python
"""JSON API для server-authoritative партії. Публічний (auth=None) — працює й
для анонімних гравців, авторизація поза скоупом цього етапу. CSRF увімкнено
(csrf=True) незалежно від auth — Django-сесія/CSRF-кука видається кожному
відвідувачу автоматично через SessionMiddleware/CsrfViewMiddleware.
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
```

- [ ] **Step 3: Підключити роутер у `config/urls.py`**

Замінити вміст `config/urls.py`:
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

- [ ] **Step 4: Написати API-тести**

Додати в `gameplay/tests.py` (оновити імпорти на початку файлу, додати клас):
```python
import uuid

from django.test import Client

from .api import api as gameplay_api  # noqa: F401 (реєструє роутер при імпорті тестового модуля)
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
        """Легальний повний розв'язок для заданого layout — жадібним
        солвером; повертає лог пар індексів у форматі, який очікує finish."""
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
        uuid.UUID(data['token'])  # не кидає ValueError

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
        # Свідомо нелегальна пара: дві кістки різного виду (якщо випадково
        # збіглися видом — беремо іншу другу кістку). Детерміновано нелегальна
        # незалежно від згенерованого layout, на відміну від довільних [0,1].
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
        # Django-тестовий Client за замовчуванням вимикає CSRF-перевірку —
        # тут вмикаємо її явно, щоб довести, що NinjaAPI(csrf=True) реально
        # захищає ендпоінт, а не просто присутній у конфігу.
        strict_client = Client(enforce_csrf_checks=True)
        response = strict_client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)
```

- [ ] **Step 5: Прогнати тести**

Run: `uv run manage.py test gameplay -v 2`
Expected: усі `BoardRuleTests`, `GeneratorTests`, `GameApiTests` — PASS.

- [ ] **Step 6: Ручна перевірка через dev-сервер**

Run:
```bash
uv run manage.py runserver &
sleep 2
curl -s -X POST http://127.0.0.1:8000/api/game/start -H 'Content-Type: application/json' -d '{"level":"easy"}' | head -c 300
kill %1
```
Expected: JSON з `"token"` (UUID) і `"layout"` (136 елементів `{x,y,z,kind}`).

- [ ] **Step 7: Commit**

```bash
git add gameplay/api.py gameplay/tests.py config/urls.py pyproject.toml uv.lock
git commit -m "feat: add server-authoritative game start/finish API"
```

---

### Task 5: Клієнт — `static/game/sync.js` (тонкий HTTP-клієнт до API)

**Files:**
- Create: `static/game/sync.js`
- Modify: `templates/game.html`

**Interfaces:**
- Consumes: `window.MAHJONG_CSRF` (string, ін'єктований у шаблоні).
- Produces: `startGame(level: string) -> Promise<{token: string, layout: {x,y,z,kind}[]}>`, `finishGame(token: string, moves: [number,number][], outcome: 'win'|'deadlock') -> Promise<{valid: boolean, reason: string|null, won: boolean, elapsedMs: number|null}>`.

- [ ] **Step 1: Інжектити CSRF-токен у шаблон**

У `templates/game.html` перед завантаженням Phaser (рядок 148), додати:
```html
<script>window.MAHJONG_CSRF = '{{ csrf_token }}';</script>
<script src="{% static 'vendor/phaser.min.js' %}"></script>
<script type="module" src="{% static 'game/main.js' %}"></script>
```

- [ ] **Step 2: Написати `static/game/sync.js`**

```javascript
// Клієнт до серверного API гри (gameplay/api.py): старт партії (сервер
// генерує поле й веде облік) і фініш (сервер реплеїть лог ходів і сам рахує
// час) — див. docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md.
// CSRF-токен береться з window.MAHJONG_CSRF (інжектиться в templates/game.html).

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

// Повертає { token, layout: [{x,y,z,kind}, ...] } — рендер бере позиції з
// layout, а індекс кістки в цьому масиві — її ідентифікатор для moves-логу.
export async function startGame(level) {
  return postJson('/api/game/start', { level });
}

// moves — масив пар [idxA, idxB] (індекси в масиві layout зі startGame,
// у порядку зняття пар). outcome — 'win' або 'deadlock'.
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

### Task 6: Прибрати клієнтську генерацію (`generator.js`, `simulate.js`) і перенести `KINDS`

**Files:**
- Modify: `static/game/board.js`
- Delete: `static/game/generator.js`
- Delete: `static/game/simulate.js`
- Delete: `tests/generator.test.js`
- Delete: `tests/simulate.test.js`

**Interfaces:**
- Produces: `static/game/board.js` тепер додатково експортує `KINDS` (list[string], 34 елементи — той самий список, що раніше жив у `generator.js`).

- [ ] **Step 1: Перенести `KINDS` у `board.js`**

Додати на початок `static/game/board.js` (перед `export const WIDTH = 12;`):
```javascript
// Домен видів кісток: 34 автентичні riichi-види (раніше жив у видаленому
// static/game/generator.js — генерація тепер серверна, gameplay/generator.py).
export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

```

- [ ] **Step 2: Видалити мертві модулі й тести**

Run:
```bash
git rm static/game/generator.js static/game/simulate.js tests/generator.test.js tests/simulate.test.js
```

- [ ] **Step 3: Прогнати JS-тести**

Run: `node --test 'tests/*.test.js'`
Expected: `board.test.js` і `stats.test.js` PASS; `generator.test.js`/`simulate.test.js` більше не існують (не запускаються).

- [ ] **Step 4: Commit**

```bash
git add static/game/board.js
git commit -m "chore: remove dead client-side generator/simulate modules, move KINDS to board.js"
```

---

### Task 7: `main.js` — інтеграція старту/фінішу через серверне API

**Files:**
- Modify: `static/game/main.js`

**Interfaces:**
- Consumes: `startGame`, `finishGame` з `static/game/sync.js` (Task 5); `KINDS` тепер з `static/game/board.js` (Task 6).

- [ ] **Step 1: Оновити імпорти**

Замінити рядки 1-2 `static/game/main.js`:
```javascript
import { WIDTH, LAYERS, Board } from './board.js';
import { generateForDifficulty, KINDS } from './generator.js';
```
на:
```javascript
import { WIDTH, LAYERS, Board, KINDS } from './board.js';
import { startGame as apiStartGame, finishGame as apiFinishGame } from './sync.js';
```

- [ ] **Step 2: Ініціалізувати стан сесії/логу ходів у `create()`**

У `create()` (одразу після `this.bgCredit = null;`, біля рядка 226), додати:
```javascript
    this.sessionToken = null;
    this.movesLog = [];
```

- [ ] **Step 3: Переписати `startGame(level)` на асинхронний запит до сервера**

Замінити метод `startGame(level)` (рядки 436-456):
```javascript
  async startGame(level) {
    this.currentLevel = level;
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;
    this.statusText.setText('⏳ Генерую розклад…');
    this.loadBackground();
    this.closeAllModals();

    let data;
    try {
      data = await apiStartGame(level);
    } catch {
      this.statusText.setText('⚠️ Не вдалося почати гру — перевірте з\'єднання');
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

- [ ] **Step 4: Вести лог ходів у `removePair`**

У `removePair(a, b)` (рядки 829-863), одразу після `if (!this.board.removePair(a, b)) return;`, додати:
```javascript
    this.movesLog.push([a.idx, b.idx]);
```
(рядок стає:)
```javascript
  removePair(a, b) {
    if (!this.board.removePair(a, b)) return;
    this.movesLog.push([a.idx, b.idx]);
    this.selected = null;
    this.bumpCounter('gamePairs', 'pairsTotal');
```

- [ ] **Step 5: Синхронізувати лог при undo**

У `undo()` (рядки 919-926), одразу після `const pair = this.board.undo(); if (!pair) return;`, додати `this.movesLog.pop();`:
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

- [ ] **Step 6: Переписати `finishGame(won)` — верифікація через сервер перед зарахуванням**

Замінити метод `finishGame(won)` (рядки 551-564):
```javascript
  // Зараховує завершену партію (перемога чи глухий кут) рівно один раз —
  // лише після того, як сервер підтвердив лог ходів реплеєм (анти-чит,
  // docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md).
  // Локальна lifetime-статистика оновлюється тільки за підтвердженим
  // результатом; серверний час (elapsedMs) — джерело істини, не клієнтський.
  async finishGame(won) {
    if (this.registry.get('gameFinished')) return;
    this.registry.set('gameFinished', true);

    const outcome = won ? 'win' : 'deadlock';
    let result;
    try {
      result = await apiFinishGame(this.sessionToken, this.movesLog, outcome);
    } catch {
      this.statusText.setText('⚠️ Не вдалося підтвердити результат партії');
      this.openStatsModal('⚠️ Партія не підтверджена сервером');
      return;
    }

    if (!result.valid) {
      this.statusText.setText('⚠️ Партія не підтверджена сервером');
      this.openStatsModal('⚠️ Партія не підтверджена сервером');
      return;
    }

    this.registry.set('gameElapsedMs', result.elapsedMs);
    const updated = result.won
      ? applyWin(this.lifetimeStats(), result.elapsedMs)
      : applyLoss(this.lifetimeStats());
    this.updateLifetimeStats(updated);
    this.playEndEffect(result.won, () => {
      this.openStatsModal(result.won ? '🎉 Перемога!' : '🚫 Глухий кут — немає ходів');
    });
  }
```

- [ ] **Step 7: Ручна браузерна перевірка (Claude-in-Chrome)**

Запустити dev-сервер (`uv run manage.py runserver`), відкрити `http://127.0.0.1:8000/`, дочекатись поля (тепер вантажиться з сервера — статус на мить показує «⏳ Генерую розклад…»), зіграти кілька пар, зробити undo, довести партію до перемоги/глухого кута. Перевірити в консолі мережі (`read_network_requests`), що `POST /api/game/start` і `POST /api/game/finish` пішли й повернули `200` з `"valid": true`.
Expected: гра рендериться, статистика в модалці оновлюється після перемоги/глухого кута, жодних помилок у консолі.

- [ ] **Step 8: Commit**

```bash
git add static/game/main.js
git commit -m "feat: wire client to server-authoritative game start/finish"
```

---

### Task 8: Оновити `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Оновити розділ «Структура гри»**

У `CLAUDE.md`, у списку файлів гри:
- Прибрати рядок про `static/game/generator.js` (видалений).
- Додати новий пункт: `gameplay/` — Django-застосунок серверної генерації поля й антирід-валідації партії (`board.py`, `generator.py` — Python-порти клієнтських модулів без вимоги бітового паритету PRNG; `models.py: GameSession` — токен-сесія без прив'язки до користувача; `api.py` — django-ninja, `POST /api/game/start`/`POST /api/game/finish`, реплей логу ходів, серверний час). Див. `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`.
- Уточнити опис `static/game/board.js`: тепер лишається лише для клієнтського інтерактиву (рендер/кліки/undo/детекція глухого кута); авторитетна перевірка — на сервері (`gameplay/board.py`), поле надходить з `POST /api/game/start`, а не з локального генератора.
- Уточнити опис `static/game/main.js`: старт і фініш партії йдуть через `static/game/sync.js` (HTTP до `gameplay/api.py`); без мережі гра не починається (без офлайн-фолбеку на локальну генерацію).

- [ ] **Step 2: Оновити розділ «Тести»**

Додати після наявного абзацу про `node --test`:
```markdown
Серверна логіка (`gameplay/`: генерація поля, правило вільності, антирід-валідація
партії через django-ninja API) — Django-тестами:

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

### Task 9: Повна наскрізна перевірка

**Files:** (нічого не змінює — лише верифікація)

- [ ] **Step 1: Повний прогін Python-тестів**

Run: `uv run manage.py test`
Expected: усі тести (`gameplay`) — PASS, 0 failures/errors.

- [ ] **Step 2: Повний прогін JS-тестів**

Run: `node --test 'tests/*.test.js'`
Expected: `board.test.js`, `stats.test.js` — PASS. Файли `generator.test.js`, `simulate.test.js` відсутні (видалені в Task 6).

- [ ] **Step 3: Ручна перевірка анти-читу**

Запустити dev-сервер, через `curl`/консоль браузера:
```bash
uv run manage.py runserver &
sleep 2
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/game/start -H 'Content-Type: application/json' -d '{"level":"easy"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s -X POST http://127.0.0.1:8000/api/game/finish -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"moves\":[[0,1]],\"outcome\":\"win\"}"
kill %1
```
Expected: `{"valid":false,"reason":"illegal move","won":false,"elapsed_ms":null}` (або `"board not fully cleared"`, якщо `[0,1]` випадково легальна пара — тест `test_finish_rejects_illegal_move` у Task 4 покриває це надійніше через контрольований layout).

- [ ] **Step 4: Браузерна перевірка повного циклу гри**

Через Claude-in-Chrome: відкрити `/`, зіграти партію на кожному з трьох рівнів (easy/normal/hard) до перемоги чи глухого кута, переконатись, що статистика (модалка «📊 Статистика») коректно оновлюється лише після серверного підтвердження.

---

## Спец-примітка щодо самоперевірки плану

- **Spec coverage:** генерація на сервері (Task 2, 4), реплей/валідація (Task 4), серверний час (Task 4 `elapsed_ms`), одноразовий claim (Task 4 `status`-перевірка + тест), robота для анонімів (модель без FK на User), прибирання клієнтського мертвого коду (Task 6), клієнтська інтеграція (Task 5, 7), документація (Task 8) — усе покрито.
- **Type consistency:** `Tile(idx, x, y, z, kind)` і `Board` з однаковою сигнатурою використовуються в `gameplay/board.py` (Task 1), `gameplay/generator.py`-тестах (Task 2) і `gameplay/api.py`/тестах (Task 4). Клієнтський `movesLog` формат `[idx, idx]` (масив, не кортеж — JSON) відповідає `moves: list[tuple[int,int]]` на сервері (Pydantic приймає масив із 2 елементів як tuple). `elapsed_ms` (Python/JSON) → `elapsedMs` (JS, `sync.js` перекладає ключ).
- **Scope:** авторизація/лідерборд/синхронізація статистики свідомо не входять — окремі майбутні плани (див. пам'ять проєкту `auth-and-anticheat-roadmap`).
