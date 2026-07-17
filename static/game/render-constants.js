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
// Ігрове поле (кістки) — окремо від повної висоти канваса: тулбар кнопок
// додає своє місце зверху (TOOLBAR_H), смуга статусу — знизу (STATUS_BAR_H).
// Кістки ніколи не потрапляють у ці зони (BOARD_TOP зсуває все поле вниз),
// але фонове фото/вуаль розтягнуті на весь канвас, тож обидві напівпрозорі
// плашки все одно виглядають "поверх картинки", а не окремими смугами
// іншого кольору над/під нею.
export const BOARD_H = HEIGHT * TILE_H + 2 * MARGIN + LAYERS * LAYER_DY;
export const TOOLBAR_H = 64;
export const BOARD_TOP = TOOLBAR_H;
export const STATUS_BAR_H = 56;
export const GAME_H = TOOLBAR_H + BOARD_H + STATUS_BAR_H;
export const STATUS_BAR_BG = 0x0d1a10;
export const STATUS_BAR_BG_ALPHA = 0.6;
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

// --- Hover ("живе наведення") ---
export const HOVER_SCALE = 1.05;
export const HOVER_WOBBLE_DEG = 2; // амплітуда «дихання» по куту при наведенні
export const HOVER_WOBBLE_MS = 400;
export const HOVER_MS = 120; // тривалість in/out переходу scale/angle

// --- Press ("фізичне вдавлювання") ---
export const PRESS_SCALE = 0.95;
export const PRESS_DROP = 3; // на скільки px кістка «вдавлюється» вниз
export const PRESS_MS = 90;
export const PRESS_TINT = 0xffe08a; // світло-золотий спалах при натисканні

// --- Error ("заперечна тряска" по заблокованій кістці) ---
export const ERROR_SHAKE_PX = 6;
export const ERROR_SHAKE_MS = 40;
export const ERROR_SHAKE_REPEAT = 4;
export const ERROR_TINT = 0xff5555;
export const ERROR_TINT_MS = 200;

// --- Політ пари до лічильника (заміна падіння вниз при знятті пари) ---
// Двофазний політ: (1) обидві кістки летять до центру екрана й ростуть —
// «зустрічаються»; (2) звідти вже разом дугою летять вниз до лічильника,
// зменшуючись до зникнення.
export const FLIGHT_TO_CENTER_MS = 650;
export const FLIGHT_MERGE_SCALE = 1.35; // до якого розміру кістки виростають у центрі
export const FLIGHT_DOWN_MS = 900;
export const FLIGHT_ARC_LIFT = 90; // наскільки контрольна точка дуги фази 2 зсунута вбік від прямої
export const FLIGHT_CENTER_X = GAME_W / 2;
export const FLIGHT_CENTER_Y = BOARD_TOP + BOARD_H / 2; // центр саме ігрового поля
// Лічильник пар — текст статусу («🀄 Залишилось: N»), притиснутий до лівого
// краю плашки статусу (STATUS_BAR_PADDING у main.js === MARGIN), тож ціль
// польоту — та сама точка, а не центр канваса.
export const FLIGHT_TARGET_X = MARGIN + 60;
export const FLIGHT_TARGET_Y = BOARD_TOP + BOARD_H + STATUS_BAR_H / 2;
