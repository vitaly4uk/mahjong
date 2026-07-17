export const WIDTH = 12;
export const HEIGHT = 8;
export const LAYERS = 3;

export const posKey = (x, y, z) => `${x},${y},${z}`;
export const posKeyOf = (p) => posKey(p.x, p.y, p.z);

// Класична розкладка "Turtle" (KMahjongg default.layout / cheshire137
// turtle.txt), обрізана до 136 клітинок = автентична riichi-колода 34×4.
// Прибрано: 5-клітинний пік (шари 3-4) і 3 виступи "голова/хвіст" у шарі 0 —
// у справжній грі це бонусні слоти під квіти/сезони, яких у riichi-наборі
// немає (див. docs/superpowers/specs/2026-07-16-turtle-board-shape-design.md).
// '#' — клітинка є, '.' — порожньо; рядки y=0..7, колонки x=0..11.
const LAYER_BITMAPS = [
  ['############', '..########..', '.##########.', '############',
    '############', '.##########.', '..########..', '############'],
  ['............', '...######...', '...######...', '...######...',
    '...######...', '...######...', '...######...', '............'],
  ['............', '............', '....####....', '....####....',
    '....####....', '....####....', '............', '............'],
];

// Цільова форма: три шари Turtle-битмапи вище → 136 позицій (84+36+16).
export function targetPositions() {
  const out = [];
  for (let z = 0; z < LAYERS; z++) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (LAYER_BITMAPS[z][y][x] === '#') out.push({ x, y, z });
      }
    }
  }
  return out;
}

// Самоперевірка при завантаженні модуля — страховка від опечатки в бітмапі.
{
  const total = targetPositions().length;
  if (total !== 136) {
    throw new Error(`targetPositions: очікувано 136 позицій, отримано ${total}`);
  }
}

// occupied — будь-який об'єкт з .has(posKey(...)): Set або Map.
export function isFreePosition(occupied, x, y, z) {
  if (occupied.has(posKey(x, y, z + 1))) return false;
  return !occupied.has(posKey(x - 1, y, z)) || !occupied.has(posKey(x + 1, y, z));
}

export class Board {
  constructor(tiles) {
    this.byPos = new Map();
    for (const tile of tiles) this.byPos.set(posKeyOf(tile), tile);
    this.undoStack = [];
  }

  tiles() {
    return [...this.byPos.values()];
  }

  isFree(tile) {
    if (this.byPos.get(posKeyOf(tile)) !== tile) return false;
    return isFreePosition(this.byPos, tile.x, tile.y, tile.z);
  }

  canMatch(a, b) {
    return a !== b && a.kind === b.kind && this.isFree(a) && this.isFree(b);
  }

  removePair(a, b) {
    if (!this.canMatch(a, b)) return false;
    this.byPos.delete(posKeyOf(a));
    this.byPos.delete(posKeyOf(b));
    this.undoStack.push([a, b]);
    return true;
  }

  undo() {
    const pair = this.undoStack.pop();
    if (!pair) return null;
    for (const tile of pair) this.byPos.set(posKeyOf(tile), tile);
    return pair;
  }

  findMatchingPair() {
    const seen = new Map();
    for (const tile of this.byPos.values()) {
      if (!this.isFree(tile)) continue;
      const partner = seen.get(tile.kind);
      if (partner) return [partner, tile];
      seen.set(tile.kind, tile);
    }
    return null;
  }

  get remaining() {
    return this.byPos.size;
  }

  isWon() {
    return this.byPos.size === 0;
  }

  isDeadlocked() {
    return this.byPos.size > 0 && this.findMatchingPair() === null;
  }
}
