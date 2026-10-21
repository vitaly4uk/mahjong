import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeScore, suitOf } from '../static/game/scoring.js';

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
