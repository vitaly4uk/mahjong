import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats, emptyAllStats, winRate, fmtTime, load,
  STORAGE_KEY, STORAGE_KEY_V1, LEVELS,
} from '../static/game/stats.js';

test('emptyStats: zeros and null best time', () => {
  const stats = emptyStats();
  assert.equal(stats.gamesStarted, 0);
  assert.equal(stats.gamesPlayed, 0);
  assert.equal(stats.gamesWon, 0);
  assert.equal(stats.hintsTotal, 0);
  assert.equal(stats.undosTotal, 0);
  assert.equal(stats.pairsTotal, 0);
  assert.equal(stats.bestTimeMs, null);
  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.bestStreak, 0);
});

test('winRate: 0 when no games played, rounds otherwise', () => {
  assert.equal(winRate(emptyStats()), 0);
  const stats = { ...emptyStats(), gamesPlayed: 2, gamesWon: 1 };
  assert.equal(winRate(stats), 50);
});

test('fmtTime: formats milliseconds as mm:ss', () => {
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(5000), '00:05');
  assert.equal(fmtTime(65000), '01:05');
  assert.equal(fmtTime(3661000), '61:01');
});

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
    has: (key) => data.has(key),
  };
}

test('emptyAllStats: one empty level per difficulty', () => {
  const all = emptyAllStats();
  assert.deepEqual(Object.keys(all).sort(), [...LEVELS].sort());
  for (const level of LEVELS) assert.deepEqual(all[level], emptyStats());
});

test('load: merges partial stored data with defaults, per level', () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: JSON.stringify({ normal: { gamesPlayed: 7 } }),
  });
  const loaded = load(storage);
  assert.equal(loaded.normal.gamesPlayed, 7);
  assert.equal(loaded.normal.gamesWon, 0);
  assert.equal(loaded.normal.bestTimeMs, null);
  assert.deepEqual(loaded.easy, emptyStats());
  assert.deepEqual(loaded.hard, emptyStats());
});

test('load: returns empty per-level defaults when storage is empty', () => {
  assert.deepEqual(load(fakeStorage()), emptyAllStats());
});

test('load: migrates v1 (single-level) stats into the hard level, drops v1 key', () => {
  const oldStats = { ...emptyStats(), gamesPlayed: 2, gamesWon: 2, bestTimeMs: 5000 };
  const storage = fakeStorage({ [STORAGE_KEY_V1]: JSON.stringify(oldStats) });
  const loaded = load(storage);
  assert.deepEqual(loaded.hard, oldStats);
  assert.deepEqual(loaded.easy, emptyStats());
  assert.deepEqual(loaded.normal, emptyStats());
  assert.equal(storage.has(STORAGE_KEY_V1), false);
  assert.equal(storage.has(STORAGE_KEY), true);
  // Наступний load читає вже змігрований v2, без v1.
  assert.deepEqual(load(storage), loaded);
});

test('load: does not throw when storage throws', () => {
  const badStorage = {
    getItem: () => { throw new Error('nope'); },
  };
  assert.deepEqual(load(badStorage), emptyAllStats());
});
