import { WIDTH, LAYERS, Board } from './board.js';
import { generateForDifficulty, KINDS } from './generator.js';
import {
  load as loadStats, save as saveStats, applyWin, applyLoss, winRate, fmtTime, LEVELS,
} from './stats.js';
import {
  TILE_W, TILE_H, DEPTH_X, DEPTH_Y, CORNER_R, FACE_W, FACE_H, LAYER_DX, LAYER_DY, MARGIN,
  GAME_W, GAME_H, SELECT_TINT, LAYER_TINTS, SIDE_COLOR, SIDE_SHADOW, SIDE_EDGE_COLOR,
  GLOW_COLOR, GLOW_STRENGTH, GLOW_PULSE_DELTA, SELECT_TILT_DEG, HINT_GLOW_COLOR, SPARK_COLORS,
  POOF_COUNT, END_EFFECT_MS, CRUMBLE_FALL, UNDO_DROP, FALLING_DEPTH,
  HOVER_SCALE, HOVER_WOBBLE_DEG, HOVER_WOBBLE_MS, HOVER_MS,
  PRESS_SCALE, PRESS_DROP, PRESS_MS, PRESS_TINT,
  ERROR_SHAKE_PX, ERROR_SHAKE_MS, ERROR_SHAKE_REPEAT, ERROR_TINT, ERROR_TINT_MS,
  FLIGHT_TO_CENTER_MS, FLIGHT_MERGE_SCALE, FLIGHT_DOWN_MS, FLIGHT_ARC_LIFT,
  FLIGHT_CENTER_X, FLIGHT_CENTER_Y, FLIGHT_TARGET_X, FLIGHT_TARGET_Y,
} from './render-constants.js';

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

    // Текстура частинки для салюту/пуфу/підказки — маленьке заповнене коло,
    // тон задається через tint при спавні емітера, тож саме зображення біле.
    const spark = this.make.graphics({}, false);
    spark.fillStyle(0xffffff);
    spark.fillCircle(4, 4, 4);
    spark.generateTexture('spark', 8, 8);
    spark.destroy();

    this.sprites = new Map(); // tile -> Phaser container
    this.selected = null;

    // Системне «зменшити рух» — вимикає важкі ефекти (салют/осипання/пуф),
    // лишаючи лише статичне виділення. glow FX (postFX) працює тільки на
    // WebGL-рендерері — на Canvas-фолбеку виділення повертається до тінту.
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.webgl = this.renderer.type === Phaser.WEBGL;

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
    this.input.on('gameobjectover', (pointer, obj) => this.handleTileOver(obj.getData('tile')));
    this.input.on('gameobjectout', (pointer, obj) => this.handleTileOut(obj.getData('tile')));

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
      this.removeGlow(this.selected);
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
    this.playEndEffect(won, () => {
      this.openStatsModal(won ? '🎉 Перемога!' : '🚫 Глухий кут — немає ходів');
    });
  }

  // Салют (перемога) чи осипання кісток (поразка) на повному полі, тоді
  // callback (відкриття модалки статистики). За reduced-motion — одразу
  // callback, без важких ефектів.
  playEndEffect(won, done) {
    if (this.reducedMotion) {
      this.time.delayedCall(150, done);
      return;
    }
    if (won) {
      const shots = 5;
      for (let i = 0; i < shots; i += 1) {
        this.time.delayedCall((END_EFFECT_MS / shots) * i, () => {
          const x = Phaser.Math.Between(MARGIN, GAME_W - MARGIN);
          const y = Phaser.Math.Between(MARGIN, GAME_H * 0.5);
          this.spawnBurst(x, y, {
            count: 26, speed: 260, lifespan: 700, gravityY: 220, scale: 0.9,
          });
        });
      }
    } else {
      let maxDelay = 0;
      for (const container of this.sprites.values()) {
        const delay = Phaser.Math.Between(0, 400);
        maxDelay = Math.max(maxDelay, delay);
        this.tweens.add({
          targets: container,
          y: container.y + CRUMBLE_FALL,
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

  // Екранна (world) позиція центру кістки — та сама формула, що й для
  // спавну спрайта, перевикористовується для позиціонування ефектів
  // (glow-таргетів, частинок), щоб не дублювати математику.
  tileScreenPos(tile) {
    const x = MARGIN + tile.x * TILE_W + TILE_W / 2 + tile.z * LAYER_DX;
    const y = MARGIN + LAYERS * LAYER_DY
      + tile.y * TILE_H + TILE_H / 2 - tile.z * LAYER_DY;
    return { x, y };
  }

  addTileSprite(tile) {
    const { x: px, y: py } = this.tileScreenPos(tile);
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

  // Пульсуюче glow-виділення (WebGL-only postFX, на Canvas-фолбеку — суцільний
  // тінт) + легкий tilt (гойдання по куту) — той самий tilt працює незалежно
  // від рендерера, тож вибрана кістка завжди помітно «жива», навіть без glow.
  applyGlow(tile, color = GLOW_COLOR, strength = GLOW_STRENGTH) {
    const container = this.sprites.get(tile);
    if (!container) return;
    if (!this.webgl) {
      this.setTileTint(tile, color);
    } else {
      const fx = container.postFX.addGlow(color, 0, 0, false, 0.15, 12);
      container._glow = fx;
      container._glowTween = this.tweens.add({
        targets: fx,
        outerStrength: strength + GLOW_PULSE_DELTA,
        duration: 450,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }
    container._tiltTween = this.tweens.add({
      targets: container,
      angle: SELECT_TILT_DEG,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  removeGlow(tile) {
    const container = this.sprites.get(tile);
    if (!container) return;
    if (container._glowTween) {
      container._glowTween.stop();
      container._glowTween = null;
    }
    if (container._glow) {
      container.postFX.remove(container._glow);
      container._glow = null;
    }
    if (container._tiltTween) {
      container._tiltTween.stop();
      container._tiltTween = null;
    }
    container.angle = 0;
    this.resetTileTint(tile);
  }

  // Миттєво знімає hover-твіни (scale/wobble) без плавного переходу — потрібно
  // перед select/removePair, де кістка вже отримує власний tilt чи летить геть.
  clearHover(container) {
    if (!container) return;
    container._hoverWobble?.stop();
    container._hoverWobble = null;
    container._hoverScaleTween?.stop();
    container._hoverScaleTween = null;
    container.setScale(1);
    container.angle = 0;
  }

  // Живе наведення: плавне збільшення + неперервне «дихання» по куту. Не чіпаємо
  // вибрану кістку (у неї вже є власний pulse/tilt від applyGlow) і кістки, що
  // летять до лічильника після знятої пари.
  handleTileOver(tile) {
    if (this.reducedMotion) return;
    const container = this.sprites.get(tile);
    if (!container || tile === this.selected || container._flying) return;
    container._hoverScaleTween?.stop();
    container._hoverScaleTween = this.tweens.add({
      targets: container, scale: HOVER_SCALE, duration: HOVER_MS, ease: 'Sine.easeOut',
    });
    container._hoverWobble?.stop();
    container._hoverWobble = this.tweens.add({
      targets: container,
      angle: { from: -HOVER_WOBBLE_DEG, to: HOVER_WOBBLE_DEG },
      duration: HOVER_WOBBLE_MS,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  handleTileOut(tile) {
    if (this.reducedMotion) return;
    const container = this.sprites.get(tile);
    if (!container || tile === this.selected || container._flying) return;
    container._hoverWobble?.stop();
    container._hoverWobble = null;
    container._hoverScaleTween?.stop();
    container._hoverScaleTween = this.tweens.add({
      targets: container, scale: 1, angle: 0, duration: HOVER_MS, ease: 'Sine.easeOut',
    });
  }

  // Повертає тінт кістки після тимчасового спалаху (press/error) з урахуванням
  // поточного стану — якщо кістка вже знята чи улетіла, нічого робити не треба;
  // якщо це досі виділена кістка на Canvas-фолбеку (без postFX), її тінт —
  // GLOW_COLOR, а не пошаровий.
  restoreTint(tile) {
    if (!this.sprites.has(tile)) return;
    if (tile === this.selected && !this.webgl) this.setTileTint(tile, GLOW_COLOR);
    else this.resetTileTint(tile);
  }

  // Фізичне вдавлювання при кліку по вільній кістці: короткий «пресс» вниз
  // зі стиском + яскравий золотий спалах, що потім згасає до звичного тінту.
  playPress(tile) {
    if (this.reducedMotion) return;
    const container = this.sprites.get(tile);
    if (!container) return;
    this.tweens.add({
      targets: container,
      y: `+=${PRESS_DROP}`,
      scale: PRESS_SCALE,
      duration: PRESS_MS,
      ease: 'Back.easeOut',
      yoyo: true,
    });
    this.setTileTint(tile, PRESS_TINT);
    this.time.delayedCall(PRESS_MS * 2, () => this.restoreTint(tile));
  }

  // «Заперечна» тряска по X при кліку на заблоковану кістку + червоний спалах.
  // Спалах лишається навіть при reduced-motion (це не рух, а миттєвий колір);
  // саму тряску пропускаємо.
  playError(tile) {
    const container = this.sprites.get(tile);
    if (!container) return;
    this.setTileTint(tile, ERROR_TINT);
    this.time.delayedCall(ERROR_TINT_MS, () => this.restoreTint(tile));
    if (this.reducedMotion || container._errorTween) return;
    const baseX = container.x;
    container._errorTween = this.tweens.add({
      targets: container,
      x: { from: baseX - ERROR_SHAKE_PX, to: baseX + ERROR_SHAKE_PX },
      duration: ERROR_SHAKE_MS,
      yoyo: true,
      repeat: ERROR_SHAKE_REPEAT,
      onComplete: () => {
        container.x = baseX;
        container._errorTween = null;
      },
    });
  }

  handleTileClick(tile) {
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

  // Короткий сплеск частинок у точці (px, py) — використовується і для
  // «пуфу» при знятті пари, і для залпів салюту при перемозі. Емітер сам
  // знищується (`stopAfter`), тож викликач не мусить прибирати за собою.
  spawnBurst(px, py, {
    count = POOF_COUNT, speed = 160, lifespan = 400, gravityY = 0, scale = 0.6,
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
    for (const tile of [a, b]) {
      const container = this.sprites.get(tile);
      container._glowTween?.stop();
      container._tiltTween?.stop();
      this.clearHover(container);
      this.sprites.delete(tile);
      if (this.reducedMotion) {
        container.destroy();
        continue;
      }
      // Піднімаємо над усіма іншими кістками на час польоту — інакше знята
      // пара пролітає позаду сусідніх кісток з вищим depth. `_flying` не дає
      // hover-обробникам чіпляти твіни на кістку, що вже летить геть.
      container.setDepth(FALLING_DEPTH);
      container._flying = true;
      this.flyToCenterThenDown(container);
    }
    this.selected = null;
    this.bumpCounter('gamePairs', 'pairsTotal');
    this.updateStatus();
  }

  // Фаза 1 знятої кістки: летить у центр екрана, зростаючи (Back.easeOut дає
  // легкий "поп"). Обидві кістки пари летять в одну й ту саму точку — так вони
  // візуально «зустрічаються»/зливаються, перш ніж полетіти далі разом.
  flyToCenterThenDown(container) {
    this.tweens.add({
      targets: container,
      x: FLIGHT_CENTER_X,
      y: FLIGHT_CENTER_Y,
      scale: FLIGHT_MERGE_SCALE,
      duration: FLIGHT_TO_CENTER_MS,
      ease: 'Back.easeOut',
      onComplete: () => this.flyDownFromCenter(container),
    });
  }

  // Фаза 2: з центру (де кістки щойно злилися) обидві летять по тому самому
  // дуговому шляху вниз до лічильника пар (DOM #status під канвасом —
  // FLIGHT_TARGET_X/Y це найближча до нього точка на самому канвасі),
  // зменшуючись назад до зникнення. Взрив частинок — у точці зникнення, вже
  // після завершення польоту, і лише тоді знищуємо контейнер.
  flyDownFromCenter(container) {
    const start = new Phaser.Math.Vector2(container.x, container.y);
    const end = new Phaser.Math.Vector2(FLIGHT_TARGET_X, FLIGHT_TARGET_Y);
    const control = new Phaser.Math.Vector2(
      (start.x + end.x) / 2 + FLIGHT_ARC_LIFT,
      (start.y + end.y) / 2,
    );
    const curve = new Phaser.Curves.QuadraticBezier(start, control, end);
    const point = new Phaser.Math.Vector2();
    const startScale = container.scaleX;
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: FLIGHT_DOWN_MS,
      ease: 'Sine.easeIn',
      onUpdate: (tween) => {
        const t = tween.getValue();
        curve.getPoint(t, point);
        container.x = point.x;
        container.y = point.y;
        container.setScale(startScale * (1 - t));
        container.alpha = 1 - t;
      },
      onComplete: () => {
        this.spawnBurst(FLIGHT_TARGET_X, FLIGHT_TARGET_Y, {
          count: POOF_COUNT, speed: 180, lifespan: 400, scale: 0.5,
        });
        container.destroy();
      },
    });
  }

  undo() {
    const pair = this.board.undo();
    if (!pair) return;
    this.deselect();
    for (const tile of pair) this.animateUndoTile(tile);
    this.bumpCounter('gameUndos', 'undosTotal');
    this.updateStatus();
  }

  // Кістка, що повертається через undo, «падає» на своє місце зверху з
  // невеликим відскоком + fade-in, замість миттєвої появи. Піднімаємо depth
  // на час падіння (як у removePair) — інакше вона під час польоту опиниться
  // позаду сусідніх кісток з вищим природним depth.
  animateUndoTile(tile) {
    this.addTileSprite(tile);
    if (this.reducedMotion) return;
    const container = this.sprites.get(tile);
    const finalY = container.y;
    const finalDepth = container.depth;
    container.setDepth(FALLING_DEPTH);
    container.y = finalY - UNDO_DROP;
    container.alpha = 0;
    this.tweens.add({
      targets: container, alpha: 1, duration: 150, ease: 'Quad.easeOut',
    });
    this.tweens.add({
      targets: container,
      y: finalY,
      duration: 400,
      ease: 'Bounce.easeOut',
      onComplete: () => {
        container.setDepth(finalDepth);
        this.spawnBurst(container.x, finalY, { count: 6, speed: 80, lifespan: 200, scale: 0.35 });
      },
    });
  }

  hint() {
    const pair = this.board.findMatchingPair();
    if (!pair) return;
    const pulseMs = 180 * (1 + 2 * 3); // duration * (1 initial + 2 * repeat) yoyo-циклів
    for (const tile of pair) {
      const container = this.sprites.get(tile);
      this.tweens.add({
        targets: container,
        alpha: 0.3,
        duration: 180,
        yoyo: true,
        repeat: 3,
      });
      // Додатковий glow (окремий від виділення-selected) — WebGL-only,
      // самознищується разом з alpha-пульсом; на Canvas лишається лише
      // alpha-пульс вище.
      if (this.webgl) {
        const fx = container.postFX.addGlow(HINT_GLOW_COLOR, GLOW_STRENGTH, 0, false, 0.15, 12);
        this.time.delayedCall(pulseMs, () => container.postFX?.remove(fx));
      }
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
