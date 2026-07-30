// Animation/tween helpers for the Phaser board scene (scene.js: MainScene) —
// deal-in, tile interaction feedback (hover/press/error/glow), the shuffle
// flip, the pair-removal flight, undo, and the win/loss end effect. Every
// function here takes the scene as its first argument (`scene.add`/
// `scene.tweens`/`scene.time`/`scene.d()`/... — same object `scene.js`
// constructs), rather than being scene methods themselves — pulled out of
// MainScene to keep that class focused on session/layout logic (see
// docs/superpowers/specs/2026-07-29-tailwind-dom-ui-migration.md).
import {
  GLOW_COLOR, GLOW_STRENGTH, GLOW_PULSE_DELTA, SELECT_TILT_DEG, SPARK_COLORS,
  POOF_COUNT, END_EFFECT_MS, CRUMBLE_FALL, UNDO_DROP, FALLING_DEPTH,
  LAYER_TINTS,
  HOVER_SCALE, HOVER_WOBBLE_DEG, HOVER_WOBBLE_MS, HOVER_MS,
  PRESS_SCALE, PRESS_DROP, PRESS_MS, PRESS_TINT,
  ERROR_SHAKE_PX, ERROR_SHAKE_MS, ERROR_SHAKE_REPEAT, ERROR_TINT, ERROR_TINT_MS,
  FLIGHT_TO_CENTER_MS, FLIGHT_MERGE_SCALE, FLIGHT_DOWN_MS, FLIGHT_ARC_LIFT,
  DEAL_TILE_MS, DEAL_LAYER_STAGGER, DEAL_TILE_STAGGER, DEAL_START_SCALE, DEAL_OFFSCREEN_PAD,
  SHUFFLE_FLIP_MS,
} from './render-constants.js';

// --- Dealing tiles at the start of a game ---------------------------------

export function playDealIn(scene) {
  if (scene.reducedMotion) return;
  const center = scene.flightCenter();
  const order = [...scene.sprites.entries()]
    .map(([tile, sprite]) => ({
      tile,
      sprite,
      dist: Phaser.Math.Distance.Between(sprite.x, sprite.y, center.x, center.y),
    }))
    .sort((a, b) => (a.tile.z - b.tile.z) || (a.dist - b.dist));

  scene.dealing = true;
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
    const { x: startX, y: startY } = dealStartPos(scene);

    sprite.x = startX;
    sprite.y = startY;
    sprite.setScale(sprite.scaleX * DEAL_START_SCALE);
    sprite._baseScale = undefined;
    sprite.alpha = 0;
    sprite._flying = true;

    const delay = tile.z * DEAL_LAYER_STAGGER + layerIndex * DEAL_TILE_STAGGER;
    maxEnd = Math.max(maxEnd, delay + DEAL_TILE_MS);

    scene.tweens.add({
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

  scene.time.delayedCall(maxEnd, () => { scene.dealing = false; });
}

function dealStartPos(scene) {
  const pad = scene.d(DEAL_OFFSCREEN_PAD);
  const { viewW, viewH } = scene.LM;
  switch (Phaser.Math.Between(0, 3)) {
    case 0: return { x: -pad, y: Phaser.Math.Between(0, viewH) };
    case 1: return { x: viewW + pad, y: Phaser.Math.Between(0, viewH) };
    case 2: return { x: Phaser.Math.Between(0, viewW), y: -pad };
    default: return { x: Phaser.Math.Between(0, viewW), y: viewH + pad };
  }
}

// --- Tile tint / hover / press / error feedback ---------------------------

export function setTileTint(scene, tile, color) {
  scene.sprites.get(tile)?.setTint(color);
}

export function resetTileTint(scene, tile) {
  if (scene.sprites.has(tile)) setTileTint(scene, tile, LAYER_TINTS[tile.z]);
}

export function applyGlow(scene, tile, color = GLOW_COLOR, strength = GLOW_STRENGTH) {
  const sprite = scene.sprites.get(tile);
  if (!sprite) return;
  if (!scene.webgl) {
    setTileTint(scene, tile, color);
  } else {
    const fx = sprite.postFX.addGlow(color, 0, 0, false, 0.15, 12);
    sprite._glow = fx;
    sprite._glowTween = scene.tweens.add({
      targets: fx,
      outerStrength: strength + GLOW_PULSE_DELTA,
      duration: 450,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }
  sprite._tiltTween = scene.tweens.add({
    targets: sprite,
    angle: SELECT_TILT_DEG,
    duration: 500,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  });
}

export function removeGlow(scene, tile) {
  const sprite = scene.sprites.get(tile);
  if (!sprite) return;
  if (sprite._glowTween) { sprite._glowTween.stop(); sprite._glowTween = null; }
  if (sprite._glow) { sprite.postFX.remove(sprite._glow); sprite._glow = null; }
  if (sprite._tiltTween) { sprite._tiltTween.stop(); sprite._tiltTween = null; }
  sprite.angle = 0;
  resetTileTint(scene, tile);
}

export function clearHover(scene, sprite) {
  if (!sprite) return;
  sprite._hoverWobble?.stop();
  sprite._hoverWobble = null;
  sprite._hoverScaleTween?.stop();
  sprite._hoverScaleTween = null;
  sprite.setDisplaySize(scene.LM.tileW, scene.LM.tileH);
  sprite.angle = 0;
}

export function handleTileOver(scene, tile) {
  if (scene.reducedMotion) return;
  const sprite = scene.sprites.get(tile);
  if (!sprite || tile === scene.selected || sprite._flying) return;
  const base = sprite.scaleX;
  sprite._hoverScaleTween?.stop();
  sprite._hoverScaleTween = scene.tweens.add({
    targets: sprite, scaleX: base * HOVER_SCALE, scaleY: base * HOVER_SCALE, duration: HOVER_MS, ease: 'Sine.easeOut',
  });
  sprite._hoverWobble?.stop();
  sprite._hoverWobble = scene.tweens.add({
    targets: sprite,
    angle: { from: -HOVER_WOBBLE_DEG, to: HOVER_WOBBLE_DEG },
    duration: HOVER_WOBBLE_MS,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  });
}

export function handleTileOut(scene, tile) {
  if (scene.reducedMotion) return;
  const sprite = scene.sprites.get(tile);
  if (!sprite || tile === scene.selected || sprite._flying) return;
  sprite._hoverWobble?.stop();
  sprite._hoverWobble = null;
  sprite._hoverScaleTween?.stop();
  sprite._hoverScaleTween = scene.tweens.add({
    targets: sprite, angle: 0, duration: HOVER_MS, ease: 'Sine.easeOut',
  });
  sprite.setDisplaySize(scene.LM.tileW, scene.LM.tileH);
}

export function restoreTint(scene, tile) {
  if (!scene.sprites.has(tile)) return;
  if (tile === scene.selected && !scene.webgl) setTileTint(scene, tile, GLOW_COLOR);
  else resetTileTint(scene, tile);
}

export function playPress(scene, tile) {
  if (scene.reducedMotion) return;
  const sprite = scene.sprites.get(tile);
  if (!sprite) return;
  const base = sprite.scaleX;
  scene.tweens.add({
    targets: sprite,
    y: `+=${scene.d(PRESS_DROP)}`,
    scaleX: base * PRESS_SCALE,
    scaleY: base * PRESS_SCALE,
    duration: PRESS_MS,
    ease: 'Back.easeOut',
    yoyo: true,
  });
  setTileTint(scene, tile, PRESS_TINT);
  scene.time.delayedCall(PRESS_MS * 2, () => restoreTint(scene, tile));
}

export function playError(scene, tile) {
  const sprite = scene.sprites.get(tile);
  if (!sprite) return;
  setTileTint(scene, tile, ERROR_TINT);
  scene.time.delayedCall(ERROR_TINT_MS, () => restoreTint(scene, tile));
  if (scene.reducedMotion || sprite._errorTween) return;
  const baseX = sprite.x;
  const shake = scene.d(ERROR_SHAKE_PX);
  sprite._errorTween = scene.tweens.add({
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

// --- Particles -------------------------------------------------------------

export function spawnBurst(scene, px, py, {
  count = POOF_COUNT, speed = scene.d(160), lifespan = 400, gravityY = 0, scale = 0.6 * scene.dpr,
} = {}) {
  const emitter = scene.add.particles(px, py, 'spark', {
    speed: { min: speed * 0.4, max: speed },
    angle: { min: 0, max: 360 },
    lifespan,
    gravityY,
    scale: { start: scale, end: 0 },
    tint: SPARK_COLORS,
    quantity: count,
  });
  emitter.explode(count);
  scene.time.delayedCall(lifespan + 50, () => emitter.destroy());
}

// --- Pair removal: fly to the counter --------------------------------------

export function flyToCenterThenDown(scene, sprite, onDone) {
  const center = scene.flightCenter();
  const base = sprite.scaleX;
  scene.tweens.add({
    targets: sprite,
    x: center.x,
    y: center.y,
    scaleX: base * FLIGHT_MERGE_SCALE,
    scaleY: base * FLIGHT_MERGE_SCALE,
    duration: FLIGHT_TO_CENTER_MS,
    ease: 'Back.easeOut',
    onComplete: () => flyDownFromCenter(scene, sprite, onDone),
  });
}

function flyDownFromCenter(scene, sprite, onDone) {
  const target = scene.flightTarget();
  const start = new Phaser.Math.Vector2(sprite.x, sprite.y);
  const end = new Phaser.Math.Vector2(target.x, target.y);
  const control = new Phaser.Math.Vector2(
    (start.x + end.x) / 2 + scene.d(FLIGHT_ARC_LIFT),
    (start.y + end.y) / 2,
  );
  const curve = new Phaser.Curves.QuadraticBezier(start, control, end);
  const point = new Phaser.Math.Vector2();
  const startScaleX = sprite.scaleX;
  const startScaleY = sprite.scaleY;
  scene.tweens.addCounter({
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
      spawnBurst(scene, target.x, target.y, {
        count: POOF_COUNT, speed: scene.d(180), lifespan: 400, scale: 0.5 * scene.dpr,
      });
      sprite.destroy();
      onDone();
    },
  });
}

// --- Undo ------------------------------------------------------------------

export function animateUndoTile(scene, tile) {
  scene.addTileSprite(tile);
  if (scene.reducedMotion) return;
  const sprite = scene.sprites.get(tile);
  const finalY = sprite.y;
  const finalDepth = sprite.depth;
  sprite.setDepth(FALLING_DEPTH);
  sprite.y = finalY - scene.d(UNDO_DROP);
  sprite.alpha = 0;
  scene.tweens.add({
    targets: sprite, alpha: 1, duration: 150, ease: 'Quad.easeOut',
  });
  scene.tweens.add({
    targets: sprite,
    y: finalY,
    duration: 400,
    ease: 'Bounce.easeOut',
    onComplete: () => {
      sprite.setDepth(finalDepth);
      spawnBurst(scene, sprite.x, finalY, {
        count: 6, speed: scene.d(80), lifespan: 200, scale: 0.35 * scene.dpr,
      });
    },
  });
}

// --- Shuffle (a card-style flip in place, per re-kinded tile) --------------

// A card-style flip in place: collapse to scaleX 0, swap the texture at the
// midpoint (every kind's CanvasTexture is rasterized to the exact same pixel
// size — scene.rasterizeTiles — so swapping mid-flip needs no
// setDisplaySize call), then expand back. `delay` staggers multiple tiles
// (scene.js: shuffleGame) into a cascading reveal instead of all flipping in
// lockstep.
export function playShuffleFlip(scene, tile, kind, delay = 0) {
  const sprite = scene.sprites.get(tile);
  if (!sprite) return;
  if (scene.reducedMotion) {
    sprite.setTexture(kind);
    return;
  }
  const baseScaleX = sprite.scaleX;
  scene.tweens.add({
    targets: sprite,
    scaleX: 0,
    duration: SHUFFLE_FLIP_MS / 2,
    delay,
    ease: 'Quad.easeIn',
    onComplete: () => {
      sprite.setTexture(kind);
      scene.tweens.add({
        targets: sprite,
        scaleX: baseScaleX,
        duration: SHUFFLE_FLIP_MS / 2,
        ease: 'Quad.easeOut',
      });
    },
  });
}

// --- Win/loss end effect ----------------------------------------------------

export function playEndEffect(scene, won, done) {
  if (scene.reducedMotion) {
    scene.time.delayedCall(150, done);
    return;
  }
  const { viewW, margin } = scene.LM;
  const center = scene.flightCenter();
  if (won) {
    const shots = 5;
    for (let i = 0; i < shots; i += 1) {
      scene.time.delayedCall((END_EFFECT_MS / shots) * i, () => {
        const x = Phaser.Math.Between(margin, viewW - margin);
        const y = Phaser.Math.Between(margin, center.y);
        spawnBurst(scene, x, y, {
          count: 26, speed: scene.d(260), lifespan: 700, gravityY: scene.d(220), scale: 0.9 * scene.dpr,
        });
      });
    }
  } else {
    for (const sprite of scene.sprites.values()) {
      const delay = Phaser.Math.Between(0, 400);
      scene.tweens.add({
        targets: sprite,
        y: sprite.y + scene.d(CRUMBLE_FALL),
        angle: Phaser.Math.Between(-70, 70),
        alpha: 0,
        delay,
        duration: 500,
        ease: 'Quad.easeIn',
      });
    }
  }
  scene.time.delayedCall(END_EFFECT_MS, done);
}
