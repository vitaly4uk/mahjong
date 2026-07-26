"""Python port of static/game/board.js: the freedom rule (nothing on top +
free left/right side), pair matching, pair removal. The server uses this as
the authoritative check when replaying the move log (gameplay/api.py) —
unlike the client board.js, tiles here are indexed (idx = position in the
layout array the server handed the client at game start), because the client
sends its move log by those indices, not by objects.

Coordinates — in "half-tile" units (like real kmahjongg: BoardLayout stores
the board on a grid four times finer than a tile, but two is actually enough
— each tile occupies a 2×2 block of such cells). A regular tile stands on
EVEN coordinates (adjacent tiles differ by 2), while special tiles — a peak
apex or a head/tail protrusion — stand on ODD coordinates (sitting "between"
regular cells of the same grid, with no rounding to a whole tile). The board
shape itself (which positions exist, board width/height/layer count) is no
longer hardcoded here — see gameplay/layouts.py, which parses it from a
kmahjongg-format `.layout` file (project root `layouts/`)."""

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
