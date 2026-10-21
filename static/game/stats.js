// Game stats: a pure module, no Phaser/DOM.
// Lifetime numbers live on the server (gameplay/models.py: Profile.stats) —
// this module only keeps presentation helper (fmtTime), an empty
// shape (emptyStats/emptyOverall/emptyAllStats, a placeholder before the first network
// request) and load() — now used ONLY as a one-time "legacy blob reader" for
// transferring the old localStorage data to the server (main.js: create()).
// applyWin/applyLoss/save() were removed — the win/loss counting logic lives
// only on the server (gameplay/stats.py), the client no longer writes
// anything to localStorage. v1 (a single stats blob, no levels) is still
// migrated into the hard level inside load() — the same payload shape
// POST /api/game/stats/import (gameplay/api.py: import_stats) expects.

export const STORAGE_KEY = 'mahjong.stats.v2';
export const STORAGE_KEY_V1 = 'mahjong.stats.v1';
export const LEVELS = ['easy', 'normal', 'hard'];

export function emptyStats() {
  return {
    gamesStarted: 0,
    gamesPlayed: 0,
    gamesWon: 0,
    hintsTotal: 0,
    undosTotal: 0,
    pairsTotal: 0,
    shufflesTotal: 0,
    bestTimeMs: null,
    currentStreak: 0,
    bestStreak: 0,
  };
}

// The points-based block the stats modal shows (gameplay/schemas.py:
// OverallStats) — one for all difficulties; of the per-level blocks next to
// it only bestTimeMs is displayed (bestTime below), the rest is stored only.
export function emptyOverall() {
  return {
    gamesScored: 0,
    totalScore: 0,
    bestScore: 0,
    gamesWon: 0,
    currentStreak: 0,
    bestStreak: 0,
  };
}

// Just the per-difficulty blocks — the shape of the legacy localStorage blob
// (and of what load() returns for the one-time server import).
export function emptyLevels() {
  return Object.fromEntries(LEVELS.map((level) => [level, emptyStats()]));
}

export function emptyAllStats() {
  return { ...emptyLevels(), overall: emptyOverall() };
}

export function averageScore(overall) {
  if (overall.gamesScored === 0) return 0;
  return Math.round(overall.totalScore / overall.gamesScored);
}

// Fastest win across all difficulties, or null before the first win
// (the per-level bestTimeMs blocks are still maintained server-side).
export function bestTime(allStats) {
  const times = LEVELS.map((level) => allStats?.[level]?.bestTimeMs).filter((t) => t != null);
  return times.length ? Math.min(...times) : null;
}

export function fmtTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// storage — anything with .getItem/.setItem/.removeItem (typically
// localStorage). Passed as a parameter so tests can supply a fake, and so
// private mode/a disabled store doesn't break the game (everything is in
// try/catch).
//
// Returns { easy, normal, hard }, each level a full emptyStats() structure
// (no `overall` — the legacy blob predates points; the server seeds it).
// Migration: if the v2 key is absent but the old mahjong.stats.v1 (a single
// stats blob, no levels) exists — the old numbers become the hard level's
// stats wholesale, easy/normal stay empty; the result is immediately saved
// as v2, and the v1 key is removed.
export function load(storage = globalThis.localStorage) {
  const defaults = emptyLevels();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged = {};
      for (const level of LEVELS) merged[level] = { ...emptyStats(), ...parsed[level] };
      return merged;
    }

    const rawV1 = storage?.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const migrated = { ...defaults, hard: { ...emptyStats(), ...JSON.parse(rawV1) } };
      save(migrated, storage);
      storage?.removeItem(STORAGE_KEY_V1);
      return migrated;
    }

    return defaults;
  } catch {
    return defaults;
  }
}

// Kept only for load()'s internal use (writing the already-migrated v1->v2
// blob back to localStorage before removing the v1 key) — no longer a source
// of truth for the live game, nothing else calls this function.
function save(allStats, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(allStats));
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

// A client-side safety net after a successful server-side import
// (gameplay/api.py: import_stats) — the real guard against a repeat transfer
// lives on the server (Profile.legacy_imported), this is just cleaning up
// now-stale local data.
export function clearLegacy(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(STORAGE_KEY);
    storage?.removeItem(STORAGE_KEY_V1);
  } catch {
    // ignore
  }
}
