import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLayout, KINDS, isAdjacent } from '../static/game/generator.js';
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

test('adjacencyBias=1: most generated pairs are adjacent tiles (averaged over seeds)', () => {
  let adjacentCount = 0;
  let totalPairs = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const tiles = generateLayout(mulberry32(seed), { adjacencyBias: 1 });
    for (let i = 0; i < tiles.length; i += 2) {
      totalPairs += 1;
      if (isAdjacent(tiles[i], tiles[i + 1])) adjacentCount += 1;
    }
  }
  // Невелика частка неспівпадінь очікувана на стиках шарів (непарний хвіст шару).
  assert.ok(
    adjacentCount / totalPairs >= 0.75,
    `expected >=75% adjacent pairs, got ${adjacentCount}/${totalPairs}`,
  );
});

// Модель "неуважного" гравця: на кожному кроці бере випадкову пару серед тих,
// що зачіпають найвищий ще не розібраний шар (гравець природно тягнеться до
// відкритих кісток зверху), без прорахунку наперед. Якщо на верхньому шарі
// пар немає — бере довільну доступну.
function randomPlayTopFirst(board, rng) {
  for (;;) {
    const byKind = new Map();
    let maxZ = -1;
    for (const tile of board.tiles()) {
      if (!board.isFree(tile)) continue;
      if (tile.z > maxZ) maxZ = tile.z;
      const list = byKind.get(tile.kind) ?? [];
      list.push(tile);
      byKind.set(tile.kind, list);
    }
    let pairs = [];
    for (const list of byKind.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].z === maxZ || list[j].z === maxZ) pairs.push([list[i], list[j]]);
        }
      }
    }
    if (pairs.length === 0) {
      for (const list of byKind.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);
        }
      }
    }
    if (pairs.length === 0) break;
    const [a, b] = pairs[Math.floor(rng() * pairs.length)];
    board.removePair(a, b);
  }
  return board.isWon();
}

test('adjacencyBias=1 layouts survive careless play far more often than adjacencyBias=0', () => {
  const trials = 100;
  let winsHigh = 0;
  let winsLow = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const boardHigh = new Board(generateLayout(mulberry32(seed), { adjacencyBias: 1 }));
    if (randomPlayTopFirst(boardHigh, mulberry32(seed + 100000))) winsHigh += 1;

    const boardLow = new Board(generateLayout(mulberry32(seed), { adjacencyBias: 0 }));
    if (randomPlayTopFirst(boardLow, mulberry32(seed + 100000))) winsLow += 1;
  }
  assert.ok(
    winsHigh > winsLow,
    `expected adjacencyBias=1 to win more often: high=${winsHigh}, low=${winsLow}`,
  );
  assert.ok(winsHigh / trials >= 0.6, `expected win rate >=60%, got ${winsHigh}/${trials}`);
});
