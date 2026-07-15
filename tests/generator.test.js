import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLayout, KINDS } from '../static/game/generator.js';
import { Board, targetPositions, posKey } from '../static/game/board.js';

// Детермінований PRNG для відтворюваних тестів.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('KINDS: 34 unique kinds', () => {
  assert.equal(KINDS.length, 34);
  assert.equal(new Set(KINDS).size, 34);
  assert.ok(KINDS.includes('Man1'));
  assert.ok(KINDS.includes('Sou9'));
  assert.ok(KINDS.includes('Chun'));
});

test('layout fills the target shape exactly', () => {
  const tiles = generateLayout(mulberry32(1));
  assert.equal(tiles.length, 242);
  const keys = new Set(tiles.map((t) => posKey(t.x, t.y, t.z)));
  const target = new Set(targetPositions().map((p) => posKey(p.x, p.y, p.z)));
  assert.deepEqual(keys, target);
});

test('kind distribution: valid kinds, even counts, 19×8 + 15×6', () => {
  const tiles = generateLayout(mulberry32(2));
  const counts = new Map();
  for (const tile of tiles) {
    assert.ok(KINDS.includes(tile.kind), `unknown kind ${tile.kind}`);
    counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1);
  }
  const values = [...counts.values()].sort((a, b) => a - b);
  assert.deepEqual(values, [...Array(15).fill(6), ...Array(19).fill(8)]);
});

test('consecutive pairs share a kind', () => {
  const tiles = generateLayout(mulberry32(3));
  for (let i = 0; i < tiles.length; i += 2) {
    assert.equal(tiles[i].kind, tiles[i + 1].kind, `pair ${i / 2}`);
  }
});

test('layout is solvable by removing pairs in generation order (30 seeds)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const tiles = generateLayout(mulberry32(seed));
    const board = new Board(tiles);
    for (let i = 0; i < tiles.length; i += 2) {
      assert.equal(
        board.removePair(tiles[i], tiles[i + 1]), true,
        `seed ${seed}: pair ${i / 2} not removable`,
      );
    }
    assert.ok(board.isWon(), `seed ${seed}: board not empty`);
  }
});
