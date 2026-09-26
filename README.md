# Mahjong

A browser-based mahjong solitaire game: the board is one of several classic
layouts (Cat/Crab/Dragon/Spider/Turtle, `layouts/*.layout`) built on a full
144-tile mahjong set (34 regular kinds × 4 copies + 8 bonus flowers/seasons),
each deal guaranteed solvable.

- **Game**: Phaser 3, vanilla JS ES modules bundled with esbuild, styled with
  Tailwind CSS v4. Client-side interaction (render, clicks, undo) — pure
  modules in `static/game/`.
- **Backend**: Django 6 + **django-ninja** (the entire JSON API: board
  generation, anti-cheat session validation via move-log replay, background
  photo) — the server is authoritative for the layout, move legality and
  game timing. Django views remain only for the page (`TemplateView`) and the
  admin.
- **Tiles**: 42 oblique-3D Cangjie6 tiles, CC BY-SA 4.0 (see
  `static/game/tiles/CREDITS.md`).

## Running it

```bash
uv sync
npm install
uv run manage.py migrate
./scripts/dev.sh
```

The game is at http://127.0.0.1:8000/.

## Tests

```bash
node --test 'tests/*.test.js'   # client (Phaser-independent logic)
uv run manage.py test           # server (gameplay/, config/)
```

Development and deployment details — in [CLAUDE.md](CLAUDE.md).
