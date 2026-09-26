# Mahjong Solitaire MVP — Design

Date: 2026-07-15
Status: approved by user

## Goal

MVP of a browser-based "mahjong solitaire" game on Phaser 3, embedded in the existing Django project. Board 9×9×3, layout **guaranteed solvable**. Tiles — the riichi set from [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) (CC0).

## Board and rules

- Grid 9×9, 3 full layers, **minus the center cell of the top layer** (x=4, y=4, z=2) → 242 tiles = 121 pairs.
- Tile coordinates: `(x, y, z)`, x,y ∈ 0..8, z ∈ 0..2. The grid is aligned (no half-offset).
- A tile is **free** if:
  - the cell `(x, y, z+1)` is empty (nothing lies on top), **and**
  - at least one of the cells `(x-1, y, z)` / `(x+1, y, z)` is empty (a free side).
- Move: click a free tile → select it; click a second free tile of **the same kind** → the pair is removed. Click the same tile again — deselect; click a different free tile — reselect.
- Win: the board is empty.
- Dead end: among the free tiles there is no matching pair → message "No moves" + "New game" button.

## Tile set

34 kinds: Man1–9, Pin1–9, Sou1–9, winds (Ton, Nan, Shaa, Pei), dragons (Haku, Hatsu, Chun).
121 pairs = 19 kinds × 4 pairs (8 copies) + 15 kinds × 3 pairs (6 copies); the distribution of kinds across groups is random at generation time.
Matching is exact-kind-only.

## Layout generation (solvability guarantee)

**Reverse generation**: start from an empty board, knowing the target shape (a list of 242 positions). At each step:

1. Compute the positions "available for placing": a position of the target shape, not yet filled, whose cell underneath (z-1) is already filled (or z=0), **and** which, once placed, would be "free" under the removal rule (nothing on top — guaranteed by the bottom-up placement order; a free side — checked among tiles already placed).
2. Take two random distinct available positions, place a pair of identical tiles (kind — from the pair pool).
3. Repeat until the shape is filled.

A solution exists by construction: removing tiles in the reverse order of placement is always legal. If at some step only one position is available (a generation dead end) — restart generation from scratch (this takes milliseconds).

An important correctness detail: a pair placed at step i, when removed in reverse order, is free, because all tiles placed later have already been removed, and they are the only ones that could have blocked it from above or from the sides after step i.

## Technology and structure

- **Vanilla JS (ES modules), no npm/build.** Phaser 3 — a single minified file at `static/vendor/phaser.min.js`.
- PNG tiles from the `Export/Regular` folder of the FluffyStuff repo → `static/game/tiles/` (34 kinds + `Front.png` as backing).
- Files:
  - `static/game/board.js` — board model: cell state, the freedom rule, removing/returning a pair, finding available pairs (for hints and dead-end detection). A pure module, no Phaser.
  - `static/game/generator.js` — reverse layout generation. A pure module, no Phaser.
  - `static/game/main.js` — Phaser scene: rendering, input, UI.
  - `templates/game.html` — the game page (replaces the coming-soon page at `/`).

## Rendering (Phaser scene)

- Each tile is a `Phaser.GameObjects.Image` (Front as backing + kind sprite; or a composite texture). Tile size is chosen so the 9×9 board fits the screen (scaling via Phaser Scale Manager, FIT mode).
- Pseudo-3D: layer z is drawn with an offset `(-offsetX*z, -offsetY*z)` (a few px up-left), depth = `z*1000 + y*10 + x` — tiles higher/lower on screen overlap correctly.
- Selection — tint; hint — a brief blink/tint of the found pair; clicking a non-free tile — a light "shake" or no reaction.

## UI (MVP)

- "New game" — full regeneration.
- "Hint" — find any available pair, highlight it. If there are no pairs — show "No moves".
- "Undo" — a stack of removed pairs, returns the last pair to its place (unlimited undo).
- Counter of remaining tiles.
- Automatic dead-end detection after every move.

## Django integration

- `config/urls.py`: `/` → `TemplateView(template_name='game.html')` (coming_soon is no longer used).
- Static files via whitenoise (already configured). Dockerfile, Procfile, dependencies — unchanged.

## Testing

Logic (board.js, generator.js) — pure ES modules, tested via the built-in `node:test` (no package.json): `node --test 'tests/*.test.js'`.

Key tests:
- The freedom rule (occupied on top / both sides occupied / edge cases).
- Generator: exactly 242 tiles, every kind in an even count, shape matches the target.
- Solvability: simulation — remove pairs in the reverse order of generation down to an empty board (and/or a greedy solver over several seeds).
- Undo: remove a pair → undo → state is identical.
- Dead-end detection and hint search.

## Out of scope for MVP

Timer, score, reshuffling the remainder on a dead end, saving progress, sound, tile-flight animations, layout selection.
