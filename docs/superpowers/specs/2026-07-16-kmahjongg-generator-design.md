# Layout generator following the KMahjongg scheme

Date: 2026-07-16. Status: approved.

Replaces the sections "Level presets", "Lever 1" and "Lever 3" of the spec
[2026-07-16-difficulty-levels-design.md](2026-07-16-difficulty-levels-design.md).
The rest of that spec (the `simulate.js` validator, `generateForDifficulty`,
statistics v2, level-selection UI, testing scheme) remains in effect.

## Problem

The current generator, even at the hard level, places both tiles of a pair on
adjacent cells: `adjacencyBias: 1` in the hard preset **always** picks an
adjacent pair, and by default the candidates are limited to the topmost
incomplete layer — both halves of the pair end up in the same narrow "removal
front". The game boils down to clicking obvious adjacent pairs.

Researching reference implementations (KMahjongg `src/gamedata.cpp`,
`generateSolvableGame`/`selectPosition`) showed that the standard approach is
the opposite: the pair's halves are scattered **uniformly across the whole
board**, and an explicit **anti-adjacency filter** is in effect — the second
half cannot land right next to the first. Commercial games (Kristanix Mahjong
Epic) use "pairs near the surface" specifically as an *easing* mechanism, and
the academic literature (arXiv:1203.6559) measures the difficulty of a
solvable board via Monte Carlo simulation of a strategy — which is exactly
what our `simulate.js` already does — and points out that difficulty without
lookahead is created by copies of the same kind spread across different
layers and locked one above the other.

## Base algorithm (shared across all levels)

Reverse play in `static/game/generator.js` (`tryGenerate`) is kept: from the
full shape of 242 positions, pairs of free positions are removed, and the
recorded order = the solution. What changes is **pair selection**:

1. Candidates — **all free positions** on the board (not just the top layer).
   In reverse simulation any pair of free positions is valid by construction,
   so solvability is unaffected. The `topFree`/`crossLayerChance` branches
   disappear.
2. The first half `a` — a uniformly random free position.
3. The second half `b` — uniformly random among the free positions that pass
   the **level's placement filter** (see below). If none pass — the filter is
   relaxed to "any free position except `a`" (bail-out).
4. **Dead end → regenerate.** In `uniform`/`layered` modes, removal can hit a
   dead end: the last two tiles lie one above the other, only the top one is
   free (measured at ~13% of seeds for `uniform`). This can't be fixed by pair
   selection — no valid pair exists. Just like KMahjongg
   (`generateSolvableGame` returns false → a new attempt), `tryGenerate` in
   such a state returns `null`, and `generateLayout` retries (expected ~1.2
   attempts; a hard cap of 100 attempts guards against future regressions).

An analog of KMahjongg's "higher is better" trick isn't needed: in the
removal-based formulation free positions always exist, and the top layer is
opened first anyway.

## Difficulty levels

A single preset parameter — `placement`, the filter mode for the second half
of a pair, plus the existing `pairScheduling` (kind queue, `buildPairKinds`
unchanged):

| Parameter | easy | normal | hard |
|---|---|---|---|
| `placement` | `surface` | `uniform` | `layered` |
| `pairScheduling` | `random` | `random` | `grouped` |
| Bot win-rate band | [0.65, 1] | [0.35, 0.65] | [0, 0.30] |

- **`surface`** (easy) — following Kristanix: both halves are taken from the
  free positions of the **topmost incomplete layer**, with a preference for
  adjacent pairs (~0.9 probability of picking an adjacent pair when one
  exists). This is the previous generator's default behavior — it remains as
  an easing mechanism. The "layer's odd tail" branch (the single free tile on
  the top layer) is preserved only in this mode.
- **`uniform`** (normal) — the pure KMahjongg scheme: `b` is any free
  position **except those adjacent** to `a` (`isAdjacent`: same layer,
  touching on a side).
- **`layered`** (hard) — the `uniform` filter plus the requirement
  `b.z !== a.z` when such candidates exist: the pair's halves are forced onto
  different layers — copies of a kind get locked vertically, and the solution
  requires a cross-layer removal order.

The `adjacencyBias` and `crossLayerChance` options are removed from the public
API (`generateLayout(rng, options)` accepts `{ placement, pairScheduling }`).

Win-rate bands — starting values: the new generator's difficulty distribution
is different, so the bands are checked by the calibration test and tuned as
needed (this is an expected adjustment, not an emergency fix). The
`generateForDifficulty` mechanism (up to 30 attempts, accepts the first layout
within the band, otherwise the closest one) is unchanged.

## Testing

Updates to `tests/generator.test.js` (`node --test 'tests/*.test.js'`):

- Solvability across 30 seeds for each of the three `placement` modes
  (replaces the `crossLayerChance` test).
- Anti-adjacency property: for `uniform` and `layered`, the halves of a single
  pair are not adjacent. A pair is reconstructed from the order in the result:
  `generateLayout` places tiles in pairs, so `tiles[2i]` and `tiles[2i+1]` are
  one pair. Rare bail-out pairs are allowed only at the tail of generation:
  the test permits adjacency only in the last two pairs of the generation
  order.
- `layered`: the fraction of pairs of a kind with halves on different layers
  is substantially higher than in `uniform` (statistical check across several
  seeds).
- Calibration test: for each level, `generateForDifficulty` over ~20 seeds
  yields a win rate within the target band.

## Out of scope

- Changes to `simulate.js`, `stats.js`, UI (`main.js`, `game.html`) — not
  needed: the generator's API for callers (`generateForDifficulty(level, rng)`)
  is unchanged.
- Daily seeds, deeper difficulty analytics.
