// Статистика гри: чистий модуль, без Phaser/DOM.
// Довічні показники (persist у localStorage), незалежні від поточної партії.
// v2: статистика розбита по рівнях складності (easy/normal/hard), кожен рівень
// має свою повну структуру. v1 (єдина статистика, без рівнів) мігрується в
// рівень hard при першому load() — див. міграцію нижче.

export const STORAGE_KEY = 'mahjong.stats.v2';
export const STORAGE_KEY_V1 = 'mahjong.stats.v1';
export const LEVELS = ['easy', 'normal', 'hard'];

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

export function emptyAllStats() {
  return { easy: emptyStats(), normal: emptyStats(), hard: emptyStats() };
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

// storage — будь-що з .getItem/.setItem/.removeItem (типово localStorage).
// Приймається параметром, щоб тести могли підсунути фейк, а приватний
// режим/вимкнене сховище не ламали гру (усе в try/catch).
//
// Повертає { easy, normal, hard }, кожен рівень — повна структура emptyStats().
// Міграція: якщо v2-ключа нема, а є старий mahjong.stats.v1 (єдина статистика
// без рівнів) — старі числа цілком стають статистикою рівня hard, easy/normal
// лишаються порожніми; результат одразу зберігається як v2, а v1-ключ
// видаляється.
export function load(storage = globalThis.localStorage) {
  const defaults = emptyAllStats();
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

export function save(allStats, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(allStats));
  } catch {
    // ignore (приватний режим, квота, тощо)
  }
}
