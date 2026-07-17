// Константи рендеру Phaser-сцени (main.js): геометрія кістки, кольори,
// параметри ефектів (glow/твіни/частинки). Чистий модуль без Phaser/DOM —
// лише числа й обчислення на них, щоб main.js лишався зосередженим на логіці
// сцени, а не на тюнінгу цифр.
import { WIDTH, HEIGHT, LAYERS } from './board.js';

export const TILE_W = 70; // крок сітки
export const TILE_H = 90;
export const DEPTH_X = 6; // товщина боковинок (справжній 3D-корпус, не зсунута копія)
export const DEPTH_Y = 8; // кістка — плоска плитка, тож товщина скромна
export const CORNER_R = 3; // радіус заокруглення кутів корпусу — узгоджений з Front.png
// GAP — гарантований проміжок саме між ЛИЦЯМИ сусідніх кісток (тому FACE_W
// рахується від TILE_W напряму, без DEPTH_X). Боковина (корпус) ширша за
// лице на DEPTH_X і тому природно "заходить" на боковину сусідки на
// (DEPTH_X − GAP) px — це і дає бажаний ефект: боковини перекриваються,
// а лиця — ніколи не торкаються.
export const GAP = 3;
export const FACE_W = TILE_W - GAP;
export const FACE_H = TILE_H - GAP;
export const LAYER_DX = 8; // зсув шару вгору-вправо для псевдо-3D
export const LAYER_DY = 10;
export const MARGIN = 30;
export const GAME_W = WIDTH * TILE_W + 2 * MARGIN + LAYERS * LAYER_DX;
export const GAME_H = HEIGHT * TILE_H + 2 * MARGIN + LAYERS * LAYER_DY;
export const SELECT_TINT = 0x77bbff;
// Затемнення нижніх шарів, щоб шари читалися окремо
export const LAYER_TINTS = [0xb0b0b0, 0xd8d8d8, 0xffffff];
export const SIDE_COLOR = 0xd9b878; // кремова ліва стінка
export const SIDE_SHADOW = 0xa9814a; // темніша нижня стінка (у тіні) — вищий контраст
export const SIDE_EDGE_COLOR = 0x7a5c33; // темніший край для чіткішого силуету

// --- Ефекти (glow/частинки/твіни) ---
export const GLOW_COLOR = 0x77bbff; // свічення вибраної кістки — той самий тон, що й SELECT_TINT
export const GLOW_STRENGTH = 3;
export const GLOW_PULSE_DELTA = 1.5; // амплітуда пульсації outerStrength
export const SELECT_TILT_DEG = 4; // амплітуда гойдання вибраної кістки, у градусах
export const HINT_GLOW_COLOR = 0xffd54a; // теплий жовтий — відрізняється від вибору
export const SPARK_COLORS = [0xffd54a, 0xff6b6b, 0x77bbff, 0x6bffb0, 0xffffff];
export const POOF_COUNT = 10;
export const END_EFFECT_MS = 1300; // тривалість салюту/осипання перед показом модалки
export const CRUMBLE_FALL = 260; // на скільки px «осипаються» кістки при поразці
export const POOF_FALL = 160; // на скільки px падає знята пара перед зникненням
export const UNDO_DROP = 70; // з якої висоти «падає» на місце кістка, повернута через undo
// Гарантовано вище за depth будь-якої кістки на полі (макс. LAYERS*10000 + HEIGHT*100 + WIDTH)
export const FALLING_DEPTH = 1000000;
