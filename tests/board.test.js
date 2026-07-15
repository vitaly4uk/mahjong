import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIDTH, HEIGHT, LAYERS, posKey, targetPositions, isFreePosition, Board,
} from '../static/game/board.js';

const t = (x, y, z, kind) => ({ x, y, z, kind });

test('constants', () => {
  assert.equal(WIDTH, 9);
  assert.equal(HEIGHT, 9);
  assert.equal(LAYERS, 3);
});

test('targetPositions: 242 unique positions, top-center missing', () => {
  const pos = targetPositions();
  assert.equal(pos.length, 242);
  const keys = new Set(pos.map((p) => posKey(p.x, p.y, p.z)));
  assert.equal(keys.size, 242);
  assert.ok(!keys.has(posKey(4, 4, 2)));
  assert.ok(keys.has(posKey(4, 4, 1)));
  assert.ok(keys.has(posKey(0, 0, 0)));
  assert.ok(keys.has(posKey(8, 8, 2)));
});

test('isFreePosition: covered position is not free', () => {
  const occupied = new Set([posKey(3, 3, 0), posKey(3, 3, 1)]);
  assert.equal(isFreePosition(occupied, 3, 3, 0), false);
  assert.equal(isFreePosition(occupied, 3, 3, 1), true);
});

test('isFreePosition: both sides occupied is not free, one side is free', () => {
  const occupied = new Set([posKey(2, 0, 0), posKey(3, 0, 0), posKey(4, 0, 0)]);
  assert.equal(isFreePosition(occupied, 3, 0, 0), false);
  assert.equal(isFreePosition(occupied, 2, 0, 0), true);
  assert.equal(isFreePosition(occupied, 4, 0, 0), true);
});

test('isFreePosition: edge of grid counts as free side', () => {
  const occupied = new Set([posKey(0, 0, 0), posKey(1, 0, 0)]);
  assert.equal(isFreePosition(occupied, 0, 0, 0), true);
});

test('Board.isFree matches the rules', () => {
  const covered = t(3, 3, 0, 'Man1');
  const cover = t(3, 3, 1, 'Pin1');
  const mid = t(1, 5, 0, 'Sou1');
  const board = new Board([
    covered, cover, t(0, 5, 0, 'Ton'), mid, t(2, 5, 0, 'Nan'),
  ]);
  assert.equal(board.isFree(covered), false);
  assert.equal(board.isFree(cover), true);
  assert.equal(board.isFree(mid), false);
  assert.equal(board.isFree(t(7, 7, 0, 'Chun')), false); // не на дошці
});

test('removePair: rejects non-matching, same tile, blocked tiles', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(3, 0, 0, 'Man1');
  const other = t(5, 0, 0, 'Pin1');
  const board = new Board([a, b, other]);
  assert.equal(board.removePair(a, other), false); // різний вид
  assert.equal(board.removePair(a, a), false); // той самий тайл
  assert.equal(board.remaining, 3);
  assert.equal(board.removePair(a, b), true);
  assert.equal(board.remaining, 1);
  assert.equal(board.isFree(a), false); // знятий тайл більше не на дошці
});

test('undo restores the last removed pair, returns null on empty stack', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(3, 0, 0, 'Man1');
  const board = new Board([a, b]);
  assert.equal(board.undo(), null);
  board.removePair(a, b);
  assert.ok(board.isWon());
  const pair = board.undo();
  assert.deepEqual(new Set(pair), new Set([a, b]));
  assert.equal(board.remaining, 2);
  assert.equal(board.isFree(a), true);
  assert.equal(board.undo(), null);
});

test('findMatchingPair, isDeadlocked, isWon', () => {
  // Man1 у центрі ряду заблокований з боків, другий Man1 вільний → пари немає
  const blockedMan = t(1, 0, 0, 'Man1');
  const freeMan = t(4, 4, 0, 'Man1');
  const board = new Board([
    t(0, 0, 0, 'Pin1'), blockedMan, t(2, 0, 0, 'Pin2'), freeMan,
  ]);
  assert.equal(board.findMatchingPair(), null);
  assert.equal(board.isDeadlocked(), true);
  assert.equal(board.isWon(), false);

  const c = t(0, 8, 0, 'Sou5');
  const d = t(8, 8, 0, 'Sou5');
  const board2 = new Board([c, d]);
  assert.deepEqual(new Set(board2.findMatchingPair()), new Set([c, d]));
  assert.equal(board2.isDeadlocked(), false);
});

test('tiles() returns remaining tiles', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(3, 0, 0, 'Man1');
  const c = t(5, 5, 1, 'Pin3');
  const board = new Board([a, b, c]);
  assert.equal(board.tiles().length, 3);
  board.removePair(a, b);
  assert.deepEqual(board.tiles(), [c]);
});
