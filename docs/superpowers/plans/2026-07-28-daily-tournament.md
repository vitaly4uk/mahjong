# Daily Tournament — Implementation Plan

**Status:** implemented. Design: [2026-07-28-daily-tournament-design.md](../specs/2026-07-28-daily-tournament-design.md).

**Goal:** Add a daily tournament (a shared deterministic layout for the day +
a time-based leaderboard with penalties), without mixing it up with the
regular game's lifetime statistics and without complicating the server model
more than necessary.

**Architecture:** A tournament attempt is the same `GameSession`, marked with
a non-empty `daily_date` (no separate model/table). The layout/level/seed are
deterministic based on the date (`gameplay/daily.py: daily_challenge`), so all
players on a given day play an identical layout with zero DB state for the
layout itself. One winning row per day per player blocks repeat attempts
(a partial `UniqueConstraint`); lost attempts can be retried indefinitely —
the same deterministic layout every time. The leaderboard and score are
computed via direct queries against `GameSession`, without duplicating data
in `Profile.stats` — and that's precisely why the tournament is isolated from
the regular game's lifetime statistics by construction, not by a patch on
top.

## Global Constraints

- Ukrainian comments in new Python/JS code — contradicts `CLAUDE.md`
  ("all comments in code — in English"); in this project the comments are
  indeed in English, unlike the `2026-07-17` plan (which had a different
  convention there).
- `uv run ruff check .`, `npx --yes @biomejs/biome@2.5.5 lint static/game
  tests`, `uv run manage.py test`, `node --test 'tests/*.test.js'` — all
  four must pass cleanly before any task is considered done.
- No new separate tournament-statistics counter in
  `Profile.stats` — YAGNI, the data already lives in `GameSession`.

---

### Task 1: Deterministic daily challenge + server model

**Files:**
- Create: `gameplay/daily.py`
- Modify: `gameplay/models.py` (`GameSession`: `hints`, `undos`, `daily_date`,
  `score_ms`, `Meta.constraints`/`indexes`)
- Create: `gameplay/migrations/0004_gamesession_daily_date_gamesession_hints_and_more.py`
  (auto-generated)

- [x] `daily_challenge(date) -> (board_slug, level, seed)` — a pure function,
  no side effects; the board rotates by day, the level is fixed at `'normal'`
  (`DAILY_LEVEL`), the seed is `f'daily-{date.isoformat()}'`.
- [x] `GameSession` + 4 fields, index `(daily_date, score_ms)` for the
  leaderboard, `UniqueConstraint(user, daily_date)` — **initial version**
  (one attempt per day, no retry).

### Task 2: `GET /daily` / `POST /daily/start` endpoints, schemas, tests

**Files:**
- Modify: `gameplay/api.py`, `gameplay/schemas.py`, `gameplay/tests.py`

- [x] `daily_info` / `start_daily` — first version: one attempt per day,
  the player's status from a single row (`'new'|'active'|'won'|'lost'`).
- [x] `DailyResponse`/`DailyStartResponse`/`LeaderboardEntry` schemas.
- [x] `finish_game` — a branch for `session.daily_date is not None`: score
  with penalties via an F-expression, `daily_rank` in the response.
- [x] `bump_stat` — an atomic increment of `hints`/`undos` only for
  tournament sessions.
- [x] Tests for determinism/idempotency/score/ranking.

### Task 3: Frontend — toolbar, tournament modal, sync.js

**Files:**
- Modify: `static/game/sync.js`, `static/game/main.js`, `templates/game.html`

- [x] `fetchDaily()`/`startDaily()` in `sync.js`.
- [x] "🏆 Tournament" button in the toolbar, `#daily-modal` + rendering
  (`renderDailyModal`), started via `playDaily()`.
- [x] An `isDaily` flag threaded through `persistGame`/`tryResumeGame` — so
  resuming a session after a page reload correctly distinguishes a
  tournament session.

### Task 4: Localization — fixing the tournament difficulty level

**Files:** `gameplay/daily.py`, `gameplay/tests.py`, `static/game/main.js`,
`locale/{uk,en}/LC_MESSAGES/*.po`

- [x] `daily_challenge` no longer rotates the level — always `'normal'`
  (reflection: one comparable leaderboard matters more than difficulty
  variety).
- [x] Removed the level display from the tournament modal
  (`renderDailyModal`) — since it's always the same one, there's nothing to
  show.

### Task 5: Retry-after-loss + a consistent new-game modal

**Files:** `gameplay/models.py`, new migration `0005_...`, `gameplay/api.py`,
`gameplay/tests.py`, `static/game/main.js`, `templates/game.html`

- [x] `UniqueConstraint` relaxed to `one_daily_win_per_user_per_day`
  (partial, `won=True` only) — any number of lost attempts is allowed, only
  a second win on the same day is blocked at the DB level.
- [x] `daily_info`/`start_daily` rewritten to work with the set of today's
  rows, rather than a single row (`_daily_setup`).
- [x] A "🔁 Replay" button in the deadlock modal (`replayGame()`) — for both
  the regular game and the tournament: registers the loss and immediately
  starts a new game without an intermediate results screen.
- [x] The difficulty buttons in the "New game" modal became plain selectors
  (just like the layout buttons); a separate "▶️ Start" button actually
  launches the game.
- [x] Tests for the retry cycle (loss → new row → same layout → a win blocks
  further attempts).

### Task 6: `/code-review simplify` — removing duplication

**Files:** `gameplay/api.py`, `gameplay/daily.py`, `gameplay/schemas.py`,
`gameplay/tests.py`, `static/game/sync.js`, `static/game/main.js`

- [x] The `Daily*`/`LeaderboardEntry`/`FinishResponse.daily_rank` schemas
  were reverted to plain snake_case (no per-schema camelCase aliases, which
  had diverged from the rest of `schemas.py`) — the camelCase mapping
  remains on the client side (`sync.js`), same as for the other endpoints.
- [x] `_daily_setup`/`_board_payload`/`_daily_rank` — shared logic between
  `daily_info`/`start_daily`/`finish_game`, removing duplicated queries.
- [x] `bump_stat` no longer writes an unnecessary UPDATE for regular
  (non-tournament) sessions; `daily_info` skips an unnecessary `COUNT` for
  `total_participants` when the leaderboard page isn't fully populated.
- [x] `_enterFreshGame()` — the shared tail of `startGame()`/`playDaily()` in
  `main.js` (client-side sprite reset/`enterGame`/rendering).
- [x] Removed dead code (`daily_score_ms`, a redundant `sorted()` over the
  already-sorted `load_layouts()`).

### Task 7: Isolating tournament stats from the regular game's lifetime stats

**Files:** `gameplay/api.py`, `gameplay/tests.py`, `static/game/main.js`
(comment)

- [x] `_lifetime_stats_after(profile, session, mutator)` — the single point
  of writing to `Profile.stats`; for a tournament session it returns the
  blob unchanged, never calling `mutator`. Applied in `finish_game`,
  `bump_stat`, `shuffle_game`.
- [x] Invariant test `test_daily_play_never_touches_lifetime_normal_stats`.
- [x] Fixed an inaccurate comment in `replayGame()` (main.js): "the session
  will simply pick back up" is only true for the tournament branch, not for
  the regular game.

## Verification

```
uv run ruff check .
npx --yes @biomejs/biome@2.5.5 lint static/game tests
uv run manage.py test
node --test 'tests/*.test.js'
```

Manual verification in the browser (all scenarios passed): starting the
tournament, dead end → "Replay" (same layout, game counter updates),
win → score/leaderboard position, re-entering the tournament after a
win → "finished", the new "New game" modal (selection without starting +
a separate "Start" button).
