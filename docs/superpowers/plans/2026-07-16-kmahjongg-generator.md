# KMahjongg-Style Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite pair selection in the layout generator to follow the KMahjongg scheme (uniform random over the whole board + an anti-adjacency filter) with three `placement` difficulty modes.

**Architecture:** In `static/game/generator.js` the reverse-play approach stays, but pair selection is factored out into two helpers: `pickSurfacePair` (easy, the old "top free front + adjacency" behavior) and `pickSpreadPair` (normal/hard, uniform random over all free positions with filters). The `DIFFICULTIES` presets move to a single `placement` parameter; the `adjacencyBias` and `crossLayerChance` options are removed. The calibration mechanism `generateForDifficulty` is unchanged; win-rate bands are tuned based on measurement.

**Tech Stack:** Vanilla JS ES modules, no build step; tests — the built-in Node runner (`node --test 'tests/*.test.js'`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md`.
- Pure modules: `generator.js` does not import Phaser/DOM.
- The public API for callers does not change: `generateForDifficulty(level, rng)`, `generateLayout(rng, options)`, the exports `DIFFICULTIES`, `KINDS`, `isAdjacent` are preserved.
- `buildPairKinds` and the `pairScheduling` modes (`random`/`grouped`/`split`) are unchanged.
- Run tests only in the form `node --test 'tests/*.test.js'` (the runner doesn't accept a bare directory without a glob).
- Code comments — in English, in the style of the existing ones.

---

### Task 1: Placement modes in the generator

**Files:**
- Modify: `static/game/generator.js` (`DIFFICULTIES` presets, `tryGenerate`, new helpers; remove `DEFAULT_ADJACENCY_BIAS`, `pickPair`, the `crossLayerChance`/`topFree` branches from `tryGenerate`)
- Modify: `tests/generator.test.js` (new tests; remove the tests `adjacencyBias=1: most generated pairs...`, `adjacencyBias=1 layouts survive...`, `crossLayerChance=1: layout is still solvable...`)

**Interfaces:**
- Consumes: `targetPositions`, `posKey`, `isFreePosition` from `./board.js`; existing `shuffle`, `buildPairKinds`, `isAdjacent`.
- Produces: `generateLayout(rng, { placement, pairScheduling })`, where `placement` ∈ `'surface' | 'uniform' | 'layered'` (default `'uniform'`); `DIFFICULTIES` with fields `{ placement, pairScheduling, winRateBand }`. Pair order in the result: `tiles[2i]`/`tiles[2i+1]` is one pair (as now).

- [ ] **Step 1: Write the new tests (they will fail)**

In `tests/generator.test.js` **remove** three tests: `adjacencyBias=1: most generated pairs are adjacent tiles (averaged over seeds)` (lines 68–83), `adjacencyBias=1 layouts survive careless play far more often than adjacencyBias=0` (85–101), `crossLayerChance=1: layout is still solvable in generation order (30 seeds)` (136–148). Add these instead:

```js
test('every placement mode yields a layout solvable in generation order (30 seeds each)', () => {
  for (const placement of ['surface', 'uniform', 'layered']) {
    for (let seed = 1; seed <= 30; seed++) {
      const tiles = generateLayout(mulberry32(seed), { placement });
      const board = new Board(tiles);
      for (let i = 0; i < tiles.length; i += 2) {
        assert.equal(
          board.removePair(tiles[i], tiles[i + 1]), true,
          `${placement} seed ${seed}: pair ${i / 2} not removable`,
        );
      }
      assert.ok(board.isWon(), `${placement} seed ${seed}: board not empty`);
    }
  }
});

test('surface: most pairs are adjacent tiles on one layer (averaged over 20 seeds)', () => {
  let adjacentCount = 0;
  let totalPairs = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const tiles = generateLayout(mulberry32(seed), { placement: 'surface' });
    for (let i = 0; i < tiles.length; i += 2) {
      totalPairs += 1;
      if (isAdjacent(tiles[i], tiles[i + 1])) adjacentCount += 1;
    }
  }
  assert.ok(
    adjacentCount / totalPairs >= 0.75,
    `expected >=75% adjacent pairs, got ${adjacentCount}/${totalPairs}`,
  );
});

test('uniform and layered: pair halves are almost never adjacent (>=99% per seed)', () => {
  for (const placement of ['uniform', 'layered']) {
    for (let seed = 1; seed <= 20; seed++) {
      const tiles = generateLayout(mulberry32(seed), { placement });
      let nonAdjacent = 0;
      const totalPairs = tiles.length / 2;
      for (let i = 0; i < tiles.length; i += 2) {
        if (!isAdjacent(tiles[i], tiles[i + 1])) nonAdjacent += 1;
      }
      assert.ok(
        nonAdjacent / totalPairs >= 0.99,
        `${placement} seed ${seed}: only ${nonAdjacent}/${totalPairs} non-adjacent pairs`,
      );
    }
  }
});

test('layered puts pair halves on different layers far more often than uniform', () => {
  const crossLayerShare = (placement) => {
    let cross = 0;
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const tiles = generateLayout(mulberry32(seed), { placement });
      for (let i = 0; i < tiles.length; i += 2) {
        total += 1;
        if (tiles[i].z !== tiles[i + 1].z) cross += 1;
      }
    }
    return cross / total;
  };
  const layered = crossLayerShare('layered');
  const uniform = crossLayerShare('uniform');
  assert.ok(
    layered >= uniform + 0.2,
    `expected layered (${layered}) to exceed uniform (${uniform}) by >=0.2`,
  );
});
```

- [ ] **Step 2: Confirm the new tests fail**

Run: `node --test 'tests/*.test.js'`
Expected: FAIL — the new tests fail (the old code ignores the `placement` option: `uniform`/`layered` behave like the old default with `adjacencyBias=0.85`, so the anti-adjacency test fails). The old tests still pass unchanged.

- [ ] **Step 3: Implementation in `generator.js`**

Remove the `DEFAULT_ADJACENCY_BIAS` constant and the `pickPair` function. Replace the presets with:

```js
// Difficulty-level presets (see docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md).
// placement — the mode for choosing positions for pair halves:
// - surface — both from the topmost free front, biased toward adjacency
//   (the easing mechanism from Kristanix Mahjong Epic);
// - uniform — the pure KMahjongg scheme: uniform random over all free
//   positions, the second half may not be adjacent to the first;
// - layered — uniform + halves forced onto different layers when possible
//   (vertical locking of the kind described in arXiv:1203.6559).
// winRateBand — target win-rate band for the "careless player" (simulate.js);
// starting values, calibrated by the generateForDifficulty test.
export const DIFFICULTIES = {
  easy: { placement: 'surface', pairScheduling: 'random', winRateBand: [0.65, 1] },
  normal: { placement: 'uniform', pairScheduling: 'random', winRateBand: [0.35, 0.65] },
  hard: { placement: 'layered', pairScheduling: 'grouped', winRateBand: [0, 0.30] },
};
```

Add helpers (replacing `pickPair`):

```js
// Probability that surface mode picks an adjacent pair when one exists on
// the top free front — keeps the layout comfortably easy to play without
// lookahead.
const SURFACE_ADJACENCY_BIAS = 0.85;

// surface: both halves from the highest incomplete layer (it is flat and
// has nothing above it, so it always has ≥1 free tile), biased toward
// adjacent pairs. An odd tail on the layer (a single free tile) is paired
// with an arbitrary free tile below.
function pickSurfacePair(free, rng) {
  const maxZ = Math.max(...free.map((p) => p.z));
  const topFree = free.filter((p) => p.z === maxZ);
  if (topFree.length === 1) {
    const a = topFree[0];
    const rest = free.filter((p) => p !== a);
    return [a, rest[Math.floor(rng() * rest.length)]];
  }
  if (rng() < SURFACE_ADJACENCY_BIAS) {
    const adjacentPairs = [];
    for (let i = 0; i < topFree.length; i++) {
      for (let j = i + 1; j < topFree.length; j++) {
        if (isAdjacent(topFree[i], topFree[j])) {
          adjacentPairs.push([topFree[i], topFree[j]]);
        }
      }
    }
    if (adjacentPairs.length > 0) {
      return adjacentPairs[Math.floor(rng() * adjacentPairs.length)];
    }
  }
  const shuffled = shuffle([...topFree], rng);
  return [shuffled[0], shuffled[1]];
}

// uniform/layered: the first half is a uniformly random free position, the
// second is a uniformly random one from those not adjacent to the first
// (KMahjongg, selectPosition). In layered mode a different layer is also
// required when such candidates exist. If the filter leaves nobody — bail
// out to "any free position except the first": generation never gets stuck.
function pickSpreadPair(free, rng, requireLayerSplit) {
  const a = free[Math.floor(rng() * free.length)];
  let candidates = free.filter((p) => p !== a && !isAdjacent(p, a));
  if (requireLayerSplit) {
    const crossLayer = candidates.filter((p) => p.z !== a.z);
    if (crossLayer.length > 0) candidates = crossLayer;
  }
  if (candidates.length === 0) candidates = free.filter((p) => p !== a);
  const b = candidates[Math.floor(rng() * candidates.length)];
  return [a, b];
}
```

Rewrite `tryGenerate` (the `topFree`/`crossLayerChance` branches disappear):

```js
// Reverse-play simulation: pairs of free positions are removed from the
// full shape, and the recorded removal order is the solution. Any pair of
// free positions is valid by construction, so the candidates are all free
// board positions; the placement mode determines how exactly the pair
// halves are chosen (see DIFFICULTIES).
function tryGenerate(rng, { placement = 'uniform', pairScheduling = 'random' } = {}) {
  const occupied = new Map(
    targetPositions().map((p) => [posKey(p.x, p.y, p.z), p]),
  );
  const pairKinds = buildPairKinds(rng, pairScheduling);
  const tiles = [];
  while (occupied.size > 0) {
    const free = [...occupied.values()].filter(
      (p) => isFreePosition(occupied, p.x, p.y, p.z),
    );
    const [a, b] = placement === 'surface'
      ? pickSurfacePair(free, rng)
      : pickSpreadPair(free, rng, placement === 'layered');

    const kind = pairKinds.pop();
    tiles.push({ x: a.x, y: a.y, z: a.z, kind }, { x: b.x, y: b.y, z: b.z, kind });
    occupied.delete(posKey(a.x, a.y, a.z));
    occupied.delete(posKey(b.x, b.y, b.z));
  }
  return tiles;
}
```

`generateLayout`, `distanceToBand`, `generateForDifficulty`, `CALIBRATION_TRIALS`, `CALIBRATION_ATTEMPTS` — unchanged. The comment above `DIFFICULTIES` about empirical observations from the old generator (lines 15–24) should be removed together with the old presets.

- [ ] **Step 4: Run all tests except the calibration one**

Run: `node --test 'tests/*.test.js'`
Expected: all tests PASS, except possibly `generateForDifficulty: each level lands its win rate in the target band on average (~20 seeds)` — its bands are calibrated in Task 2. If anything else fails — fix it here.

- [ ] **Step 5: Commit**

```bash
git add static/game/generator.js tests/generator.test.js
git commit -m "feat: KMahjongg-style pair placement with surface/uniform/layered modes"
```

---

### Task 2: Calibrate the win-rate bands

**Files:**
- Modify: `static/game/generator.js` (only the `winRateBand` values in `DIFFICULTIES`, if the measurement shows a miss)
- Modify: `docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md` (band table — update to match the actual values)

**Interfaces:**
- Consumes: `generateLayout`, `measureWinRate` (`simulate.js`), presets from Task 1.
- Produces: final `winRateBand` values for the three levels; a green calibration test.

- [ ] **Step 1: Measure the actual win-rate distribution of the new generator**

Write a one-off script in the scratchpad (not in the repo) that, for each preset, generates 20 layouts `generateLayout(mulberry32(seed), preset)` and prints the win rate for each (`measureWinRate(tiles, mulberry32(seed + 777), 40)`), plus min/max/average:

```js
// scratchpad/measure.mjs
import { generateLayout, DIFFICULTIES } from '/Users/vitaly4uk/Documents/GitHub/mahjong/static/game/generator.js';
import { measureWinRate } from '/Users/vitaly4uk/Documents/GitHub/mahjong/static/game/simulate.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const [level, preset] of Object.entries(DIFFICULTIES)) {
  const rates = [];
  for (let seed = 1; seed <= 20; seed++) {
    const tiles = generateLayout(mulberry32(seed), preset);
    rates.push(measureWinRate(tiles, mulberry32(seed + 777), 40));
  }
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  console.log(level, 'min', Math.min(...rates), 'avg', avg.toFixed(3), 'max', Math.max(...rates), rates.map((r) => r.toFixed(2)).join(' '));
}
```

Run: `node scratchpad/measure.mjs`
Expected: three lines of statistics. Record the actual ranges.

- [ ] **Step 2: Tune the bands based on the measurement**

Rule: a level's band must cover the central mass of its preset's actual distribution, and the three levels' bands must remain distinct (easy above normal, normal above hard; overlapping edges are acceptable). If the starting bands ([0.65,1] / [0.35,0.65] / [0,0.30]) already satisfy this — change nothing. Otherwise — change **only** the `winRateBand` numbers in `DIFFICULTIES` and in the spec table; don't touch the logic.

- [ ] **Step 3: Run the calibration test**

Run: `node --test 'tests/*.test.js'`
Expected: all tests PASS, including `generateForDifficulty: each level lands its win rate in the target band on average (~20 seeds)`.

- [ ] **Step 4: Commit**

```bash
git add static/game/generator.js docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md
git commit -m "feat: calibrate win-rate bands for KMahjongg-style generator"
```

---

### Task 3: Manual verification in the browser

`main.js` is unchanged (it calls `generateForDifficulty`), but the actual gameplay needs to be seen with our own eyes.

**Files:** nothing changes; verification only.

- [ ] **Step 1: Start the server**

Run: `uv run manage.py runserver`
Expected: server at `http://127.0.0.1:8000/`.

- [ ] **Step 2: Check the three levels**

For each level (easy/normal/hard), start a new game and make sure:
- the layout renders fully (242 tiles), clicks/matching work;
- on normal/hard, pair halves do **not** lie massively on adjacent cells;
- on easy the game is noticeably easier (pairs are often next to each other on the surface);
- the hint finds pairs, undo works.

- [ ] **Step 3: Final test run and push**

Run: `node --test 'tests/*.test.js'`
Expected: all PASS.

```bash
git push dokku main   # deploy — only if the user confirms
```
