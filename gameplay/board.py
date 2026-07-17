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
