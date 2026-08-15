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
    // Only set for a won daily-tournament session (gameplay/api.py: finish_game).
    dailyRank: data.daily_rank ?? null,
  };
}

// Reshuffles the kinds of whatever tiles remain on the board (offered on a
// dead end, main.js: updateStatus()/shuffleGame). moves — the current move
// log (same shape as finishGame), used server-side to replay to the current
// board state before reshuffling. Returns { kinds: {idx: kind}, stats } — kinds
// only for tiles still on the board; positions are unchanged. Throws (via
// requestJson) on a non-2xx response — e.g. the board isn't actually
// deadlocked, or the session already ended.
export async function shuffleGame(token, moves) {
  const data = await postJson(`/api/game/${token}/shuffle`, { moves });
  return { kinds: data.kinds, stats: data.stats };
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
  return {
    stats: data.stats,
    legacyImportAvailable: data.legacy_import_available,
    playerName: data.player_name,
  };
}

// Sets the player's chosen display name (gameplay/api.py: update_profile) —
// free-form, not unique, also doubles as the client-side DiceBear avatar
// seed (avatar.js). Returns the resolved name: the server already applies
// the auto-generated fallback (gameplay/daily.py: nickname_for) if `name`
// trims to empty, so the client never computes that fallback itself.
export async function saveProfile(name) {
  const data = await postJson('/api/game/profile', { name });
  return data.name;
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

// Today's daily tournament: the shared board/level, the caller's own
// progress ('new'|'active'|'won'|'lost'), and the top of the leaderboard
// (gameplay/api.py: daily_info). Read-only — safe to call just to refresh
// the modal.
export async function fetchDaily() {
  const data = await requestJson('/api/game/daily');
  return {
    date: data.date,
    board: data.board,
    boardName: data.board_name,
    boardWidth: data.board_width,
    boardHeight: data.board_height,
    boardLayers: data.board_layers,
    level: data.level,
    yourStatus: data.your_status,
    yourScoreMs: data.your_score_ms,
    yourRank: data.your_rank,
    totalParticipants: data.total_participants,
    leaderboard: data.leaderboard.map((entry) => (
      { rank: entry.rank, nickname: entry.nickname, scoreMs: entry.score_ms }
    )),
  };
}

// Idempotent get-or-create for today's attempt (gameplay/api.py: start_daily):
// the first call generates+claims today's shared board; later calls the same
// day return the same session while resumable, or finished=true (with no
// token/layout) once claimed/forfeited — never a second board.
export async function startDaily() {
  const data = await postJson('/api/game/daily/start', {});
  return {
    finished: data.finished,
    token: data.token,
    layout: data.layout,
    board: data.board,
    boardWidth: data.board_width,
    boardHeight: data.board_height,
    boardLayers: data.board_layers,
    level: data.level,
  };
}

// Switches the active UI language via Django's built-in set_language view
// (config/urls.py: path('i18n/', include('django.conf.urls.i18n'))). Sent as
// a form-encoded body (not JSON, unlike the rest of this file) — the view
// reads request.POST, which Django only populates for form-encoded/multipart
// bodies. 'Accept: application/json' skips the HTML redirect-page body the
// view would otherwise render (no text/html in Accept -> 204 No Content); the
// django_language cookie is set either way, via Set-Cookie on the response.
// Caller reloads the page afterward — both the server-rendered template and
// the /jsi18n/ catalog need a fresh request to pick up the new language.
export async function setLanguage(code) {
  await fetch('/i18n/setlang/', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': window.MAHJONG_CSRF,
      Accept: 'application/json',
    },
    body: new URLSearchParams({ language: code, next: '/' }),
  });
}
