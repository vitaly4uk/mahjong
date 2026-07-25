"""Server-side generation of a guaranteed-solvable field by simulating the
game in reverse (random free pairs are removed from the full layout; the
recorded order is the solution). Bit-for-bit parity with any client generator
is NOT required — the server is the sole source of the field, the client only
renders it — so there's no need for an identical PRNG. Likewise winRateBand
calibration is deliberately not implemented: at this stage, a solvability
guarantee is enough for anti-cheat purposes — difficulty levels are emulated
only through placement/pair_scheduling.
"""
import random

from .board import FLOWERS, SEASONS, is_free_position, target_positions

# 34 regular riichi kinds (4 copies each = 2 pairs each). Flowers/seasons (1
# copy each, wildcard groups) are added separately — see _bonus_pairs.
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


def _bonus_pairs(rng):
    """4 flowers → 2 pairs of DIFFERENT flowers; 4 seasons → 2 pairs of
    DIFFERENT seasons. Thanks to wildcard matching, any pair from the same
    group can be removed together, so it's enough to deal each bonus kind
    exactly once."""
    out = []
    for group in (FLOWERS, SEASONS):
        g = _shuffle(group, rng)
        out.append((g[0], g[1]))
        out.append((g[2], g[3]))
    return out


def _build_pair_kinds(rng, pair_scheduling='random'):
    """A list of 72 (kindA, kindB) pairs — one per pair of tiles on the board:
    34 regular kinds × 2 identical pairs (kind, kind) = 68 + 4 bonus pairs."""
    kinds = _shuffle(KINDS, rng)
    bonus = _bonus_pairs(rng)

    if pair_scheduling == 'grouped':
        # Both copy-pairs of a kind next to each other; bonus pairs at the end.
        pairs = [(k, k) for k in kinds for _ in range(2)]
        return pairs + bonus

    if pair_scheduling == 'split':
        # One pair of each kind at the bottom and one at the top; bonuses scattered.
        bottom = [(k, k) for k in kinds] + [bonus[0], bonus[2]]
        top = [(k, k) for k in kinds] + [bonus[1], bonus[3]]
        return _shuffle(bottom, rng) + _shuffle(top, rng)

    pairs = [(k, k) for k in kinds for _ in range(2)] + bonus
    return _shuffle(pairs, rng)


def is_adjacent(a, b):
    """Adjacency on board.py's half-tile grid (a regular tile = a step of 2 in
    x or y, not 1 — see gameplay/board.py: WIDTH/HEIGHT and TURTLE_CELLS)."""
    if a[2] != b[2]:
        return False
    dx, dy = abs(a[0] - b[0]), abs(a[1] - b[1])
    return (dx == 2 and dy == 0) or (dx == 0 and dy == 2)


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
        # Dead end: tiles remain but fewer than two are free — signal a retry
        # (the same condition as in the old JS generator).
        if len(free) < 2:
            return None
        if placement == 'surface':
            a, b = _pick_surface_pair(free, rng)
        else:
            a, b = _pick_spread_pair(free, rng, placement == 'layered')
        kind_a, kind_b = pair_kinds.pop()
        tiles.append((a[0], a[1], a[2], kind_a))
        tiles.append((b[0], b[1], b[2], kind_b))
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
    """Returns a solvable field for the given difficulty level: a list of 144
    (x, y, z, kind) tuples."""
    preset = DIFFICULTIES[level]
    rng = random.Random(seed)
    return generate_layout(rng, **preset)
