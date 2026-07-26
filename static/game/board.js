// Tile kind domain: 34 authentic riichi kinds + 8 bonus (4 flowers + 4
// seasons) = a full 42-kind mahjong set. Field generation is server-side
// (gameplay/generator.py); KINDS here is for rendering/tests.
export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
  'Plum', 'Orchid', 'Bamboo', 'Chrysanthemum',
  'Spring', 'Summer', 'Autumn', 'Winter',
];

// Bonus kinds (flowers/seasons) with wildcard matching: any flower matches
// any flower, any season matches any season (two groups).
export const FLOWERS = ['Plum', 'Orchid', 'Bamboo', 'Chrysanthemum'];
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
const BONUS_GROUP = new Map([
  ...FLOWERS.map((k) => [k, 'flower']),
  ...SEASONS.map((k) => [k, 'season']),
]);

// Matching key: every flower → 'flower', every season → 'season', everything
// else — the kind itself. Two tiles match if their matchKey is equal (mirrors
// gameplay/board.py).
export const matchKey = (kind) => BONUS_GROUP.get(kind) ?? kind;

// Coordinates — in "half-tile" units (like real kmahjongg: BoardLayout stores
// the board on a grid twice as fine as a tile). A regular tile stands on EVEN
// coordinates (adjacent tiles differ by 2), while special tiles — a peak
// apex or a head/tail protrusion — stand on ODD coordinates (sitting
// "between" regular cells of the same grid, with no rounding to a whole
// tile). The board shape (which positions exist, board width/height/layer
// count) is no longer hardcoded here — it comes from the server's `layout`
// array (gameplay/layouts.py parses it from a kmahjongg-format `.layout`
// file, project root `layouts/`); main.js derives width/height/layer count
// from that array (main.js: applyBoardDims).

export const posKey = (x, y, z) => `${x},${y},${z}`;
export const posKeyOf = (p) => posKey(p.x, p.y, p.z);

// kmahjongg's freedom rule (src/gamescene.cpp: isSelectable), ported 1:1: a
// tile occupies a 2×2 cell block of the half-tile grid with corner (x, y), so
// "is there anything on top" is a 3×3 window check (x-1..x+1, y-1..y+1) on
// layer z+1 (any tile whose corner lands there covers this tile — this is
// what catches diagonal/half-tile offsets like the peak apex). "Is a side
// free" is a check of the column EXACTLY 2 cells to the left/right (where a
// regular neighbour's corner would stand), but with a ±1 row tolerance
// (y-1..y+1), to correctly see a neighbour offset by half a tile (the
// head/tail protrusions).
// occupied — any object with .has(posKey(...)): Set or Map.
export function isFreePosition(occupied, x, y, z) {
  for (let i = x - 1; i <= x + 1; i++) {
    for (let j = y - 1; j <= y + 1; j++) {
      if (occupied.has(posKey(i, j, z + 1))) return false;
    }
  }
  let leftFree = true;
  let rightFree = true;
  for (let j = y - 1; j <= y + 1 && (leftFree || rightFree); j++) {
    if (occupied.has(posKey(x - 2, j, z))) leftFree = false;
    if (occupied.has(posKey(x + 2, j, z))) rightFree = false;
  }
  return leftFree || rightFree;
}

// Restores a game from a saved move log (main.js: the localStorage blob
// mahjong.activeGame.v1): tiles — an array where the index = the tile's idx
// in the server layout; moves — pairs of indices in removal order. Returns a
// Board with the pairs removed and the undo stack naturally rebuilt, or null
// if any move is illegal (a corrupted/forged blob — a signal to discard the
// saved state).
export function replayMoves(tiles, moves) {
  const board = new Board(tiles);
  for (const [a, b] of moves) {
    const tileA = tiles[a];
    const tileB = tiles[b];
    if (!tileA || !tileB || !board.removePair(tileA, tileB)) return null;
  }
  return board;
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
    return a !== b && matchKey(a.kind) === matchKey(b.kind)
      && this.isFree(a) && this.isFree(b);
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
      const key = matchKey(tile.kind);
      const partner = seen.get(key);
      if (partner) return [partner, tile];
      seen.set(key, tile);
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
