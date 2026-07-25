"""Python port of static/game/board.js: the freedom rule (nothing on top +
free left/right side), pair matching, pair removal. The server uses this as
the authoritative check when replaying the move log (gameplay/api.py) —
unlike the client board.js, tiles here are indexed (idx = position in the
layout array the server handed the client at game start), because the client
sends its move log by those indices, not by objects."""

# Coordinates — in "half-tile" units (like real kmahjongg: BoardLayout stores
# the board on a grid four times finer than a tile, but two is actually
# enough — each tile occupies a 2×2 block of such cells). A regular tile
# stands on EVEN coordinates (adjacent tiles differ by 2), while the special
# tiles — the central peak and the "head/tail" protrusions — stand on ODD
# coordinates (sitting "between" regular cells of the same grid, with no
# rounding to a whole tile). WIDTH/HEIGHT — the bounds of this grid (max
# source coordinate + 2, to fit the 2×2 footprint of the outermost tile).
WIDTH = 30
HEIGHT = 16
LAYERS = 5

# Exact coordinates of the classic "Turtle" layout — transcribed verbatim from
# two independent primary sources (KDE/kmahjongg default.layout,
# cheshire137/Mahjong turtle.txt), with no rounding or hand-drawn
# approximation: 87+36+16+4+1 = 144. Key — layer (z), value — list of (x, y)
# in the half-tile units above.
_TURTLE_CELLS = {
    0: [  # 87 tiles — the shell with the "head" (0,7) and "tail" (26,7)/(28,7) protrusions
        (0, 7), (2, 0), (2, 6), (2, 8), (2, 14), (4, 0), (4, 4), (4, 6), (4, 8), (4, 10),
        (4, 14), (6, 0), (6, 2), (6, 4), (6, 6), (6, 8), (6, 10), (6, 12), (6, 14), (8, 0),
        (8, 2), (8, 4), (8, 6), (8, 8), (8, 10), (8, 12), (8, 14), (10, 0), (10, 2), (10, 4),
        (10, 6), (10, 8), (10, 10), (10, 12), (10, 14), (12, 0), (12, 2), (12, 4), (12, 6),
        (12, 8), (12, 10), (12, 12), (12, 14), (14, 0), (14, 2), (14, 4), (14, 6), (14, 8),
        (14, 10), (14, 12), (14, 14), (16, 0), (16, 2), (16, 4), (16, 6), (16, 8), (16, 10),
        (16, 12), (16, 14), (18, 0), (18, 2), (18, 4), (18, 6), (18, 8), (18, 10), (18, 12),
        (18, 14), (20, 0), (20, 2), (20, 4), (20, 6), (20, 8), (20, 10), (20, 12), (20, 14),
        (22, 0), (22, 4), (22, 6), (22, 8), (22, 10), (22, 14), (24, 0), (24, 6), (24, 8),
        (24, 14), (26, 7), (28, 7),
    ],
    1: [  # 36 tiles
        (8, 2), (8, 4), (8, 6), (8, 8), (8, 10), (8, 12), (10, 2), (10, 4), (10, 6), (10, 8),
        (10, 10), (10, 12), (12, 2), (12, 4), (12, 6), (12, 8), (12, 10), (12, 12), (14, 2),
        (14, 4), (14, 6), (14, 8), (14, 10), (14, 12), (16, 2), (16, 4), (16, 6), (16, 8),
        (16, 10), (16, 12), (18, 2), (18, 4), (18, 6), (18, 8), (18, 10), (18, 12),
    ],
    2: [  # 16 tiles
        (10, 4), (10, 6), (10, 8), (10, 10), (12, 4), (12, 6), (12, 8), (12, 10), (14, 4),
        (14, 6), (14, 8), (14, 10), (16, 4), (16, 6), (16, 8), (16, 10),
    ],
    3: [  # 4 tiles — the 2×2 base of the peak
        (12, 6), (12, 8), (14, 6), (14, 8),
    ],
    4: [  # 1 tile — the peak apex, coordinate (13, 7) is ODD — exactly between
        # the four tiles of layer 3 (x-wise between 12 and 14, y-wise between
        # 6 and 8), not above any single one of them.
        (13, 7),
    ],
}


def target_positions():
    """144 target positions of the Turtle layout as (x, y, z) tuples."""
    return [(x, y, z) for z, cells in _TURTLE_CELLS.items() for x, y in cells]


_TOTAL = len(target_positions())
if _TOTAL != 144:
    raise RuntimeError(f'target_positions: expected 144 positions, got {_TOTAL}')


# Bonus kinds (flowers/seasons) beyond the riichi-34 — wildcard groups: any
# flower matches any flower, any season matches any season.
FLOWERS = ('Plum', 'Orchid', 'Bamboo', 'Chrysanthemum')
SEASONS = ('Spring', 'Summer', 'Autumn', 'Winter')
_BONUS_GROUP = {**{k: 'flower' for k in FLOWERS}, **{k: 'season' for k in SEASONS}}


def match_key(kind):
    """Matching key: every flower → 'flower', every season → 'season',
    everything else — the kind itself. Two tiles match iff their match_key
    is equal."""
    return _BONUS_GROUP.get(kind, kind)


def is_free_position(occupied, x, y, z):
    """kmahjongg's freedom rule (src/gamescene.cpp: isSelectable), ported 1:1:
    a tile occupies a 2×2 cell block of the half-tile grid with corner (x, y),
    so "is there anything on top" is a 3×3 window check (x-1..x+1, y-1..y+1)
    on layer z+1 (any tile whose corner lands there covers this tile — this is
    what catches diagonal/half-tile offsets like the peak apex). "Is a side
    free" is a check of the column EXACTLY 2 cells to the left/right (where a
    regular neighbour's corner would stand), but with a ±1 row tolerance
    (y-1..y+1), to correctly see a neighbour offset by half a tile (the
    head/tail protrusions). occupied — anything supporting `in` on an
    (x, y, z) tuple (set/dict)."""
    for i in range(x - 1, x + 2):
        for j in range(y - 1, y + 2):
            if (i, j, z + 1) in occupied:
                return False
    left_free = all((x - 2, j, z) not in occupied for j in range(y - 1, y + 2))
    right_free = all((x + 2, j, z) not in occupied for j in range(y - 1, y + 2))
    return left_free or right_free


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
        return (
            a is not b
            and match_key(a.kind) == match_key(b.kind)
            and self.is_free(a)
            and self.is_free(b)
        )

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
            key = match_key(tile.kind)
            partner = seen.get(key)
            if partner is not None:
                return partner, tile
            seen[key] = tile
        return None

    @property
    def remaining(self):
        return len(self.by_pos)

    def is_won(self):
        return len(self.by_pos) == 0

    def is_deadlocked(self):
        return len(self.by_pos) > 0 and self.find_matching_pair() is None
