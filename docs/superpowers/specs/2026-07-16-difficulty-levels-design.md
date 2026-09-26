# Layout generation difficulty levels

Date: 2026-07-16. Status: approved.

## Goal

Three difficulty levels — **easy / normal / hard** ("Easy / Normal / Hard") — with
a guarantee that the actual difficulty of every generated layout is measured, not
just "tuned via probabilities". Layout solvability is preserved at all
levels (reverse simulation by construction yields a solvable layout).

## Architecture: heuristics + validator bot

Generation remains reverse simulation in `static/game/generator.js`. Difficulty
is achieved via two layers:

1. **Heuristic levers** shift the difficulty distribution in the desired direction.
2. **Validator bot** measures the win rate of careless play and accepts a layout
   only if it falls within the level's target band; otherwise — regenerate.

### Level presets

`generator.js` exports `DIFFICULTIES` (starting values, calibrated by tests):

| Parameter | easy | normal | hard |
|---|---|---|---|
| `adjacencyBias` | 0.9 | 0.5 | 0.05 |
| `pairScheduling` | `grouped` | `random` | `split` |
| `crossLayerChance` | 0 | 0 | 0.4 |
| Bot win-rate band | [0.75, 1] | [0.30, 0.60] | [0, 0.10] |

### Lever 1: `adjacencyBias` (existing)

The probability of placing a pair's tiles adjacently. A low value → the pair's
tiles are far from each other → harder.

### Lever 2: `pairScheduling` (new)

Replaces the plain shuffle in `buildPairKinds` with a queue scheduler for kinds:

- `grouped` — all pairs of the same kind sit consecutively in the queue: all
  copies of a kind open up in the game at roughly the same time, so any match
  among the 4 copies is safe.
- `random` — current behavior (full shuffle).
- `split` — pairs of the same kind are scattered across opposite halves of the
  queue: one pair "sinks" to the bottom of the layout, the other lands near the
  surface. This creates traps with 4 identical tiles: removing the "wrong"
  combination blocks the deep pair.

### Lever 3: `crossLayerChance` (new)

Currently `tryGenerate` removes pairs strictly from the topmost incomplete layer
(maxZ), and the solution proceeds layer by layer. With probability
`crossLayerChance`, a pair is taken from **all** free positions — the solution
starts jumping between layers, creating cross-layer dependencies ("to open the
bottom here, you have to clear the top there"). Solvability is unaffected: any
pair of free positions in reverse simulation is valid by construction. The odd-
tail branch of the top layer is preserved for the maxZ path.

### Validator: `static/game/simulate.js` (new pure module)

- `carelessPlay(board, rng)` — the "careless player" bot (ported from
  `tests/generator.test.js`, `randomPlayTopFirst`): at each step picks a random
  pair among those touching the topmost layer; no lookahead. Returns
  win/loss.
- `measureWinRate(tiles, rng, trials)` — the fraction of wins over `trials`
  simulations (typically ~16).

### `generateForDifficulty(level, rng)` (new, in `generator.js`)

A loop of up to 30 attempts: generate a layout with the level's preset →
measure win rate → accept if within the band. If no hit within 30 attempts —
returns the candidate closest to the band (the game is never left without a
layout). Worst case ~480 simulations ≈ a few hundred ms; the typical case is
much less, since the heuristics already shift the distribution into the band.

`generateLayout(rng, options)` with low-level options is kept — used by the
tests; `generateForDifficulty` is a wrapper over it.

## Statistics: `stats.js` v2

- New key `mahjong.stats.v2`, format `{ easy, normal, hard }` — each level
  has the current structure (`gamesPlayed`, `gamesWon`, `hintsTotal`, `undosTotal`,
  `pairsTotal`, `bestTimeMs`, `currentStreak`, `bestStreak`).
- **Migration**: `load()` reads v2; if it's absent but `mahjong.stats.v1` exists —
  the old numbers become the **hard**-level statistics entirely, easy/normal stay
  empty; the result is saved as v2, and the v1 key is removed.
- The pure transformers `applyWin`/`applyLoss` are unchanged — they operate on
  a single level's object; the caller passes the slice for the relevant level.

## UI: `main.js` + `templates/game.html`

- **New game modal** `#newgame-modal` (styled like `#stats-modal`): three
  buttons "Easy / Normal / Hard", the current choice highlighted. The "New
  game" button opens the modal; clicking a level starts a session.
- The choice is stored in `localStorage` (`mahjong.difficulty`, default
  `normal`). First page load: the game starts immediately with the saved
  level, no modal.
- **Stats modal**: three blocks — one per level; the current level is
  highlighted.
- The toolbar shows a label for the current level. Registry keys
  (`this.registry`) receive a level dimension; wins/losses are written to the
  statistics of the level the session **started** at.

## Testing

`node --test 'tests/*.test.js'`, no browser:

- `simulate.js`: the bot is deterministic with a seeded rng, always finishes
  the game.
- `pairScheduling`: `grouped` yields adjacent pairs of a kind in the queue;
  `split` — spread across the halves.
- `crossLayerChance=1`: solvability across 30 seeds (analogous to the existing
  test).
- **Calibration test**: for each level, `generateForDifficulty` over ~20 seeds
  yields a win rate within the target band, with a reasonable average number
  of attempts.
- `stats.js`: v1→hard migration, v2 load/save, empty levels.
- `main.js` (Phaser, modals) — manual verification in the browser.

## Out of scope

- Daily seeds (a separate effort).
- Clustering visually similar suits ("visual noise") — a possible fourth
  lever in the future.
- Statistics breakdown finer than three levels.
