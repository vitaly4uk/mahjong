# Daily tournament (daily challenge + leaderboard)

Date: 2026-07-28. Status: implemented.

## Goal

A classic "daily challenge": all players on a given calendar day play the
**same deterministic layout**, competing for a spot on the leaderboard based
on completion time with penalties for hints/undos. No registration —
built on top of the already-existing anonymous identity
(`mahjong_player` cookie). Lifetime stats for regular play remain untouched —
the tournament exists as a fully parallel, isolated track.

## Solution

### Deterministic daily challenge

`gameplay/daily.py: daily_challenge(date) -> (board_slug, level, seed)` —
a pure function with no side effects and no state in the DB:

- **Layout** rotates by day: `list(load_layouts())[date.toordinal() %
  len(...)]` (`load_layouts()` already returns slugs in sorted order — an
  additional `sorted()` over them was redundant and has been removed, see
  Task 6 of the plan).
- **Difficulty level is always `'normal'`** (`DAILY_LEVEL`) — deliberately,
  so the leaderboard stays a single comparable board for everyone, instead
  of being split into easy/normal/hard.
- **Seed** — `f'daily-{date.isoformat()}'`, plain text (not a secret):
  `generate_for_difficulty` produces a deterministic result for the same
  `(seed, level, layout)` — the same mechanism that already guarantees
  reproducible generation in `gameplay/generator.py`.

### Data model: `GameSession` is reused, not duplicated

A tournament attempt is a regular `GameSession` with a non-empty
`daily_date` (the mode marker — there's no separate boolean field) plus
three new fields:

- `hints`/`undos` (`PositiveIntegerField`, default 0) — server-side penalty
  counters, incremented atomically (an `F()` expression) from the live
  `POST /{token}/bump`, the same way the rest of hint/undo counting works.
  For regular games these are dead columns, never written to (guarded by
  `session.daily_date is not None` in `bump_stat`).
- `score_ms` (`PositiveIntegerField`, nullable) — set only on a winning
  claim; stays `null` for regular games and for lost/unfinished tournament
  attempts.

The `one_daily_win_per_user_per_day` constraint (`gameplay/models.py:
GameSession.Meta.constraints`) is a **partial** `UniqueConstraint(fields=
['user', 'daily_date'], condition=Q(daily_date__isnull=False) &
Q(won=True))`. This is deliberately NOT "one attempt per day": any number of
rows with `daily_date` for the same user and day are allowed, as long as
none of them has `won=True` — only a SECOND win on the same day is blocked
at the DB level. This is the basis for retry-after-loss below.

### Scoring and ranking

`score_ms = elapsed_ms + hints × 5000 + undos × 3000` (ms), lower is better.
Computed atomically with an F-expression inside the same `UPDATE ... WHERE
status='active'` that claims the session (`gameplay/api.py: finish_game`) —
no separate read-modify-write, no race with a concurrent `/bump`. Computed
**only for a win**; a loss/deadlock/expired session leaves `score_ms =
null` and doesn't appear on the leaderboard (a `won=True` filter is applied
everywhere ranking/participants are counted).

Tie-break for equal scores — `claimed_at` (whoever recorded the result
first).

### Endpoints (`gameplay/api.py`, under `/api/game/`)

- **`GET /daily`** (`daily_info`) — today's layout/level, the player's
  status, the top-20 leaderboard, the player's own score/rank. The player's
  status (`'new' | 'active' | 'lost' | 'won'`) is derived from **the
  player's entire set** of today's rows (`_daily_setup`), not from a single
  row — because after a retry there can be several rows: a win exists →
  `'won'`; no win but a live `ACTIVE`-within-TTL attempt exists → `'active'`;
  no win and no live attempt, but rows exist (all ended in a loss/TTL) →
  `'lost'` (can retry); no rows at all → `'new'`.
- **`POST /daily/start`** (`start_daily`) — an idempotent get-or-create: if
  a win exists for today → `{finished: true}`, no new board will be
  created; if a live active attempt exists → returns the same token/layout
  (resume, no re-counting); otherwise — a new `GameSession` with the same
  deterministic seed (so this is either the first attempt or a legitimate
  retry after a loss — the layout is always the same).

Shared plumbing (`_daily_setup`, `_board_payload`, `_daily_rank`,
`_active_daily_session`) is factored out separately — both endpoints read
the same set of sessions and compute rank the same way, without duplicating
queries.

### Retrying a lost attempt (retry-after-loss)

Losing today's tournament and starting over is allowed any number of times
— the same deterministic layout, a fresh timer. A single win in a day
closes the tournament for the rest of the day
(`one_daily_win_per_user_per_day`).

UI entry point — the **"🔁 Replay"** button in the deadlock modal
(`static/game/main.js: replayGame()`, `templates/game.html:
#btn-deadlock-replay`), next to the existing "Shuffle"/"Give up" buttons:
1. Registers the current game as a loss (`POST /finish` with
   `outcome='deadlock'`, the same call as "Give up").
2. Immediately starts a new game with the same settings — no intermediate
   results screen.
   - For the tournament — `playDaily()` (the same deterministic board).
   - For regular play — `startGame(level, board)` (a new random `seed`, as
     always for free play — determinism is neither needed nor wanted here).

The button works the same way in both modes — a deadlock is detected by the
client and the server independently of whether the session is a tournament
session or not.

### Stats: the tournament and regular play never mix

`gameplay/api.py: _lifetime_stats_after(profile, session, mutator)` — the
single point of writing to `Profile.stats`: if `session.daily_date is not
None`, it returns the current blob **unchanged**; otherwise it applies
`mutator` (`apply_win`/`apply_loss`/`bump_counter`) as usual. Used in all
three places that touch `Profile.stats`: `finish_game`, `bump_stat`,
`shuffle_game`. A tournament game — whether it's a win, a hint, or a
shuffle — **never** moves `gamesPlayed`/`gamesWon`/`currentStreak`/
`bestTimeMs`/`hintsTotal`/`undosTotal`/`shufflesTotal` for the `normal`
level.

Consequence: `gamesStarted` is never incremented for the tournament —
`start_daily` never calls `bump_counter('start')`. This isn't a special
case, but a natural result of the tournament not touching profile counters
at all.

Tournament history (how many times played, how many losses, with what
score) lives entirely in `GameSession` rows (`daily_date`/`won`/`score_ms`/
`hints`/`undos`) — no duplicated/aggregated counter has deliberately been
added to the profile (YAGNI). A lifetime tournament record (how many times
won overall, longest streak of winning days, etc.) is not implemented; if
needed, it can be computed with a direct query against `GameSession` — the
data is already there.

### New "New game" modal: selection + a separate start button

The difficulty buttons became **pure selectors**, just like the layout
buttons — clicking only highlights the selection and saves it to
`localStorage`, without starting the game. A separate **"▶️ Start"** button
(`#btn-newgame-start`) starts the game with the current
`currentLevel`/`currentBoard`. The same Publisher/Subscriber pattern
(`registry.set('modal', ...)` + `renderModal()`) as before — no new
mechanism was added, only the "start" side effect was removed from clicking
a difficulty level.

### Tournament UI

- A **"🏆 Tournament"** button in the toolbar
  (`static/game/main.js: createToolbar`) — the sixth button, next to
  "Stats".
- `#daily-modal` (`templates/game.html`): today's layout name + number of
  participants (**the level is deliberately not shown** — it's always the
  same one, so there's nothing to show); if the player has won — their own
  score and rank; the top-20 leaderboard with an auto-nickname
  `Player #<4 hex chars of the public id>` (`gameplay/daily.py:
  nickname_for`, no registration/player name involved); the "Play"/
  "Continue" button — hidden once today's tournament has already been won
  (nothing left to start).

## Deliberately not done (YAGNI)

- No lifetime aggregated tournament score in the UI (the raw data exists in
  `GameSession`).
- No named nicknames or authentication — the leaderboard is fully
  anonymous.
- No separate difficulty level for the tournament — always `normal`.

## Tests

`gameplay/tests.py: DailyTournamentTests` — determinism of
`daily_challenge` (a fixed date → the same result, layout rotation by day),
reproducibility of generation from the same seed, idempotency of
`/daily/start`, `one_daily_win_per_user_per_day` (two losses — fine, two
wins — `IntegrityError`), the full retry-after-loss cycle (loss → new row →
same layout → a win blocks further attempts), scoring with penalties
(`test_daily_finish_sets_score_ms_with_hint_and_undo_penalties`), losses
being absent from the leaderboard, ranking order by score/claim time, and
separately — stats isolation
(`test_daily_play_never_touches_lifetime_normal_stats`).
