// Render constants for the Phaser scene (main.js): field proportions,
// colors, effect parameters. A pure module, no Phaser/DOM. After moving to a
// sprite-based oblique render (Cangjie6's ready-made 3D set instead of a
// hand-built body) and to native resolution (Scale.NONE + manual DPR canvas
// scaling, world = device px), tile geometry is no longer "baked" here — tile
// size and layer offsets are computed dynamically in main.js (computeLayout)
// from the actual window size. Only the BASE (design-px, multiplied by dpr in
// the scene) values, proportions, and effect tuning remain here.

// Tile aspect ratio (oblique SVG, Cangjie6: viewBox 210×255).
export const TILE_ASPECT = 210 / 255;

// Every Cangjie6 sprite already contains a drawn 3D thickness (bevel) ABOVE
// and to the RIGHT of the face, not just the face itself (measured pixel by
// pixel on Man1.svg: the face ends at ~84.4% of the width, the bevel to the
// right extends to ~94%, the black outline to 100%; the face starts at
// ~10.9% of the height, the bevel on top starts at ~5%; there's no bevel on
// the left/bottom). So neighbouring tiles on the same grid CANNOT be placed
// flush at the sprite's full size (even a mathematically zero gap between
// bounding boxes still leaves the neighbouring tile's bevel+outline visible
// as a solid strip ~16% of width/11% of height wide — that's what looked
// like "a gap with the background showing through"). The grid step (distance
// between centers) must be SMALLER than the sprite's full size, so the tile
// to the right/above rides over that strip and hides it — the same way
// stacked oblique tiles work in kmahjongg. STEP_*_FRAC — the fraction of
// tileW/tileH that goes into the grid step; the rest is deliberate overlap,
// hidden by depth sorting (addTileSprite: tiles further right/up are drawn on
// top — both measured thresholds 0.844/0.891 with margin for rounding).
export const STEP_X_FRAC = 0.80;
export const STEP_Y_FRAC = 0.85;

// Layer offset for the pseudo-3D stack — DOWN and to the LEFT, sized exactly
// to the drawn bevel thickness (measured pixel by pixel on Man1.svg: the
// right-side bevel is ~9.9% of width, the top bevel ~5.9% of height — these
// exact fractions, not arbitrary numbers). The artist drew the thickness
// ABOVE and to the RIGHT of the face — meaning the "camera" looks in such a
// way that the side of the tile nearest the viewer is bottom-left. A tile on
// a higher layer is physically closer to the viewer (it sits on top of the
// stack), so on screen it should shift exactly there — down-left, by exactly
// the size of that same bevel: then the exposed part of the tile beneath it
// (that same top-right triangle) has a width of exactly one "thickness", with
// no excess or insufficient overlap.
export const LAYER_DX_FRAC = 0.099;
export const LAYER_DY_FRAC = 0.059;

// UI bars (design-px, ×dpr in the scene): toolbar on top, status bar at the bottom, margins.
export const MARGIN = 20;
export const TOOLBAR_H = 60;
export const STATUS_BAR_H = 52;
export const STATUS_BAR_BG = 0x0d1a10;
export const STATUS_BAR_BG_ALPHA = 0.6;

export const SELECT_TINT = 0x77bbff;
// Darkening of lower layers, so the 5 layers read as distinct (z=0..4, bottom to top).
export const LAYER_TINTS = [0x9a9a9a, 0xb6b6b6, 0xd0d0d0, 0xe8e8e8, 0xffffff];

// --- Effects (glow/particles/tweens) ---
export const GLOW_COLOR = 0x77bbff; // glow of the selected tile — the same tone as SELECT_TINT
export const GLOW_STRENGTH = 3;
export const GLOW_PULSE_DELTA = 1.5; // amplitude of the outerStrength pulse
export const SELECT_TILT_DEG = 4; // amplitude of the selected tile's tilt wobble, in degrees
export const HINT_GLOW_COLOR = 0xffd54a; // warm yellow — distinct from selection
export const SPARK_COLORS = [0xffd54a, 0xff6b6b, 0x77bbff, 0x6bffb0, 0xffffff];
export const POOF_COUNT = 10;
export const END_EFFECT_MS = 1300; // duration of the confetti/crumble before the modal appears
export const CRUMBLE_FALL = 260; // how many px tiles "crumble" down on a loss (base, ×dpr)
export const UNDO_DROP = 70; // the height a tile "drops" from when restored via undo (base, ×dpr)
// Guaranteed to be above the depth of any tile on the board (max LAYERS*10000 + HEIGHT*100 + WIDTH)
export const FALLING_DEPTH = 1000000;

// --- Hover ("live hover") ---
export const HOVER_SCALE = 1.05;
export const HOVER_WOBBLE_DEG = 2; // amplitude of the angle "breathing" on hover
export const HOVER_WOBBLE_MS = 400;
export const HOVER_MS = 120; // duration of the in/out scale/angle transition

// --- Press ("physical press-down") ---
export const PRESS_SCALE = 0.95;
export const PRESS_DROP = 3; // how many px the tile "presses" down (base, ×dpr)
export const PRESS_MS = 90;
export const PRESS_TINT = 0xffe08a; // light-gold flash on press

// --- Error ("rejection shake" on a blocked tile) ---
export const ERROR_SHAKE_PX = 6; // base, ×dpr
export const ERROR_SHAKE_MS = 40;
export const ERROR_SHAKE_REPEAT = 4;
export const ERROR_TINT = 0xff5555;
export const ERROR_TINT_MS = 200;

// --- Pair flight to the counter (target X/Y computed by main.js from layout) ---
export const FLIGHT_TO_CENTER_MS = 650;
export const FLIGHT_MERGE_SCALE = 1.35; // how large the tiles grow at the center
export const FLIGHT_DOWN_MS = 900;
export const FLIGHT_ARC_LIFT = 90; // how far phase-2's arc control point is offset sideways (base, ×dpr)

// --- Shuffle (a card-style flip in place, per re-kinded tile) ---
export const SHUFFLE_FLIP_MS = 280; // total flip duration (half collapsing to scaleX 0, half expanding back)
export const SHUFFLE_TILE_STAGGER = 30; // delay between each re-kinded tile's flip start, for a cascading look

// --- Dealing tiles at the start of a game ---
export const DEAL_TILE_MS = 520; // duration of a single tile's flight
export const DEAL_LAYER_STAGGER = 240; // delay between the start of each layer (z)
export const DEAL_TILE_STAGGER = 7; // extra delay between tiles of the same layer
export const DEAL_START_SCALE = 0.5; // starting scale (grows to 1 on landing)
export const DEAL_OFFSCREEN_PAD = 140; // how far past the screen edge the start point is (base, ×dpr)
