export const WIDTH = 9;
export const HEIGHT = 9;
export const LAYERS = 3;

export const posKey = (x, y, z) => `${x},${y},${z}`;

// Цільова форма: 3 повні шари 9×9 мінус центр верхнього шару → 242 позиції.
export function targetPositions() {
  const out = [];
  for (let z = 0; z < LAYERS; z++) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (z === LAYERS - 1 && x === 4 && y === 4) continue;
        out.push({ x, y, z });
      }
    }
  }
  return out;
}

// occupied — будь-який об'єкт з .has(posKey(...)): Set або Map.
export function isFreePosition(occupied, x, y, z) {
  if (occupied.has(posKey(x, y, z + 1))) return false;
  return !occupied.has(posKey(x - 1, y, z)) || !occupied.has(posKey(x + 1, y, z));
}

export class Board {
  constructor(tiles) {
    this.byPos = new Map();
    for (const tile of tiles) this.byPos.set(posKey(tile.x, tile.y, tile.z), tile);
    this.undoStack = [];
  }

  tiles() {
    return [...this.byPos.values()];
  }

  isFree(tile) {
    if (this.byPos.get(posKey(tile.x, tile.y, tile.z)) !== tile) return false;
    return isFreePosition(this.byPos, tile.x, tile.y, tile.z);
  }

  canMatch(a, b) {
    return a !== b && a.kind === b.kind && this.isFree(a) && this.isFree(b);
  }

  removePair(a, b) {
    if (!this.canMatch(a, b)) return false;
    this.byPos.delete(posKey(a.x, a.y, a.z));
    this.byPos.delete(posKey(b.x, b.y, b.z));
    this.undoStack.push([a, b]);
    return true;
  }

  undo() {
    const pair = this.undoStack.pop();
    if (!pair) return null;
    for (const tile of pair) this.byPos.set(posKey(tile.x, tile.y, tile.z), tile);
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
