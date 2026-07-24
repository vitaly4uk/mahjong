// Статистика гри: чистий модуль, без Phaser/DOM.
// Довічні показники живуть на сервері (gameplay/models.py: Profile.stats) —
// цей модуль лишає лише презентаційні хелпери (winRate/fmtTime), порожню
// форму (emptyStats/emptyAllStats, для плейсхолдера до першого мережевого
// запиту) і load() — тепер використовується ЛИШЕ як одноразовий "зчитувач
// legacy-блоба" для переносу старого localStorage на сервер (main.js:
// create()). applyWin/applyLoss/save() видалені — логіка порахунку win/loss
// живе тільки на сервері (gameplay/stats.py), клієнт більше нічого не пише
// в localStorage. v1 (єдина статистика, без рівнів) і далі мігрується в
// рівень hard усередині load() — той самий формат payload, що очікує
// POST /api/game/stats/import (gameplay/api.py: import_stats).

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
    bestTimeMs: null,
    currentStreak: 0,
    bestStreak: 0,
  };
}

export function emptyAllStats() {
  return Object.fromEntries(LEVELS.map((level) => [level, emptyStats()]));
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

// Лишається лише для внутрішнього використання load() (запис уже
// змігрованого v1->v2 блоба назад у localStorage перед видаленням v1-ключа) —
// більше НЕ джерело істини для живої гри, ніхто інший цю функцію не викликає.
function save(allStats, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(allStats));
  } catch {
    // ignore (приватний режим, квота, тощо)
  }
}

// Клієнтська підстраховка після успішного серверного імпорту (gameplay/api.py:
// import_stats) — реальний гард від повторного переносу є на сервері
// (Profile.legacy_imported), це лише прибирання вже неактуальних локальних
// даних.
export function clearLegacy(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(STORAGE_KEY);
    storage?.removeItem(STORAGE_KEY_V1);
  } catch {
    // ignore
  }
}
