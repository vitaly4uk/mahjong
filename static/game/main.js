import { WIDTH, HEIGHT, LAYERS, Board } from './board.js';
import { generateForDifficulty, KINDS } from './generator.js';
import {
  load as loadStats, save as saveStats, applyWin, applyLoss, winRate, fmtTime, LEVELS,
} from './stats.js';

const TILE_W = 70; // крок сітки
const TILE_H = 90;
const DEPTH_X = 6; // товщина боковинок (справжній 3D-корпус, не зсунута копія)
const DEPTH_Y = 8; // кістка — плоска плитка, тож товщина скромна
const CORNER_R = 3; // радіус заокруглення кутів корпусу — узгоджений з Front.png
// GAP — гарантований проміжок саме між ЛИЦЯМИ сусідніх кісток (тому FACE_W
// рахується від TILE_W напряму, без DEPTH_X). Боковина (корпус) ширша за
// лице на DEPTH_X і тому природно "заходить" на боковину сусідки на
// (DEPTH_X − GAP) px — це і дає бажаний ефект: боковини перекриваються,
// а лиця — ніколи не торкаються.
const GAP = 3;
const FACE_W = TILE_W - GAP;
const FACE_H = TILE_H - GAP;
const LAYER_DX = 8; // зсув шару вгору-вправо для псевдо-3D
const LAYER_DY = 10;
const MARGIN = 30;
const GAME_W = WIDTH * TILE_W + 2 * MARGIN + LAYERS * LAYER_DX;
const GAME_H = HEIGHT * TILE_H + 2 * MARGIN + LAYERS * LAYER_DY;
const SELECT_TINT = 0x77bbff;
// Затемнення нижніх шарів, щоб шари читалися окремо
const LAYER_TINTS = [0xb0b0b0, 0xd8d8d8, 0xffffff];
const SIDE_COLOR = 0xd9b878; // кремова ліва стінка
const SIDE_SHADOW = 0xa9814a; // темніша нижня стінка (у тіні) — вищий контраст
const SIDE_EDGE_COLOR = 0x7a5c33; // темніший край для чіткішого силуету

const DIFFICULTY_KEY = 'mahjong.difficulty';
const DEFAULT_DIFFICULTY = 'normal';
const LEVEL_LABELS = { easy: '😌 Легко', normal: '🙂 Нормально', hard: '😈 Складно' };

// Без явно збереженого вибору — якщо є щойно мігровані дані з v1 (вони завжди
// лягають у hard, див. stats.js), відкриваємо гру саме на hard, інакше
// новачок побачить порожню статистику на normal і подумає, що вона згубилась.
function loadDifficultyPref(allStats) {
  try {
    const stored = globalThis.localStorage?.getItem(DIFFICULTY_KEY);
    if (LEVELS.includes(stored)) return stored;
    return allStats.hard.gamesPlayed > 0 ? 'hard' : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

function saveDifficultyPref(level) {
  try {
    globalThis.localStorage?.setItem(DIFFICULTY_KEY, level);
  } catch {
    // ignore (приватний режим, квота, тощо)
  }
}

const tileUrl = (name) => `/static/game/tiles/${name}.png`;
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('stats-summary');
const difficultyLabelEl = document.getElementById('difficulty-label');
const hintBtn = document.getElementById('btn-hint');
const undoBtn = document.getElementById('btn-undo');
const statsModal = document.getElementById('stats-modal');
const statsTitleEl = document.getElementById('stats-title');
const statsLevelsEl = document.getElementById('stats-levels');
const newgameModal = document.getElementById('newgame-modal');
const newgameLevelButtons = [...newgameModal.querySelectorAll('[data-level]')];
const newgameCloseBtn = document.getElementById('btn-newgame-close');

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
  }

  preload() {
    this.load.image('Front', tileUrl('Front'));
    for (const kind of KINDS) this.load.image(kind, tileUrl(kind));
  }

  create() {
    // Текстура корпусу кістки: справжній паралелепіпед — верхня грань (під
    // Front) + дві скошені бокові стінки, що йдуть униз-вліво (товщина
    // DEPTH_X/DEPTH_Y). Одна текстура на всі 136 кісток.
    const bodyW = FACE_W + DEPTH_X;
    const bodyH = FACE_H + DEPTH_Y;

    // Заокруглення кута без тригонометрії: дві точки-дотики (де пряме ребро
    // переходить у заокруглення) + коло того самого радіуса поверх — воно
    // рівно заповнює дугу між дотичними, не залежачи від напрямку обходу
    // (на відміну від ручної дуги, тут неможливо переплутати порядок точок).
    const TANGENTS = {
      TL: (x, y, w, h) => [{ x, y: y + CORNER_R }, { x: x + CORNER_R, y }],
      TR: (x, y, w, h) => [{ x: x + w - CORNER_R, y }, { x: x + w, y: y + CORNER_R }],
      BR: (x, y, w, h) => [{ x: x + w, y: y + h - CORNER_R }, { x: x + w - CORNER_R, y: y + h }],
      BL: (x, y, w, h) => [{ x: x + CORNER_R, y: y + h }, { x, y: y + h - CORNER_R }],
    };
    const CENTERS = {
      TL: (x, y) => [x + CORNER_R, y + CORNER_R],
      TR: (x, y, w) => [x + w - CORNER_R, y + CORNER_R],
      BR: (x, y, w, h) => [x + w - CORNER_R, y + h - CORNER_R],
      BL: (x, y, w, h) => [x + CORNER_R, y + h - CORNER_R],
    };
    const tangents = (x, y, w, h, which) => TANGENTS[which](x, y, w, h);
    const center = (x, y, w, h, which) => CENTERS[which](x, y, w, h);
    // Точки дуги того самого кола — лише для контуру зовнішніх кутів, щоб
    // темна лінія огинала ту саму дугу, яку домальовує коло-заповнювач
    // (інакше пряма фаска зрізає видиму випуклість, лишаючи характерний шов).
    const ARCS = {
      TL: [180, 270], TR: [270, 360], BR: [0, 90], BL: [90, 180],
    };
    const arcPoints = (x, y, w, h, which, segments = 3) => {
      const [cx, cy] = center(x, y, w, h, which);
      const [from, to] = ARCS[which];
      return Array.from({ length: segments + 1 }, (_, i) => {
        const rad = Phaser.Math.DegToRad(from + (to - from) * (i / segments));
        return { x: cx + CORNER_R * Math.cos(rad), y: cy + CORNER_R * Math.sin(rad) };
      });
    };

    // Кути верхньої грані (сюди ляже Front) і відповідні кути основи,
    // зсунуті на (-DEPTH_X, +DEPTH_Y) — та сама сторона, куди зсунуті шари.
    // Кожна пара точок задана в "природному" напрямку обходу зовнішнього
    // контуру за годинниковою стрілкою (faceTL→faceTR→faceBR→baseBR→baseBL→baseTL).
    const faceTL = tangents(DEPTH_X, 0, FACE_W, FACE_H, 'TL');
    const faceTR = tangents(DEPTH_X, 0, FACE_W, FACE_H, 'TR');
    const faceBR = tangents(DEPTH_X, 0, FACE_W, FACE_H, 'BR');
    const baseTL = tangents(0, DEPTH_Y, FACE_W, FACE_H, 'TL');
    const baseBR = tangents(0, DEPTH_Y, FACE_W, FACE_H, 'BR');
    const baseBL = tangents(0, DEPTH_Y, FACE_W, FACE_H, 'BL');
    // faceBL не входить у зовнішній контур (він захований під Front) — його
    // напрямок обирається так, щоб починатись на лівому ребрі лиця і
    // закінчуватись на нижньому, як того потребують обидві стінки нижче.
    const faceBL = [...tangents(DEPTH_X, 0, FACE_W, FACE_H, 'BL')].reverse();

    const g = this.make.graphics({}, false);
    g.fillStyle(SIDE_COLOR);
    // Ліва стінка йде вниз по лівому ребру лиця — тут faceTL потрібен у
    // зворотному напрямку (щоб закінчуватись на лівому ребрі, а не на
    // верхньому, як для зовнішнього контуру).
    g.fillPoints([...[...faceTL].reverse(), ...faceBL, ...baseBL, ...baseTL], true);
    g.fillStyle(SIDE_SHADOW);
    // Нижня стінка йде по нижньому ребру лиця — тут faceBR потрібен у
    // зворотному напрямку (щоб починатися на нижньому ребрі, а не на
    // правому, як для зовнішнього контуру).
    g.fillPoints([...faceBL, ...[...faceBR].reverse(), ...baseBR, ...baseBL], true);

    // Кола поверх фасок домальовують плавну дугу точно між дотичними точками.
    const round = (x, y, w, h, which, color) => {
      const [cx, cy] = center(x, y, w, h, which);
      g.fillStyle(color);
      g.fillCircle(cx, cy, CORNER_R);
    };
    round(DEPTH_X, 0, FACE_W, FACE_H, 'TL', SIDE_COLOR);
    round(DEPTH_X, 0, FACE_W, FACE_H, 'BL', SIDE_SHADOW);
    round(DEPTH_X, 0, FACE_W, FACE_H, 'BR', SIDE_SHADOW);
    round(0, DEPTH_Y, FACE_W, FACE_H, 'TL', SIDE_COLOR);
    round(0, DEPTH_Y, FACE_W, FACE_H, 'BL', SIDE_SHADOW);
    round(0, DEPTH_Y, FACE_W, FACE_H, 'BR', SIDE_SHADOW);

    g.lineStyle(2, SIDE_EDGE_COLOR);
    g.strokePoints([
      ...arcPoints(DEPTH_X, 0, FACE_W, FACE_H, 'TL'),
      ...arcPoints(DEPTH_X, 0, FACE_W, FACE_H, 'TR'),
      ...arcPoints(DEPTH_X, 0, FACE_W, FACE_H, 'BR'),
      ...arcPoints(0, DEPTH_Y, FACE_W, FACE_H, 'BR'),
      ...arcPoints(0, DEPTH_Y, FACE_W, FACE_H, 'BL'),
      ...arcPoints(0, DEPTH_Y, FACE_W, FACE_H, 'TL'),
    ], true, true);
    g.generateTexture('tileBody', bodyW, bodyH);
    g.destroy();

    this.sprites = new Map(); // tile -> Phaser container
    this.selected = null;

    const allStats = loadStats();
    this.registry.set('allStats', allStats);
    this.registry.events.on('changedata', () => this.renderStats());

    this.currentLevel = loadDifficultyPref(allStats);
    saveDifficultyPref(this.currentLevel);
    // Гри ще немає — таймерна петля нижче не повинна тікати, поки гравець
    // не обере рівень і не почне партію (startGame() зніме прапорець).
    this.registry.set('gameFinished', true);

    this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        if (this.registry.get('gameFinished')) return;
        this.registry.set('gameElapsedMs', Date.now() - this.registry.get('gameStartMs'));
      },
    });

    document.getElementById('btn-new').addEventListener('click', () => this.openNewGameModal());
    document.getElementById('btn-stats').addEventListener('click', () => this.toggleStatsModal());
    document.getElementById('btn-stats-close').addEventListener('click', () => this.closeAllModals());
    document.getElementById('btn-stats-new').addEventListener('click', () => this.openNewGameModal());
    newgameCloseBtn.addEventListener('click', () => this.closeAllModals());
    for (const btn of newgameLevelButtons) {
      btn.addEventListener('click', () => {
        const level = btn.dataset.level;
        saveDifficultyPref(level);
        this.closeAllModals();
        this.startGame(level);
      });
    }

    // Один сценовий обробник на всі плитки (замість замикання на кожну):
    // спрацьовує і для плиток, доданих пізніше (undo, нова гра).
    this.input.on('gameobjectdown', (pointer, obj) => this.handleTileClick(obj.getData('tile')));

    // Перший запуск сторінки: показуємо стартову модалку — гравець сам
    // обирає рівень і час; без кнопки закриття, бо грати ще нема в що.
    this.openNewGameModal(false);
  }

  startGame(level) {
    this.currentLevel = level;
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;
    statusEl.textContent = '⏳ Генерую розклад…';
    this.board = new Board(generateForDifficulty(level, Math.random));
    for (const tile of this.board.tiles()) this.addTileSprite(tile);

    this.registry.set('gameHints', 0);
    this.registry.set('gameUndos', 0);
    this.registry.set('gamePairs', 0);
    this.registry.set('gameStartMs', Date.now());
    this.registry.set('gameElapsedMs', 0);
    this.registry.set('gameFinished', false);
    this.closeAllModals();
    this.renderStats();

    this.updateStatus();
  }

  // Довічні показники поточного рівня — зріз з registry-allStats.
  lifetimeStats() {
    return this.registry.get('allStats')[this.currentLevel];
  }

  // Оновлює зріз статистики поточного рівня в registry-allStats (новий
  // об'єкт, щоб Phaser registry розпізнав зміну й розіслав 'changedata').
  updateLifetimeStats(updated) {
    const allStats = { ...this.registry.get('allStats'), [this.currentLevel]: updated };
    this.registry.set('allStats', allStats);
    saveStats(allStats);
  }

  // Інкремент лічильника поточної партії (registry) і парного довічного
  // тоталу (allStats) — спільний хвіст для removePair/undo/hint.
  bumpCounter(gameKey, totalKey) {
    this.registry.set(gameKey, this.registry.get(gameKey) + 1);
    const stats = this.lifetimeStats();
    this.updateLifetimeStats({ ...stats, [totalKey]: stats[totalKey] + 1 });
  }

  // Знімає виділення з поточної плитки, якщо вона є.
  deselect() {
    if (this.selected) {
      this.resetTileTint(this.selected);
      this.selected = null;
    }
  }

  // Модалки взаємовиключні — перш ніж відкрити одну, завжди закриваємо решту,
  // щоб ніколи не було двох відкритих одночасно (однаковий z-index, інакше
  // одна ховає іншу непомітно для гравця).
  closeAllModals() {
    statsModal.classList.remove('open');
    newgameModal.classList.remove('open');
  }

  openStatsModal(title) {
    this.closeAllModals();
    statsTitleEl.textContent = title || '📊 Статистика';
    statsModal.classList.add('open');
  }

  toggleStatsModal() {
    if (statsModal.classList.contains('open')) this.closeAllModals();
    else this.openStatsModal('📊 Статистика');
  }

  // canClose=false — для стартової модалки при першому завантаженні: гри ще
  // немає, тож ховаємо «✖ Закрити», щоб гравець не лишився без поля.
  openNewGameModal(canClose = true) {
    this.closeAllModals();
    for (const btn of newgameLevelButtons) {
      btn.classList.toggle('selected', btn.dataset.level === this.currentLevel);
    }
    newgameCloseBtn.style.display = canClose ? '' : 'none';
    newgameModal.classList.add('open');
  }

  renderStats() {
    const hints = this.registry.get('gameHints') || 0;
    const undos = this.registry.get('gameUndos') || 0;
    hintBtn.textContent = hints > 0 ? `💡 Підказка (${hints})` : '💡 Підказка';
    undoBtn.textContent = undos > 0 ? `↩️ Скасувати (${undos})` : '↩️ Скасувати';
    difficultyLabelEl.textContent = LEVEL_LABELS[this.currentLevel];

    const stats = this.lifetimeStats();
    const elapsed = this.registry.get('gameElapsedMs') || 0;
    summaryEl.textContent = `🏆 ${stats.gamesWon}/${stats.gamesPlayed} · 🔥 ${stats.currentStreak} · ⏱️ ${fmtTime(elapsed)}`;

    const allStats = this.registry.get('allStats');
    statsLevelsEl.innerHTML = LEVELS.map((level) => {
      const s = allStats[level];
      const current = level === this.currentLevel ? ' current' : '';
      return `
        <div class="level-block${current}">
          <h3>${LEVEL_LABELS[level]}</h3>
          <dl>
            <dt>📋 Зіграно партій</dt><dd>${s.gamesPlayed}</dd>
            <dt>🏆 Перемог</dt><dd>${s.gamesWon}</dd>
            <dt>📈 % перемог</dt><dd>${winRate(s)}%</dd>
            <dt>🔥 Поточна серія</dt><dd>${s.currentStreak}</dd>
            <dt>⭐ Рекордна серія</dt><dd>${s.bestStreak}</dd>
            <dt>⏱️ Найкращий час</dt><dd>${s.bestTimeMs == null ? '—' : fmtTime(s.bestTimeMs)}</dd>
            <dt>💡 Підказок усього</dt><dd>${s.hintsTotal}</dd>
            <dt>↩️ Скасувань усього</dt><dd>${s.undosTotal}</dd>
            <dt>🀄 Знято пар усього</dt><dd>${s.pairsTotal}</dd>
          </dl>
        </div>
      `;
    }).join('');
  }

  // Зараховує завершену партію (перемога чи глухий кут) рівно один раз.
  finishGame(won) {
    if (this.registry.get('gameFinished')) return;
    this.registry.set('gameFinished', true);
    const elapsed = Date.now() - this.registry.get('gameStartMs');
    this.registry.set('gameElapsedMs', elapsed);
    const updated = won
      ? applyWin(this.lifetimeStats(), elapsed)
      : applyLoss(this.lifetimeStats());
    this.updateLifetimeStats(updated);
    this.openStatsModal(won ? '🎉 Перемога!' : '🚫 Глухий кут — немає ходів');
  }

  addTileSprite(tile) {
    const px = MARGIN + tile.x * TILE_W + TILE_W / 2 + tile.z * LAYER_DX;
    const py = MARGIN + LAYERS * LAYER_DY
      + tile.y * TILE_H + TILE_H / 2 - tile.z * LAYER_DY;
    // Корпус (верхня грань + бокові стінки) центрований так, щоб його верхня
    // грань точно збіглася з Front — стінки при цьому природно стирчать
    // вниз-вліво, у бік зсуву шарів угору-вправо.
    const body = this.add.image(-DEPTH_X / 2, DEPTH_Y / 2, 'tileBody');
    const front = this.add.image(0, 0, 'Front').setDisplaySize(FACE_W, FACE_H);
    const face = this.add.image(0, -3, tile.kind)
      .setDisplaySize(FACE_W * 0.78, FACE_H * 0.78);
    const container = this.add.container(px, py, [body, front, face]);
    container.setSize(TILE_W, TILE_H);
    // Боковинка стирчить униз-вліво, тож ближчі до глядача тайли
    // (нижчі ряди, лівіші колонки, вищі шари) малюємо поверх
    container.setDepth(
      tile.z * 10000 + tile.y * 100 + (WIDTH - 1 - tile.x),
    );
    container.setInteractive();
    container.setData('tile', tile);
    this.sprites.set(tile, container);
    this.resetTileTint(tile);
  }

  setTileTint(tile, color) {
    Phaser.Actions.SetTint(this.sprites.get(tile).list, color);
  }

  resetTileTint(tile) {
    if (this.sprites.has(tile)) this.setTileTint(tile, LAYER_TINTS[tile.z]);
  }

  handleTileClick(tile) {
    if (!this.board.isFree(tile)) return;
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
    this.setTileTint(tile, SELECT_TINT);
  }

  removePair(a, b) {
    if (!this.board.removePair(a, b)) return;
    for (const tile of [a, b]) {
      this.sprites.get(tile).destroy();
      this.sprites.delete(tile);
    }
    this.selected = null;
    this.bumpCounter('gamePairs', 'pairsTotal');
    this.updateStatus();
  }

  undo() {
    const pair = this.board.undo();
    if (!pair) return;
    this.deselect();
    for (const tile of pair) this.addTileSprite(tile);
    this.bumpCounter('gameUndos', 'undosTotal');
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
    this.bumpCounter('gameHints', 'hintsTotal');
  }

  updateStatus() {
    if (this.board.isWon()) {
      statusEl.textContent = '🎉 Перемога!';
      this.finishGame(true);
    } else if (this.board.isDeadlocked()) {
      statusEl.textContent = '🚫 Немає ходів — почніть нову гру';
      this.finishGame(false);
    } else {
      statusEl.textContent = `🀄 Залишилось: ${this.board.remaining}`;
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

window.mahjongGame = game;

const scene = () => game.scene.keys.main;
hintBtn.addEventListener('click', () => scene().hint());
undoBtn.addEventListener('click', () => scene().undo());
