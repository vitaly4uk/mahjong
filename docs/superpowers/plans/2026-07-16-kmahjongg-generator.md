# KMahjongg-Style Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписати вибір пар у генераторі розкладу за схемою KMahjongg (рівномірний random по всій дошці + анти-суміжний фільтр) з трьома `placement`-режимами складності.

**Architecture:** У `static/game/generator.js` зворотна гра лишається, але вибір пари виноситься у два хелпери: `pickSurfacePair` (easy, стара поведінка «верхній фронт + суміжність») і `pickSpreadPair` (normal/hard, рівномірний random усіх вільних з фільтрами). Пресети `DIFFICULTIES` переходять на єдиний параметр `placement`; опції `adjacencyBias` і `crossLayerChance` видаляються. Калібрувальний механізм `generateForDifficulty` не змінюється, смуги win-rate підкручуються за виміром.

**Tech Stack:** Vanilla JS ES-модулі без білда; тести — вбудований runner Node (`node --test 'tests/*.test.js'`).

## Global Constraints

- Спека: `docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md`.
- Чисті модулі: `generator.js` не імпортує Phaser/DOM.
- Публічний API для викликачів не змінюється: `generateForDifficulty(level, rng)`, `generateLayout(rng, options)`, експорти `DIFFICULTIES`, `KINDS`, `isAdjacent` зберігаються.
- `buildPairKinds` і режими `pairScheduling` (`random`/`grouped`/`split`) не змінюються.
- Тести запускати лише формою `node --test 'tests/*.test.js'` (каталог без глоба runner не приймає).
- Коментарі в коді — українською, у стилі наявних.

---

### Task 1: Placement-режими у генераторі

**Files:**
- Modify: `static/game/generator.js` (пресети `DIFFICULTIES`, `tryGenerate`, нові хелпери; видалення `DEFAULT_ADJACENCY_BIAS`, `pickPair`, гілок `crossLayerChance`/`topFree` з `tryGenerate`)
- Modify: `tests/generator.test.js` (нові тести; видалення тестів `adjacencyBias=1: most generated pairs...`, `adjacencyBias=1 layouts survive...`, `crossLayerChance=1: layout is still solvable...`)

**Interfaces:**
- Consumes: `targetPositions`, `posKey`, `isFreePosition` з `./board.js`; наявні `shuffle`, `buildPairKinds`, `isAdjacent`.
- Produces: `generateLayout(rng, { placement, pairScheduling })`, де `placement` ∈ `'surface' | 'uniform' | 'layered'` (дефолт `'uniform'`); `DIFFICULTIES` з полями `{ placement, pairScheduling, winRateBand }`. Порядок пар у результаті: `tiles[2i]`/`tiles[2i+1]` — одна пара (як зараз).

- [ ] **Step 1: Написати нові тести (падатимуть)**

У `tests/generator.test.js` **видалити** три тести: `adjacencyBias=1: most generated pairs are adjacent tiles (averaged over seeds)` (рядки 68–83), `adjacencyBias=1 layouts survive careless play far more often than adjacencyBias=0` (85–101), `crossLayerChance=1: layout is still solvable in generation order (30 seeds)` (136–148). Замість них додати:

```js
test('every placement mode yields a layout solvable in generation order (30 seeds each)', () => {
  for (const placement of ['surface', 'uniform', 'layered']) {
    for (let seed = 1; seed <= 30; seed++) {
      const tiles = generateLayout(mulberry32(seed), { placement });
      const board = new Board(tiles);
      for (let i = 0; i < tiles.length; i += 2) {
        assert.equal(
          board.removePair(tiles[i], tiles[i + 1]), true,
          `${placement} seed ${seed}: pair ${i / 2} not removable`,
        );
      }
      assert.ok(board.isWon(), `${placement} seed ${seed}: board not empty`);
    }
  }
});

test('surface: most pairs are adjacent tiles on one layer (averaged over 20 seeds)', () => {
  let adjacentCount = 0;
  let totalPairs = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const tiles = generateLayout(mulberry32(seed), { placement: 'surface' });
    for (let i = 0; i < tiles.length; i += 2) {
      totalPairs += 1;
      if (isAdjacent(tiles[i], tiles[i + 1])) adjacentCount += 1;
    }
  }
  assert.ok(
    adjacentCount / totalPairs >= 0.75,
    `expected >=75% adjacent pairs, got ${adjacentCount}/${totalPairs}`,
  );
});

test('uniform and layered: pair halves are almost never adjacent (>=99% per seed)', () => {
  for (const placement of ['uniform', 'layered']) {
    for (let seed = 1; seed <= 20; seed++) {
      const tiles = generateLayout(mulberry32(seed), { placement });
      let nonAdjacent = 0;
      const totalPairs = tiles.length / 2;
      for (let i = 0; i < tiles.length; i += 2) {
        if (!isAdjacent(tiles[i], tiles[i + 1])) nonAdjacent += 1;
      }
      assert.ok(
        nonAdjacent / totalPairs >= 0.99,
        `${placement} seed ${seed}: only ${nonAdjacent}/${totalPairs} non-adjacent pairs`,
      );
    }
  }
});

test('layered puts pair halves on different layers far more often than uniform', () => {
  const crossLayerShare = (placement) => {
    let cross = 0;
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const tiles = generateLayout(mulberry32(seed), { placement });
      for (let i = 0; i < tiles.length; i += 2) {
        total += 1;
        if (tiles[i].z !== tiles[i + 1].z) cross += 1;
      }
    }
    return cross / total;
  };
  const layered = crossLayerShare('layered');
  const uniform = crossLayerShare('uniform');
  assert.ok(
    layered >= uniform + 0.2,
    `expected layered (${layered}) to exceed uniform (${uniform}) by >=0.2`,
  );
});
```

- [ ] **Step 2: Переконатися, що нові тести падають**

Run: `node --test 'tests/*.test.js'`
Expected: FAIL — нові тести падають (опція `placement` ігнорується старим кодом: `uniform`/`layered` поводяться як старий дефолт з `adjacencyBias=0.85`, тож анти-суміжний тест провалюється). Старі тести без змін проходять.

- [ ] **Step 3: Реалізація у `generator.js`**

Видалити константу `DEFAULT_ADJACENCY_BIAS` і функцію `pickPair`. Пресети замінити на:

```js
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
```

Додати хелпери (замість `pickPair`):

```js
// Ймовірність у режимі surface обрати суміжну пару, якщо така є на
// верхньому фронті — розклад лишається легким для гри без прорахунку.
const SURFACE_ADJACENCY_BIAS = 0.85;

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
// кандидати є. Якщо фільтр не лишає нікого — bail-out до "будь-яка вільна,
// крім першої": генерація ніколи не застрягає.
function pickSpreadPair(free, rng, requireLayerSplit) {
  const a = free[Math.floor(rng() * free.length)];
  let candidates = free.filter((p) => p !== a && !isAdjacent(p, a));
  if (requireLayerSplit) {
    const crossLayer = candidates.filter((p) => p.z !== a.z);
    if (crossLayer.length > 0) candidates = crossLayer;
  }
  if (candidates.length === 0) candidates = free.filter((p) => p !== a);
  const b = candidates[Math.floor(rng() * candidates.length)];
  return [a, b];
}
```

Переписати `tryGenerate` (гілки `topFree`/`crossLayerChance` зникають):

```js
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
    const [a, b] = placement === 'surface'
      ? pickSurfacePair(free, rng)
      : pickSpreadPair(free, rng, placement === 'layered');

    const kind = pairKinds.pop();
    tiles.push({ x: a.x, y: a.y, z: a.z, kind }, { x: b.x, y: b.y, z: b.z, kind });
    occupied.delete(posKey(a.x, a.y, a.z));
    occupied.delete(posKey(b.x, b.y, b.z));
  }
  return tiles;
}
```

`generateLayout`, `distanceToBand`, `generateForDifficulty`, `CALIBRATION_TRIALS`, `CALIBRATION_ATTEMPTS` — без змін. Коментар над `DIFFICULTIES` про емпіричні спостереження старого генератора (рядки 15–24) видалити разом зі старими пресетами.

- [ ] **Step 4: Прогнати всі тести, крім калібрувального**

Run: `node --test 'tests/*.test.js'`
Expected: усі тести PASS, окрім, можливо, `generateForDifficulty: each level lands its win rate in the target band on average (~20 seeds)` — його смуги калібруються в Task 2. Якщо падає щось інше — лагодити тут.

- [ ] **Step 5: Commit**

```bash
git add static/game/generator.js tests/generator.test.js
git commit -m "feat: KMahjongg-style pair placement with surface/uniform/layered modes"
```

---

### Task 2: Калібрування смуг win-rate

**Files:**
- Modify: `static/game/generator.js` (лише значення `winRateBand` у `DIFFICULTIES`, якщо вимір покаже промах)
- Modify: `docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md` (таблиця смуг — привести до фактичних значень)

**Interfaces:**
- Consumes: `generateLayout`, `measureWinRate` (`simulate.js`), пресети з Task 1.
- Produces: фінальні `winRateBand` для трьох рівнів; зелений калібрувальний тест.

- [ ] **Step 1: Виміряти фактичний розподіл win-rate нового генератора**

Написати одноразовий скрипт у scratchpad (не в репо), який для кожного пресета генерує 20 розкладів `generateLayout(mulberry32(seed), preset)` і друкує win-rate кожного (`measureWinRate(tiles, mulberry32(seed + 777), 40)`), мінімум/максимум/середнє:

```js
// scratchpad/measure.mjs
import { generateLayout, DIFFICULTIES } from '/Users/vitaly4uk/Documents/GitHub/mahjong/static/game/generator.js';
import { measureWinRate } from '/Users/vitaly4uk/Documents/GitHub/mahjong/static/game/simulate.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const [level, preset] of Object.entries(DIFFICULTIES)) {
  const rates = [];
  for (let seed = 1; seed <= 20; seed++) {
    const tiles = generateLayout(mulberry32(seed), preset);
    rates.push(measureWinRate(tiles, mulberry32(seed + 777), 40));
  }
  const avg = rates.reduce((s, r) => s + r, 0) / rates.length;
  console.log(level, 'min', Math.min(...rates), 'avg', avg.toFixed(3), 'max', Math.max(...rates), rates.map((r) => r.toFixed(2)).join(' '));
}
```

Run: `node scratchpad/measure.mjs`
Expected: три рядки зі статистикою. Записати фактичні діапазони.

- [ ] **Step 2: Підкрутити смуги за виміром**

Правило: смуга рівня має накривати центральну масу фактичного розподілу
його пресета, і смуги трьох рівнів мають лишатися розділеними
(easy вище за normal, normal вище за hard; перекриття країв допустиме).
Якщо стартові смуги ([0.65,1] / [0.35,0.65] / [0,0.30]) це вже
задовольняють — нічого не міняти. Інакше — змінити **тільки** числа
`winRateBand` у `DIFFICULTIES` та в таблиці спеки; логіку не чіпати.

- [ ] **Step 3: Прогнати калібрувальний тест**

Run: `node --test 'tests/*.test.js'`
Expected: усі тести PASS, включно з `generateForDifficulty: each level lands its win rate in the target band on average (~20 seeds)`.

- [ ] **Step 4: Commit**

```bash
git add static/game/generator.js docs/superpowers/specs/2026-07-16-kmahjongg-generator-design.md
git commit -m "feat: calibrate win-rate bands for KMahjongg-style generator"
```

---

### Task 3: Ручна перевірка в браузері

`main.js` не змінюється (він викликає `generateForDifficulty`), але фактичну гру треба побачити очима.

**Files:** нічого не змінюється; лише перевірка.

- [ ] **Step 1: Запустити сервер**

Run: `uv run manage.py runserver`
Expected: сервер на `http://127.0.0.1:8000/`.

- [ ] **Step 2: Перевірити три рівні**

Для кожного рівня (easy/normal/hard) почати нову гру і переконатися:
- розклад рендериться повністю (242 кістки), кліки/матчинг працюють;
- на normal/hard пари виду **не** лежать масово на сусідніх клітинках;
- на easy гра відчутно легша (пари часто поруч на поверхні);
- підказка (hint) знаходить пари, undo працює.

- [ ] **Step 3: Фінальний прогін тестів і push**

Run: `node --test 'tests/*.test.js'`
Expected: усі PASS.

```bash
git push dokku main   # деплой — лише якщо користувач підтвердить
```
