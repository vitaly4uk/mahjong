import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLayout, generateForDifficulty, DIFFICULTIES, KINDS, isAdjacent,
} from '../static/game/generator.js';
import { Board, targetPositions, posKey } from '../static/game/board.js';
import { carelessPlay, measureWinRate } from '../static/game/simulate.js';

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

test('adjacencyBias=1 layouts survive careless play far more often than adjacencyBias=0', () => {
  const trials = 100;
  let winsHigh = 0;
  let winsLow = 0;
  for (let seed = 1; seed <= trials; seed++) {
    const boardHigh = new Board(generateLayout(mulberry32(seed), { adjacencyBias: 1 }));
    if (carelessPlay(boardHigh, mulberry32(seed + 100000))) winsHigh += 1;

    const boardLow = new Board(generateLayout(mulberry32(seed), { adjacencyBias: 0 }));
    if (carelessPlay(boardLow, mulberry32(seed + 100000))) winsLow += 1;
  }
  assert.ok(
    winsHigh > winsLow,
    `expected adjacencyBias=1 to win more often: high=${winsHigh}, low=${winsLow}`,
  );
  assert.ok(winsHigh / trials >= 0.6, `expected win rate >=60%, got ${winsHigh}/${trials}`);
});

test('pairScheduling=grouped: pairs of a kind are contiguous in the queue', () => {
  // Спостерігаємо непрямо: у розкладі, згенерованому з grouped, кожен вид
  // з'являється підряд у порядку зняття (tiles-масив = порядок generation,
  // тобто зворотний до порядку зняття, але суміжність видів зберігається).
  const tiles = generateLayout(mulberry32(4), { pairScheduling: 'grouped' });
  const kindsInOrder = [];
  for (let i = 0; i < tiles.length; i += 2) kindsInOrder.push(tiles[i].kind);
  // Кожен вид має утворювати один суцільний блок у послідовності генерації.
  const seenBlocks = new Set();
  let prevKind = null;
  for (const kind of kindsInOrder) {
    if (kind !== prevKind) {
      assert.ok(!seenBlocks.has(kind), `kind ${kind} appeared in more than one block`);
      seenBlocks.add(kind);
      prevKind = kind;
    }
  }
});

test('pairScheduling=split: a kind\'s pairs land in opposite halves of the generation order', () => {
  const tiles = generateLayout(mulberry32(5), { pairScheduling: 'split' });
  const kindsInOrder = [];
  for (let i = 0; i < tiles.length; i += 2) kindsInOrder.push(tiles[i].kind);
  const half = Math.floor(kindsInOrder.length / 2);
  const firstHalfKinds = new Set(kindsInOrder.slice(0, half));
  const secondHalfKinds = new Set(kindsInOrder.slice(half));
  const kindsInBoth = [...firstHalfKinds].filter((k) => secondHalfKinds.has(k));
  assert.ok(
    kindsInBoth.length > 0,
    'expected at least some kinds split across both halves of the generation order',
  );
});

test('crossLayerChance=1: layout is still solvable in generation order (30 seeds)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const tiles = generateLayout(mulberry32(seed), { crossLayerChance: 1 });
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

// generateForDifficulty приймає перший розклад, що влучив у смугу, або (за
// 30 спроб) найближчий кандидат — тож окремий сід іноді може лишитись поза
// смугою (шум вимірювання win-rate одним розкладом). Калібрування оцінюється
// агрегатно: середнє по сідах близьке до смуги, і переважна більшість сідів
// влучає в межах допуску — а не "кожен окремий сід влучає точно".
test('generateForDifficulty: each level lands its win rate in the target band on average (~20 seeds)', () => {
  const SEEDS = 20;
  const TOLERANCE = 0.15; // допуск на шум вимірювання одним розкладом
  for (const level of Object.keys(DIFFICULTIES)) {
    const { winRateBand } = DIFFICULTIES[level];
    let sum = 0;
    let withinTolerance = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = mulberry32(seed * 1000 + level.length);
      const tiles = generateForDifficulty(level, rng);
      // Незалежний rng для оцінки — не той самий потік, що використовувався
      // всередині generateForDifficulty для генерації/відбору.
      const rate = measureWinRate(tiles, mulberry32(seed + 777), 40);
      sum += rate;
      if (rate >= winRateBand[0] - TOLERANCE && rate <= winRateBand[1] + TOLERANCE) {
        withinTolerance += 1;
      }
    }
    const avg = sum / SEEDS;
    assert.ok(
      avg >= winRateBand[0] - TOLERANCE / 2 && avg <= winRateBand[1] + TOLERANCE / 2,
      `${level}: average win rate ${avg} not close to band [${winRateBand}]`,
    );
    assert.ok(
      withinTolerance >= SEEDS * 0.8,
      `${level}: only ${withinTolerance}/${SEEDS} seeds within tolerance of band [${winRateBand}]`,
    );
  }
});
