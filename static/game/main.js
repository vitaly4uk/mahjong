import { WIDTH, HEIGHT, LAYERS, Board } from './board.js';
import { generateLayout, KINDS } from './generator.js';

const TILE_W = 70;
const TILE_H = 90;
const LAYER_DX = 6; // зсув шару вгору-вправо для псевдо-3D
const LAYER_DY = 8;
const MARGIN = 30;
const GAME_W = WIDTH * TILE_W + 2 * MARGIN + LAYERS * LAYER_DX;
const GAME_H = HEIGHT * TILE_H + 2 * MARGIN + LAYERS * LAYER_DY;
const SELECT_TINT = 0x77bbff;

const tileUrl = (name) => `/static/game/tiles/${name}.png`;
const statusEl = document.getElementById('status');

class MainScene extends Phaser.Scene {
  constructor() {
    super('main');
  }

  preload() {
    this.load.image('Front', tileUrl('Front'));
    for (const kind of KINDS) this.load.image(kind, tileUrl(kind));
  }

  create() {
    this.sprites = new Map(); // tile -> Phaser container
    this.selected = null;
    this.newGame();
  }

  newGame() {
    for (const sprite of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
    this.selected = null;
    this.board = new Board(generateLayout());
    for (const tile of this.board.tiles()) this.addTileSprite(tile);
    this.updateStatus();
  }

  addTileSprite(tile) {
    const px = MARGIN + tile.x * TILE_W + TILE_W / 2 + tile.z * LAYER_DX;
    const py = MARGIN + LAYERS * LAYER_DY
      + tile.y * TILE_H + TILE_H / 2 - tile.z * LAYER_DY;
    const front = this.add.image(0, 0, 'Front').setDisplaySize(TILE_W, TILE_H);
    const face = this.add.image(0, -3, tile.kind)
      .setDisplaySize(TILE_W * 0.78, TILE_H * 0.78);
    const container = this.add.container(px, py, [front, face]);
    container.setSize(TILE_W, TILE_H);
    container.setDepth(tile.z);
    container.setInteractive();
    container.on('pointerdown', () => this.handleTileClick(tile));
    container.tintTargets = [front, face];
    this.sprites.set(tile, container);
  }

  setTileTint(tile, color) {
    for (const img of this.sprites.get(tile).tintTargets) img.setTint(color);
  }

  clearTileTint(tile) {
    const sprite = this.sprites.get(tile);
    if (sprite) for (const img of sprite.tintTargets) img.clearTint();
  }

  handleTileClick(tile) {
    if (!this.board.isFree(tile)) return;
    if (this.selected === tile) {
      this.clearTileTint(tile);
      this.selected = null;
      return;
    }
    if (this.selected && this.board.canMatch(this.selected, tile)) {
      this.removePair(this.selected, tile);
      return;
    }
    if (this.selected) this.clearTileTint(this.selected);
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
    this.updateStatus();
  }

  undo() {
    const pair = this.board.undo();
    if (!pair) return;
    if (this.selected) {
      this.clearTileTint(this.selected);
      this.selected = null;
    }
    for (const tile of pair) this.addTileSprite(tile);
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
  }

  updateStatus() {
    if (this.board.isWon()) {
      statusEl.textContent = 'Перемога! 🎉';
    } else if (this.board.isDeadlocked()) {
      statusEl.textContent = 'Немає ходів — почніть нову гру';
    } else {
      statusEl.textContent = `Тайлів: ${this.board.remaining}`;
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
document.getElementById('btn-new').addEventListener('click', () => scene().newGame());
document.getElementById('btn-hint').addEventListener('click', () => scene().hint());
document.getElementById('btn-undo').addEventListener('click', () => scene().undo());
