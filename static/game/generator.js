import { targetPositions, posKey, isFreePosition } from './board.js';
import { measureWinRate } from './simulate.js';

export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

// Пресети рівнів складності (див. docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md).
// placement — режим вибору позицій для половинок пари:
// - surface — обидві з верхнього фронту знімання, з перевагою суміжних
//   (механізм полегшення за Kristanix Mahjong Epic);
// - uniform — чиста схема KMahjongg: рівномірний random усіх вільних,
//   друга половинка не може бути суміжною з першою;
// - layered — uniform + половинки принудово на різних шарах, коли можливо
//   (вертикальне запирання виду, arXiv:1203.6559).
// winRateBand — цільова смуга частки перемог "неуважного гравця" (simulate.js);
// стартові значення, калібруються тестом generateForDifficulty.
export const DIFFICULTIES = {
  easy: { placement: 'surface', pairScheduling: 'random', winRateBand: [0.65, 1] },
  normal: { placement: 'uniform', pairScheduling: 'random', winRateBand: [0.35, 0.65] },
  hard: { placement: 'layered', pairScheduling: 'grouped', winRateBand: [0, 0.30] },
};

const CALIBRATION_TRIALS = 16;
const CALIBRATION_ATTEMPTS = 30;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 121 вид пари: 19 випадкових видів по 4 пари + 15 видів по 3 пари.
// pairScheduling визначає порядок пар у черзі; знімаються вони з кінця
// (pop()) і кладуться в розклад шар-за-шаром згори вниз — тобто початок
// черги (index 0) відповідає найглибшим позиціям розкладу ("дно").
//
// - random  — повне тасування (поточна/дефолтна поведінка).
// - grouped — усі пари одного виду стоять поспіль (порядок видів тасується,
//   але пари всередині виду — ні): копії виду відкриваються одночасно.
// - split   — пари одного виду розкидані по протилежних половинах черги:
//   одна пара лягає на дно, друга — на поверхню.
function buildPairKinds(rng, pairScheduling = 'random') {
  const kinds = shuffle([...KINDS], rng);
  const kindPairs = kinds.map((kind, i) => ({ kind, pairs: i < 19 ? 4 : 3 }));

  if (pairScheduling === 'grouped') {
    const pairKinds = [];
    for (const { kind, pairs } of kindPairs) {
      for (let p = 0; p < pairs; p++) pairKinds.push(kind);
    }
    return pairKinds;
  }

  if (pairScheduling === 'split') {
    const bottom = [];
    const top = [];
    for (const { kind, pairs } of kindPairs) {
      const half = Math.floor(pairs / 2);
      for (let p = 0; p < half; p++) bottom.push(kind);
      for (let p = half; p < pairs; p++) top.push(kind);
    }
    return [...shuffle(bottom, rng), ...shuffle(top, rng)];
  }

  const pairKinds = [];
  for (const { kind, pairs } of kindPairs) {
    for (let p = 0; p < pairs; p++) pairKinds.push(kind);
  }
  return shuffle(pairKinds, rng);
}

// Дві позиції суміжні, якщо лежать в одному шарі впритул одна до одної.
export function isAdjacent(a, b) {
  return a.z === b.z && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

// Ймовірність у режимі surface обрати суміжну пару, якщо така є на
// верхньому фронті — розклад лишається легким для гри без прорахунку.
const SURFACE_ADJACENCY_BIAS = 0.9;

// surface: обидві половинки з найвищого незавершеного шару (він пласкій і
// не має нічого зверху, тож завжди має ≥1 вільну кість), з перевагою
// суміжних пар. Непарний хвіст шару (єдина вільна кість) спарюється з
// довільною вільною кісткою нижче.
function pickSurfacePair(free, rng) {
  const maxZ = Math.max(...free.map((p) => p.z));
  const topFree = free.filter((p) => p.z === maxZ);
  if (topFree.length === 1) {
    const a = topFree[0];
    const rest = free.filter((p) => p !== a);
    return [a, rest[Math.floor(rng() * rest.length)]];
  }
  if (rng() < SURFACE_ADJACENCY_BIAS) {
    const adjacentPairs = [];
    for (let i = 0; i < topFree.length; i++) {
      for (let j = i + 1; j < topFree.length; j++) {
        if (isAdjacent(topFree[i], topFree[j])) {
          adjacentPairs.push([topFree[i], topFree[j]]);
        }
      }
    }
    if (adjacentPairs.length > 0) {
      return adjacentPairs[Math.floor(rng() * adjacentPairs.length)];
    }
  }
  const shuffled = shuffle([...topFree], rng);
  return [shuffled[0], shuffled[1]];
}

// uniform/layered: перша половинка — рівномірно випадкова вільна позиція,
// друга — рівномірно випадкова з тих, що не суміжні з першою (KMahjongg,
// selectPosition). У layered додатково вимагається інший шар, коли такі
// кандидати є. Якщо фільтр не лишає нікого — bail-out на інші шари, потім на
// будь-яку: генерація ніколи не застрягає.
function pickSpreadPair(free, rng, requireLayerSplit) {
  const a = free[Math.floor(rng() * free.length)];
  let candidates = free.filter((p) => p !== a && !isAdjacent(p, a));

  if (requireLayerSplit) {
    const crossLayer = candidates.filter((p) => p.z !== a.z);
    if (crossLayer.length > 0) {
      candidates = crossLayer;
    } else if (candidates.length === 0) {
      // No non-adjacent; try cross-layer without adjacency constraint
      candidates = free.filter((p) => p !== a && p.z !== a.z);
      if (candidates.length === 0) {
        candidates = free.filter((p) => p !== a);
      }
    }
  } else if (candidates.length === 0) {
    // uniform: no non-adjacent found; try cross-layer, then any
    candidates = free.filter((p) => p !== a && p.z !== a.z);
    if (candidates.length === 0) {
      candidates = free.filter((p) => p !== a);
    }
  }

  const b = candidates[Math.floor(rng() * candidates.length)];
  return [a, b];
}

// Симуляція зворотної гри: з повної форми знімаються пари вільних позицій,
// записаний порядок зняття і є розв'язком. Будь-яка пара вільних позицій
// валідна за побудовою, тож кандидати — всі вільні позиції дошки; режим
// placement визначає, як саме обираються половинки пари (див. DIFFICULTIES).
function tryGenerate(rng, { placement = 'uniform', pairScheduling = 'random' } = {}) {
  const occupied = new Map(
    targetPositions().map((p) => [posKey(p.x, p.y, p.z), p]),
  );
  const pairKinds = buildPairKinds(rng, pairScheduling);
  const tiles = [];
  while (occupied.size > 0) {
    const free = [...occupied.values()].filter(
      (p) => isFreePosition(occupied, p.x, p.y, p.z),
    );
    const maxZ = Math.max(...free.map((p) => p.z));
    const topFree = free.filter((p) => p.z === maxZ);

    let a;
    let b;
    if (topFree.length === 1) {
      // Непарний хвіст верхнього шару: єдина вільна кість на верхньому шарі
      // спарюється з довільною вільною кісткою нижче.
      a = topFree[0];
      const rest = free.filter((p) => p !== a);
      b = rest[Math.floor(rng() * rest.length)];
    } else if (placement === 'surface') {
      [a, b] = pickSurfacePair(free, rng);
    } else {
      [a, b] = pickSpreadPair(free, rng, placement === 'layered');
    }

    const kind = pairKinds.pop();
    tiles.push({ x: a.x, y: a.y, z: a.z, kind }, { x: b.x, y: b.y, z: b.z, kind });
    occupied.delete(posKey(a.x, a.y, a.z));
    occupied.delete(posKey(b.x, b.y, b.z));
  }
  return tiles;
}

export function generateLayout(rng = Math.random, options = {}) {
  return tryGenerate(rng, options);
}

// Найближча відстань значення до інтервалу [lo, hi]; 0, якщо значення в межах.
function distanceToBand(value, [lo, hi]) {
  if (value < lo) return lo - value;
  if (value > hi) return value - hi;
  return 0;
}

// Генерація з гарантією виміряної складності: до CALIBRATION_ATTEMPTS спроб
// згенерувати розклад пресетом рівня і виміряти win-rate бота-валідатора;
// приймається перший, що влучив у цільову смугу. Якщо жоден не влучив —
// повертається найближчий до смуги кандидат (гра ніколи не лишається без
// розкладу).
export function generateForDifficulty(level, rng = Math.random) {
  const preset = DIFFICULTIES[level];
  let best = null;
  let bestDistance = Infinity;
  for (let attempt = 0; attempt < CALIBRATION_ATTEMPTS; attempt++) {
    const tiles = generateLayout(rng, preset);
    const rate = measureWinRate(tiles, rng, CALIBRATION_TRIALS);
    const distance = distanceToBand(rate, preset.winRateBand);
    if (distance === 0) return tiles;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tiles;
    }
  }
  return best;
}
