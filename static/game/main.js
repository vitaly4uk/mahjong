import { WIDTH, HEIGHT, LAYERS, Board } from './board.js';
import { generateForDifficulty, KINDS } from './generator.js';
import {
  load as loadStats, save as saveStats, applyWin, applyLoss, winRate, fmtTime, LEVELS,
} from './stats.js';

const TILE_W = 70; // крок сітки
const TILE_H = 90;
const FACE_W = TILE_W - 6; // кришка менша за крок — між кістками видно зазор
const FACE_H = TILE_H - 6;
const LAYER_DX = 8; // зсув шару вгору-вправо для псевдо-3D
const LAYER_DY = 10;
const MARGIN = 30;
const GAME_W = WIDTH * TILE_W + 2 * MARGIN + LAYERS * LAYER_DX;
const GAME_H = HEIGHT * TILE_H + 2 * MARGIN + LAYERS * LAYER_DY;
const SELECT_TINT = 0x77bbff;
// Затемнення нижніх шарів, щоб шари читалися окремо
const LAYER_TINTS = [0xb0b0b0, 0xd8d8d8, 0xffffff];
const SIDE_COLOR = 0xe6c88f; // кремова боковинка
const SIDE_EDGE_COLOR = 0x9c7f52;

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

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
  }

  preload() {
    this.load.image('Front', tileUrl('Front'));
    for (const kind of KINDS) this.load.image(kind, tileUrl(kind));
  }

  create() {
    // Текстура боковинки: кремовий заокруглений прямокутник з темнішим краєм
    const g = this.make.graphics({}, false);
    g.fillStyle(SIDE_COLOR);
    g.fillRoundedRect(0, 0, FACE_W, FACE_H, 8);
    g.lineStyle(2, SIDE_EDGE_COLOR);
    g.strokeRoundedRect(1, 1, FACE_W - 2, FACE_H - 2, 8);
    g.generateTexture('tileSide', FACE_W, FACE_H);
    g.destroy();

    this.sprites = new Map(); // tile -> Phaser container
    this.selected = null;

    const allStats = loadStats();
    this.registry.set('allStats', allStats);
    this.registry.events.on('changedata', () => this.renderStats());

    this.currentLevel = loadDifficultyPref(allStats);
    saveDifficultyPref(this.currentLevel);

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
    document.getElementById('btn-newgame-close').addEventListener('click', () => this.closeAllModals());
    for (const btn of newgameLevelButtons) {
      btn.addEventListener('click', () => {
        const level = btn.dataset.level;
        saveDifficultyPref(level);
        this.closeAllModals();
        this.startGame(level);
      });
    }

    // Перший запуск сторінки: стартуємо одразу зі збереженим рівнем, без модалки.
    this.startGame(this.currentLevel);
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
    this.closeStatsModal();
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

  closeStatsModal() {
    statsModal.classList.remove('open');
  }

  toggleStatsModal() {
    if (statsModal.classList.contains('open')) this.closeAllModals();
    else this.openStatsModal('📊 Статистика');
  }

  openNewGameModal() {
    this.closeAllModals();
    for (const btn of newgameLevelButtons) {
      btn.classList.toggle('selected', btn.dataset.level === this.currentLevel);
    }
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
    // Боковинка зсунута вниз-вліво — протилежно до зсуву шарів угору-вправо
    const side = this.add.image(-LAYER_DX, LAYER_DY, 'tileSide')
      .setDisplaySize(FACE_W, FACE_H);
    const front = this.add.image(0, 0, 'Front').setDisplaySize(FACE_W, FACE_H);
    const face = this.add.image(0, -3, tile.kind)
      .setDisplaySize(FACE_W * 0.78, FACE_H * 0.78);
    const container = this.add.container(px, py, [side, front, face]);
    container.setSize(TILE_W, TILE_H);
    // Боковинка стирчить униз-вліво, тож ближчі до глядача тайли
    // (нижчі ряди, лівіші колонки, вищі шари) малюємо поверх
    container.setDepth(
      tile.z * 10000 + tile.y * 100 + (WIDTH - 1 - tile.x),
    );
    container.setInteractive();
    container.on('pointerdown', () => this.handleTileClick(tile));
    container.tintTargets = [side, front, face];
    this.sprites.set(tile, container);
    this.resetTileTint(tile);
  }

  setTileTint(tile, color) {
    for (const img of this.sprites.get(tile).tintTargets) img.setTint(color);
  }

  resetTileTint(tile) {
    if (this.sprites.has(tile)) this.setTileTint(tile, LAYER_TINTS[tile.z]);
  }

  handleTileClick(tile) {
    if (!this.board.isFree(tile)) return;
    if (this.selected === tile) {
      this.resetTileTint(tile);
      this.selected = null;
      return;
    }
    if (this.selected && this.board.canMatch(this.selected, tile)) {
      this.removePair(this.selected, tile);
      return;
    }
    if (this.selected) this.resetTileTint(this.selected);
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
    this.registry.set('gamePairs', this.registry.get('gamePairs') + 1);
    const stats = this.lifetimeStats();
    this.updateLifetimeStats({ ...stats, pairsTotal: stats.pairsTotal + 1 });
    this.updateStatus();
  }

  undo() {
    const pair = this.board.undo();
    if (!pair) return;
    if (this.selected) {
      this.resetTileTint(this.selected);
      this.selected = null;
    }
    for (const tile of pair) this.addTileSprite(tile);
    this.registry.set('gameUndos', this.registry.get('gameUndos') + 1);
    const stats = this.lifetimeStats();
    this.updateLifetimeStats({ ...stats, undosTotal: stats.undosTotal + 1 });
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
    this.registry.set('gameHints', this.registry.get('gameHints') + 1);
    const stats = this.lifetimeStats();
    this.updateLifetimeStats({ ...stats, hintsTotal: stats.hintsTotal + 1 });
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
document.getElementById('btn-hint').addEventListener('click', () => scene().hint());
document.getElementById('btn-undo').addEventListener('click', () => scene().undo());
