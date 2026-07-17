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
