// Entry point: builds the Phaser game from MainScene (scene.js) and exposes
// it for debugging/tests (window.mahjongGame). The scene itself owns session
// logic; static/game/effects.js owns animation; static/game/ui-dom.js owns
// the DOM toolbar/status-bar/modals. See
// docs/superpowers/specs/2026-07-29-tailwind-dom-ui-migration.md.
import { MainScene } from './scene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#1d2b1f',
  scale: {
    // Native resolution: the canvas is managed manually (scene.js:
    // resizeCanvas) — the backing store is in device-px, CSS size = the
    // container. World coordinates = device-px, so tile textures rasterize
    // 1:1 at the actual size and stay sharp on any screen/window.
    mode: Phaser.Scale.NONE,
    width: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
    height: Math.round(window.innerHeight * (window.devicePixelRatio || 1)),
  },
  scene: MainScene,
});

window.mahjongGame = game;
