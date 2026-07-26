import test from 'node:test';
import assert from 'node:assert/strict';
import {
  posKey, isFreePosition, Board, replayMoves, matchKey,
} from '../static/game/board.js';

const t = (x, y, z, kind) => ({ x, y, z, kind });

// Board shape (which positions exist, board dimensions) is no longer
// hardcoded on the client — it's server-authoritative (gameplay/layouts.py,
// parsed from a kmahjongg-format `.layout` file) and comes down with every
// game's `layout` array. board.js tests below only cover the shape-agnostic
// rules (freedom, matching, undo, replay) — see gameplay/tests.py for
// coverage of the actual layouts/*.layout files (144-tile count, known
// coordinates, solvability).

test('matchKey: flowers and seasons form two wildcard groups', () => {
  assert.equal(matchKey('Man1'), 'Man1');
  assert.equal(matchKey('Plum'), matchKey('Orchid')); // any flower ↔ flower
  assert.equal(matchKey('Spring'), matchKey('Winter')); // any season ↔ season
  assert.notEqual(matchKey('Plum'), matchKey('Spring')); // flower ≠ season
  // Board.canMatch: two different free flowers are removed together.
  const plum = t(0, 0, 0, 'Plum');
  const orchid = t(6, 0, 0, 'Orchid');
  const spring = t(12, 0, 0, 'Spring');
  const board = new Board([plum, orchid, spring]);
  assert.equal(board.canMatch(plum, orchid), true);
  assert.equal(board.canMatch(plum, spring), false);
});

test('isFreePosition: exact-position cover (same x,y, layer above)', () => {
  const occupied = new Set([posKey(4, 4, 0), posKey(4, 4, 1)]);
  assert.equal(isFreePosition(occupied, 4, 4, 0), false);
  assert.equal(isFreePosition(occupied, 4, 4, 1), true);
});

test('isFreePosition: covering tile at a HALF-tile offset above still counts '
  + '(3×3 window) — this is the exact rule kmahjongg uses for the peak apex', () => {
  // Reproduces the real "peak apex over its base" situation: (13,7) — ODD
  // coordinates, centered exactly between the four tiles
  // (12,6)/(12,8)/(14,6)/(14,8) on the layer below. Each of them must be
  // "covered" by the apex, even though none matches its coordinates exactly.
  const occupied = new Set([
    posKey(12, 6, 0), posKey(12, 8, 0), posKey(14, 6, 0), posKey(14, 8, 0),
    posKey(13, 7, 1),
  ]);
  assert.equal(isFreePosition(occupied, 12, 6, 0), false);
  assert.equal(isFreePosition(occupied, 12, 8, 0), false);
  assert.equal(isFreePosition(occupied, 14, 6, 0), false);
  assert.equal(isFreePosition(occupied, 14, 8, 0), false);
});

test('isFreePosition: both sides occupied is not free, one side is free (step 2)', () => {
  const occupied = new Set([posKey(2, 0, 0), posKey(4, 0, 0), posKey(6, 0, 0)]);
  assert.equal(isFreePosition(occupied, 4, 0, 0), false);
  assert.equal(isFreePosition(occupied, 2, 0, 0), true);
  assert.equal(isFreePosition(occupied, 6, 0, 0), true);
});

test('isFreePosition: side check tolerates a half-row-offset neighbour (±1 window)', () => {
  // The head (0,7) is on an odd y; the only real neighbours in column 2
  // stand at y=6 and y=8 (even) — both should read as "occupied on the right".
  const occupied = new Set([posKey(0, 7, 0), posKey(2, 6, 0), posKey(2, 8, 0)]);
  // Right side is occupied by both; left side (x=-2) is off the board — always free.
  assert.equal(isFreePosition(occupied, 0, 7, 0), true);
});

test('isFreePosition: edge of grid counts as free side', () => {
  const occupied = new Set([posKey(0, 0, 0), posKey(2, 0, 0)]);
  assert.equal(isFreePosition(occupied, 0, 0, 0), true);
});

test('Board.isFree matches the rules', () => {
  const covered = t(4, 4, 0, 'Man1');
  const cover = t(4, 4, 1, 'Pin1');
  const mid = t(2, 10, 0, 'Sou1');
  const board = new Board([
    covered, cover, t(0, 10, 0, 'Ton'), mid, t(4, 10, 0, 'Nan'),
  ]);
  assert.equal(board.isFree(covered), false);
  assert.equal(board.isFree(cover), true);
  assert.equal(board.isFree(mid), false);
  assert.equal(board.isFree(t(20, 20, 0, 'Chun')), false); // not on the board
});

test('removePair: rejects non-matching, same tile, blocked tiles', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(2, 0, 0, 'Man1');
  const other = t(6, 0, 0, 'Pin1'); // not flush against b — otherwise b would be blocked on both sides
  const board = new Board([a, b, other]);
  assert.equal(board.removePair(a, other), false); // different kind
  assert.equal(board.removePair(a, a), false); // the same tile
  assert.equal(board.remaining, 3);
  assert.equal(board.removePair(a, b), true);
  assert.equal(board.remaining, 1);
  assert.equal(board.isFree(a), false); // a removed tile is no longer on the board
});

test('undo restores the last removed pair, returns null on empty stack', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(2, 0, 0, 'Man1');
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
  // Man1 in the middle of the row is blocked on both sides, the second Man1
  // is free → no pair exists.
  const blockedMan = t(2, 0, 0, 'Man1');
  const freeMan = t(8, 8, 0, 'Man1');
  const board = new Board([
    t(0, 0, 0, 'Pin1'), blockedMan, t(4, 0, 0, 'Pin2'), freeMan,
  ]);
  assert.equal(board.findMatchingPair(), null);
  assert.equal(board.isDeadlocked(), true);
  assert.equal(board.isWon(), false);

  const c = t(0, 16, 0, 'Sou5');
  const d = t(16, 16, 0, 'Sou5');
  const board2 = new Board([c, d]);
  assert.deepEqual(new Set(board2.findMatchingPair()), new Set([c, d]));
  assert.equal(board2.isDeadlocked(), false);
});

test('replayMoves: valid log rebuilds board with undo stack', () => {
  const tiles = [
    t(0, 0, 0, 'Man1'), t(2, 0, 0, 'Man1'), t(0, 4, 0, 'Pin1'), t(2, 4, 0, 'Pin1'),
  ];
  const board = replayMoves(tiles, [[0, 1], [2, 3]]);
  assert.ok(board);
  assert.equal(board.remaining, 0);
  // The undo stack is rebuilt by replay: the Pin1 pair was removed last.
  const pair = board.undo();
  assert.deepEqual(new Set(pair), new Set([tiles[2], tiles[3]]));
  assert.equal(board.remaining, 2);
});

test('replayMoves: illegal move (blocked/non-matching) returns null', () => {
  const tiles = [
    t(0, 0, 0, 'Man1'), t(2, 0, 0, 'Pin1'), t(4, 0, 0, 'Man1'),
  ];
  // Illegal pair — different kinds.
  assert.equal(replayMoves(tiles, [[0, 1]]), null);
});

test('replayMoves: out-of-range index returns null', () => {
  const tiles = [t(0, 0, 0, 'Man1'), t(2, 0, 0, 'Man1')];
  assert.equal(replayMoves(tiles, [[0, 99]]), null);
});

test('tiles() returns remaining tiles', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(2, 0, 0, 'Man1');
  const c = t(10, 10, 1, 'Pin3');
  const board = new Board([a, b, c]);
  assert.equal(board.tiles().length, 3);
  board.removePair(a, b);
  assert.deepEqual(board.tiles(), [c]);
});
