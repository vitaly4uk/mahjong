import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats, applyWin, applyLoss, winRate, fmtTime, load, save, STORAGE_KEY,
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
  };
}

test('load/save: round-trips through storage', () => {
  const storage = fakeStorage();
  let stats = emptyStats();
  stats = applyWin(stats, 1234);
  save(stats, storage);
  const loaded = load(storage);
  assert.deepEqual(loaded, stats);
});

test('load: merges partial stored data with defaults', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ gamesPlayed: 7 }) });
  const loaded = load(storage);
  assert.equal(loaded.gamesPlayed, 7);
  assert.equal(loaded.gamesWon, 0);
  assert.equal(loaded.bestTimeMs, null);
});

test('load: returns defaults when storage is empty', () => {
  assert.deepEqual(load(fakeStorage()), emptyStats());
});

test('load: does not throw when storage throws', () => {
  const badStorage = {
    getItem: () => { throw new Error('nope'); },
  };
  assert.deepEqual(load(badStorage), emptyStats());
});

test('save: does not throw when storage throws', () => {
  const badStorage = {
    setItem: () => { throw new Error('nope'); },
  };
  assert.doesNotThrow(() => save(emptyStats(), badStorage));
});
