import { targetPositions, posKey, isFreePosition } from './board.js';

export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

// Дефолтна сила "тримати парні кості поруч" — розклад лишається легким для
// гри без прорахунку наперед (див. docs/superpowers/specs).
const DEFAULT_ADJACENCY_BIAS = 0.85;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 121 вид пари: 19 випадкових видів по 4 пари + 15 видів по 3 пари.
function buildPairKinds(rng) {
  const kinds = shuffle([...KINDS], rng);
  const pairKinds = [];
  kinds.forEach((kind, i) => {
    const pairs = i < 19 ? 4 : 3;
    for (let p = 0; p < pairs; p++) pairKinds.push(kind);
  });
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
function tryGenerate(rng, { adjacencyBias = DEFAULT_ADJACENCY_BIAS } = {}) {
  const occupied = new Map(
    targetPositions().map((p) => [posKey(p.x, p.y, p.z), p]),
  );
  const pairKinds = buildPairKinds(rng);
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
      // з довільною вільною кісткою нижче.
      a = topFree[0];
      const rest = free.filter((p) => p !== a);
      b = rest[Math.floor(rng() * rest.length)];
    } else {
      [a, b] = pickPair(topFree, rng, adjacencyBias);
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
