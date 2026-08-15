// The Phaser board scene: tile sprites, layout/resize, and the game-session
// lifecycle (start/resume/finish/shuffle/undo/hint). Animation/tween details
// live in effects.js; the DOM toolbar/status-bar/modals live in ui-dom.js —
// this class only ever WRITES facts to `this.registry` for ui-dom.js to
// render (Publisher/Subscriber, see ui-dom.js's own header comment). See
// docs/superpowers/specs/2026-07-29-tailwind-dom-ui-migration.md.
import {
  KINDS, Board, replayMoves,
} from './board.js';
import {
  startGame as apiStartGame, finishGame as apiFinishGame, bumpStat as apiBumpStat,
  shuffleGame as apiShuffleGame,
  fetchStats, importLegacyStats, fetchVersion, fetchSessionState,
  startDaily,
} from './sync.js';
import {
  load as loadLegacyStats, clearLegacy, emptyAllStats, LEVELS,
} from './stats.js';
import {
  TILE_ASPECT, LAYER_DX_FRAC, LAYER_DY_FRAC, STEP_X_FRAC, STEP_Y_FRAC, MARGIN,
  SHUFFLE_TILE_STAGGER, FALLING_DEPTH, HINT_GLOW_COLOR, GLOW_STRENGTH,
} from './render-constants.js';
import { createUiDom } from './ui-dom.js';
import * as fx from './effects.js';

// Provided globally by Django's JavaScriptCatalog (config/urls.py:
// javascript-catalog) — templates/game.html loads it as a classic <script>
// before this module, so these already exist by the time this file runs.
// Emoji prefixes throughout this file are deliberately kept OUTSIDE these
// calls (plain string literals) — they're language-neutral, only the text is
// translated. (Toolbar/status/modal label constants live in ui-dom.js — the
// DOM UI is the only thing left that renders them.)
const { gettext, interpolate } = window;

const DIFFICULTY_KEY = 'mahjong.difficulty';
const DEFAULT_DIFFICULTY = 'normal';

const BOARD_KEY = 'mahjong.board';
const DEFAULT_BOARD = 'turtle';
// Separate pref for the newgame modal's picker — unlike BOARD_KEY (always a
// real slug: the active/resumed game's actual board), this one records what
// the player last PICKED in the modal, which can be the 'random' sentinel.
// Keeping the two apart means BOARD_KEY/currentBoard never needs to know
// about 'random' at all — it's resolved to a real slug at Start-click time
// (ui-dom.js) before anything downstream (startGame(), the server) sees it.
const BOARD_CHOICE_KEY = 'mahjong.boardChoice';
const RANDOM_BOARD = 'random';
// Board dimensions before any game has loaded a real `layout` from the
// server (scene.js: applyBoardDims) — Turtle's own shape, so the very first
// canvas sizing (create(), before the new-game modal is even shown) matches
// what a default-board game will look like.
const DEFAULT_BOARD_DIMS = { width: 30, height: 16, layers: 5 };

// The server sends board_width/board_height/board_layers alongside `layout`
// on every startGame() (gameplay/layouts.py: Layout.width/height/layers,
// gameplay/schemas.py: StartResponse) — this is only a FALLBACK for resuming
// a game from a localStorage snapshot saved before those fields existed
// (persistGame), where the tile coordinates are all we have. Deriving them
// (bounding box + 2 for the tile footprint, one more layer than the max z)
// is the same convention gameplay/layouts.py's own normalization uses.
function boardDimsFromLayout(layout) {
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  for (const t of layout) {
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
    if (t.z > maxZ) maxZ = t.z;
  }
  return { width: maxX + 2, height: maxY + 2, layers: maxZ + 1 };
}

// Shared read/write for the small localStorage preferences below (board,
// difficulty) — each pref keeps its own validation/fallback logic, only the
// try/catch-around-localStorage (private mode, quota, etc.) is common.
function readPref(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

// this.currentBoard persists the same way difficulty does — but validated
// against the buttons actually rendered in the DOM (server-curated
// layouts/*.layout — templates/game.html), since a stale slug from an older
// deploy might no longer exist.
function loadBoardPref(validSlugs) {
  const stored = readPref(BOARD_KEY);
  return validSlugs.includes(stored) ? stored : DEFAULT_BOARD;
}

function saveBoardPref(slug) {
  writePref(BOARD_KEY, slug);
}

// this.boardChoice (the newgame modal's picker selection) persists the same
// way, but also accepts the 'random' sentinel — see BOARD_CHOICE_KEY above.
function loadBoardChoicePref(validSlugs) {
  const stored = readPref(BOARD_CHOICE_KEY);
  return stored === RANDOM_BOARD || validSlugs.includes(stored) ? stored : DEFAULT_BOARD;
}

function saveBoardChoicePref(choice) {
  writePref(BOARD_CHOICE_KEY, choice);
}

// With no explicitly saved choice — if data was just migrated from v1 (it
// always lands in hard, see stats.js), open the game on hard; otherwise a
// newcomer would see empty stats on normal and think they'd been lost.
function loadDifficultyPref(allStats) {
  const stored = readPref(DIFFICULTY_KEY);
  if (LEVELS.includes(stored)) return stored;
  return allStats.hard.gamesPlayed > 0 ? 'hard' : DEFAULT_DIFFICULTY;
}

function saveDifficultyPref(level) {
  writePref(DIFFICULTY_KEY, level);
}

// A snapshot of the active game for resuming after a page reload (a closed/
// forgotten standalone window on iOS, etc.) — token+layout+move log is
// enough to deterministically reconstruct the current board state by replay
// (board.js: replayMoves). '.v1' is the version of this specific blob
// schema, unrelated to mahjong.stats.v1/v2 (that's a separate version line
// for the legacy stats blob).
const ACTIVE_GAME_KEY = 'mahjong.activeGame.v1';

function saveActiveGame(state) {
  try {
    globalThis.localStorage?.setItem(ACTIVE_GAME_KEY, JSON.stringify(state));
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

function loadActiveGame() {
  try {
    const raw = globalThis.localStorage?.getItem(ACTIVE_GAME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearActiveGame() {
  try {
    globalThis.localStorage?.removeItem(ACTIVE_GAME_KEY);
  } catch {
    // ignore
  }
}

// Background-photo depth/timing (canvas objects — the toolbar/status-bar/
// credit that used to share this "UI overlay" section are DOM now, see
// ui-dom.js).
const BG_VEIL_ALPHA = 0.45;
const BG_DEPTH = -2;
const BG_VEIL_DEPTH = -1;
const BG_FADE_MS = 900;

export class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
  }

  // design-px → device-px (world = device px, Scale.NONE + manual DPR scaling).
  d(n) {
    return n * this.dpr;
  }

  preload() {
    // Photos from Pexels are loaded at runtime by a separate loader cycle and
    // use this crossOrigin too (a WebGL texture from an external host).
    this.load.crossOrigin = 'anonymous';
  }

  async create() {
    this.dpr = window.devicePixelRatio || 1;
    this.resizeCanvas();
    // A board's real shape only arrives with the server's `layout` (start/
    // resume — applyBoardDims()); Turtle's own dims are a reasonable default
    // for sizing the canvas/tiles before that (the new-game modal's default
    // board selection).
    this.boardWidth = DEFAULT_BOARD_DIMS.width;
    this.boardHeight = DEFAULT_BOARD_DIMS.height;
    this.boardLayers = DEFAULT_BOARD_DIMS.layers;
    this.computeLayout();

    // Tile sources — 42 oblique SVGs (Cangjie6), loaded as HTMLImageElement
    // and rasterized into a CanvasTexture at the tile's actual pixel size;
    // re-rasterizing on resize keeps them sharp at any window size.
    await this.loadTileImages();
    this.rasterizeTiles();

    // Particle texture for the confetti/poof/hint — a white filled circle,
    // tone set via tint on spawn, so the image itself is white.
    const spark = this.make.graphics({}, false);
    spark.fillStyle(0xffffff);
    spark.fillCircle(this.d(4), this.d(4), this.d(4));
    spark.generateTexture('spark', this.d(8), this.d(8));
    spark.destroy();

    this.sprites = new Map(); // tile -> Phaser.Image
    this.selected = null;
    this.dealing = false;
    this.bgCounter = 0;
    this.bgImage = null;
    this.bgVeil = null;
    this.bgData = null; // the last photo (for repositioning the credit on resize)
    this.sessionToken = null;
    this.layout = null;
    this.movesLog = [];
    this.isDaily = false;
    this.dailyInfo = null;

    // The DOM UI (toolbar/status-bar/modals — templates/game.html) renders
    // from this same registry; see ui-dom.js. Created here (not earlier) so
    // its click handlers can already call scene methods like hint()/undo().
    this.ui = createUiDom(this);

    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.webgl = this.renderer.type === Phaser.WEBGL;

    let bootstrapped;
    try {
      bootstrapped = await fetchStats();
    } catch {
      bootstrapped = { stats: emptyAllStats(), legacyImportAvailable: false };
      this.registry.set('status', `⚠️ ${gettext('Failed to load statistics')}`);
    }
    let allStats = bootstrapped.stats;
    if (bootstrapped.legacyImportAvailable) {
      const legacy = loadLegacyStats();
      if (LEVELS.some((level) => legacy[level].gamesPlayed > 0)) {
        try {
          const result = await importLegacyStats(legacy);
          if (result.imported) {
            allStats = result.stats;
            clearLegacy();
          }
        } catch {
          // network error — the next launch will retry.
        }
      }
    }
    this.registry.set('allStats', allStats);
    // Left unset on a fetch failure (the catch above) — the toolbar simply
    // shows no name/avatar until the next successful boot, same tolerance as
    // the other bootstrapped: * fields.
    if (bootstrapped.playerName) this.registry.set('player', bootstrapped.playerName);
    this.registry.set('modal', null);
    // this.ui (created above) already subscribed to 'changedata'/
    // 'changedata-allStats'/'changedata-modal'/'setdata' and wired every
    // modal/toolbar button — see ui-dom.js: createUiDom().

    this.currentLevel = loadDifficultyPref(allStats);
    saveDifficultyPref(this.currentLevel);
    this.currentBoard = loadBoardPref(this.ui.realBoardSlugs);
    saveBoardPref(this.currentBoard);
    // The newgame modal's own picker state — independent of currentBoard
    // (which tryResumeGame(), below, is about to overwrite with whatever
    // board the resumed game actually uses).
    this.boardChoice = loadBoardChoicePref(this.ui.realBoardSlugs);
    this.registry.set('gameFinished', true);

    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (this.registry.get('gameFinished')) return;
        this.registry.set('gameElapsedMs', Date.now() - this.registry.get('gameStartMs'));
      },
    });

    this.input.on('gameobjectdown', (_pointer, obj) => {
      if (this.registry.get('modal')) return;
      const tile = obj.getData('tile');
      if (tile) this.handleTileClick(tile);
    });
    this.input.on('gameobjectover', (_pointer, obj) => {
      const tile = obj.getData('tile');
      if (tile) fx.handleTileOver(this, tile);
    });
    this.input.on('gameobjectout', (_pointer, obj) => {
      const tile = obj.getData('tile');
      if (tile) fx.handleTileOut(this, tile);
    });

    // React to size changes of #game-container itself (ResizeObserver, not a
    // window 'resize' listener): the toolbar/status bar are DOM flex
    // siblings now (templates/game.html), so #game-container's box can
    // change from purely internal reflow too — e.g. the header wrapping to a
    // second row, or a language switch changing button label lengths —
    // none of which fires a window resize event. Debounced — so we don't
    // rasterize 42 SVGs on every intermediate observer tick while the window
    // is being dragged.
    this._resizeTimer = null;
    this._onContainerResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.handleResize(), 120);
    };
    this._resizeObserver = new ResizeObserver(this._onContainerResize);
    this._resizeObserver.observe(document.getElementById('game-container'));
    this.events.once('shutdown', () => this._resizeObserver.disconnect());

    this.loadBackground();
    if (!(await this.tryResumeGame())) {
      this.registry.set('modal', { type: 'newgame', canClose: false });
    }
  }

  // Thin wrappers so ui-dom.js's newgame board/level picker click handlers
  // (which only hold a `scene` reference) can persist a choice without
  // importing the module-level pref helpers directly.
  saveBoardChoicePref(choice) {
    saveBoardChoicePref(choice);
  }

  saveDifficultyPref(level) {
    saveDifficultyPref(level);
  }

  // --- Layout and canvas size (native resolution) --------------------

  // Canvas at native resolution: backing = CSS size × dpr, while the CSS
  // size is kept equal to the container — the browser scales it back down
  // to CSS pixels, so everything renders in device-px and stays sharp on
  // any screen/window.
  resizeCanvas() {
    const parent = this.game.canvas.parentElement
      || document.getElementById('game-container');
    const cssW = parent?.clientWidth || window.innerWidth;
    const cssH = parent?.clientHeight || window.innerHeight;
    this.dpr = window.devicePixelRatio || 1;
    this.scale.resize(Math.round(cssW * this.dpr), Math.round(cssH * this.dpr));
    const canvas = this.game.canvas;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    // scale.resize() computes displayScale from the canvas's CSS bounds
    // BEFORE the two lines above override them, so it caches a stale value
    // (one resize behind) — every pointer coordinate (tiles, toolbar
    // buttons) is transformed through that scale, producing the left/up
    // hitbox drift reported after resizing. refresh() is the only public
    // method that recomputes displayScale itself (updateBounds() alone
    // refreshes canvasBounds but leaves the stale displayScale untouched).
    this.scale.refresh();
  }

  // Computes the board's metrics (device-px) from the current canvas size:
  // tile size (fit into the available area, with margins), the origin point
  // for centering. Stored in this.LM. The toolbar/status bar are DOM flex
  // siblings of the canvas now (templates/game.html) — #game-container's own
  // clientWidth/clientHeight (resizeCanvas) already excludes them, so there's
  // no separate bar height to subtract here anymore.
  computeLayout() {
    const viewW = this.scale.gameSize.width;
    const viewH = this.scale.gameSize.height;
    const margin = this.d(MARGIN);

    const availW = Math.max(1, viewW - 2 * margin);
    const availH = Math.max(1, viewH - 2 * margin);

    // this.boardWidth/boardHeight (see applyBoardDims) are in kmahjongg's
    // half-tile units (a regular tile = a step of 2, not 1: that's also
    // where the peak/protrusion coordinates live on odd units). The real
    // tile-column/row count is half that.
    const realWidth = this.boardWidth / 2;
    const realHeight = this.boardHeight / 2;
    const layers = this.boardLayers;

    // Tiles on the same grid DELIBERATELY overlap (step < the sprite's full
    // size) — every Cangjie6 sprite contains not just the face but also a
    // bevel above/to the right, and the neighbour must ride over it to hide
    // it (see STEP_X_FRAC/STEP_Y_FRAC in render-constants.js). So the
    // board's content width is (realWidth-1) steps of STEP_X_FRAC*tileW plus
    // one full tileW (the last tile extends its full width past its own
    // step), and likewise for Y. tileW = tileH*ASPECT. We pick tileH so it
    // fits both the width and the height.
    const wSpan = TILE_ASPECT * ((realWidth - 1) * STEP_X_FRAC + 1 + (layers - 1) * LAYER_DX_FRAC);
    const hSpan = (realHeight - 1) * STEP_Y_FRAC + 1 + (layers - 1) * LAYER_DY_FRAC;
    const tileH = Math.min(availW / wSpan, availH / hSpan);
    const tileW = tileH * TILE_ASPECT;
    const stepX = tileW * STEP_X_FRAC;
    const stepY = tileH * STEP_Y_FRAC;
    const layerDX = tileW * LAYER_DX_FRAC;
    const layerDY = tileH * LAYER_DY_FRAC;

    // The topmost layer (z=layers-1) is shifted furthest down-left — we
    // compute the content size FROM IT (the largest visible rectangle), so
    // originX/Y remains the bound of that topmost layer, and lower layers
    // (smaller shift) fit inside it.
    const contentW = (realWidth - 1) * stepX + tileW + (layers - 1) * layerDX;
    const contentH = (realHeight - 1) * stepY + tileH + (layers - 1) * layerDY;
    const originX = (viewW - contentW) / 2;
    const originY = (viewH - contentH) / 2;

    this.LM = {
      viewW, viewH, margin,
      tileW, tileH, stepX, stepY, layerDX, layerDY, contentW, contentH, originX, originY,
    };
  }

  // The on-screen (world) position of a tile's center — the same formula
  // used for spawning the sprite and for positioning effects. tile.x/tile.y
  // are in half-tile units (the corner of the tile's 2×2 footprint), so the
  // step per unit is stepX/2, stepY/2, and the tile's center is +1 unit from
  // the corner (the true middle of its 2-unit footprint, correctly centering
  // odd coordinates too — the peak apex/head-tail protrusions — with no
  // approximation). Higher layers (z) are shifted DOWN-LEFT by the drawn
  // bevel's thickness (render-constants.js: LAYER_DX/DY_FRAC) — exactly
  // where the Cangjie6 oblique art's tile thickness "sticks out" toward the viewer.
  tileScreenPos(tile) {
    const {
      originX, originY, stepX, stepY, layerDX, layerDY,
    } = this.LM;
    const x = originX + (tile.x + 1) * (stepX / 2) - tile.z * layerDX;
    const y = originY + (tile.y + 1) * (stepY / 2) + tile.z * layerDY;
    return { x, y };
  }

  flightCenter() {
    const { originX, originY, contentW, contentH } = this.LM;
    return { x: originX + contentW / 2, y: originY + contentH / 2 };
  }

  // The "Remaining: N" counter now lives in the DOM status bar (templates/
  // game.html: #status-text, footer below the canvas — ui-dom.js:
  // getCounterRect()), not on the canvas itself. Map its on-screen CSS-px
  // rect into canvas world-space (device-px: world = (screenPx - canvasCssOrigin) * dpr).
  // The target ends up just below the canvas's bottom edge — the flying tile
  // fades out (effects.js: flyDownFromCenter) as it exits, which reads fine.
  flightTarget() {
    const canvasRect = this.game.canvas.getBoundingClientRect();
    const counterRect = this.ui.getCounterRect();
    const cx = counterRect.left + counterRect.width / 2;
    const cy = counterRect.top + counterRect.height / 2;
    return {
      x: (cx - canvasRect.left) * this.dpr,
      y: (cy - canvasRect.top) * this.dpr,
    };
  }

  // --- Tiles: loading SVGs + rasterization --------------------------

  // We load the SVG as TEXT and turn it into a blob-URL Image (origin-clean)
  // rather than an `<img src="...svg">` directly: an http-SVG drawn into a
  // canvas "taints" it, and WebGL refuses to upload a texture from it (the
  // same approach Phaser's SVGFile uses). We add explicit width/height from
  // the viewBox — without them Adobe SVGs have zero intrinsic size and
  // drawImage paints nothing.
  loadTileImages() {
    this.tileImages = new Map();
    return Promise.all(KINDS.map(async (kind) => {
      try {
        const res = await fetch(`/static/game/tiles/${kind}.svg`);
        let text = await res.text();
        if (!/<svg[^>]*\swidth=/.test(text)) {
          text = text.replace(/<svg\b/, '<svg width="210" height="255"');
        }
        const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
        const img = new Image();
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
          img.src = url;
        });
        this.tileImages.set(kind, img);
      } catch {
        // a missing/broken tile shouldn't crash the whole startup
      }
    }));
  }

  // Draws each SVG into a CanvasTexture at the tile's current pixel size
  // (this.LM.tileW/tileH — already device-px). Texture key = tile kind. If
  // the texture already exists at the right size, skip it (no point redrawing).
  rasterizeTiles() {
    const w = Math.max(1, Math.round(this.LM.tileW));
    const h = Math.max(1, Math.round(this.LM.tileH));
    if (this._rasterW === w && this._rasterH === h) return;
    this._rasterW = w;
    this._rasterH = h;
    for (const kind of KINDS) {
      const img = this.tileImages.get(kind);
      const tex = this.textures.exists(kind)
        ? this.textures.get(kind) : this.textures.createCanvas(kind, w, h);
      if (tex.width !== w || tex.height !== h) tex.setSize(w, h);
      const ctx = tex.getContext();
      ctx.clearRect(0, 0, w, h);
      if (img) ctx.drawImage(img, 0, 0, w, h);
      tex.refresh();
    }
  }

  // --- Background (Pexels) ----------------------------------------------------

  async loadBackground() {
    let data;
    try {
      const response = await fetch('/api/background/');
      data = await response.json();
    } catch {
      return;
    }
    if (!data?.url) return;

    this.bgCounter += 1;
    const key = `bg-${this.bgCounter}`;
    this.load.image(key, data.url);
    this.load.once(`filecomplete-image-${key}`, () => {
      const prevImage = this.bgImage;
      const prevTextureKey = this.bgTextureKey;
      const { viewW, viewH } = this.LM;

      const newImage = this.add.image(viewW / 2, viewH / 2, key)
        .setDisplaySize(viewW, viewH)
        .setDepth(BG_DEPTH)
        .setAlpha(this.reducedMotion ? 1 : 0);
      this.bgImage = newImage;
      this.bgTextureKey = key;

      if (!this.bgVeil) {
        this.bgVeil = this.add.rectangle(viewW / 2, viewH / 2, viewW, viewH, 0x000000, BG_VEIL_ALPHA)
          .setDepth(BG_VEIL_DEPTH);
      }

      const cleanupPrev = () => {
        prevImage?.destroy();
        if (prevTextureKey) this.textures.remove(prevTextureKey);
      };
      if (this.reducedMotion) {
        cleanupPrev();
      } else {
        this.tweens.add({
          targets: newImage, alpha: 1, duration: BG_FADE_MS, ease: 'Sine.easeInOut', onComplete: cleanupPrev,
        });
      }

      this.bgData = data;
      this.ui.setBgCredit(data.photographer, data.photographer_url);
    });
    this.load.once('loaderror', () => {});
    this.load.start();
  }

  // Sets this.boardWidth/boardHeight/boardLayers (the board shape is no
  // longer hardcoded — see gameplay/layouts.py) and recomputes tile sizing/
  // rasterization for it. Called before any tile sprites for that layout are
  // created (startGame/tryResumeGame), so no relayoutTiles() pass is needed
  // here — new sprites spawn at the right size/position from the start.
  applyBoardDims(width, height, layers) {
    this.boardWidth = width;
    this.boardHeight = height;
    this.boardLayers = layers;
    this.computeLayout();
    this.rasterizeTiles(); // no-op if the tile pixel size didn't change
  }

  // --- Resize handling --------------------------------------------------

  handleResize() {
    if (!this.LM) return;
    this.resizeCanvas();
    this.computeLayout();
    this.rasterizeTiles();
    this.relayoutTiles();
    this.layoutUI();
  }

  relayoutTiles() {
    const { tileW, tileH } = this.LM;
    for (const [tile, sprite] of this.sprites) {
      if (sprite._flying) continue; // flying to the counter — don't touch it
      const { x, y } = this.tileScreenPos(tile);
      sprite.setDisplaySize(tileW, tileH);
      sprite.setPosition(x, y);
      // rasterizeTiles() just resized the shared per-kind CanvasTexture's
      // frame — but a hit area Rectangle created by setInteractive() is a
      // snapshot, not a live reference, and doesn't follow the frame's new
      // size on its own. Without this, the hitbox stays stuck at whatever
      // size the tile first rendered at, drifting away from the visible
      // sprite on every resize.
      sprite.input?.hitArea.setTo(0, 0, sprite.width, sprite.height);
    }
  }

  // Toolbar/status bar/credit are DOM now (templates/game.html) — they
  // reflow via ordinary CSS flex, no JS layout pass needed on resize. Only
  // the background photo/veil (still canvas objects) need repositioning.
  layoutUI() {
    const { viewW, viewH } = this.LM;
    if (this.bgImage) this.bgImage.setPosition(viewW / 2, viewH / 2).setDisplaySize(viewW, viewH);
    if (this.bgVeil) this.bgVeil.setPosition(viewW / 2, viewH / 2).setSize(viewW, viewH);
  }

  // --- Game persistence/resume -------------------------------------------

  // The shared tail of "enter a game" — used by both startGame() (a fresh
  // board from the server) and tryResumeGame() (a board replayed from a
  // saved localStorage snapshot). Everything before this point differs
  // (where the data comes from); everything from here on — board dims,
  // sprites, deal-in, the per-game registry counters — is identical.
  enterGame({
    token, layout, width, height, layers, boardInstance, movesLog, shuffles,
    hints, undos, pairs, startMs, elapsedMs,
  }) {
    this.sessionToken = token;
    this.layout = layout;
    this.applyBoardDims(width, height, layers);
    this.movesLog = movesLog;
    this.shuffles = shuffles || [];
    this.board = boardInstance;
    for (const tile of this.board.tiles()) this.addTileSprite(tile);
    fx.playDealIn(this);

    this.registry.set('gameHints', hints);
    this.registry.set('gameUndos', undos);
    this.registry.set('gamePairs', pairs);
    this.registry.set('gameStartMs', startMs);
    this.registry.set('gameElapsedMs', elapsedMs);
    this.registry.set('gameFinished', false);
  }

  persistGame() {
    saveActiveGame({
      token: this.sessionToken,
      level: this.currentLevel,
      board: this.currentBoard,
      layout: this.layout,
      boardWidth: this.boardWidth,
      boardHeight: this.boardHeight,
      boardLayers: this.boardLayers,
      movesLog: this.movesLog,
      shuffles: this.shuffles,
      hints: this.registry.get('gameHints'),
      undos: this.registry.get('gameUndos'),
      daily: this.isDaily,
    });
  }

  async tryResumeGame() {
    const saved = loadActiveGame();
    if (!saved) return false;

    let state;
    try {
      state = await fetchSessionState(saved.token);
    } catch {
      state = null;
    }
    if (state?.status !== 'active') {
      clearActiveGame();
      return false;
    }

    const tiles = saved.layout.map((t, idx) => ({ ...t, idx }));
    // saved.shuffles is absent in snapshots written before shuffling existed
    // — those games never shuffled, so an empty log reproduces them exactly.
    const shuffles = saved.shuffles || [];
    const board = replayMoves(tiles, saved.movesLog, shuffles);
    if (!board) {
      clearActiveGame();
      return false;
    }

    this.currentLevel = saved.level;
    // saved.board is absent in snapshots written before board selection
    // existed — those are all Turtle games (the only board there was).
    this.currentBoard = saved.board || DEFAULT_BOARD;
    // saved.daily is absent in snapshots written before the daily tournament
    // existed — those are always regular games.
    this.isDaily = !!saved.daily;
    // saved.boardWidth/Height/Layers are likewise absent in snapshots from
    // before this field existed — fall back to deriving them from the tile
    // coordinates themselves (boardDimsFromLayout) for those old saves only;
    // a fresh save always carries the server-authoritative values straight
    // through, no re-derivation needed.
    const dims = saved.boardWidth != null
      ? { width: saved.boardWidth, height: saved.boardHeight, layers: saved.boardLayers }
      : boardDimsFromLayout(saved.layout);
    this.enterGame({
      token: saved.token,
      layout: saved.layout,
      width: dims.width, height: dims.height, layers: dims.layers,
      boardInstance: board,
      movesLog: saved.movesLog.map((pair) => [...pair]),
      shuffles,
      hints: saved.hints, undos: saved.undos, pairs: saved.movesLog.length,
      startMs: Date.now() - state.elapsedMs, elapsedMs: state.elapsedMs,
    });
    this.updateStatus();
    return true;
  }

  // --- The game session ----------------------------------------------------------

  async startGame(level, board) {
    try {
      const serverVersion = await fetchVersion();
      if (serverVersion !== window.MAHJONG_VERSION) {
        location.reload();
        return;
      }
    } catch {
      // Network unavailable — don't block the game on the version check.
    }

    // Cleared eagerly (before the network round trip) so the board visibly
    // empties out right away, under the "Generating layout…" status —
    // unlike playDaily() below, which has no equivalent waiting state to show.
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;
    this.registry.set('status', `⏳ ${gettext('Generating layout…')}`);
    this.registry.set('modal', null);

    let data;
    try {
      data = await apiStartGame(level, board);
    } catch {
      this.registry.set('status', `⚠️ ${gettext("Failed to start the game — check your connection")}`);
      return;
    }

    this.registry.set('allStats', data.stats);
    this._enterFreshGame({
      token: data.token, layout: data.layout,
      width: data.board_width, height: data.board_height, layers: data.board_layers,
      level, board, isDaily: false,
    });
  }

  // Starts (or resumes) today's daily-tournament attempt (gameplay/api.py:
  // start_daily) — idempotent, so clicking Play again the same day never
  // hands out a different board. If the attempt is already WON (possibly on
  // another device), there's no board to start — just refresh the modal to
  // show the result instead. A LOST attempt is retryable — falls through to
  // startDaily(), which mints a fresh session on the same deterministic
  // board.
  async playDaily() {
    // Already resumed into this tab (e.g. tryResumeGame() on page load) —
    // just return to it, don't re-fetch/restart via the server (that would
    // reset the local move log to empty, discarding real progress).
    if (this.isDaily && this.sessionToken && !this.registry.get('gameFinished')) {
      this.registry.set('modal', null);
      return;
    }
    // A WIN closes the day — nothing left to start. A 'lost' status falls
    // through to startDaily() below, which mints a fresh retry session
    // (gameplay/api.py: start_daily only refuses on a recorded win).
    if (this.dailyInfo && this.dailyInfo.yourStatus === 'won') {
      this.registry.set('modal', null);
      return;
    }

    let data;
    try {
      data = await startDaily();
    } catch {
      this.registry.set(
        'status', `⚠️ ${gettext('Failed to start the daily tournament — check your connection')}`,
      );
      return;
    }
    if (data.finished) {
      this.ui.renderDailyModal(); // claimed/forfeited between fetch and click
      return;
    }

    this.registry.set('modal', null);
    // The server doesn't store partial progress — resuming an attempt
    // already active on another device (or after clearing localStorage)
    // starts the move log over in _enterFreshGame, even though the board/
    // timer are shared (an accepted limitation — see docs/superpowers/specs).
    this._enterFreshGame({
      token: data.token, layout: data.layout,
      width: data.boardWidth, height: data.boardHeight, layers: data.boardLayers,
      level: data.level, board: data.board, isDaily: true,
    });
  }

  // Shared tail of startGame()/playDaily(): swap in a brand new board (empty
  // move log, fresh counters) and re-render everything that depends on it.
  // `data.stats`, when present, must already be pushed to the registry by
  // the caller before this runs — daily starts don't bump lifetime stats, so
  // playDaily() has none to push.
  _enterFreshGame({ token, layout, width, height, layers, level, board, isDaily }) {
    this.currentLevel = level;
    this.currentBoard = board;
    this.isDaily = isDaily;
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;

    const tiles = layout.map((t, idx) => ({ ...t, idx }));
    this.enterGame({
      token, layout, width, height, layers,
      boardInstance: new Board(tiles),
      movesLog: [],
      hints: 0, undos: 0, pairs: 0,
      startMs: Date.now(), elapsedMs: 0,
    });

    // No explicit re-render call needed here (unlike the old canvas code) —
    // enterGame()'s own registry.set('gameFinished', false) above already
    // fires 'changedata', and this.currentLevel/currentBoard (read by
    // ui-dom.js's renderStats()) are already updated by the time it does.
    this.persistGame();
    this.updateStatus();
  }

  bumpCounter(gameKey, counter) {
    this.registry.set(gameKey, this.registry.get(gameKey) + 1);
    this.persistGame();
    apiBumpStat(this.sessionToken, counter)
      .then((stats) => this.registry.set('allStats', stats))
      .catch(() => {});
  }

  deselect() {
    if (this.selected) {
      fx.removeGlow(this, this.selected);
      this.selected = null;
    }
  }

  async finishGame(won) {
    if (this.registry.get('gameFinished')) return;
    this.registry.set('gameFinished', true);

    const outcome = won ? 'win' : 'deadlock';
    let result;
    try {
      result = await apiFinishGame(this.sessionToken, this.movesLog, outcome);
    } catch {
      this.registry.set('status', `⚠️ ${gettext('Failed to confirm the game result')}`);
      this.registry.set('modal', { type: 'result', error: true });
      return;
    }

    if (!result.valid) {
      this.registry.set('status', `⚠️ ${gettext('The game was not confirmed by the server')}`);
      this.registry.set('modal', { type: 'result', error: true });
      clearActiveGame();
      return;
    }

    clearActiveGame();
    this.registry.set('gameElapsedMs', result.elapsedMs);
    this.registry.set('allStats', result.stats);
    if (result.won) this.loadBackground();
    fx.playEndEffect(this, result.won, () => {
      if (this.isDaily) {
        // A daily win/loss doesn't touch lifetime per-difficulty stats
        // (gameplay/api.py: _lifetime_stats_after) — showing the regular
        // stats-modal breakdown here would show numbers unrelated to what
        // just happened. Reopen the tournament modal instead: it refetches
        // today's status and shows the score/rank/leaderboard directly.
        this.dailyInfo = null;
        this.registry.set('modal', { type: 'daily' });
      } else {
        this.registry.set('modal', { type: 'result', won: result.won });
      }
    });
  }

  // The dead-end alternative to shuffling/giving up (scene.js: updateStatus()
  // opens the 'deadlock' modal, templates/game.html: #btn-deadlock-replay):
  // registers the current game as a loss (the same server call "give up"
  // makes) and immediately starts a fresh one with the same settings — no
  // intermediate result screen. For a daily attempt the per-day seed is
  // deterministic, so the retry is the identical board, just a new session
  // row (gameplay/models.py: one_daily_win_per_user_per_day only blocks a
  // SECOND win, a lost attempt may always be retried).
  async replayGame() {
    if (this.registry.get('gameFinished')) return;
    this.registry.set('gameFinished', true);
    const wasDaily = this.isDaily;
    const level = this.currentLevel;
    const board = this.currentBoard;

    try {
      await apiFinishGame(this.sessionToken, this.movesLog, 'deadlock');
    } catch {
      // Best-effort: even if the server didn't get to record the loss (e.g.
      // a network hiccup), still let the player continue instead of leaving
      // them stuck at a dead end. For a daily attempt the old session simply
      // stays ACTIVE and playDaily() below picks it back up; for a regular
      // game startGame() always mints a fresh session regardless, so the
      // old one is just abandoned (orphaned until it hits SESSION_TTL).
    }
    clearActiveGame();
    this.registry.set('modal', null);

    if (wasDaily) {
      this.dailyInfo = null;
      await this.playDaily();
    } else {
      await this.startGame(level, board);
    }
  }

  // The dead-end alternative to giving up (scene.js: updateStatus() opens the
  // 'deadlock' modal, templates/game.html: #btn-deadlock-shuffle). Re-deals
  // kinds for whatever tiles remain — server-authoritative and guaranteed
  // solvable (gameplay/generator.py: reshuffle_layout) — so the game can
  // always be finished after this, unlike a plain client-side shuffle.
  async shuffleGame() {
    if (!this.board) return;
    let result;
    try {
      result = await apiShuffleGame(this.sessionToken, this.movesLog);
    } catch {
      this.registry.set('status', `⚠️ ${gettext('Failed to shuffle — check your connection')}`);
      return;
    }

    // The data model updates immediately (the server is authoritative) —
    // effects.js's playShuffleFlip only re-textures the sprite, on its own
    // delayed/tweened schedule, so a slow flip animation can never leave
    // board state (isWon/isDeadlocked) looking at stale kinds.
    const tilesByIdx = new Map(this.board.tiles().map((tile) => [tile.idx, tile]));
    Object.entries(result.kinds).forEach(([idxStr, kind], i) => {
      const tile = tilesByIdx.get(Number(idxStr));
      if (!tile) return;
      tile.kind = kind;
      fx.playShuffleFlip(this, tile, kind, i * SHUFFLE_TILE_STAGGER);
    });
    this.shuffles.push({ afterMoves: this.movesLog.length, kinds: result.kinds });
    this.registry.set('allStats', result.stats);
    this.persistGame();
    this.registry.set('modal', null);
    this.updateStatus();
  }

  // --- Tile sprites --------------------------------------------------

  addTileSprite(tile) {
    const { x, y } = this.tileScreenPos(tile);
    const sprite = this.add.image(x, y, tile.kind).setDisplaySize(this.LM.tileW, this.LM.tileH);
    // The bevel (drawn in the Cangjie6 oblique art) sticks out ABOVE and to
    // the RIGHT of the face — so a tile with a smaller y (higher row) and a
    // larger x (further-right column) must hide the neighbour's bevel
    // beneath it: smaller y and larger x → higher depth. x and y contribute
    // with EQUAL weight (not ×100 for y), because regular neighbours differ
    // by exactly 2 in only ONE axis (the other matches — that axis's weight
    // doesn't matter there), while diagonal half-tile neighbours (the peak
    // apex, the head/tail protrusions) differ by ±1 in BOTH axes at once —
    // an unequal weight (used to be ×100 for y) made the y difference
    // completely swamp x and gave the wrong draw order exactly for them (a
    // visible hole with the background showing through at the seam). Higher
    // layers (z) are always on top, regardless of x/y.
    sprite.setDepth(tile.z * 10000 + (this.boardHeight - 1 - tile.y) + tile.x);
    sprite.setInteractive();
    sprite.setData('tile', tile);
    this.sprites.set(tile, sprite);
    fx.resetTileTint(this, tile);
  }

  handleTileClick(tile) {
    if (this.dealing) return;
    if (!this.board.isFree(tile)) {
      fx.playError(this, tile);
      return;
    }
    fx.playPress(this, tile);
    if (this.selected === tile) {
      this.deselect();
      return;
    }
    if (this.selected && this.board.canMatch(this.selected, tile)) {
      this.removePair(this.selected, tile);
      return;
    }
    this.deselect();
    this.selected = tile;
    fx.clearHover(this, this.sprites.get(tile));
    fx.applyGlow(this, tile);
  }

  removePair(a, b) {
    if (!this.board.removePair(a, b)) return;
    this.movesLog.push([a.idx, b.idx]);
    this.selected = null;
    this.bumpCounter('gamePairs', 'pair');

    let pending = 0;
    const onTileGone = () => {
      pending -= 1;
      if (pending === 0) this.updateStatus();
    };

    for (const tile of [a, b]) {
      const sprite = this.sprites.get(tile);
      sprite._glowTween?.stop();
      sprite._tiltTween?.stop();
      fx.clearHover(this, sprite);
      this.sprites.delete(tile);
      if (this.reducedMotion) {
        sprite.destroy();
        continue;
      }
      sprite.setDepth(FALLING_DEPTH);
      sprite._flying = true;
      pending += 1;
      fx.flyToCenterThenDown(this, sprite, onTileGone);
    }
    if (pending === 0) this.updateStatus();
  }

  undo() {
    if (!this.board) return;
    const pair = this.board.undo();
    if (!pair) return;
    this.movesLog.pop();
    this.deselect();
    for (const tile of pair) fx.animateUndoTile(this, tile);
    this.bumpCounter('gameUndos', 'undo');
    this.updateStatus();
  }

  hint() {
    if (!this.board) return;
    const pair = this.board.findMatchingPair();
    if (!pair) return;
    // The glow removal timer below is derived from these same two values —
    // change them together, not pulseMs on its own, or the glow will
    // outlive (or cut off before) the alpha pulse it's paired with.
    const pulseDuration = 180;
    const pulseRepeat = 3;
    const pulseMs = pulseDuration * (1 + 2 * pulseRepeat);
    for (const tile of pair) {
      const sprite = this.sprites.get(tile);
      this.tweens.add({
        targets: sprite,
        alpha: 0.3,
        duration: pulseDuration,
        yoyo: true,
        repeat: pulseRepeat,
      });
      if (this.webgl) {
        const glowFx = sprite.postFX.addGlow(HINT_GLOW_COLOR, GLOW_STRENGTH, 0, false, 0.15, 12);
        this.time.delayedCall(pulseMs, () => sprite.postFX?.remove(glowFx));
      }
    }
    this.bumpCounter('gameHints', 'hint');
  }

  updateStatus() {
    if (this.board.isWon()) {
      this.registry.set('status', `🎉 ${gettext('Victory!')}`);
      this.finishGame(true);
    } else if (this.board.isDeadlocked()) {
      this.registry.set('status', `🚫 ${gettext('No moves left')}`);
      this.registry.set('modal', { type: 'deadlock' });
    } else {
      // No noun to agree in number here ("Remaining: N", not "N tiles left")
      // — a plain interpolated count needs no ngettext/plural forms.
      this.registry.set('status', `🀄 ${interpolate(gettext('Remaining: %(n)s'), { n: this.board.remaining }, true)}`);
    }
  }
}
