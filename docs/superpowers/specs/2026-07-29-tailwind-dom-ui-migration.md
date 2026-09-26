# Move the UI chrome to DOM + Tailwind CSS, split up main.js

Date: 2026-07-29. Status: implemented.

## Goal

Before this change, ~95% of the game's UI was drawn on the Phaser canvas: the
toolbar, the status bar, the photographer credit — all of it was
`Phaser.Text`/rectangle/container objects (`static/game/main.js`). The only
real DOM was 4 modals (`templates/game.html`), styled by a separate `app.css`.

Plans to grow the DOM part of the game (new panels/menus outside the canvas)
made the current architecture cramped: adding DOM UI meant either duplicating
rendering logic (canvas + DOM), or moving part of the UI from the canvas to
the DOM. At the same time, `main.js` had grown to 1821 lines, mixing the
scene, DOM chrome, the game session, and animations into a single file.

Decision:
1. Move the **toolbar + status bar + photographer credit + modals** into the
   DOM; from now on the canvas draws **only** the board (tiles/effects/
   background).
2. Style this DOM with **Tailwind CSS v4**, built by the same Docker stage
   that already builds `bundle.js` (esbuild).
3. Split `main.js` into `scene.js`/`effects.js`/`ui-dom.js`/a thin `main.js`.

## Canvas/DOM boundary

**In the canvas (unchanged):** tile sprites, SVG rasterization, depth
sorting, tile clicks (the single scene-level `gameobjectdown` handler), all
animations/effects (deal-in, pair flight to the counter, flip on shuffle,
glow/hover/press/error, the final win/loss effect), the background photo +
veil, all the session game logic (the freedom rule, matching, undo, deadlock,
start/finish/shuffle).

**In the DOM (new):** the toolbar (New game/Hint/Undo/Stats/Tournament/
Language), the status bar (remaining/difficulty/lifetime stats), the
photographer credit, 4 modals.

Two points of contact between canvas and DOM:
- **State sync** — the game still writes facts into `scene.registry`
  (Phaser DataManager); the DOM subscriber (`ui-dom.js`) reads them and
  updates `textContent` instead of `setText`. The same Publisher/Subscriber
  pattern as before — only the subscriber's render target changed.
- **Tile flight to the counter** (`removePair` → `flyToCenterThenDown` →
  `flyDownFromCenter`) — the target is now computed from the DOM counter's
  `getBoundingClientRect()` (`ui-dom.js: getCounterRect()`), converted into
  the canvas's world space (`scene.js: flightTarget()`:
  `(screenPx - canvasCssOrigin) * dpr`).

## Technical pitfalls (for future changes in this same area)

- **`#game-container` must not have its own `height`** in the Tailwind
  source (`assets/tailwind.src.css`). It's a `<main class="flex-1 min-h-0">`
  between `<header>`/`<footer>` — flexbox computes the size. An explicit
  `height` in `@layer base` (even an incorrect/stale one) would beat
  `flex-1` — Tailwind's cascade layers (`base`→`components`→`utilities`)
  determine priority ON TOP OF ordinary CSS specificity: a rule from `base`
  touching the same property always loses to any rule from `utilities`, no
  matter how simple that rule is. Hence the corollary: the `.open` class for
  modals is made **not** via the Tailwind `hidden` utility (which lives in
  `utilities` and would always win), but with a dedicated rule in `@layer
  components`.
- **Resize is tracked via a `ResizeObserver` on `#game-container`, not
  `window.resize`** (`scene.js: create()`). The DOM toolbar/status bar can
  change height through purely internal reflow (a button wrapping to a
  second row, a label's length changing when switching language) — none of
  these events trigger a `window resize`, yet the canvas must pick up the
  container's new height.
- **Phaser's `DataManager` does not emit `changedata` on the FIRST write of a
  key** — only `setdata` (with no per-key variant). Every registry key that
  `ui-dom.js` reads (`status`, `gameHints`, `allStats`, `modal`, ...) is
  first written somewhere during page load/game start — without an explicit
  subscription to `setdata` too, the initial render of each of them would
  silently never happen (the old canvas version never hit this, because it
  manually hardcoded the initial text in the constructor and only UPDATED it
  via `changedata`). `ui-dom.js: createUiDom()` subscribes to both.

## Tailwind build

Tailwind v4 (`@import "tailwindcss"` in `assets/tailwind.src.css`) resolves
the `tailwindcss` package as a regular Node module — unlike esbuild, which
doesn't need a real `node_modules` for a bare `npx --yes`. That's why a
minimal `package.json`/`package-lock.json` appeared at the repo root (just
`tailwindcss`+`@tailwindcss/cli`, pinned versions, `node_modules/` in
`.gitignore`) — and the Docker stage `jsbuild` now runs `npm ci` before
building. `@source` in `assets/tailwind.src.css` scans `templates/**/*.html`
and `static/game/*.js` (for classes like `.open`/`.you`/`.current-tag` that
are written only from JS) — which is why the `jsbuild` stage copies
`templates/` too, not just `static/game/`. Local development: `npx
@tailwindcss/cli -i assets/tailwind.src.css -o static/game/tailwind.css
--watch` alongside `runserver` (CLAUDE.md: Local development).

`assets/tailwind.src.css` lives outside `static/`, neither at the repo root
nor inside `static/game/` — this is a documented WhiteNoise+Tailwind pitfall,
not an invention of ours: whitenoise's `collectstatic` postprocessor rewrites
url()-like tokens in EVERY `.css` file under `static/` and fails with
`MissingFileError` on `@import "tailwindcss"`, treating it as a broken
relative url() reference. The official `django-tailwind-cli` documentation
gives the same recipe: "do not place your custom Tailwind configuration file
within static file directories... store custom configurations elsewhere in
your project."

## File structure after the change

- `static/game/scene.js` — `MainScene`: tiles, layout/resize, the game
  session.
- `static/game/effects.js` — (mostly) pure `(scene, ...)` helpers: deal-in,
  pair flight, shuffle-flip, glow/hover/press/error, the final effect,
  particles.
- `static/game/ui-dom.js` — the DOM controller for the toolbar/status bar/
  modals, subscribed to `scene.registry`.
- `static/game/main.js` — a thin entry point: assembles the `Phaser.Game`,
  exports `window.mahjongGame`.
- `assets/tailwind.src.css` — the Tailwind source (`@theme`/`@layer
  base`/`@layer components`), absorbed the structural rules of the old
  `app.css` (now removed).
- `static/game/render-constants.js` — without the toolbar/status-bar
  constants (`TOOLBAR_H`/`STATUS_BAR_H`/`STATUS_BAR_BG*`), otherwise
  unchanged.
