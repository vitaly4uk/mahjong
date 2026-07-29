import {
  KINDS, Board, replayMoves,
} from './board.js';
import {
  startGame as apiStartGame, finishGame as apiFinishGame, bumpStat as apiBumpStat,
  shuffleGame as apiShuffleGame,
  fetchStats, importLegacyStats, fetchVersion, fetchSessionState, setLanguage,
  fetchDaily, startDaily,
} from './sync.js';
import {
  load as loadLegacyStats, clearLegacy, emptyAllStats, winRate, fmtTime, LEVELS,
} from './stats.js';
import {
  TILE_ASPECT, LAYER_DX_FRAC, LAYER_DY_FRAC, STEP_X_FRAC, STEP_Y_FRAC, MARGIN, TOOLBAR_H, STATUS_BAR_H,
  STATUS_BAR_BG, STATUS_BAR_BG_ALPHA, LAYER_TINTS,
  GLOW_COLOR, GLOW_STRENGTH, GLOW_PULSE_DELTA, SELECT_TILT_DEG, HINT_GLOW_COLOR, SPARK_COLORS,
  POOF_COUNT, END_EFFECT_MS, CRUMBLE_FALL, UNDO_DROP, FALLING_DEPTH,
  HOVER_SCALE, HOVER_WOBBLE_DEG, HOVER_WOBBLE_MS, HOVER_MS,
  PRESS_SCALE, PRESS_DROP, PRESS_MS, PRESS_TINT,
  ERROR_SHAKE_PX, ERROR_SHAKE_MS, ERROR_SHAKE_REPEAT, ERROR_TINT, ERROR_TINT_MS,
  FLIGHT_TO_CENTER_MS, FLIGHT_MERGE_SCALE, FLIGHT_DOWN_MS, FLIGHT_ARC_LIFT,
  DEAL_TILE_MS, DEAL_LAYER_STAGGER, DEAL_TILE_STAGGER, DEAL_START_SCALE, DEAL_OFFSCREEN_PAD,
  SHUFFLE_FLIP_MS, SHUFFLE_TILE_STAGGER,
} from './render-constants.js';

// Provided globally by Django's JavaScriptCatalog (config/urls.py:
// javascript-catalog) — templates/game.html loads it as a classic <script>
// before this module, so these already exist by the time this file runs.
// Emoji prefixes throughout this file are deliberately kept OUTSIDE these
// calls (plain string literals) — they're language-neutral, only the text is
// translated.
const { gettext, interpolate } = window;

const DIFFICULTY_KEY = 'mahjong.difficulty';
const DEFAULT_DIFFICULTY = 'normal';
const LEVEL_LABELS = {
  easy: `😌 ${gettext('Easy')}`,
  normal: `🙂 ${gettext('Normal')}`,
  hard: `😈 ${gettext('Hard')}`,
};

// Hoisted like LEVEL_LABELS above — renderStats() runs on every registry
//'changedata' tick (deliberately cheap, see its own comment), so these
// gettext()/interpolate() results (constant for the life of the page — the
// language only ever changes via a full reload) shouldn't be recomputed
// on every tick.
const HINT_LABEL = `💡 ${gettext('Hint')}`;
const HINT_TEMPLATE = gettext('Hint (%(n)s)');
const UNDO_LABEL = `↩️ ${gettext('Undo')}`;
const UNDO_TEMPLATE = gettext('Undo (%(n)s)');

// Hoisted for the same reason as HINT_LABEL/UNDO_LABEL above — renderStatsModal()
// rebuilds this 3-levels×9-rows table on every allStats change/modal open, no
// need to re-translate the (per-page-load constant) row labels each time.
const STATS_ROW_LABELS = {
  started: `🎲 ${gettext('Games started')}`,
  played: `📋 ${gettext('Games played')}`,
  wins: `🏆 ${gettext('Wins')}`,
  winRate: `📈 ${gettext('Win rate')}`,
  currentStreak: `🔥 ${gettext('Current streak')}`,
  bestStreak: `⭐ ${gettext('Best streak')}`,
  bestTime: `⏱️ ${gettext('Best time')}`,
  totalHints: `💡 ${gettext('Total hints')}`,
  totalUndos: `↩️ ${gettext('Total undos')}`,
  totalPairs: `🀄 ${gettext('Total pairs removed')}`,
  totalShuffles: `🔀 ${gettext('Total shuffles')}`,
};

const BOARD_KEY = 'mahjong.board';
const DEFAULT_BOARD = 'turtle';
// Board dimensions before any game has loaded a real `layout` from the
// server (main.js: applyBoardDims) — Turtle's own shape, so the very first
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

const statsModal = document.getElementById('stats-modal');
const statsTitleEl = document.getElementById('stats-title');
const statsLevelsEl = document.getElementById('stats-levels');
const newgameModal = document.getElementById('newgame-modal');
const newgameLevelButtons = [...newgameModal.querySelectorAll('[data-level]')];
const newgameBoardButtons = [...newgameModal.querySelectorAll('[data-board]')];
const newgameStartBtn = document.getElementById('btn-newgame-start');
const newgameCloseBtn = document.getElementById('btn-newgame-close');
const deadlockModal = document.getElementById('deadlock-modal');
const deadlockShuffleBtn = document.getElementById('btn-deadlock-shuffle');
const deadlockReplayBtn = document.getElementById('btn-deadlock-replay');
const deadlockGiveupBtn = document.getElementById('btn-deadlock-giveup');
const dailyModal = document.getElementById('daily-modal');
const dailyInfoEl = document.getElementById('daily-info');
const dailyBoardEl = document.getElementById('daily-board');
const dailyPlayBtn = document.getElementById('btn-daily-play');
const dailyCloseBtn = document.getElementById('btn-daily-close');

// Only uk/en ship for now (config/settings.py: LANGUAGES) — a single toggle
// button in the canvas toolbar (createToolbar) is simpler than a picker for
// two options; switching to more languages later would need a real picker.
const LANG_BTN_LABEL = { uk: 'UA', en: 'EN' };

const BG_VEIL_ALPHA = 0.45;
const BG_DEPTH = -2;
const BG_VEIL_DEPTH = -1;
const BG_FADE_MS = 900;
const BG_CREDIT_DEPTH = FALLING_DEPTH + 1;
const BG_CREDIT_PADDING = 8;

// The toolbar/status overlay plates sit above the canvas edges (over the
// photo and the tiles) — higher than FALLING_DEPTH, so a tile flying to the
// counter "disappears under" the status plate instead of covering the text.
const STATUS_BAR_PLATE_DEPTH = FALLING_DEPTH + 1;
const STATUS_BAR_DEPTH = FALLING_DEPTH + 2;
const TOOLBAR_PLATE_DEPTH = FALLING_DEPTH + 1;
const TOOLBAR_DEPTH = FALLING_DEPTH + 2;
const TOOLBAR_BTN_GAP = 12; // design-px
const TOOLBAR_BTN_H = 42; // design-px
const TOOLBAR_BTN_BG = 0x3a5a40;
const TOOLBAR_BTN_HOVER = 0x4c7454;
const BTN_CORNER_R = 10; // design-px

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
  }

  // design-px → device-px (world = device px, Scale.NONE + manual DPR scaling).
  d(n) {
    return n * this.dpr;
  }

  // Canvas text style: size in device-px (base×dpr), resolution=1 — the
  // world is already in device-px, so no extra multiplication is needed and
  // the font stays sharp.
  textStyle(basePx, color) {
    return {
      fontSize: `${Math.round(this.d(basePx))}px`,
      color,
      fontFamily: 'system-ui, sans-serif',
      resolution: 1,
    };
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

    // Toolbar button background texture — a rounded rectangle at a fixed
    // "base" size; scaled to the actual button width via setDisplaySize.
    this.btnBaseW = this.d(200);
    const btnBg = this.make.graphics({}, false);
    btnBg.fillStyle(0xffffff);
    btnBg.fillRoundedRect(0, 0, this.btnBaseW, this.d(TOOLBAR_BTN_H), this.d(BTN_CORNER_R));
    btnBg.generateTexture('toolbarBtnBg', this.btnBaseW, this.d(TOOLBAR_BTN_H));
    btnBg.destroy();

    this.sprites = new Map(); // tile -> Phaser.Image
    this.selected = null;
    this.dealing = false;
    this.bgCounter = 0;
    this.bgImage = null;
    this.bgVeil = null;
    this.bgCredit = null;
    this.bgData = null; // the last photo (for repositioning the credit on resize)
    this.sessionToken = null;
    this.layout = null;
    this.movesLog = [];
    this.isDaily = false;
    this.dailyInfo = null;

    this.createStatusBar();
    this.createToolbar();

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
    this.registry.events.on('changedata', () => this.renderStats());
    // Narrower than the 'changedata' above on purpose: the stats-modal HTML
    // (3 levels × 9 rows) only needs rebuilding when allStats itself
    // changes, not on every registry write — including the 1Hz elapsed-time
    // tick, which would otherwise rebuild it every second even while the
    // modal is closed.
    this.registry.events.on('changedata-allStats', () => this.renderStatsModal());

    this.registry.set('modal', null);
    this.registry.events.on('changedata-modal', (_parent, value) => this.renderModal(value));

    this.currentLevel = loadDifficultyPref(allStats);
    saveDifficultyPref(this.currentLevel);
    this.currentBoard = loadBoardPref(newgameBoardButtons.map((btn) => btn.dataset.board));
    saveBoardPref(this.currentBoard);
    this.registry.set('gameFinished', true);

    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (this.registry.get('gameFinished')) return;
        this.registry.set('gameElapsedMs', Date.now() - this.registry.get('gameStartMs'));
      },
    });

    document.getElementById('btn-stats-close').addEventListener('click', () => this.registry.set('modal', null));
    document.getElementById('btn-stats-new').addEventListener('click', () => {
      this.registry.set('modal', { type: 'newgame', canClose: true });
    });
    newgameCloseBtn.addEventListener('click', () => this.registry.set('modal', null));
    for (const btn of newgameBoardButtons) {
      btn.addEventListener('click', () => {
        this.currentBoard = btn.dataset.board;
        saveBoardPref(this.currentBoard);
        this.renderModal(this.registry.get('modal'));
      });
    }
    for (const btn of newgameLevelButtons) {
      btn.addEventListener('click', () => {
        this.currentLevel = btn.dataset.level;
        saveDifficultyPref(this.currentLevel);
        this.renderModal(this.registry.get('modal'));
      });
    }
    newgameStartBtn.addEventListener('click', () => {
      this.registry.set('modal', null);
      this.startGame(this.currentLevel, this.currentBoard);
    });
    deadlockShuffleBtn.addEventListener('click', () => this.shuffleGame());
    deadlockReplayBtn.addEventListener('click', () => this.replayGame());
    deadlockGiveupBtn.addEventListener('click', () => this.finishGame(false));
    dailyPlayBtn.addEventListener('click', () => this.playDaily());
    dailyCloseBtn.addEventListener('click', () => this.registry.set('modal', null));

    this.input.on('gameobjectdown', (_pointer, obj) => {
      if (this.registry.get('modal')) return;
      const tile = obj.getData('tile');
      if (tile) this.handleTileClick(tile);
    });
    this.input.on('gameobjectover', (_pointer, obj) => {
      const tile = obj.getData('tile');
      if (tile) this.handleTileOver(tile);
    });
    this.input.on('gameobjectout', (_pointer, obj) => {
      const tile = obj.getData('tile');
      if (tile) this.handleTileOut(tile);
    });

    // React to window resizes: relay out the board and UI + re-rasterize
    // tiles for the new size. Debounced — so we don't rasterize 42 SVGs on
    // every resize event tick while the window is being dragged.
    this._resizeTimer = null;
    this._onWinResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this.handleResize(), 120);
    };
    window.addEventListener('resize', this._onWinResize);
    this.events.once('shutdown', () => window.removeEventListener('resize', this._onWinResize));

    this.loadBackground();
    if (!(await this.tryResumeGame())) {
      this.registry.set('modal', { type: 'newgame', canClose: false });
    }
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
  // tile size (fit into the available area between the toolbar and the
  // status bar, with margins), the origin point for centering. Stored in this.LM.
  computeLayout() {
    const viewW = this.scale.gameSize.width;
    const viewH = this.scale.gameSize.height;
    const margin = this.d(MARGIN);
    const toolbarH = this.d(TOOLBAR_H);
    const statusH = this.d(STATUS_BAR_H);

    const availW = Math.max(1, viewW - 2 * margin);
    const availH = Math.max(1, viewH - toolbarH - statusH - 2 * margin);

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
    const originY = toolbarH + (viewH - toolbarH - statusH - contentH) / 2;

    this.LM = {
      viewW, viewH, margin, toolbarH, statusH,
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

  flightTarget() {
    // The "Remaining: N" counter — on the left of the status bar.
    return { x: this.LM.margin + this.d(50), y: this.LM.viewH - this.LM.statusH / 2 };
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

  // --- UI: status bar and toolbar --------------------------------------

  createStatusBar() {
    const { viewW, viewH, statusH, margin } = this.LM;
    const y = viewH - statusH / 2;
    this.statusPlate = this.add.rectangle(viewW / 2, y, viewW, statusH, STATUS_BAR_BG, STATUS_BAR_BG_ALPHA)
      .setDepth(STATUS_BAR_PLATE_DEPTH);
    this.statusText = this.add.text(margin, y, '', this.textStyle(22, '#ffffff'))
      .setOrigin(0, 0.5).setDepth(STATUS_BAR_DEPTH);
    this.difficultyText = this.add.text(viewW / 2, y, '', this.textStyle(16, '#dfeaff'))
      .setOrigin(0.5, 0.5).setDepth(STATUS_BAR_DEPTH);
    this.summaryText = this.add.text(viewW - margin, y, '', this.textStyle(16, '#dfeaff'))
      .setOrigin(1, 0.5).setDepth(STATUS_BAR_DEPTH);
  }

  createToolbar() {
    const { viewW, toolbarH } = this.LM;
    const y = toolbarH / 2;
    this.toolbarPlate = this.add.rectangle(viewW / 2, y, viewW, toolbarH, STATUS_BAR_BG, STATUS_BAR_BG_ALPHA)
      .setDepth(TOOLBAR_PLATE_DEPTH);

    const specs = [
      { key: 'new', text: `🆕 ${gettext('New game')}`, onClick: () => this.registry.set('modal', { type: 'newgame', canClose: true }) },
      { key: 'hint', text: HINT_LABEL, onClick: () => this.hint() },
      { key: 'undo', text: UNDO_LABEL, onClick: () => this.undo() },
      {
        key: 'stats',
        text: `📊 ${gettext('Statistics')}`,
        onClick: () => {
          const open = this.registry.get('modal')?.type === 'stats';
          this.registry.set('modal', open ? null : { type: 'stats' });
        },
      },
      {
        key: 'daily',
        text: `🏆 ${gettext('Daily')}`,
        onClick: () => {
          const open = this.registry.get('modal')?.type === 'daily';
          this.registry.set('modal', open ? null : { type: 'daily' });
        },
      },
      {
        // Toggles straight to the other language — no picker needed for
        // just two options. The button label shows the CURRENT language;
        // reloading after the switch flips it to the new current one.
        key: 'lang',
        text: `🌐 ${LANG_BTN_LABEL[window.MAHJONG_LANG] || window.MAHJONG_LANG}`,
        onClick: () => setLanguage(window.MAHJONG_LANG === 'uk' ? 'en' : 'uk').finally(() => location.reload()),
      },
    ];
    this.toolbarTexts = {};
    this.toolbarButtons = [];

    for (const { key, text, onClick } of specs) {
      const bg = this.add.image(0, 0, 'toolbarBtnBg').setTint(TOOLBAR_BTN_BG);
      const label = this.add.text(0, 0, text, this.textStyle(17, '#ffffff')).setOrigin(0.5, 0.5);
      this.toolbarTexts[key] = label;
      const container = this.add.container(0, y, [bg, label]).setDepth(TOOLBAR_DEPTH);
      container._bg = bg;
      container._baseY = y;

      container.on('pointerover', () => {
        bg.setTint(TOOLBAR_BTN_HOVER);
        container._hoverTween?.stop();
        container._hoverTween = this.tweens.add({
          targets: container, scale: HOVER_SCALE, duration: HOVER_MS, ease: 'Sine.easeOut',
        });
      });
      container.on('pointerout', () => {
        bg.setTint(TOOLBAR_BTN_BG);
        container._hoverTween?.stop();
        container._hoverTween = this.tweens.add({
          targets: container, scale: 1, y: container._baseY, duration: HOVER_MS, ease: 'Sine.easeOut',
        });
      });
      container.on('pointerdown', () => {
        if (this.registry.get('modal')) return;
        container._hoverTween?.stop();
        this.tweens.add({
          targets: container,
          scale: PRESS_SCALE,
          y: container._baseY + this.d(PRESS_DROP),
          duration: PRESS_MS,
          ease: 'Back.easeOut',
          yoyo: true,
        });
        onClick();
      });
      this.toolbarButtons.push(container);
    }
    this.layoutToolbarButtons();
  }

  // Positions the toolbar buttons for the current window width: equal
  // widths, fitted into viewW with gaps; the background is scaled to the
  // computed width.
  layoutToolbarButtons() {
    const { viewW, toolbarH } = this.LM;
    const y = toolbarH / 2;
    const gap = this.d(TOOLBAR_BTN_GAP);
    const n = this.toolbarButtons.length;
    const btnW = (viewW - gap * (n + 1)) / n;
    const btnH = this.d(TOOLBAR_BTN_H);
    this.toolbarButtons.forEach((container, i) => {
      const x = gap + btnW / 2 + i * (btnW + gap);
      container._baseY = y;
      container.setPosition(x, y);
      container._bg.setDisplaySize(btnW, btnH);
      container.setSize(btnW, btnH);
      // setInteractive() on an object that's ALREADY interactive silently
      // ignores the new hit area shape passed in — it only takes effect the
      // very first time. So on every later resize this rectangle must be
      // mutated in place, same fix as the tile hitboxes in relayoutTiles().
      //
      // The rect is (0, 0, btnW, btnH), NOT centered on the container: Phaser's
      // hit test (pointWithinHitArea) adds the object's displayOriginX/Y to the
      // local point before checking it against hitArea — and a Container with
      // origin 0.5 has displayOriginX/Y = (btnW/2, btnH/2). A rect centered at
      // (-btnW/2, -btnH/2) double-applies that offset, shifting the real
      // clickable region left/up by half a button (bleeding into the
      // neighbour) relative to what's actually drawn.
      if (!container.input) {
        container.setInteractive(
          new Phaser.Geom.Rectangle(0, 0, btnW, btnH),
          Phaser.Geom.Rectangle.Contains,
        );
      } else {
        container.input.hitArea.setTo(0, 0, btnW, btnH);
      }
      container.input.cursor = 'pointer';
    });
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
      this.setBgCredit(data.photographer, data.photographer_url);
    });
    this.load.once('loaderror', () => {});
    this.load.start();
  }

  setBgCredit(photographer, photographerUrl) {
    this.bgCredit?.destroy();
    this.bgCredit = null;
    if (!photographer) return;
    const { viewW, viewH, statusH } = this.LM;
    const text = this.add.text(
      viewW - this.d(BG_CREDIT_PADDING),
      viewH - statusH - this.d(BG_CREDIT_PADDING),
      interpolate(gettext('Photo: %(name)s · Pexels'), { name: photographer }, true),
      this.textStyle(12, '#ffffff'),
    )
      .setOrigin(1, 1)
      .setDepth(BG_CREDIT_DEPTH)
      .setAlpha(0.75)
      .setShadow(0, 1, '#000000', 2, true, true);
    if (photographerUrl) {
      text.setInteractive({ useHandCursor: true })
        .on('pointerdown', () => window.open(photographerUrl, '_blank', 'noopener'));
    }
    this.bgCredit = text;
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

  layoutUI() {
    const { viewW, viewH, toolbarH, statusH, margin } = this.LM;
    const sy = viewH - statusH / 2;
    this.statusPlate.setPosition(viewW / 2, sy).setSize(viewW, statusH);
    this.statusText.setPosition(margin, sy);
    this.difficultyText.setPosition(viewW / 2, sy);
    this.summaryText.setPosition(viewW - margin, sy);

    const ty = toolbarH / 2;
    this.toolbarPlate.setPosition(viewW / 2, ty).setSize(viewW, toolbarH);
    this.layoutToolbarButtons();

    if (this.bgImage) this.bgImage.setPosition(viewW / 2, viewH / 2).setDisplaySize(viewW, viewH);
    if (this.bgVeil) this.bgVeil.setPosition(viewW / 2, viewH / 2).setSize(viewW, viewH);
    if (this.bgData) this.setBgCredit(this.bgData.photographer, this.bgData.photographer_url);
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
    this.playDealIn();

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

  // --- Modals / stats (Publisher/Subscriber via registry) -------

  renderModal(modal) {
    const showStats = modal?.type === 'stats' || modal?.type === 'result';
    statsModal.classList.toggle('open', showStats);
    newgameModal.classList.toggle('open', modal?.type === 'newgame');
    deadlockModal.classList.toggle('open', modal?.type === 'deadlock');
    dailyModal.classList.toggle('open', modal?.type === 'daily');

    if (showStats) {
      let title = `📊 ${gettext('Statistics')}`;
      if (modal.type === 'result') {
        if (modal.error) {
          title = `⚠️ ${gettext('The game was not confirmed by the server')}`;
        } else if (modal.won) {
          // A daily win never reaches here — finishGame() routes it to the
          // {type:'daily'} modal instead (see there for why).
          title = `🎉 ${gettext('Victory!')}`;
        } else {
          title = `🚫 ${gettext('Dead end — no moves left')}`;
        }
      }
      statsTitleEl.textContent = title;
      // Not just relying on the changedata-allStats listener: currentLevel
      // (which controls the "current" highlight) can change without a fresh
      // allStats push, so refresh the content on every open too.
      this.renderStatsModal();
    }
    if (modal?.type === 'newgame') {
      for (const btn of newgameLevelButtons) {
        btn.classList.toggle('selected', btn.dataset.level === this.currentLevel);
      }
      for (const btn of newgameBoardButtons) {
        btn.classList.toggle('selected', btn.dataset.board === this.currentBoard);
      }
      newgameCloseBtn.style.display = modal.canClose ? '' : 'none';
    }
    if (modal?.type === 'daily') this.renderDailyModal();
  }

  // Fills the daily-tournament modal: today's board/level, the caller's own
  // status/rank, and the leaderboard (gameplay/api.py: daily_info). Fetched
  // fresh on every open — the standings change as other players finish.
  async renderDailyModal() {
    dailyInfoEl.textContent = gettext('Loading…');
    dailyBoardEl.innerHTML = '';
    dailyPlayBtn.disabled = true;
    dailyPlayBtn.style.display = '';

    let info;
    try {
      info = await fetchDaily();
    } catch {
      dailyInfoEl.textContent = `⚠️ ${gettext('Failed to load the daily tournament')}`;
      dailyPlayBtn.disabled = false;
      dailyPlayBtn.textContent = `🔄 ${gettext('Retry')}`;
      return;
    }
    this.dailyInfo = info;
    dailyPlayBtn.disabled = false;

    // Once today's attempt is claimed there's nothing left to do here — the
    // result (score/rank) and the leaderboard below already show it inline,
    // so a "view result" action would just close the modal again, which
    // read as a dead button. Only 'new'/'active' get a Play/Resume action.
    const finished = info.yourStatus === 'won' || info.yourStatus === 'lost';
    dailyPlayBtn.style.display = finished ? 'none' : '';
    const playLabels = {
      new: `▶️ ${gettext('Play')}`,
      active: `▶️ ${gettext('Resume')}`,
    };
    dailyPlayBtn.textContent = playLabels[info.yourStatus] || playLabels.new;

    // The daily tournament is always a single difficulty (gameplay/daily.py:
    // DAILY_LEVEL) — nothing to disambiguate, so unlike the regular-game
    // status bar, level is deliberately not shown here.
    const lines = [
      info.boardName,
      interpolate(gettext('Participants: %(n)s'), { n: info.totalParticipants }, true),
    ];
    if (info.yourStatus === 'won' && info.yourScoreMs != null) {
      lines.push(interpolate(
        gettext('Your score: %(time)s (rank #%(rank)s)'),
        { time: fmtTime(info.yourScoreMs), rank: info.yourRank }, true,
      ));
    } else if (info.yourStatus === 'lost') {
      lines.push(gettext("Today's attempt is over"));
    }
    dailyInfoEl.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');

    dailyBoardEl.innerHTML = info.leaderboard.length
      ? info.leaderboard.map((entry) => `
        <li class="${entry.rank === info.yourRank ? 'you' : ''}">
          <span class="rank">#${entry.rank}</span>
          <span class="nickname">${entry.nickname}</span>
          <span class="time">${fmtTime(entry.scoreMs)}</span>
        </li>
      `).join('')
      : `<li class="empty">${gettext('No winners yet today')}</li>`;
  }

  lifetimeStats() {
    return this.registry.get('allStats')[this.currentLevel];
  }

  renderStats() {
    this.statusText.setText(this.registry.get('status') || '');

    const hints = this.registry.get('gameHints') || 0;
    const undos = this.registry.get('gameUndos') || 0;
    this.toolbarTexts.hint.setText(hints > 0
      ? `💡 ${interpolate(HINT_TEMPLATE, { n: hints }, true)}`
      : HINT_LABEL);
    this.toolbarTexts.undo.setText(undos > 0
      ? `↩️ ${interpolate(UNDO_TEMPLATE, { n: undos }, true)}`
      : UNDO_LABEL);
    this.difficultyText.setText(LEVEL_LABELS[this.currentLevel]);

    const stats = this.lifetimeStats();
    const elapsed = this.registry.get('gameElapsedMs') || 0;
    this.summaryText.setText(`🏆 ${stats.gamesWon}/${stats.gamesPlayed} · 🔥 ${stats.currentStreak} · ⏱️ ${fmtTime(elapsed)}`);
  }

  // The stats-modal HTML (3 levels × 9 rows) — split out from renderStats()
  // since it's far more expensive to rebuild (innerHTML) and doesn't need to
  // run on every registry tick, only when allStats changes or the modal
  // opens (see the changedata-allStats listener and renderModal() below).
  renderStatsModal() {
    const allStats = this.registry.get('allStats');
    statsLevelsEl.innerHTML = LEVELS.map((level) => {
      const s = allStats[level];
      const current = level === this.currentLevel ? ' current' : '';
      const currentTag = current ? ` <span class="current-tag">← ${gettext('current')}</span>` : '';
      return `
        <div class="level-block${current}">
          <h3>${LEVEL_LABELS[level]}${currentTag}</h3>
          <dl>
            <dt>${STATS_ROW_LABELS.started}</dt><dd>${s.gamesStarted}</dd>
            <dt>${STATS_ROW_LABELS.played}</dt><dd>${s.gamesPlayed}</dd>
            <dt>${STATS_ROW_LABELS.wins}</dt><dd>${s.gamesWon}</dd>
            <dt>${STATS_ROW_LABELS.winRate}</dt><dd>${winRate(s)}%</dd>
            <dt>${STATS_ROW_LABELS.currentStreak}</dt><dd>${s.currentStreak}</dd>
            <dt>${STATS_ROW_LABELS.bestStreak}</dt><dd>${s.bestStreak}</dd>
            <dt>${STATS_ROW_LABELS.bestTime}</dt><dd>${s.bestTimeMs == null ? '—' : fmtTime(s.bestTimeMs)}</dd>
            <dt>${STATS_ROW_LABELS.totalHints}</dt><dd>${s.hintsTotal}</dd>
            <dt>${STATS_ROW_LABELS.totalUndos}</dt><dd>${s.undosTotal}</dd>
            <dt>${STATS_ROW_LABELS.totalPairs}</dt><dd>${s.pairsTotal}</dd>
            <dt>${STATS_ROW_LABELS.totalShuffles}</dt><dd>${s.shufflesTotal}</dd>
          </dl>
        </div>
      `;
    }).join('');
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
  // hands out a different board. If the attempt is already claimed (won/
  // lost, possibly on another device), there's no board to start — just
  // refresh the modal to show the result instead.
  async playDaily() {
    // Already resumed into this tab (e.g. tryResumeGame() on page load) —
    // just return to it, don't re-fetch/restart via the server (that would
    // reset the local move log to empty, discarding real progress).
    if (this.isDaily && this.sessionToken && !this.registry.get('gameFinished')) {
      this.registry.set('modal', null);
      return;
    }
    if (this.dailyInfo && (this.dailyInfo.yourStatus === 'won' || this.dailyInfo.yourStatus === 'lost')) {
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
      this.renderDailyModal(); // claimed/forfeited between fetch and click
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

    this.renderStats();
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
      this.removeGlow(this.selected);
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
    this.playEndEffect(result.won, () => {
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

  // The dead-end alternative to shuffling/giving up (main.js: updateStatus()
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

  // The dead-end alternative to giving up (main.js: updateStatus() opens the
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
    // playShuffleFlip only re-textures the sprite, on its own delayed/tweened
    // schedule, so a slow flip animation can never leave board state (isWon/
    // isDeadlocked) looking at stale kinds.
    const tilesByIdx = new Map(this.board.tiles().map((tile) => [tile.idx, tile]));
    Object.entries(result.kinds).forEach(([idxStr, kind], i) => {
      const tile = tilesByIdx.get(Number(idxStr));
      if (!tile) return;
      tile.kind = kind;
      this.playShuffleFlip(tile, kind, i * SHUFFLE_TILE_STAGGER);
    });
    this.shuffles.push({ afterMoves: this.movesLog.length, kinds: result.kinds });
    this.registry.set('allStats', result.stats);
    this.persistGame();
    this.registry.set('modal', null);
    this.updateStatus();
  }

  // A card-style flip in place: collapse to scaleX 0, swap the texture at
  // the midpoint (every kind's CanvasTexture is rasterized to the exact same
  // pixel size — rasterizeTiles — so swapping mid-flip needs no
  // setDisplaySize call), then expand back. `delay` staggers multiple tiles
  // (main.js: shuffleGame) into a cascading reveal instead of all flipping
  // in lockstep.
  playShuffleFlip(tile, kind, delay = 0) {
    const sprite = this.sprites.get(tile);
    if (!sprite) return;
    if (this.reducedMotion) {
      sprite.setTexture(kind);
      return;
    }
    const baseScaleX = sprite.scaleX;
    this.tweens.add({
      targets: sprite,
      scaleX: 0,
      duration: SHUFFLE_FLIP_MS / 2,
      delay,
      ease: 'Quad.easeIn',
      onComplete: () => {
        sprite.setTexture(kind);
        this.tweens.add({
          targets: sprite,
          scaleX: baseScaleX,
          duration: SHUFFLE_FLIP_MS / 2,
          ease: 'Quad.easeOut',
        });
      },
    });
  }

  playEndEffect(won, done) {
    if (this.reducedMotion) {
      this.time.delayedCall(150, done);
      return;
    }
    const { viewW, margin } = this.LM;
    const center = this.flightCenter();
    if (won) {
      const shots = 5;
      for (let i = 0; i < shots; i += 1) {
        this.time.delayedCall((END_EFFECT_MS / shots) * i, () => {
          const x = Phaser.Math.Between(margin, viewW - margin);
          const y = Phaser.Math.Between(this.LM.toolbarH + margin, center.y);
          this.spawnBurst(x, y, {
            count: 26, speed: this.d(260), lifespan: 700, gravityY: this.d(220), scale: 0.9 * this.dpr,
          });
        });
      }
    } else {
      for (const sprite of this.sprites.values()) {
        const delay = Phaser.Math.Between(0, 400);
        this.tweens.add({
          targets: sprite,
          y: sprite.y + this.d(CRUMBLE_FALL),
          angle: Phaser.Math.Between(-70, 70),
          alpha: 0,
          delay,
          duration: 500,
          ease: 'Quad.easeIn',
        });
      }
    }
    this.time.delayedCall(END_EFFECT_MS, done);
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
    this.resetTileTint(tile);
  }

  playDealIn() {
    if (this.reducedMotion) return;
    const center = this.flightCenter();
    const order = [...this.sprites.entries()]
      .map(([tile, sprite]) => ({
        tile,
        sprite,
        dist: Phaser.Math.Distance.Between(sprite.x, sprite.y, center.x, center.y),
      }))
      .sort((a, b) => (a.tile.z - b.tile.z) || (a.dist - b.dist));

    this.dealing = true;
    let maxEnd = 0;
    let layerIndex = -1;
    let prevZ = null;

    for (const { tile, sprite } of order) {
      if (tile.z !== prevZ) {
        prevZ = tile.z;
        layerIndex = 0;
      } else {
        layerIndex += 1;
      }

      const finalX = sprite.x;
      const finalY = sprite.y;
      const { x: startX, y: startY } = this.dealStartPos();

      sprite.x = startX;
      sprite.y = startY;
      sprite.setScale(sprite.scaleX * DEAL_START_SCALE);
      sprite._baseScale = undefined;
      sprite.alpha = 0;
      sprite._flying = true;

      const delay = tile.z * DEAL_LAYER_STAGGER + layerIndex * DEAL_TILE_STAGGER;
      maxEnd = Math.max(maxEnd, delay + DEAL_TILE_MS);

      this.tweens.add({
        targets: sprite,
        x: finalX,
        y: finalY,
        scaleX: sprite.scaleX / DEAL_START_SCALE,
        scaleY: sprite.scaleY / DEAL_START_SCALE,
        alpha: 1,
        delay,
        duration: DEAL_TILE_MS,
        ease: 'Back.easeOut',
        onComplete: () => { sprite._flying = false; },
      });
    }

    this.time.delayedCall(maxEnd, () => { this.dealing = false; });
  }

  dealStartPos() {
    const pad = this.d(DEAL_OFFSCREEN_PAD);
    const { viewW, viewH } = this.LM;
    switch (Phaser.Math.Between(0, 3)) {
      case 0: return { x: -pad, y: Phaser.Math.Between(0, viewH) };
      case 1: return { x: viewW + pad, y: Phaser.Math.Between(0, viewH) };
      case 2: return { x: Phaser.Math.Between(0, viewW), y: -pad };
      default: return { x: Phaser.Math.Between(0, viewW), y: viewH + pad };
    }
  }

  setTileTint(tile, color) {
    this.sprites.get(tile)?.setTint(color);
  }

  resetTileTint(tile) {
    if (this.sprites.has(tile)) this.setTileTint(tile, LAYER_TINTS[tile.z]);
  }

  applyGlow(tile, color = GLOW_COLOR, strength = GLOW_STRENGTH) {
    const sprite = this.sprites.get(tile);
    if (!sprite) return;
    if (!this.webgl) {
      this.setTileTint(tile, color);
    } else {
      const fx = sprite.postFX.addGlow(color, 0, 0, false, 0.15, 12);
      sprite._glow = fx;
      sprite._glowTween = this.tweens.add({
        targets: fx,
        outerStrength: strength + GLOW_PULSE_DELTA,
        duration: 450,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    sprite._tiltTween = this.tweens.add({
      targets: sprite,
      angle: SELECT_TILT_DEG,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  removeGlow(tile) {
    const sprite = this.sprites.get(tile);
    if (!sprite) return;
    if (sprite._glowTween) { sprite._glowTween.stop(); sprite._glowTween = null; }
    if (sprite._glow) { sprite.postFX.remove(sprite._glow); sprite._glow = null; }
    if (sprite._tiltTween) { sprite._tiltTween.stop(); sprite._tiltTween = null; }
    sprite.angle = 0;
    this.resetTileTint(tile);
  }

  clearHover(sprite) {
    if (!sprite) return;
    sprite._hoverWobble?.stop();
    sprite._hoverWobble = null;
    sprite._hoverScaleTween?.stop();
    sprite._hoverScaleTween = null;
    sprite.setDisplaySize(this.LM.tileW, this.LM.tileH);
    sprite.angle = 0;
  }

  handleTileOver(tile) {
    if (this.reducedMotion) return;
    const sprite = this.sprites.get(tile);
    if (!sprite || tile === this.selected || sprite._flying) return;
    const base = sprite.scaleX;
    sprite._hoverScaleTween?.stop();
    sprite._hoverScaleTween = this.tweens.add({
      targets: sprite, scaleX: base * HOVER_SCALE, scaleY: base * HOVER_SCALE, duration: HOVER_MS, ease: 'Sine.easeOut',
    });
    sprite._hoverWobble?.stop();
    sprite._hoverWobble = this.tweens.add({
      targets: sprite,
      angle: { from: -HOVER_WOBBLE_DEG, to: HOVER_WOBBLE_DEG },
      duration: HOVER_WOBBLE_MS,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  handleTileOut(tile) {
    if (this.reducedMotion) return;
    const sprite = this.sprites.get(tile);
    if (!sprite || tile === this.selected || sprite._flying) return;
    sprite._hoverWobble?.stop();
    sprite._hoverWobble = null;
    sprite._hoverScaleTween?.stop();
    sprite._hoverScaleTween = this.tweens.add({
      targets: sprite, angle: 0, duration: HOVER_MS, ease: 'Sine.easeOut',
    });
    sprite.setDisplaySize(this.LM.tileW, this.LM.tileH);
  }

  restoreTint(tile) {
    if (!this.sprites.has(tile)) return;
    if (tile === this.selected && !this.webgl) this.setTileTint(tile, GLOW_COLOR);
    else this.resetTileTint(tile);
  }

  playPress(tile) {
    if (this.reducedMotion) return;
    const sprite = this.sprites.get(tile);
    if (!sprite) return;
    const base = sprite.scaleX;
    this.tweens.add({
      targets: sprite,
      y: `+=${this.d(PRESS_DROP)}`,
      scaleX: base * PRESS_SCALE,
      scaleY: base * PRESS_SCALE,
      duration: PRESS_MS,
      ease: 'Back.easeOut',
      yoyo: true,
    });
    this.setTileTint(tile, PRESS_TINT);
    this.time.delayedCall(PRESS_MS * 2, () => this.restoreTint(tile));
  }

  playError(tile) {
    const sprite = this.sprites.get(tile);
    if (!sprite) return;
    this.setTileTint(tile, ERROR_TINT);
    this.time.delayedCall(ERROR_TINT_MS, () => this.restoreTint(tile));
    if (this.reducedMotion || sprite._errorTween) return;
    const baseX = sprite.x;
    const shake = this.d(ERROR_SHAKE_PX);
    sprite._errorTween = this.tweens.add({
      targets: sprite,
      x: { from: baseX - shake, to: baseX + shake },
      duration: ERROR_SHAKE_MS,
      yoyo: true,
      repeat: ERROR_SHAKE_REPEAT,
      onComplete: () => {
        sprite.x = baseX;
        sprite._errorTween = null;
      },
    });
  }

  handleTileClick(tile) {
    if (this.dealing) return;
    if (!this.board.isFree(tile)) {
      this.playError(tile);
      return;
    }
    this.playPress(tile);
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
    this.clearHover(this.sprites.get(tile));
    this.applyGlow(tile, GLOW_COLOR);
  }

  spawnBurst(px, py, {
    count = POOF_COUNT, speed = this.d(160), lifespan = 400, gravityY = 0, scale = 0.6 * this.dpr,
  } = {}) {
    const emitter = this.add.particles(px, py, 'spark', {
      speed: { min: speed * 0.4, max: speed },
      angle: { min: 0, max: 360 },
      lifespan,
      gravityY,
      scale: { start: scale, end: 0 },
      tint: SPARK_COLORS,
      quantity: count,
    });
    emitter.explode(count);
    this.time.delayedCall(lifespan + 50, () => emitter.destroy());
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
      this.clearHover(sprite);
      this.sprites.delete(tile);
      if (this.reducedMotion) {
        sprite.destroy();
        continue;
      }
      sprite.setDepth(FALLING_DEPTH);
      sprite._flying = true;
      pending += 1;
      this.flyToCenterThenDown(sprite, onTileGone);
    }
    if (pending === 0) this.updateStatus();
  }

  flyToCenterThenDown(sprite, onDone) {
    const center = this.flightCenter();
    const base = sprite.scaleX;
    this.tweens.add({
      targets: sprite,
      x: center.x,
      y: center.y,
      scaleX: base * FLIGHT_MERGE_SCALE,
      scaleY: base * FLIGHT_MERGE_SCALE,
      duration: FLIGHT_TO_CENTER_MS,
      ease: 'Back.easeOut',
      onComplete: () => this.flyDownFromCenter(sprite, onDone),
    });
  }

  flyDownFromCenter(sprite, onDone) {
    const target = this.flightTarget();
    const start = new Phaser.Math.Vector2(sprite.x, sprite.y);
    const end = new Phaser.Math.Vector2(target.x, target.y);
    const control = new Phaser.Math.Vector2(
      (start.x + end.x) / 2 + this.d(FLIGHT_ARC_LIFT),
      (start.y + end.y) / 2,
    );
    const curve = new Phaser.Curves.QuadraticBezier(start, control, end);
    const point = new Phaser.Math.Vector2();
    const startScaleX = sprite.scaleX;
    const startScaleY = sprite.scaleY;
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: FLIGHT_DOWN_MS,
      ease: 'Sine.easeIn',
      onUpdate: (tween) => {
        const t = tween.getValue();
        curve.getPoint(t, point);
        sprite.x = point.x;
        sprite.y = point.y;
        sprite.scaleX = startScaleX * (1 - t);
        sprite.scaleY = startScaleY * (1 - t);
        sprite.alpha = 1 - t;
      },
      onComplete: () => {
        this.spawnBurst(target.x, target.y, {
          count: POOF_COUNT, speed: this.d(180), lifespan: 400, scale: 0.5 * this.dpr,
        });
        sprite.destroy();
        onDone();
      },
    });
  }

  undo() {
    if (!this.board) return;
    const pair = this.board.undo();
    if (!pair) return;
    this.movesLog.pop();
    this.deselect();
    for (const tile of pair) this.animateUndoTile(tile);
    this.bumpCounter('gameUndos', 'undo');
    this.updateStatus();
  }

  animateUndoTile(tile) {
    this.addTileSprite(tile);
    if (this.reducedMotion) return;
    const sprite = this.sprites.get(tile);
    const finalY = sprite.y;
    const finalDepth = sprite.depth;
    sprite.setDepth(FALLING_DEPTH);
    sprite.y = finalY - this.d(UNDO_DROP);
    sprite.alpha = 0;
    this.tweens.add({
      targets: sprite, alpha: 1, duration: 150, ease: 'Quad.easeOut',
    });
    this.tweens.add({
      targets: sprite,
      y: finalY,
      duration: 400,
      ease: 'Bounce.easeOut',
      onComplete: () => {
        sprite.setDepth(finalDepth);
        this.spawnBurst(sprite.x, finalY, {
          count: 6, speed: this.d(80), lifespan: 200, scale: 0.35 * this.dpr,
        });
      },
    });
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
        const fx = sprite.postFX.addGlow(HINT_GLOW_COLOR, GLOW_STRENGTH, 0, false, 0.15, 12);
        this.time.delayedCall(pulseMs, () => sprite.postFX?.remove(fx));
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

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#1d2b1f',
  scale: {
    // Native resolution: the canvas is managed manually (resizeCanvas) — the
    // backing store is in device-px, CSS size = the container. World
    // coordinates = device-px, so tile textures rasterize 1:1 at the actual
    // size and stay sharp on any screen/window (re-rasterized on resize).
    mode: Phaser.Scale.NONE,
    width: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
    height: Math.round(window.innerHeight * (window.devicePixelRatio || 1)),
  },
  scene: MainScene,
});

window.mahjongGame = game;
