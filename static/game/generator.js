import { targetPositions, posKey, isFreePosition } from './board.js';
import { measureWinRate } from './simulate.js';

export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

// Дефолтна сила "тримати парні кості поруч" — розклад лишається легким для
// гри без прорахунку наперед (див. docs/superpowers/specs).
const DEFAULT_ADJACENCY_BIAS = 0.85;

// Пресети рівнів складності (див. docs/superpowers/specs/2026-07-16-*).
// winRateBand — цільова смуга частки перемог "неуважного гравця" (simulate.js).
//
// Значення підібрані емпірично (калібрувальний тест генератора вимірює
// фактичний win-rate на ~20 сідах): "неуважний бот" завжди тягнеться до
// верхнього шару, тож adjacencyBias і crossLayerChance впливають на нього
// слабше, ніж очікувалось з першого наближення, а pairScheduling='grouped'
// (усі копії виду концентруються у вузькому вікні генерації) виявився
// найсильнішим важелем ускладнення, а не спрощення, як припускалось спершу —
// саме тому тут пресет hard, а не easy, використовує 'grouped'.
export const DIFFICULTIES = {
  easy: {
    adjacencyBias: 1, pairScheduling: 'random', crossLayerChance: 0, winRateBand: [0.65, 1],
  },
  normal: {
    adjacencyBias: 0, pairScheduling: 'split', crossLayerChance: 0, winRateBand: [0.45, 0.65],
  },
  hard: {
    adjacencyBias: 1, pairScheduling: 'grouped', crossLayerChance: 1, winRateBand: [0, 0.30],
  },
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

function pickPair(candidates, rng, adjacencyBias) {
  if (rng() < adjacencyBias) {
    const adjacentPairs = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (isAdjacent(candidates[i], candidates[j])) {
          adjacentPairs.push([candidates[i], candidates[j]]);
        }
      }
    }
    if (adjacentPairs.length > 0) {
      return adjacentPairs[Math.floor(rng() * adjacentPairs.length)];
    }
  }
  const shuffled = shuffle([...candidates], rng);
  return [shuffled[0], shuffled[1]];
}

// Симуляція зворотної гри: знімаємо шар за шаром згори вниз (найвищий
// незавершений шар завжди має ≥2 вільні кості — він пласкій і не має нічого
// зверху, тож ніколи не "запирається"), надаючи парам видів по ходу.
// Записаний порядок зняття і є розв'язком.
//
// crossLayerChance: з цією ймовірністю кандидатами для пари стають усі вільні
// позиції (а не лише найвищий шар) — розв'язок починає стрибати між шарами.
// Розв'язність не страждає: будь-яка пара вільних позицій у зворотній
// симуляції валідна за побудовою.
function tryGenerate(rng, {
  adjacencyBias = DEFAULT_ADJACENCY_BIAS,
  pairScheduling = 'random',
  crossLayerChance = 0,
} = {}) {
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
      // Непарний хвіст шару: єдина вільна кість на верхньому шарі спарюється
      // з довільною вільною кісткою нижче. Не крос-шаровий вибір — topFree
      // гарантовано непорожній (крайня колонка шару), тож free тут завжди
      // містить ≥2 елементи.
      a = topFree[0];
      const rest = free.filter((p) => p !== a);
      b = rest[Math.floor(rng() * rest.length)];
    } else {
      // topFree.length >= 2, отже і candidates тут завжди має ≥2 елементи.
      const crossLayer = rng() < crossLayerChance;
      const candidates = crossLayer ? free : topFree;
      [a, b] = pickPair(candidates, rng, adjacencyBias);
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
