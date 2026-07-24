import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIDTH, HEIGHT, LAYERS, posKey, targetPositions, isFreePosition, Board, replayMoves,
} from '../static/game/board.js';

const t = (x, y, z, kind) => ({ x, y, z, kind });

test('constants', () => {
  assert.equal(WIDTH, 12);
  assert.equal(HEIGHT, 8);
  assert.equal(LAYERS, 3);
});

test('targetPositions: 136 unique positions (Turtle shape), per-layer counts', () => {
  const pos = targetPositions();
  assert.equal(pos.length, 136);
  const keys = new Set(pos.map((p) => posKey(p.x, p.y, p.z)));
  assert.equal(keys.size, 136);
  const byLayer = [0, 0, 0];
  for (const p of pos) byLayer[p.z] += 1;
  assert.deepEqual(byLayer, [84, 36, 16]);
  // Кут шару 0 — заповнений.
  assert.ok(keys.has(posKey(0, 0, 0)));
  assert.ok(keys.has(posKey(11, 7, 0)));
  // Виступ "хвіст" (був у справжній Turtle, обрізаний до 136) — відсутній.
  assert.ok(!keys.has(posKey(0, 1, 0)));
  // Клітинка шару 2 (верхній, найвужчий шар).
  assert.ok(keys.has(posKey(5, 3, 2)));
  assert.ok(!keys.has(posKey(0, 0, 2)));
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

test('replayMoves: valid log rebuilds board with undo stack', () => {
  const tiles = [
    t(0, 0, 0, 'Man1'), t(3, 0, 0, 'Man1'), t(0, 2, 0, 'Pin1'), t(3, 2, 0, 'Pin1'),
  ];
  const board = replayMoves(tiles, [[0, 1], [2, 3]]);
  assert.ok(board);
  assert.equal(board.remaining, 0);
  // undo-стек відновлено реплеєм: останньою знято пару Pin1.
  const pair = board.undo();
  assert.deepEqual(new Set(pair), new Set([tiles[2], tiles[3]]));
  assert.equal(board.remaining, 2);
});

test('replayMoves: illegal move (blocked/non-matching) returns null', () => {
  const tiles = [
    t(0, 0, 0, 'Man1'), t(1, 0, 0, 'Pin1'), t(2, 0, 0, 'Man1'),
  ];
  // Man1 (idx 0) і Man1 (idx 2): другий затиснутий сусідами? idx 2 вільний
  // праворуч, а от нелегальна саме пара різних видів [0, 1].
  assert.equal(replayMoves(tiles, [[0, 1]]), null);
});

test('replayMoves: out-of-range index returns null', () => {
  const tiles = [t(0, 0, 0, 'Man1'), t(3, 0, 0, 'Man1')];
  assert.equal(replayMoves(tiles, [[0, 99]]), null);
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
