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
  game timing. Django views remain only for the page (a plain view) and the
  admin.
- **Tiles**: 42 oblique-3D Cangjie6 tiles, CC BY-SA 4.0 (see
  `static/game/tiles/CREDITS.md`).

## Running it

```bash
cp .env.example .env
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

## License

Project code is **GPL-3.0-or-later** (see [LICENSE](LICENSE)). Two sets of
bundled third-party assets keep their own license:

- `layouts/*.layout` — board shapes from
  [KDE kmahjongg](https://invent.kde.org/games/kmahjongg), GPL (attribution
  in every file).
- `static/game/tiles/*.svg` — Cangjie6's oblique tile art,
  **CC BY-SA 4.0** (compatible with, but not relicensed under, GPLv3 — see
  [`static/game/tiles/CREDITS.md`](static/game/tiles/CREDITS.md)).
- `static/game/tiles/*.png` — the older FluffyStuff riichi tile set, CC0,
  kept only as a source for icon generation.
