// Статистика гри: чистий модуль, без Phaser/DOM.
// Довічні показники (persist у localStorage), незалежні від поточної партії.

export const STORAGE_KEY = 'mahjong.stats.v1';

export function emptyStats() {
  return {
    gamesPlayed: 0,
    gamesWon: 0,
    hintsTotal: 0,
    undosTotal: 0,
    pairsTotal: 0,
    bestTimeMs: null,
    currentStreak: 0,
    bestStreak: 0,
  };
}

// Перемога: гра зіграна, серія росте, рекорд часу — мінімум серед перемог.
export function applyWin(stats, timeMs) {
  const currentStreak = stats.currentStreak + 1;
  return {
    ...stats,
    gamesPlayed: stats.gamesPlayed + 1,
    gamesWon: stats.gamesWon + 1,
    currentStreak,
    bestStreak: Math.max(stats.bestStreak, currentStreak),
    bestTimeMs: stats.bestTimeMs === null ? timeMs : Math.min(stats.bestTimeMs, timeMs),
  };
}

// Поразка (глухий кут): гра зіграна, серія перемог обривається.
export function applyLoss(stats) {
  return {
    ...stats,
    gamesPlayed: stats.gamesPlayed + 1,
    currentStreak: 0,
  };
}

export function winRate(stats) {
  if (stats.gamesPlayed === 0) return 0;
  return Math.round((stats.gamesWon / stats.gamesPlayed) * 100);
}

export function fmtTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// storage — будь-що з .getItem/.setItem (типово localStorage). Приймається
// параметром, щоб тести могли підсунути фейк, а приватний режим/вимкнене
// сховище не ламали гру (усе в try/catch).
export function load(storage = globalThis.localStorage) {
  const defaults = emptyStats();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function save(stats, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // ignore (приватний режим, квота, тощо)
  }
}
