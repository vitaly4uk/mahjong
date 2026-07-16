import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats, emptyAllStats, applyWin, applyLoss, winRate, fmtTime, load, save,
  STORAGE_KEY, STORAGE_KEY_V1, LEVELS,
} from '../static/game/stats.js';

test('emptyStats: zeros and null best time', () => {
  const stats = emptyStats();
  assert.equal(stats.gamesPlayed, 0);
  assert.equal(stats.gamesWon, 0);
  assert.equal(stats.hintsTotal, 0);
  assert.equal(stats.undosTotal, 0);
  assert.equal(stats.pairsTotal, 0);
  assert.equal(stats.bestTimeMs, null);
  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.bestStreak, 0);
});

test('applyWin: increments played/won/streak, tracks best streak and best time', () => {
  let stats = emptyStats();
  stats = applyWin(stats, 5000);
  assert.equal(stats.gamesPlayed, 1);
  assert.equal(stats.gamesWon, 1);
  assert.equal(stats.currentStreak, 1);
  assert.equal(stats.bestStreak, 1);
  assert.equal(stats.bestTimeMs, 5000);

  stats = applyWin(stats, 3000);
  assert.equal(stats.gamesPlayed, 2);
  assert.equal(stats.currentStreak, 2);
  assert.equal(stats.bestStreak, 2);
  assert.equal(stats.bestTimeMs, 3000); // faster win becomes the record

  stats = applyWin(stats, 9000);
  assert.equal(stats.bestTimeMs, 3000); // slower win doesn't overwrite record
  assert.equal(stats.bestStreak, 3);
});

test('applyLoss: increments played, resets current streak, keeps best streak', () => {
  let stats = emptyStats();
  stats = applyWin(stats, 1000);
  stats = applyWin(stats, 1000);
  assert.equal(stats.currentStreak, 2);
  stats = applyLoss(stats);
  assert.equal(stats.gamesPlayed, 3);
  assert.equal(stats.gamesWon, 2);
  assert.equal(stats.currentStreak, 0);
  assert.equal(stats.bestStreak, 2);
});

test('winRate: 0 when no games played, rounds otherwise', () => {
  assert.equal(winRate(emptyStats()), 0);
  let stats = emptyStats();
  stats = applyWin(stats, 1000);
  stats = applyLoss(stats);
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

test('load/save: round-trips a per-level stats object through storage', () => {
  const storage = fakeStorage();
  const all = emptyAllStats();
  all.hard = applyWin(all.hard, 1234);
  save(all, storage);
  const loaded = load(storage);
  assert.deepEqual(loaded, all);
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
  const oldStats = applyWin(applyWin(emptyStats(), 5000), 6000);
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

test('save: does not throw when storage throws', () => {
  const badStorage = {
    setItem: () => { throw new Error('nope'); },
  };
  assert.doesNotThrow(() => save(emptyAllStats(), badStorage));
});
