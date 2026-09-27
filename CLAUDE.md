# CLAUDE.md

Project context and deployment infrastructure for mahjong.

## Language

**All text in this repository is English** — code comments and docstrings,
this file (CLAUDE.md), `README.md`, everything under `docs/**`, `Dockerfile`/
config comments, template comments, dev-script output, and commit messages. No
exceptions. The only carve-out: the Ukrainian **translation catalog**
(`locale/uk/LC_MESSAGES/*.po` `msgstr` values) — that is the shipped Ukrainian
translation itself, not project prose; msgids stay English as usual (see
Localization below).

## Documentation

**This file is a map, not a docstring mirror.** Write here only what isn't
visible from reading a single file: how files relate to each other, why a
non-obvious decision was made, operational knowledge (deploy/env/commands)
that lives nowhere else. Signatures, algorithms, field-by-field breakdowns
belong in the code's own docstrings and comments, **not here**: a duplicate
inevitably drifts from the code on the next change (learned the hard way — the
section below already once grew into a full retelling of `gameplay/api.py`/
`main.js` and went stale). When adding a description for a new module/feature
— 1–3 sentences (path, responsibility, cross-file link), leave details to the
code; a new feature's full design goes in `docs/superpowers/specs/`, not here.

## What this is

A browser-based "mahjong solitaire" game: the board is one of several classic
layouts (Cat/Crab/Dragon/Spider/Turtle, `layouts/*.layout`) built on **144
tiles** (a full mahjong set: 34 regular kinds × 4 copies + 8 bonus flowers/
seasons × 1), the deal is **guaranteed solvable**. The board shape (which
layout) is chosen by the player in the new-game modal and is identical for the
144-tile set regardless of the chosen shape — see `gameplay/layouts.py`.
Coordinates use a half-tile grid (like real kmahjongg): a regular tile sits on
even coordinates, while "head-tail" peaks/overhangs sit on odd ones, exactly
between neighbors, with no approximation. Bonus kinds match as **wildcard
groups** (any flower ↔ any flower, any season ↔ any season). The game lives at
root `/`. Design and plans: `docs/superpowers/specs/` (latest —
`2026-07-29-tailwind-dom-ui-migration.md`), `docs/superpowers/plans/`.

## Code style (Python)

For data structures always use `ninja.Schema` (or pydantic `BaseModel`), never
`namedtuple`/`@dataclass` — the single model style across the project
(`gameplay/schemas.py`, `config/schemas.py`, `gameplay/layouts.py: Layout`).

## Stack

- **Django 6.0** + **uv** as the package manager.
- **django-ninja** — the entire project's JSON/HTTP API (no plain Django
  view/`JsonResponse` — only `admin/` (the standard Django admin) and `''`
  (renders the game's HTML page) stay outside ninja, since neither is an API).
- Django project: `config/` (settings/urls/api/wsgi), `manage.py` at the root.
- Production server: `gunicorn` (`config.wsgi:application`).
- Game frontend: **Phaser 3.90** vanilla JS ES modules. Phaser is a local file
  `static/vendor/phaser.min.js`. **JS build**: `templates/game.html` always
  loads a **single** `static/game/bundle.js` (no `{% if debug %}` branching),
  which `esbuild` assembles from the module graph in `static/game/*.js`.
  Locally — `esbuild --watch` (`scripts/dev.sh`, no `--minify`, with
  `--sourcemap` for readable stack traces/devtools breakpoints on the real
  source files); production — minified, no sourcemap, at Docker-build time
  (a separate `node` stage `jsbuild` in `Dockerfile`). Both `bundle.js` and
  `bundle.js.map` are build artifacts, not committed to git (`.gitignore`);
  the dev and prod versions never coexist (different run contexts), so there's
  no filename conflict.
- **CSS — Tailwind CSS v4** (`assets/tailwind.src.css` → built
  `static/game/tailwind.css`, also a build artifact outside git). Unlike
  esbuild, the Tailwind CLI resolves `@import "tailwindcss"` as a regular Node
  package, so bare `npx --yes` (as used for esbuild/Biome) isn't enough — the
  repo root has a minimal `package.json`/`package-lock.json`
  (`node_modules/` in `.gitignore`). `Dockerfile: jsbuild` stage runs
  `npm ci`, then builds both `bundle.js` and `tailwind.css`; locally —
  `npx @tailwindcss/cli -i assets/tailwind.src.css -o static/game/tailwind.css
  --watch=always` alongside `runserver` (see Local development below).
  `@source` in `assets/tailwind.src.css` scans both `templates/**/*.html` and
  `static/game/*.js` (classes written only from JS — `.open`/`.you`/
  `.current-tag` etc.), so the `jsbuild` stage also copies `templates/`.
  Design/pitfalls — `docs/superpowers/specs/2026-07-29-tailwind-dom-ui-migration.md`.
  Cache busting is the stock `whitenoise.storage.CompressedManifestStaticFilesStorage`
  (hash in the filename, works the same for JS and CSS); whitenoise generates
  `.gz` **and `.br`** for every static file on `collectstatic` (brotli — the
  `brotli` dependency in `pyproject.toml`; without it there would only be
  gzip) and serves the smallest variant based on `Accept-Encoding`.
- **`package.json` has both `devDependencies` (Tailwind — build-time, not in
  the prod image) and `dependencies`** (`@dicebear/core`+`@dicebear/collection`
  — actually shipped in `bundle.js`, imported by `static/game/avatar.js`).
  `npm install` is therefore required for local development too, not just for
  the Docker build.

## Game structure

> Below is a **map**, not a retelling of the implementation: what lives
> where, how files relate to each other, and why a non-obvious decision was
> made where it isn't visible from the file itself. Details (signatures,
> algorithms, field-by-field) live in each file's own docstrings/comments and
> are deliberately not duplicated here (so they don't drift when the code
> changes).

### Backend API (django-ninja)

- `config/api.py` — the project's single `NinjaAPI` (`/api/`): background
  photo, build version, mounts `gameplay.api.router` under `/game`.
  `CsrfOnly` — an auth stub that lets anonymous users through but requires the
  standard Django CSRF check on unsafe requests; inherited by every mounted
  router. The build version (hash of the `collectstatic` manifest) is checked
  by the client before starting a game (`scene.js: startGame()`) — a fix for
  stale caches on standalone PWAs on iOS/macOS, where the window can go
  un-refreshed for weeks; deliberately without a service worker.
- `config/schemas.py` — ninja schemas for `config/api.py`.
- `layouts/*.layout` (repo root) — board shapes in the native kmahjongg
  format, taken verbatim from [KDE kmahjongg](https://invent.kde.org/games/kmahjongg)
  (GPL, attribution in every file). The format is parsed by
  `gameplay/layouts.py` (details — in the module's docstring). Only
  144-tile layouts are accepted.
- `gameplay/` — the Django app for server-side board generation, anti-cheat
  session validation, lifetime stats and the daily tournament:
  `layouts.py` (the `.layout` parser, plus `board_thumbnail()` — an SVG
  thumbnail of the board shape for the picker icons in `#newgame-modal`),
  `board.py` (the freedom/matching rule — knows nothing about the board
  shape, only the coordinate system), `generator.py` (generation of a
  guaranteed-solvable board), `daily.py` (the deterministic daily tournament
  challenge), `models.py` (`GameSession`/`Profile`), `middleware.py`
  (resolves the player from the `mahjong_player` cookie), `stats.py`
  (lifetime counters), `ratelimit.py` (`IpRateThrottle` — a thin subclass of
  django-ninja's own `ninja.throttling.SimpleRateThrottle`, not a hand-rolled
  counter; needed because ninja's built-in `AnonRateThrottle` would throttle
  nothing here — see the module docstring for why), `schemas.py`, `api.py`
  (all endpoints, most with a `throttle=` on the route; `middleware.py`'s
  new-profile limit calls the same throttle class's `.allow_request()`
  directly, since middleware runs before ninja's own routing).
  `GameSession.user` is nullable only for a painless migration of already
  existing rows (new code always sets it). Stats are attributed to the player
  who STARTED the session (`session.user`), not necessarily whoever makes the
  current request. IP rate-limiting goes through `CF-Connecting-IP`
  (production sits behind a Cloudflare Tunnel — `REMOTE_ADDR` would just see
  the proxy's own address). `management/commands/purge_sessions.py` is the
  retention job for `GameSession` — deletes old non-daily rows, blanks (but
  keeps) old daily rows so the tournament record stays computable. Not
  scheduled — a manual tool for if/when row growth ever becomes a real
  problem (at ~6 KB/row for the board layout, that's years out at this
  project's scale; see `DEPLOY.local.md` for the invocation). Design/plan:
  `docs/superpowers/plans/2026-07-17-server-authoritative-gameplay.md`,
  `docs/superpowers/specs/2026-07-28-daily-tournament-design.md`.
  `Profile.display_name` is a free-form (non-unique) player name; `daily.py:
  nickname_for(profile)` is the single source of "how to display a player"
  (toolbar + tournament leaderboard), with a fallback to `Player #xxxx` when
  no name is set. That same name is also the seed for the client-side
  DiceBear avatar (`static/game/avatar.js`) — there's no separate seed field.
- `static/game/board.js` — the board model for client-side interaction
  (render/clicks/undo/deadlock detection); authoritative validation is on the
  server (`gameplay/board.py`). The board shape is **not** hardcoded here —
  positions come from the server-provided `layout`, width/height/layers are
  derived from it too (`scene.js: applyBoardDims`), not from module constants.
  A pure module, no Phaser/DOM.
- `static/game/stats.js` — lifetime stats now live on the server
  (`gameplay/models.py: Profile.stats`); the module keeps only presentation
  helpers and a one-time reader for the legacy `localStorage` blob, used to
  migrate it to the server. A pure module, no Phaser/DOM.
- `static/game/audio.js` — WebAudio synthesis of sound effects (click/pair/
  error/undo/hint/shuffle/win/loss) — oscillators and noise, no samples (zero
  files, zero licensing). The toggle lives in `#profile-modal` (`ui-dom.js`),
  state — `localStorage['mahjong.sound']`, a separate preference from
  `scene.js: reducedMotion`. The `AudioContext` is created lazily (only on the
  first click — browser autoplay policy), injected via a parameter for the
  sake of `node --test`. A pure module, no Phaser/DOM.
- `static/game/avatar.js` — renders the DiceBear avatar (`@dicebear/core` +
  the `funEmoji` style from `@dicebear/collection`, npm dependencies actually
  bundled into `bundle.js` — not an HTTP API). Seed = the player's name
  (`gameplay/daily.py: nickname_for` — the same string shown as the name).
  SVGs are memoized by `name|size`. A pure module, no Phaser/DOM.
- `static/game/sync.js` — a thin HTTP client for `config/api.py`/
  `gameplay/api.py`. Player identity is the `mahjong_player` cookie
  (HttpOnly, signed by the server), sent automatically with every fetch;
  the CSRF token comes from `window.MAHJONG_CSRF`, header `X-CSRFToken`.
- `static/game/scene.js` — the Phaser scene (`MainScene`): tiles,
  layout/resize, game session (start/resume/finish/shuffle/undo/hint). The
  canvas draws **only the board** — the toolbar/status bar/photographer
  credit/modals are now DOM (`templates/game.html`, `ui-dom.js`). The board
  for a new game is always fetched from the server (the game never starts
  without a network connection). UI state uses a Publisher/Subscriber
  pattern through `this.registry` (Phaser `DataManager`): business logic
  never calls methods like "open the modal" — it only writes a fact
  (`registry.set(...)`), and `ui-dom.js` is subscribed and decides what to
  show. A game survives a page reload — a snapshot in `localStorage`
  (`persistGame`/`tryResumeGame`), reconciled with the server before
  resuming. Resize is caught via a `ResizeObserver` on `#game-container`,
  not `window.resize` — the DOM toolbar/status bar can change height from
  purely internal reflow (a button wrapping, a label changing length when
  the language changes), without any `window resize` event.
- `static/game/effects.js` — animation helpers for `scene.js`: every function
  takes `scene` as its first argument (deal-in, a pair flying into the
  counter, shuffle-flip, glow/hover/press/error, the final win/loss effect,
  particles) — extracted out of the scene so `MainScene` stays about the
  session/layout, not tween details.
- `static/game/render-constants.js` — base (design-px) proportions/colors/
  effect tuning for `scene.js`/`effects.js`. After the move to sprite
  rendering (ready-made oblique art from Cangjie6) and native resolution, the
  tile geometry here is no longer "baked in" — the tile size and grid steps
  are computed dynamically in `scene.js` (`computeLayout`) from the real
  window size; only the base values, multiplied by DPR in the scene, remain
  here. A pure module, no Phaser/DOM.
- `static/game/ui-dom.js` — the DOM controller for the toolbar/status bar/
  photographer credit/5 modals (`templates/game.html`). The tournament
  leaderboard builds `<li>` elements through the DOM API
  (`createElement`/`textContent`), not `innerHTML` — `entry.nickname` is now
  arbitrary text chosen by the player (POST `/api/game/profile`), so
  interpolating it into an HTML string would be stored XSS. Subscribes to
  `scene.registry` (**both `changedata` and `setdata`** — Phaser only sends
  `changedata` from the SECOND write of a key; the first always comes as
  `setdata` with no per-key variant; missing this means the initial render of
  every freshly-set registry key silently never happens).
- `static/game/main.js` — a thin entry point: assembles the `Phaser.Game`
  with `MainScene`, exports `window.mahjongGame` (access to the game for
  debugging/tests).
- `templates/game.html` — the game page (root `/`): a `<header>` toolbar +
  `<main id="game-container">` (canvas, board only) + a `<footer>` status
  bar, all three a flex column inside `<body>`; followed by 5 DOM modals
  (new game/stats/tournament/deadlock/player). The last toolbar button
  (`#btn-profile`, avatar+name) is the only one not `flex-1`: `ml-auto`
  pushes it to the right edge, while the other five buttons on the left
  share the space evenly. Injects `window.MAHJONG_CSRF`/`MAHJONG_VERSION`/
  `MAHJONG_LANG`. Styles — Tailwind (`assets/tailwind.src.css` → built
  `tailwind.css`, a single `<link>` with no `{% if debug %}`); the template
  has no `<style>` of its own — any `{% trans %}` inside CSS is impossible
  (static assets don't go through the templating engine), so the "← current"
  label in stats is rendered by `ui-dom.js: renderStatsModal()` via
  `gettext()`, not a CSS `::after`.
- `static/game/tiles/*.svg` — 42 oblique-3D tiles (Cangjie6, **CC BY-SA
  4.0**, attribution required — see `static/game/tiles/CREDITS.md`).
  Rasterized from SVG into a `CanvasTexture` at runtime, no texture atlas.
- `static/game/tiles/*.png` + `Front.png` — the old CC0 FluffyStuff set; the
  game no longer renders tiles with it, it only remains as a source for
  `scripts/gen_icons.py`.
- `static/icons/*` — favicon/PWA icons, generated by `scripts/gen_icons.py`
  (Pillow — an ephemeral dependency, `uv run --with pillow ...`).

### Rendering nuances (do not break)

Details and rationale live in comments right next to the relevant code in
`static/game/scene.js`/`effects.js`; this is just a checklist so nothing
breaks by accident:

- **Depth formula** in `addTileSprite` (`z*10000 + (boardHeight-1-y) + x`,
  x/y weighted **equally**) — critical specifically for diagonal half-tile
  neighbors (peaks, head/tail), otherwise tiles overlap chaotically.
- **A tile is one sprite with ready-made oblique-3D art** — volume is drawn
  in the SVG itself, the game doesn't bake its own 3D body.
- **Textures are rasterized from SVG at runtime** (`rasterizeTiles`) and
  loaded as a **blob-URL Image**, not `<img src>` — otherwise the WebGL
  canvas gets "tainted" and refuses the texture.
- **Native resolution** (`Scale.NONE` + manual DPR scaling), not
  `Scale.FIT` — world coordinates are always in device px.
- **Clicking a tile** — a single scene-level `gameobjectdown` handler, not
  `pointerdown` on every sprite (`create()`).
- **A DOM modal does NOT block clicks on the canvas underneath it** — Phaser
  does its own hit-testing past DOM z-index; the only guard is an explicit
  `if (this.registry.get('modal')) return;` in EVERY click handler (the
  scene's, and each toolbar button's individually). The toolbar/status bar
  sidestep this trap entirely — they're DOM flex siblings of the canvas
  (`templates/game.html`), not an overlay on top of it, so no tile ever ends
  up underneath them.
- **`#game-container` must not have its own `height`** in the Tailwind
  source (`assets/tailwind.src.css`) — the size is computed by flexbox
  (`<main class="flex-1 min-h-0">` between `<header>`/`<footer>`). Tailwind's
  cascade layers (`base`→`components`→`utilities`) determine priority ON TOP
  OF regular CSS specificity: an explicit `height` in `base`, even a stale/
  mistaken one, would always beat `flex-1` from `utilities`.

## Local development

```
cp .env.example .env         # once — sets DJANGO_DEBUG=True, see Configuration via env
uv sync                      # install dependencies from uv.lock
npm install                  # once — devDependencies for the esbuild/Tailwind watchers
uv run manage.py migrate
./scripts/dev.sh             # runserver + esbuild --watch + Tailwind --watch, one Ctrl-C
```

`scripts/dev.sh` is a thin wrapper: it brings up the esbuild and Tailwind
watchers in the background (an EXIT trap kills both), and leaves `runserver`
in the foreground — Ctrl-C stops everything. `static/game/bundle.js`/
`tailwind.css` don't exist without this script (build artifacts,
`.gitignore`), so plain `manage.py runserver` without `dev.sh` will 404 on
JS/CSS. If you only need one of the watchers on its own — the commands:

```
uv run manage.py runserver
npx --yes esbuild@0.24.2 static/game/main.js \
  --bundle --sourcemap --format=esm --outfile=static/game/bundle.js --watch=forever
npx @tailwindcss/cli -i assets/tailwind.src.css -o static/game/tailwind.css --watch=always
```

Adding dependencies: `uv add <package>` (production) / `uv add --dev <package>`
(dev tools, linters, tests).

## Localization

Stock Django gettext-i18n (`uk` + `en`), msgids are **English** (idiomatic
Django), translations — `locale/{uk,en}/LC_MESSAGES/{django,djangojs}.po`.
The default for a new visitor with no cookie and no matching
`Accept-Language` is Ukrainian (`LANGUAGE_CODE = 'uk'`, `config/settings.py`).
The language switcher is a picker (`🌐 UA`/`🌐 EN`, the same radio-button
style `.newgame-option` as the pickers in `#newgame-modal`) inside
`#profile-modal` (`templates/game.html`, next to the sound toggle), not a
separate toolbar button. Only two languages (`config/settings.py: LANGUAGES`),
so it's a two-option picker, not a `<select>`: it highlights the CURRENT
language (`ui-dom.js`: `langButtons`, compared against `window.MAHJONG_LANG`),
clicking the inactive one switches it. `window.MAHJONG_LANG` (from
`{% get_current_language %}`, `templates/game.html`) is the source of the
current language for JS. A click POSTs to Django's `set_language`
(`static/game/sync.js: setLanguage()`, `config/urls.py:
path('i18n/', include('django.conf.urls.i18n'))`) and reloads the page —
**without** `i18n_patterns`, the root `/` URL stays clean (important for the
standalone PWA/`start_url`). An active game survives the reload without loss
(`tryResumeGame()` — the same path as a regular reload/resume).

Dynamic text (hint/undo counters, "Remaining: N", stats lines, tournament
info — `ui-dom.js`/`scene.js`) still goes through Django's
**`JavaScriptCatalog`** (`config/urls.py:
path('jsi18n/', JavaScriptCatalog.as_view())`, no `packages=` — the catalog
lives in the project's `locale/`, not inside `gameplay/locale/`), included in
`game.html` via a **classic** `<script>` (not `type="module"`) **before** the
module bundle — the global `gettext`/`interpolate` must be defined before
`main.js`/`bundle.js` runs. Static labels on the toolbar/modals (except
counters) now go through plain Django `{% trans %}` directly in
`templates/game.html` (domain `django`, separate from `djangojs` — the same
text in both catalogs needs a separate translation in each).
Emoji prefixes (`🆕`, `💡`, `🏆`, ...) deliberately stay **outside**
`gettext()`/`{% trans %}` — they're language-independent, nothing to
translate.

Layout names (`Cat`/`Crab`/`Dragon`/`Spider`/`Turtle`, from `#`-comments in
the `.layout` files) are cached by the process (`gameplay/layouts.py:
load_layouts()`, `@lru_cache`) — so translation isn't applied to the cached
name itself, but every time in `list_boards()` via `gettext(layout.name)`;
known names are registered via `gettext_noop()` for `makemessages`.

Catalogs are recompiled from `.po` to `.mo` on every Docker build
(`Dockerfile: RUN uv run manage.py compilemessages`, requires system
`gettext`) — `.mo` files aren't committed to git (`.gitignore:
locale/**/*.mo`), same as `bundle.js`. After changing translatable text in the
code — regenerate the catalogs:

```
uv run manage.py makemessages -l uk -l en \
  --ignore='static/vendor/*' --ignore='static/game/bundle.js' \
  --ignore='staticfiles/*' --ignore='.venv/*' --ignore='node_modules/*'
uv run manage.py makemessages -d djangojs -l uk -l en \
  --ignore='static/vendor/*' --ignore='static/game/bundle.js' \
  --ignore='staticfiles/*' --ignore='.venv/*' --ignore='node_modules/*'
uv run manage.py compilemessages --locale=uk --locale=en   # for a local check
```

## Tests

Client-side game logic is tested without a browser and without npm — using
Node's built-in test runner:

```
node --test 'tests/*.test.js'
```

(The form `node --test tests/` doesn't work — node treats the directory as a
module.) Covered: the freedom rule, matching/undo, deadlock, move-log replay,
transformers and the localStorage wrapper for stats (`stats.js`), sound
on/off and lazy `AudioContext` init through an injected double (`audio.js`).
The board shape (which layout, generation solvability) is no longer covered
by client tests — it's entirely server-side (below); `board.js` now only
knows the coordinate system, not a specific shape. `scene.js`/`effects.js`/
`ui-dom.js` (Phaser + DOM) aren't covered by unit tests — check in the
browser.

Server-side logic (`gameplay/`: `.layout` file parser, board generation for
each layout, the freedom rule, session validation through the API;
`config/`: the background endpoint):

```
uv run manage.py test
```

(without an argument — Django's discovery finds `gameplay/tests.py` and
`config/tests.py` automatically; `uv run manage.py test gameplay` narrows it
to one app.)

## Linting (a completion criterion)

A task is NOT considered done until both linters pass clean — on par with the
tests above:

- **Python (`ruff`)** — a dev dependency (`uv add --dev ruff`, not pulled
  into the prod image: the Dockerfile runs `uv sync ... --no-dev`), config —
  `[tool.ruff]`/`[tool.ruff.lint]` in `pyproject.toml` (`select = ["E", "F",
  "I", "UP", "B", "DJ"]`, `migrations`/`staticfiles` excluded):
  ```
  uv run ruff check .
  ```
  Autofix of safe ones (import sorting, pyupgrade): `uv run ruff check --fix .`

- **JS + CSS (`Biome`)** — run through `npx` with a pinned version (the same
  approach as `esbuild` in `Dockerfile: jsbuild`; Biome itself doesn't need a
  local `node_modules` — unlike Tailwind, see Stack above), config —
  `biome.json` (lints `static/game/**/*.js`, `static/game/**/*.css` and
  `tests/**/*.js`, excludes the build artifacts `bundle.js`/`tailwind.css`
  and the source `assets/tailwind.src.css` — the latter uses
  Tailwind-specific at-rules (`@source`/`@theme`/`@apply`) that Biome's CSS
  linter (standard CSS, no dialects) doesn't know; `static/vendor/` isn't
  matched by any include pattern either, so it's also out of scope). A
  separate CSS tool (stylelint etc.) wasn't set up; the CSS formatter stays
  off (Biome's default), the criterion is `lint` only:
  ```
  npx --yes @biomejs/biome@2.5.5 lint static/game tests
  ```
  Autofix: `npx --yes @biomejs/biome@2.5.5 lint --write static/game tests`
  (some fixes are `--unsafe` — review the diff before applying).

Both linters are purely static analysis. GitHub Actions
(`.github/workflows/ci.yml`) runs them, alongside `manage.py test`/
`node --test` and the deploy-readiness checks below, on every PR and push to
`main` (jobs `python`/`javascript`) — these two jobs are the required status
checks on `main` (see Deploying to dokku below), but run the commands above
locally too before committing/finishing a task.

The `python` job also runs, after `manage.py test`:
```
uv run manage.py makemigrations --check --dry-run
uv run manage.py check --deploy --fail-level WARNING
```
so a model change with no migration, or a setting `check --deploy` flags
(see the `if not DEBUG:` block in Configuration via env below), fails CI
instead of surfacing after a deploy. The job sets a placeholder
`DJANGO_SECRET_KEY`/`DJANGO_ALLOWED_HOSTS` at job level — not real
production config, just enough for settings to import at all (see below).

## Configuration via env

All env vars go through **django-environ** (`config/settings.py: env =
environ.Env(...)`) — one idiom instead of ad-hoc `os.environ.get(...)`/
comma-splitting, `.env` picked up via `environ.Env.read_env()` (same file/
role as the old `python-dotenv` call it replaced). Its key property: reading
a var with no `default=` raises Django's `ImproperlyConfigured` if it's
missing, rather than silently falling back to something insecure.

`config/settings.py` reads:
- `DJANGO_DEBUG` (`True`/`False`) — **defaults to `False`.** Insecure
  settings must be opted into, never assumed; a forgotten env var in
  production must crash at boot, not silently ship `DEBUG=True` or an
  insecure `SECRET_KEY`. Local development sets `DJANGO_DEBUG=True` in
  `.env` (copy `.env.example`) — `manage.py runserver`/`dev.sh` alike need
  nothing else.
- `DJANGO_SECRET_KEY` — **required** when `DJANGO_DEBUG` is not `True`
  (a hardcoded insecure literal is the default only in DEBUG mode).
- `DJANGO_ALLOWED_HOSTS` (comma-separated, e.g. `mahjong.vitaly4uk.in.ua`) —
  **required** when `DJANGO_DEBUG` is not `True`, for the same reason: an
  empty list under `DEBUG=False` breaks every request anyway, and would
  silently empty `CSRF_TRUSTED_ORIGINS` too (see CSRF below).
- `PEXELS_API_KEY` — Pexels API key for the background photo (`config/api.py`);
  without it the background endpoint silently disables itself
  (`if not settings.PEXELS_API_KEY`), the rest of the game works normally.
- `DATABASE_URL` — optionally overrides the default sqlite
  (`env.db_url(...)`, default `sqlite:///db.sqlite3`). Note `CONN_MAX_AGE`
  is set explicitly in Python, not via a `?conn_max_age=` query param on the
  URL — `env.db_url()` has no kwarg for it (unlike the old
  `dj_database_url.config(conn_max_age=...)`), so it would otherwise
  silently be lost the day someone sets `DATABASE_URL` without that query
  string.

When not `DEBUG`, `config/settings.py` also turns on `SESSION_COOKIE_SECURE`/
`CSRF_COOKIE_SECURE`/`SECURE_CONTENT_TYPE_NOSNIFF`/HSTS — but deliberately
**not** `SECURE_SSL_REDIRECT`: dokku nginx already terminates TLS and
redirects in front of gunicorn (see CSRF below), so Django's own redirect on
top would risk a loop; `check --deploy`'s `W008` for this is silenced
(`SILENCED_SYSTEM_CHECKS`) on purpose, not an oversight.

`/api/docs` and `/api/openapi.json` (django-ninja's interactive docs/schema)
are only served when `DEBUG` — `CsrfOnly` authenticates everyone (see its
docstring in `config/api.py`), so leaving them on in production would make
the whole API schema public.

Anonymous player identity (`gameplay/middleware.py:
PlayerIdentityMiddleware`) mints a `User`+`Profile` for any first-time
visitor under `/api/game/` — bounded two ways: a path that doesn't resolve
to a real view never touches the DB at all, and *new*-profile creation
(never a returning player's cookie) is rate-limited per IP
(`NEW_PROFILE_RATE_LIMIT`, via the same `IpRateThrottle` —
`gameplay/ratelimit.py` — that backs the per-endpoint quotas in
`gameplay/api.py`; built on django-ninja's own `ninja.throttling`, not a
hand-rolled counter).

### CSRF behind a reverse proxy (do not break)

Production traffic goes browser → Cloudflare edge (**TLS terminates here**,
not any closer to the app) → Cloudflare Tunnel → dokku nginx → gunicorn,
with the last two hops both plain HTTP. `config/settings.py` sets:

```python
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
CSRF_TRUSTED_ORIGINS = [f'https://{h}' for h in ALLOWED_HOSTS]
```

Without this Django considers every request insecure
(`request.is_secure() == False`), and the CSRF Origin-header check (the
browser sends `https://...`) doesn't match the computed scheme (`http://...`)
→ **403 on every POST**, regardless of whether the CSRF token itself is
correct (this affects the django-ninja API too — `CsrfOnly` in
`config/api.py` relies on exactly this check).

**This alone isn't sufficient** — dokku's nginx must also be told to
*trust* the `X-Forwarded-Proto` Cloudflare itself sends, instead of its own
default of stamping nginx's own connection scheme onto that header
(`$scheme`, which here is always `http` — the Tunnel→nginx hop is plain
HTTP, so left at the default this silently and permanently makes
`request.is_secure()` `False` regardless of what the real client used; the
CSRF check above still happens to pass in that state for a real browser,
since it always sends an `Origin` header, so this can go unnoticed for a
long time — found live in production 2026-09-27, only exposed once HSTS/
secure-cookie settings started depending on `is_secure()`, see
`DEPLOY.local.md`). This is a per-app **dokku host setting**, not something
`config/settings.py` or the `Dockerfile` controls:

```
dokku nginx:set <app> x-forwarded-proto-value '$http_x_forwarded_proto'
dokku proxy:build-config <app>
```

Safe specifically because the Tunnel is the *only* path to this dokku host
(see `DEPLOY.local.md`: "External access") — trusting a proxied header is
only safe when every request is guaranteed to have passed through that
proxy. Verify with `curl -sI https://<host>/ | grep -i
strict-transport-security` — present means nginx is forwarding the real
scheme; absent means it's back to stamping its own.

## Deploying to dokku

There's a `Dockerfile` (dokku deploys from it automatically, no separate
buildpack) plus a `Procfile` for the web process command. `main` is a
protected branch (a ruleset: PR + the two CI jobs above required, no
direct pushes) — merging a PR is what deploys: `.github/workflows/ci.yml`'s
`deploy` job pushes the merge commit to the dokku remote over SSH, tunneled
through the Cloudflare Tunnel already used for production traffic (dokku
itself sits on a LAN address, unreachable to a GitHub-hosted runner
otherwise). A manual `git push dokku main` from the dev machine still works
and remains the fallback if the workflow is broken. Host addresses, SSH
access and admin commands are not part of this public file — see
`DEPLOY.local.md` (gitignored, machine-local).

### Ports in dokku (matters for the Dockerfile)

The Dockerfile **has no** `EXPOSE`. This is deliberate: for Dockerfile
deploys, dokku
- **with `EXPOSE <port>`** → nginx listens on exactly that port (and then you
  either have to change the Cloudflare rule for it, or run
  `dokku ports:set`);
- **without `EXPOSE`** → nginx automatically listens on 80/443 and proxies to
  the container port given by the `$PORT` env var (dokku injects it itself,
  usually 5000).

So gunicorn listens on `$PORT` (no default — dokku always injects this
variable for the web process). The startup command is set in `Procfile`
(`web: gunicorn ... --bind 0.0.0.0:$PORT`), not in the Dockerfile's `CMD`:
for Dockerfile deploys with a `Procfile` present, dokku takes the web
process's command from there. **Important:** don't use the
`${PORT:-8000}` syntax in `Procfile` — dokku parses `Procfile` lines itself
(not through the container's runtime shell) and doesn't understand the bash
fallback `:-`, so the variable silently turns into an empty string and
gunicorn crashes with `'' is not a valid port number`. This pattern is worth
repeating in future Dockerfile-based apps — then every new
`<name>.vitaly4uk.in.ua` will work immediately through the existing wildcard
tunnel, with no manual port setup.

Host access, the dokku git remote and admin commands are documented in
`DEPLOY.local.md` (not tracked in git — see Deploying to dokku above).

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`vitaly4uk/mahjong`), managed via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Neither `CONTEXT.md` nor `docs/adr/` exist yet in this repo — see
`docs/agents/domain.md` for the (single-context) layout they'd take and how
skills should consume them once created; the file itself says to proceed
silently in their absence, not to flag or stub them.
