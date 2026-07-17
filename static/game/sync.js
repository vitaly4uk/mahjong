// Клієнт до серверного API гри (gameplay/api.py): старт партії (сервер
// генерує поле й веде облік) і фініш (сервер реплеїть лог ходів і сам рахує
// час) — див. docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md.
// CSRF-токен береться з window.MAHJONG_CSRF (інжектиться в templates/game.html).

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': window.MAHJONG_CSRF,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

// Повертає { token, layout: [{x,y,z,kind}, ...] } — рендер бере позиції з
// layout, а індекс кістки в цьому масиві — її ідентифікатор для moves-логу.
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
  };
}
