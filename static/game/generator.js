import { targetPositions, posKey, isFreePosition } from './board.js';

export const KINDS = [
  ...['Man', 'Pin', 'Sou'].flatMap(
    (suit) => Array.from({ length: 9 }, (_, i) => `${suit}${i + 1}`),
  ),
  'Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun',
];

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

// Симуляція зворотної гри: знімаємо випадкові вільні пари з повної форми,
// призначаючи видам порядок зняття. Результат розв'язний за побудовою —
// записаний порядок зняття і є розв'язком.
function tryGenerate(rng) {
  const occupied = new Map(
    targetPositions().map((p) => [posKey(p.x, p.y, p.z), p]),
  );
  const pairKinds = buildPairKinds(rng);
  const tiles = [];
  while (occupied.size > 0) {
    const free = [...occupied.values()].filter(
      (p) => isFreePosition(occupied, p.x, p.y, p.z),
    );
    if (free.length < 2) return null;
    shuffle(free, rng);
    const [a, b] = free;
    const kind = pairKinds.pop();
    tiles.push({ x: a.x, y: a.y, z: a.z, kind }, { x: b.x, y: b.y, z: b.z, kind });
    occupied.delete(posKey(a.x, a.y, a.z));
    occupied.delete(posKey(b.x, b.y, b.z));
  }
  return tiles;
}

export function generateLayout(rng = Math.random) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const tiles = tryGenerate(rng);
    if (tiles) return tiles;
  }
  throw new Error('Failed to generate a solvable layout after 100 attempts');
}
