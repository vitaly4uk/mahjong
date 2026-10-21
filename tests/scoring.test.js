import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeScore, liveScore, suitOf } from '../static/game/scoring.js';

// Shared with gameplay/tests.py: ScoringTests — both implementations must
// produce identical numbers for every case in this file.
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/scoring_cases.json', import.meta.url), 'utf8'),
);

for (const { name, input, expected } of cases) {
  test(`computeScore: ${name}`, () => {
    assert.deepEqual(computeScore(input), expected);
  });
}

test('suitOf: groups regular kinds and merges bonus kinds', () => {
  assert.equal(suitOf('Man5'), 'man');
  assert.equal(suitOf('Pin9'), 'pin');
  assert.equal(suitOf('Sou3'), 'sou');
  assert.equal(suitOf('Pei'), 'winds');
  assert.equal(suitOf('Chun'), 'dragons');
  assert.equal(suitOf('Plum'), 'flower');
  assert.equal(suitOf('Winter'), 'season');
});

const live = (pairKinds, extra = {}) => liveScore({
  pairKinds, level: 'normal', hints: 0, undos: 0, shuffles: 0, ...extra,
});

test('liveScore: empty log scores nothing', () => {
  assert.deepEqual(live([]), { total: 0, lastPoints: 0, lastChain: 0 });
});

test('liveScore: same-suit chain grows to the cap, a new suit resets it', () => {
  const kinds = ['Man1', 'Man2', 'Man3', 'Man4', 'Man5', 'Man6'];
  assert.deepEqual(live(kinds.slice(0, 3)).lastChain, 3);
  assert.equal(live(kinds).lastChain, 5);
  assert.equal(live([...kinds, 'Pin1']).lastChain, 1);
});

test('liveScore: penalties lower the total, floor at 0, and no bonuses apply', () => {
  const base = live(['Man1']);
  assert.equal(base.total, 20);
  assert.equal(live(['Man1'], { hints: 1 }).total, 0);
  assert.equal(live(['Man1'], { undos: 1 }).total, 20 - 20);
  assert.equal(live(['Man1', 'Man2'], { undos: 1 }).total, 20 + 40 - 20);
});

test('liveScore: dropping the last pair and re-adding it repeats the numbers', () => {
  const kinds = ['Man1', 'Man2', 'Pin3'];
  const first = live(kinds);
  const again = live([...kinds.slice(0, -1), kinds.at(-1)]);
  assert.deepEqual(again, first);
  assert.equal(live(kinds.slice(0, -1)).lastPoints, 40);
});
