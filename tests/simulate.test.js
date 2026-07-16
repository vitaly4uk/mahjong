import test from 'node:test';
import assert from 'node:assert/strict';
import { carelessPlay, measureWinRate } from '../static/game/simulate.js';
import { generateLayout } from '../static/game/generator.js';
import { Board } from '../static/game/board.js';

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

test('carelessPlay: always finishes the game (empties board or deadlocks)', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const tiles = generateLayout(mulberry32(seed));
    const board = new Board(tiles);
    carelessPlay(board, mulberry32(seed + 500));
    assert.ok(board.isWon() || board.isDeadlocked(), `seed ${seed}: game didn't finish`);
  }
});

test('carelessPlay: deterministic given the same seeded rng', () => {
  const tiles = generateLayout(mulberry32(7));
  const board1 = new Board(tiles);
  const won1 = carelessPlay(board1, mulberry32(42));
  const board2 = new Board(tiles);
  const won2 = carelessPlay(board2, mulberry32(42));
  assert.equal(won1, won2);
  assert.equal(board1.remaining, board2.remaining);
});

test('measureWinRate: returns a value in [0, 1]', () => {
  const tiles = generateLayout(mulberry32(3));
  const rate = measureWinRate(tiles, mulberry32(99), 16);
  assert.ok(rate >= 0 && rate <= 1, `expected rate in [0,1], got ${rate}`);
});

test('measureWinRate: deterministic on a fixed seed', () => {
  const tiles = generateLayout(mulberry32(3));
  const rate1 = measureWinRate(tiles, mulberry32(99), 16);
  const rate2 = measureWinRate(tiles, mulberry32(99), 16);
  assert.equal(rate1, rate2);
});

test('measureWinRate: surface layouts win far more often than uniform', () => {
  const tilesSurface = generateLayout(mulberry32(11), { placement: 'surface' });
  const tilesUniform = generateLayout(mulberry32(11), { placement: 'uniform' });
  const rateSurface = measureWinRate(tilesSurface, mulberry32(1), 30);
  const rateUniform = measureWinRate(tilesUniform, mulberry32(1), 30);
  assert.ok(
    rateSurface > rateUniform,
    `expected surface to win more often: surface=${rateSurface}, uniform=${rateUniform}`,
  );
});
