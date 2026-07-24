// Клієнт до серверного API гри (gameplay/api.py): старт партії (сервер
// генерує поле й веде облік), фініш (сервер реплеїть лог ходів і сам рахує
// час), живі лічильники hint/undo/pair-знять і довічна статистика —
// див. docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md.
// CSRF-токен береться з window.MAHJONG_CSRF (інжектиться в templates/game.html).
// Ідентичність гравця — кукі mahjong_player (HttpOnly, підписана сервером),
// їде автоматично з кожним fetch (credentials: 'same-origin').

async function requestJson(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': window.MAHJONG_CSRF,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(url, body) {
  return requestJson(url, { method: 'POST', body });
}

// Повертає { token, layout: [{x,y,z,kind}, ...], stats } — рендер бере
// позиції з layout, а індекс кістки в цьому масиві — її ідентифікатор для
// moves-логу. stats — оновлений довічний блоб (сервер уже інкрементував
// gamesStarted для цього рівня).
export async function startGame(level) {
  return postJson('/api/game/start', { level });
}

// moves — масив пар [idxA, idxB] (індекси в масиві layout зі startGame,
// у порядку зняття пар). outcome — 'win' або 'deadlock'.
export async function finishGame(token, moves, outcome) {
  const data = await postJson('/api/game/finish', { token, moves, outcome });
  return {
    valid: data.valid,
    reason: data.reason ?? null,
    won: data.won,
    elapsedMs: data.elapsed_ms,
    stats: data.stats ?? null,
  };
}

// Живий інкремент лічильника hint/undo/pair під час активної партії (не
// чекає фінішу). counter — 'hint' | 'undo' | 'pair'. Повертає оновлений
// довічний блоб.
export async function bumpStat(token, counter) {
  const data = await postJson(`/api/game/${token}/bump`, { counter });
  return data.stats;
}

// Читає поточну довічну статистику гравця (бутстрапить кукі mahjong_player
// на сервері, якщо її ще нема). legacyImportAvailable=true — клієнт ще не
// переносив свій localStorage-блоб на цей профіль.
export async function fetchStats() {
  const data = await requestJson('/api/game/stats');
  return { stats: data.stats, legacyImportAvailable: data.legacy_import_available };
}

// Одноразовий перенос старого localStorage-блоба на сервер. imported=false
// (з reason='already imported') — сервер уже переносив дані для цього
// профілю раніше, клієнт більше не повторює спробу.
export async function importLegacyStats(stats) {
  const data = await postJson('/api/game/stats/import', { stats });
  return { imported: data.imported, reason: data.reason ?? null, stats: data.stats ?? null };
}

// Поточна версія білда (хеш маніфесту collectstatic) — звіряється з
// window.MAHJONG_VERSION перед стартом нової партії.
export async function fetchVersion() {
  const data = await requestJson('/api/version/');
  return data.version;
}
