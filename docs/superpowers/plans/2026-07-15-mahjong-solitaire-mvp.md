# Mahjong Solitaire MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser-based mahjong solitaire on Phaser 3 with a 9×9×3 board (minus the center of the top layer, 242 tiles) and a guaranteed-solvable generation, embedded into the existing Django project.

**Architecture:** Pure game logic in ES modules `static/game/board.js` (board model) and `static/game/generator.js` (solvable generation via reverse-game simulation), tested via `node:test` without npm. Rendering and input — Phaser 3 (a single vendor file) in `static/game/main.js`, the page — Django template `templates/game.html` at the root `/`. UI buttons — DOM elements above the canvas.

**Tech Stack:** Django 6.0 (no dependency changes), Phaser 3.90.0 (minified file in static), vanilla JS ES modules, node:test (node v26 locally), CC0 tiles from FluffyStuff/riichi-mahjong-tiles.

**Spec:** `docs/superpowers/specs/2026-07-15-mahjong-solitaire-mvp-design.md`

## Global Constraints

- No npm/package.json/build system. Phaser — static file `static/vendor/phaser.min.js`.
- Logic (board.js, generator.js) does not import Phaser and does not touch the DOM.
- Board: 9×9×3 minus (x=4, y=4, z=2) = 242 tiles. Coordinates x,y ∈ 0..8, z ∈ 0..2.
- A tile is free ⇔ the cell (x,y,z+1) is empty AND (x−1,y,z) or (x+1,y,z) is empty.
- 34 tile kinds: Man1–9, Pin1–9, Sou1–9, Ton, Nan, Shaa, Pei, Haku, Hatsu, Chun. Names = PNG file names.
- 121 pairs = 19 random kinds × 4 pairs + 15 kinds × 3 pairs.
- Dockerfile, Procfile, pyproject.toml — do not change.
- Tests: `node --test 'tests/*.test.js'` from the repo root.

---

### Task 1: Board model (board.js)

**Files:**
- Create: `static/game/board.js`
- Test: `tests/board.test.js`

**Interfaces:**
- Produces:
  - `WIDTH = 9`, `HEIGHT = 9`, `LAYERS = 3` (numeric constants)
  - `posKey(x, y, z)` → string `"x,y,z"`
  - `targetPositions()` → array of 242 objects `{x, y, z}` (without `{4,4,2}`)
  - `isFreePosition(occupied, x, y, z)` → boolean; `occupied` — anything with a `.has(key)` method (Map/Set with `posKey` keys)
  - `class Board`:
    - `constructor(tiles)` — tiles: array of objects `{x, y, z, kind}` (stored by reference)
    - `tiles()` → array of remaining tiles
    - `isFree(tile)` → boolean
    - `canMatch(a, b)` → boolean (different objects, same kind, both free)
    - `removePair(a, b)` → boolean (false if not canMatch; if true — removes and pushes to the undo stack)
    - `undo()` → `[a, b]` or `null`
    - `findMatchingPair()` → `[a, b]` or `null` (among free tiles)
    - `get remaining` → number
    - `isWon()` → boolean
    - `isDeadlocked()` → boolean (`remaining > 0` and no pairs)

- [x] **Step 1: Write failing tests**

Create `tests/board.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WIDTH, HEIGHT, LAYERS, posKey, targetPositions, isFreePosition, Board,
} from '../static/game/board.js';

const t = (x, y, z, kind) => ({ x, y, z, kind });

test('constants', () => {
  assert.equal(WIDTH, 9);
  assert.equal(HEIGHT, 9);
  assert.equal(LAYERS, 3);
});

test('targetPositions: 242 unique positions, top-center missing', () => {
  const pos = targetPositions();
  assert.equal(pos.length, 242);
  const keys = new Set(pos.map((p) => posKey(p.x, p.y, p.z)));
  assert.equal(keys.size, 242);
  assert.ok(!keys.has(posKey(4, 4, 2)));
  assert.ok(keys.has(posKey(4, 4, 1)));
  assert.ok(keys.has(posKey(0, 0, 0)));
  assert.ok(keys.has(posKey(8, 8, 2)));
});

test('isFreePosition: covered position is not free', () => {
  const occupied = new Set([posKey(3, 3, 0), posKey(3, 3, 1)]);
  assert.equal(isFreePosition(occupied, 3, 3, 0), false);
  assert.equal(isFreePosition(occupied, 3, 3, 1), true);
});

test('isFreePosition: both sides occupied is not free, one side is free', () => {
  const occupied = new Set([posKey(2, 0, 0), posKey(3, 0, 0), posKey(4, 0, 0)]);
  assert.equal(isFreePosition(occupied, 3, 0, 0), false);
  assert.equal(isFreePosition(occupied, 2, 0, 0), true);
  assert.equal(isFreePosition(occupied, 4, 0, 0), true);
});

test('isFreePosition: edge of grid counts as free side', () => {
  const occupied = new Set([posKey(0, 0, 0), posKey(1, 0, 0)]);
  assert.equal(isFreePosition(occupied, 0, 0, 0), true);
});

test('Board.isFree matches the rules', () => {
  const covered = t(3, 3, 0, 'Man1');
  const cover = t(3, 3, 1, 'Pin1');
  const mid = t(1, 5, 0, 'Sou1');
  const board = new Board([
    covered, cover, t(0, 5, 0, 'Ton'), mid, t(2, 5, 0, 'Nan'),
  ]);
  assert.equal(board.isFree(covered), false);
  assert.equal(board.isFree(cover), true);
  assert.equal(board.isFree(mid), false);
  assert.equal(board.isFree(t(7, 7, 0, 'Chun')), false); // not on the board
});

test('removePair: rejects non-matching, same tile, blocked tiles', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(3, 0, 0, 'Man1');
  const other = t(5, 0, 0, 'Pin1');
  const board = new Board([a, b, other]);
  assert.equal(board.removePair(a, other), false); // different kind
  assert.equal(board.removePair(a, a), false); // the same tile
  assert.equal(board.remaining, 3);
  assert.equal(board.removePair(a, b), true);
  assert.equal(board.remaining, 1);
  assert.equal(board.isFree(a), false); // removed tile is no longer on the board
});

test('undo restores the last removed pair, returns null on empty stack', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(3, 0, 0, 'Man1');
  const board = new Board([a, b]);
  assert.equal(board.undo(), null);
  board.removePair(a, b);
  assert.ok(board.isWon());
  const pair = board.undo();
  assert.deepEqual(new Set(pair), new Set([a, b]));
  assert.equal(board.remaining, 2);
  assert.equal(board.isFree(a), true);
  assert.equal(board.undo(), null);
});

test('findMatchingPair, isDeadlocked, isWon', () => {
  // Man1 in the middle of the row is blocked on both sides, the second Man1 is free → no pair
  const blockedMan = t(1, 0, 0, 'Man1');
  const freeMan = t(4, 4, 0, 'Man1');
  const board = new Board([
    t(0, 0, 0, 'Pin1'), blockedMan, t(2, 0, 0, 'Pin2'), freeMan,
  ]);
  assert.equal(board.findMatchingPair(), null);
  assert.equal(board.isDeadlocked(), true);
  assert.equal(board.isWon(), false);

  const c = t(0, 8, 0, 'Sou5');
  const d = t(8, 8, 0, 'Sou5');
  const board2 = new Board([c, d]);
  assert.deepEqual(new Set(board2.findMatchingPair()), new Set([c, d]));
  assert.equal(board2.isDeadlocked(), false);
});

test('tiles() returns remaining tiles', () => {
  const a = t(0, 0, 0, 'Man1');
  const b = t(3, 0, 0, 'Man1');
  const c = t(5, 5, 1, 'Pin3');
  const board = new Board([a, b, c]);
  assert.equal(board.tiles().length, 3);
  board.removePair(a, b);
  assert.deepEqual(board.tiles(), [c]);
});
```

- [x] **Step 2: Verify that the tests fail**

Run: `node --test 'tests/*.test.js'`
Expected: FAIL — `Cannot find module .../static/game/board.js`

- [x] **Step 3: Implement board.js**

Create `static/game/board.js`:

```js
export const WIDTH = 9;
export const HEIGHT = 9;
export const LAYERS = 3;

export const posKey = (x, y, z) => `${x},${y},${z}`;

// Target shape: 3 full 9×9 layers minus the center of the top layer → 242 positions.
export function targetPositions() {
  const out = [];
  for (let z = 0; z < LAYERS; z++) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (z === LAYERS - 1 && x === 4 && y === 4) continue;
        out.push({ x, y, z });
      }
    }
  }
  return out;
}

// occupied — any object with .has(posKey(...)): Set or Map.
export function isFreePosition(occupied, x, y, z) {
  if (occupied.has(posKey(x, y, z + 1))) return false;
  return !occupied.has(posKey(x - 1, y, z)) || !occupied.has(posKey(x + 1, y, z));
}

export class Board {
  constructor(tiles) {
    this.byPos = new Map();
    for (const tile of tiles) this.byPos.set(posKey(tile.x, tile.y, tile.z), tile);
    this.undoStack = [];
  }

  tiles() {
    return [...this.byPos.values()];
  }

  isFree(tile) {
    if (this.byPos.get(posKey(tile.x, tile.y, tile.z)) !== tile) return false;
    return isFreePosition(this.byPos, tile.x, tile.y, tile.z);
  }

  canMatch(a, b) {
    return a !== b && a.kind === b.kind && this.isFree(a) && this.isFree(b);
  }

  removePair(a, b) {
    if (!this.canMatch(a, b)) return false;
    this.byPos.delete(posKey(a.x, a.y, a.z));
    this.byPos.delete(posKey(b.x, b.y, b.z));
    this.undoStack.push([a, b]);
    return true;
  }

  undo() {
    const pair = this.undoStack.pop();
    if (!pair) return null;
    for (const tile of pair) this.byPos.set(posKey(tile.x, tile.y, tile.z), tile);
    return pair;
  }

  findMatchingPair() {
    const seen = new Map();
    for (const tile of this.byPos.values()) {
      if (!this.isFree(tile)) continue;
      const partner = seen.get(tile.kind);
      if (partner) return [partner, tile];
      seen.set(tile.kind, tile);
    }
    return null;
  }

  get remaining() {
    return this.byPos.size;
  }

  isWon() {
    return this.byPos.size === 0;
  }

  isDeadlocked() {
    return this.byPos.size > 0 && this.findMatchingPair() === null;
  }
}
```

- [x] **Step 4: Verify that the tests pass**

Run: `node --test 'tests/*.test.js'`
Expected: PASS, 10 tests.

- [x] **Step 5: Commit**

```bash
git add static/game/board.js tests/board.test.js
git commit -m "feat: mahjong board model with free-tile rule, match/undo, deadlock detection"
```

---

### Task 2: Solvable generation (generator.js)

**Files:**
- Create: `static/game/generator.js`
- Test: `tests/generator.test.js`

**Interfaces:**
- Consumes: `targetPositions()`, `posKey`, `isFreePosition` from `./board.js`
- Produces:
  - `KINDS` — an array of 34 strings (kind names = PNG names)
  - `generateLayout(rng = Math.random)` → an array of 242 tiles `{x, y, z, kind}`, **ordered in pairs in solution order**: pair i — elements `[2i]` and `[2i+1]`; removing pairs sequentially in this order is legal and empties the board.

**Algorithm (reverse-game simulation):** fill the entire target shape with anonymous positions; then play "into the future": at each step find all free positions (per the removal rule), take two random ones, assign them the next pair's kind, and remove them. The recorded removal order = a ready-made solution. If fewer than 2 positions are free (a rare dead end, e.g. two positions stacked at the very end) — restart the attempt from scratch.

- [x] **Step 1: Write failing tests**

Create `tests/generator.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLayout, KINDS } from '../static/game/generator.js';
import { Board, targetPositions, posKey } from '../static/game/board.js';

// Deterministic PRNG for reproducible tests.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('KINDS: 34 unique kinds', () => {
  assert.equal(KINDS.length, 34);
  assert.equal(new Set(KINDS).size, 34);
  assert.ok(KINDS.includes('Man1'));
  assert.ok(KINDS.includes('Sou9'));
  assert.ok(KINDS.includes('Chun'));
});

test('layout fills the target shape exactly', () => {
  const tiles = generateLayout(mulberry32(1));
  assert.equal(tiles.length, 242);
  const keys = new Set(tiles.map((t) => posKey(t.x, t.y, t.z)));
  const target = new Set(targetPositions().map((p) => posKey(p.x, p.y, p.z)));
  assert.deepEqual(keys, target);
});

test('kind distribution: valid kinds, even counts, 19×8 + 15×6', () => {
  const tiles = generateLayout(mulberry32(2));
  const counts = new Map();
  for (const tile of tiles) {
    assert.ok(KINDS.includes(tile.kind), `unknown kind ${tile.kind}`);
    counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1);
  }
  const values = [...counts.values()].sort((a, b) => a - b);
  assert.deepEqual(values, [...Array(15).fill(6), ...Array(19).fill(8)]);
});

test('consecutive pairs share a kind', () => {
  const tiles = generateLayout(mulberry32(3));
  for (let i = 0; i < tiles.length; i += 2) {
    assert.equal(tiles[i].kind, tiles[i + 1].kind, `pair ${i / 2}`);
  }
});

test('layout is solvable by removing pairs in generation order (30 seeds)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const tiles = generateLayout(mulberry32(seed));
    const board = new Board(tiles);
    for (let i = 0; i < tiles.length; i += 2) {
      assert.equal(
        board.removePair(tiles[i], tiles[i + 1]), true,
        `seed ${seed}: pair ${i / 2} not removable`,
      );
    }
    assert.ok(board.isWon(), `seed ${seed}: board not empty`);
  }
});
```

- [x] **Step 2: Verify that the new tests fail**

Run: `node --test 'tests/*.test.js'`
Expected: board tests PASS, generator tests FAIL (`Cannot find module .../generator.js`).

- [x] **Step 3: Implement generator.js**

Create `static/game/generator.js`:

```js
import { targetPositions, posKey, isFreePosition } from './board.js';

export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 121 pair kinds: 19 random kinds with 4 pairs each + 15 kinds with 3 pairs each.
function buildPairKinds(rng) {
  const kinds = shuffle([...KINDS], rng);
  const pairKinds = [];
  kinds.forEach((kind, i) => {
    const pairs = i < 19 ? 4 : 3;
    for (let p = 0; p < pairs; p++) pairKinds.push(kind);
  });
  return shuffle(pairKinds, rng);
}

// Reverse-game simulation: remove random free pairs from the full shape,
// assigning kinds in removal order. The result is solvable by construction —
// the recorded removal order is itself the solution.
function tryGenerate(rng) {
  const occupied = new Map(
    targetPositions().map((p) => [posKey(p.x, p.y, p.z), p]),
  );
  const pairKinds = buildPairKinds(rng);
  const tiles = [];
  while (occupied.size > 0) {
    const free = [...occupied.values()].filter(
      (p) => isFreePosition(occupied, p.x, p.y, p.z),
    );
    if (free.length < 2) return null;
    shuffle(free, rng);
    const [a, b] = free;
    const kind = pairKinds.pop();
    tiles.push({ x: a.x, y: a.y, z: a.z, kind }, { x: b.x, y: b.y, z: b.z, kind });
    occupied.delete(posKey(a.x, a.y, a.z));
    occupied.delete(posKey(b.x, b.y, b.z));
  }
  return tiles;
}

export function generateLayout(rng = Math.random) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const tiles = tryGenerate(rng);
    if (tiles) return tiles;
  }
  throw new Error('Failed to generate a solvable layout after 100 attempts');
}
```

- [x] **Step 4: Verify that all tests pass**

Run: `node --test 'tests/*.test.js'`
Expected: PASS, 15 tests (10 board + 5 generator). The 30-seed test should pass within seconds.

- [x] **Step 5: Commit**

```bash
git add static/game/generator.js tests/generator.test.js
git commit -m "feat: guaranteed-solvable layout generator via reverse-game simulation"
```

---

### Task 3: Static assets and Django integration

**Files:**
- Create: `static/vendor/phaser.min.js` (download)
- Create: `static/game/tiles/*.png` (35 files: 34 kinds + Front.png)
- Create: `templates/game.html`
- Modify: `config/settings.py` (add `STATICFILES_DIRS`)
- Modify: `config/urls.py` (root → game.html)
- Modify: `.gitignore` (make sure `staticfiles/` is ignored)

**Interfaces:**
- Consumes: kind names `KINDS` (Task 2) = PNG file names.
- Produces:
  - Page `/` with DOM: `#toolbar` (buttons `#btn-new`, `#btn-hint`, `#btn-undo`, status `#status`), container `#game-container`, with `vendor/phaser.min.js` (plain script) and `game/main.js` (module) included.
  - Tiles available at URL `/static/game/tiles/<Kind>.png`.

- [x] **Step 1: Download Phaser and tiles**

```bash
cd /Users/vitaly4uk/Documents/GitHub/mahjong
mkdir -p static/vendor static/game/tiles
curl -fsSL -o static/vendor/phaser.min.js \
  https://cdn.jsdelivr.net/npm/phaser@3.90.0/dist/phaser.min.js
names="Man1 Man2 Man3 Man4 Man5 Man6 Man7 Man8 Man9 \
Pin1 Pin2 Pin3 Pin4 Pin5 Pin6 Pin7 Pin8 Pin9 \
Sou1 Sou2 Sou3 Sou4 Sou5 Sou6 Sou7 Sou8 Sou9 \
Ton Nan Shaa Pei Haku Hatsu Chun Front"
for n in $names; do
  curl -fsSL -o "static/game/tiles/$n.png" \
    "https://raw.githubusercontent.com/FluffyStuff/riichi-mahjong-tiles/master/Export/Regular/$n.png"
done
ls static/game/tiles | wc -l   # expected 35
```

Check the size of one PNG (`file static/game/tiles/Man1.png`) — should be a valid PNG.

- [x] **Step 2: Add STATICFILES_DIRS to settings.py**

In `config/settings.py`, after the line `STATIC_ROOT = BASE_DIR / 'staticfiles'`, add:

```python
STATICFILES_DIRS = [BASE_DIR / 'static']
```

Make sure `.gitignore` contains the line `staticfiles/` (add it if missing).

- [x] **Step 3: Create templates/game.html**

```html
{% load static %}
<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mahjong</title>
<style>
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; background: #1d2b1f; color: #eee;
    font-family: system-ui, sans-serif;
  }
  #toolbar { display: flex; gap: 8px; align-items: center; padding: 10px; }
  #toolbar button {
    padding: 8px 14px; font-size: 15px; border: 0; border-radius: 6px;
    background: #3a5a40; color: #fff; cursor: pointer;
  }
  #toolbar button:hover { background: #4c7454; }
  #status { margin-left: 12px; font-size: 15px; }
  #game-container { width: 100%; max-width: 800px; flex: 1; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="btn-new">New game</button>
  <button id="btn-hint">Hint</button>
  <button id="btn-undo">Undo</button>
  <span id="status"></span>
</div>
<div id="game-container"></div>
<script src="{% static 'vendor/phaser.min.js' %}"></script>
<script type="module" src="{% static 'game/main.js' %}"></script>
</body>
</html>
```

- [x] **Step 4: Switch the root to the game**

In `config/urls.py`, replace the line with `coming_soon.html`:

```python
    path('', TemplateView.as_view(template_name='game.html'), name='home'),
```

(The `templates/coming_soon.html` template can be left in place — it's harmless.)

- [x] **Step 5: Verification**

`static/game/main.js` doesn't exist yet — create a temporary stub to check the page:

```bash
echo "console.log('main.js stub');" > static/game/main.js
uv run manage.py runserver 8000 &
sleep 2
curl -s http://127.0.0.1:8000/ | grep -c 'game-container'      # expected 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/static/vendor/phaser.min.js   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/static/game/tiles/Man1.png    # 200
kill %1
uv run manage.py collectstatic --noinput --dry-run | tail -1   # no errors
```

- [x] **Step 6: Commit**

```bash
git add static/vendor static/game templates/game.html config/settings.py config/urls.py .gitignore
git commit -m "feat: game page, Phaser vendor bundle, CC0 riichi tile assets (FluffyStuff)"
```

---

### Task 4: Phaser scene and UI (main.js)

**Files:**
- Create (replace the stub): `static/game/main.js`

**Interfaces:**
- Consumes:
  - `Board` (methods from Task 1: `tiles()`, `isFree`, `canMatch`, `removePair`, `undo`, `findMatchingPair`, `remaining`, `isWon`, `isDeadlocked`)
  - `generateLayout()`, `KINDS` (Task 2)
  - DOM from Task 3: `#btn-new`, `#btn-hint`, `#btn-undo`, `#status`, `#game-container`
  - Global `Phaser` (vendor script)
- Produces: a fully functional game at `/`.

- [x] **Step 1: Implement main.js**

```js
import { WIDTH, HEIGHT, LAYERS, Board } from './board.js';
import { generateLayout, KINDS } from './generator.js';

const TILE_W = 70;
const TILE_H = 90;
const LAYER_DX = 6; // layer offset up-right for pseudo-3D
const LAYER_DY = 8;
const MARGIN = 30;
const GAME_W = WIDTH * TILE_W + 2 * MARGIN + LAYERS * LAYER_DX;
const GAME_H = HEIGHT * TILE_H + 2 * MARGIN + LAYERS * LAYER_DY;
const SELECT_TINT = 0x77bbff;

const tileUrl = (name) => `/static/game/tiles/${name}.png`;
const statusEl = document.getElementById('status');

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
  }

  preload() {
    this.load.image('Front', tileUrl('Front'));
    for (const kind of KINDS) this.load.image(kind, tileUrl(kind));
  }

  create() {
    this.sprites = new Map(); // tile -> Phaser container
    this.selected = null;
    this.newGame();
  }

  newGame() {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;
    this.board = new Board(generateLayout());
    for (const tile of this.board.tiles()) this.addTileSprite(tile);
    this.updateStatus();
  }

  addTileSprite(tile) {
    const px = MARGIN + tile.x * TILE_W + TILE_W / 2 + tile.z * LAYER_DX;
    const py = MARGIN + LAYERS * LAYER_DY
      + tile.y * TILE_H + TILE_H / 2 - tile.z * LAYER_DY;
    const front = this.add.image(0, 0, 'Front').setDisplaySize(TILE_W, TILE_H);
    const face = this.add.image(0, -3, tile.kind)
      .setDisplaySize(TILE_W * 0.78, TILE_H * 0.78);
    const container = this.add.container(px, py, [front, face]);
    container.setSize(TILE_W, TILE_H);
    container.setDepth(tile.z);
    container.setInteractive();
    container.on('pointerdown', () => this.handleTileClick(tile));
    container.tintTargets = [front, face];
    this.sprites.set(tile, container);
  }

  setTileTint(tile, color) {
    for (const img of this.sprites.get(tile).tintTargets) img.setTint(color);
  }

  clearTileTint(tile) {
    const sprite = this.sprites.get(tile);
    if (sprite) for (const img of sprite.tintTargets) img.clearTint();
  }

  handleTileClick(tile) {
    if (!this.board.isFree(tile)) return;
    if (this.selected === tile) {
      this.clearTileTint(tile);
      this.selected = null;
      return;
    }
    if (this.selected && this.board.canMatch(this.selected, tile)) {
      this.removePair(this.selected, tile);
      return;
    }
    if (this.selected) this.clearTileTint(this.selected);
    this.selected = tile;
    this.setTileTint(tile, SELECT_TINT);
  }

  removePair(a, b) {
    if (!this.board.removePair(a, b)) return;
    for (const tile of [a, b]) {
      this.sprites.get(tile).destroy();
      this.sprites.delete(tile);
    }
    this.selected = null;
    this.updateStatus();
  }

  undo() {
    const pair = this.board.undo();
    if (!pair) return;
    if (this.selected) {
      this.clearTileTint(this.selected);
      this.selected = null;
    }
    for (const tile of pair) this.addTileSprite(tile);
    this.updateStatus();
  }

  hint() {
    const pair = this.board.findMatchingPair();
    if (!pair) return;
    for (const tile of pair) {
      this.tweens.add({
        targets: this.sprites.get(tile),
        alpha: 0.3,
        duration: 180,
        yoyo: true,
        repeat: 3,
      });
    }
  }

  updateStatus() {
    if (this.board.isWon()) {
      statusEl.textContent = 'You win! 🎉';
    } else if (this.board.isDeadlocked()) {
      statusEl.textContent = 'No moves left — start a new game';
    } else {
      statusEl.textContent = `Tiles: ${this.board.remaining}`;
    }
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#1d2b1f',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_W,
    height: GAME_H,
  },
  scene: MainScene,
});

const scene = () => game.scene.keys.main;
document.getElementById('btn-new').addEventListener('click', () => scene().newGame());
document.getElementById('btn-hint').addEventListener('click', () => scene().hint());
document.getElementById('btn-undo').addEventListener('click', () => scene().undo());
```

- [x] **Step 2: Run all logic tests (regression)**

Run: `node --test 'tests/*.test.js'`
Expected: PASS, 15 tests.

- [x] **Step 3: Smoke test in the browser**

```bash
uv run manage.py runserver 8000
```

Open `http://127.0.0.1:8000/` in a browser (playwright/chrome tools or manually) and verify:
- The 9×9 board with three layers is rendered, tiles are legible, upper layers are shifted.
- Browser console has no errors (404s on tiles, JS errors).
- Clicking a free tile — highlights it; clicking a second matching tile — the pair disappears, counter -2.
- Clicking a blocked tile (center of the bottom layer) — nothing happens.
- "Hint" — the pair blinks; "Undo" — the pair returns; "New game" — a new layout of 242 tiles.

- [x] **Step 4: Verify the prod static build**

```bash
uv run manage.py collectstatic --noinput
```
Expected: built without errors (whitenoise manifest). The `staticfiles/` directory does not go into git.

- [x] **Step 5: Commit**

```bash
git add static/game/main.js
git commit -m "feat: Phaser scene — rendering, matching, hint, undo, deadlock/win status"
```

---

## Verification against the spec (final checklist)

- [x] 242 tiles (9×9×3 minus the center of the top layer) — `targetPositions` test.
- [x] Free-tile rule — board tests.
- [x] Guaranteed solvability — 30-seed test.
- [x] 34 kinds, 19×4 + 15×3 pairs — distribution test.
- [x] New game / hint / undo / dead-end detection — browser smoke test.
- [x] Dockerfile/Procfile unchanged, collectstatic works.
