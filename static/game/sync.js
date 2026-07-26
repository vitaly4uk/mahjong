// Client for the game's server API (gameplay/api.py): starting a game (the
// server generates the field and tracks it), finishing (the server replays
// the move log and computes the time itself), live hint/undo/pair-removal
// counters, and lifetime stats — see
// docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md.
// The CSRF token comes from window.MAHJONG_CSRF (injected in
// templates/game.html). Player identity is the mahjong_player cookie
// (HttpOnly, signed by the server), sent automatically with every fetch
// (credentials: 'same-origin').

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

// Returns { token, layout: [{x,y,z,kind}, ...], board_width, board_height,
// board_layers, stats } — the renderer takes positions from layout (a tile's
// index in this array is its identifier for the moves log) and board
// dimensions straight from board_width/height/layers (gameplay/layouts.py:
// Layout, main.js: applyBoardDims — no need to re-derive them from layout).
// stats — the updated lifetime blob (the server already incremented
// gamesStarted for this level). board — a slug rendered server-side as
// `[data-board]` buttons in templates/game.html (gameplay/layouts.py:
// list_boards()), defaults to 'turtle' server-side if omitted.
export async function startGame(level, board) {
  return postJson('/api/game/start', { level, board });
}

// moves — an array of [idxA, idxB] pairs (indices into the layout array from
// startGame, in pair-removal order). outcome — 'win' or 'deadlock'.
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

// Session state for resuming a game after a page reload: status — 'active' |
// 'claimed' | 'expired' | 'unknown' (always 200, branch on the field),
// elapsedMs — the server-side game time, only for 'active'.
export async function fetchSessionState(token) {
  const data = await requestJson(`/api/game/${token}`);
  return { status: data.status, elapsedMs: data.elapsed_ms };
}

// A live increment of the hint/undo/pair counter during an active game
// (doesn't wait for finish). counter — 'hint' | 'undo' | 'pair'. Returns the
// updated lifetime blob.
export async function bumpStat(token, counter) {
  const data = await postJson(`/api/game/${token}/bump`, { counter });
  return data.stats;
}

// Reads the player's current lifetime stats (bootstraps the mahjong_player
// cookie on the server if it doesn't exist yet). legacyImportAvailable=true —
// the client hasn't transferred its localStorage blob to this profile yet.
export async function fetchStats() {
  const data = await requestJson('/api/game/stats');
  return { stats: data.stats, legacyImportAvailable: data.legacy_import_available };
}

// A one-time transfer of the old localStorage blob to the server.
// imported=false (with reason='already imported') — the server already
// transferred data for this profile before, the client doesn't retry.
export async function importLegacyStats(stats) {
  const data = await postJson('/api/game/stats/import', { stats });
  return { imported: data.imported, reason: data.reason ?? null, stats: data.stats ?? null };
}

// The current build version (the collectstatic manifest hash) — checked
// against window.MAHJONG_VERSION before starting a new game.
export async function fetchVersion() {
  const data = await requestJson('/api/version/');
  return data.version;
}
