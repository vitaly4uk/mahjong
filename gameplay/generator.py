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
from collections import defaultdict

from .board import FLOWERS, SEASONS, is_free_position, match_key

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


def _bonus_pairs(rng):
    """4 flowers → 2 pairs of DIFFERENT flowers; 4 seasons → 2 pairs of
    DIFFERENT seasons. Thanks to wildcard matching, any pair from the same
    group can be removed together, so it's enough to deal each bonus kind
    exactly once."""
    out = []
    for group in (FLOWERS, SEASONS):
        g = list(group)
        rng.shuffle(g)
        out.append((g[0], g[1]))
        out.append((g[2], g[3]))
    return out


def _build_pair_kinds(rng, pair_scheduling='random'):
    """A list of 72 (kindA, kindB) pairs — one per pair of tiles on the board:
    34 regular kinds × 2 identical pairs (kind, kind) = 68 + 4 bonus pairs."""
    kinds = list(KINDS)
    rng.shuffle(kinds)
    bonus = _bonus_pairs(rng)
    doubled = [(k, k) for k in kinds for _ in range(2)]

    if pair_scheduling == 'grouped':
        # Both copy-pairs of a kind next to each other; bonus pairs at the end.
        return doubled + bonus

    if pair_scheduling == 'split':
        # One pair of each kind at the bottom and one at the top; bonuses scattered.
        bottom = [(k, k) for k in kinds] + [bonus[0], bonus[2]]
        top = [(k, k) for k in kinds] + [bonus[1], bonus[3]]
        rng.shuffle(bottom)
        rng.shuffle(top)
        return bottom + top

    pairs = doubled + bonus
    rng.shuffle(pairs)
    return pairs


def is_adjacent(a, b):
    """Adjacency on board.py's half-tile grid (a regular tile = a step of 2 in
    x or y, not 1 — see gameplay/board.py's module docstring)."""
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
        return a, rng.choice(rest)
    if rng.random() < SURFACE_ADJACENCY_BIAS:
        adjacent_pairs = [
            (top_free[i], top_free[j])
            for i in range(len(top_free))
            for j in range(i + 1, len(top_free))
            if is_adjacent(top_free[i], top_free[j])
        ]
        if adjacent_pairs:
            return rng.choice(adjacent_pairs)
    shuffled = list(top_free)
    rng.shuffle(shuffled)
    return shuffled[0], shuffled[1]


def _pick_spread_pair(free, rng, require_layer_split):
    a = rng.choice(free)
    candidates = [p for p in free if p != a and not is_adjacent(p, a)]
    if require_layer_split:
        cross_layer = [p for p in candidates if p[2] != a[2]]
        if cross_layer:
            candidates = cross_layer
    if not candidates:
        candidates = [p for p in free if p != a]
    return a, rng.choice(candidates)


def _remnant_pairs(rng, kinds):
    """Builds (kindA, kindB) pairs out of an arbitrary multiset of remaining
    kinds (used by reshuffle_layout — the deck left on the board after some
    pairs have already been removed, not the full 72-pair deck). Groups by
    match_key (board.py) — regular kinds pair with themselves, flowers pair
    with any other flower, seasons with any other season — since each group's
    count is always even (removals happen two-at-a-time within a group),
    pairing within the group never leaves a leftover."""
    by_group = defaultdict(list)
    for kind in kinds:
        by_group[match_key(kind)].append(kind)

    pairs = []
    for group_kinds in by_group.values():
        if len(group_kinds) % 2 != 0:
            raise RuntimeError('_remnant_pairs: odd-sized match group, cannot pair evenly')
        shuffled = list(group_kinds)
        rng.shuffle(shuffled)
        for i in range(0, len(shuffled), 2):
            pairs.append((shuffled[i], shuffled[i + 1]))
    rng.shuffle(pairs)
    return pairs


def _try_generate(rng, positions, pair_kinds, placement='uniform'):
    occupied = set(positions)
    pair_kinds = list(pair_kinds)
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


def generate_layout(rng, positions, placement='uniform', pair_scheduling='random'):
    for _ in range(MAX_ATTEMPTS):
        pair_kinds = _build_pair_kinds(rng, pair_scheduling)
        tiles = _try_generate(rng, positions, pair_kinds, placement)
        if tiles is not None:
            return tiles
    raise RuntimeError('generate_layout: failed to avoid a dead end in 100 attempts')


def reshuffle_layout(rng, positions, kinds, placement='uniform'):
    """Like generate_layout, but for a shuffle mid-game: `positions` and
    `kinds` are the tiles still on the board (not the full 72-pair deck) —
    the reverse simulation only cares that each pair it lays down matches by
    match_key, so reusing the same _try_generate keeps the same solvability
    guarantee for an arbitrary remaining subset."""
    for _ in range(MAX_ATTEMPTS):
        pair_kinds = _remnant_pairs(rng, kinds)
        tiles = _try_generate(rng, positions, pair_kinds, placement)
        if tiles is not None:
            return tiles
    raise RuntimeError('reshuffle_layout: failed to avoid a dead end in 100 attempts')


def generate_for_difficulty(level, layout, seed=None):
    """Returns a solvable field for the given difficulty level and board
    shape (a gameplay.layouts.Layout): a list of 144 (x, y, z, kind) tuples."""
    preset = DIFFICULTIES[level]
    rng = random.Random(seed)
    return generate_layout(rng, layout.positions, **preset)
