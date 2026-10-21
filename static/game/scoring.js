// Scoring formula: a JS twin of gameplay/scoring.py. The server is
// authoritative (it computes the final score on /finish from its own replay
// and counters); this copy is for the live display. Both are verified against
// the same cases in tests/fixtures/scoring_cases.json — change one, change the
// other. A pure module, no Phaser/DOM.
import { matchKey } from './board.js';

export const LEVEL_MULTIPLIER = { easy: 1, normal: 2, hard: 3 };
export const PAIR_BASE = 10;
export const CHAIN_CAP = 5;
export const HINT_PENALTY = 20;
export const UNDO_PENALTY = 10;
export const SHUFFLE_PENALTY = 20;
// A win with no hints/undos/shuffles earns this share of the pair points
// (as the numerator over NO_HELP_BONUS_DEN).
export const NO_HELP_BONUS_NUM = 1;
export const NO_HELP_BONUS_DEN = 2;
export const TIME_BONUS_BASE_SECONDS = 600;

const WINDS = new Set(['Ton', 'Nan', 'Shaa', 'Pei']);
const DRAGONS = new Set(['Haku', 'Hatsu', 'Chun']);

// Chain group of a tile kind: man/pin/sou, winds, dragons, flower, season.
// Flowers and seasons are wildcard groups (matchKey), so the suit of a bonus
// pair is its group, not its exact kind.
export function suitOf(kind) {
  const key = matchKey(kind);
  if (key === 'flower' || key === 'season') return key;
  if (WINDS.has(key)) return 'winds';
  if (DRAGONS.has(key)) return 'dragons';
  return key.slice(0, 3).toLowerCase();
}

// pairKinds — the kind of each removed pair, in removal order (undone moves
// are not in it). Returns the total plus the breakdown; keys match
// gameplay/schemas.py: ScoreResult (by alias).
export function computeScore({
  pairKinds, level, hints, undos, shuffles, elapsedMs, won,
}) {
  const mult = LEVEL_MULTIPLIER[level];

  const pairPoints = [];
  let prevSuit = null;
  let run = 0;
  for (const kind of pairKinds) {
    const suit = suitOf(kind);
    run = suit === prevSuit ? run + 1 : 1;
    prevSuit = suit;
    pairPoints.push(PAIR_BASE * mult * Math.min(run, CHAIN_CAP));
  }
  const pairTotal = pairPoints.reduce((sum, p) => sum + p, 0);

  const hintPenalty = hints * HINT_PENALTY * mult;
  const undoPenalty = undos * UNDO_PENALTY * mult;
  const shufflePenalty = shuffles * SHUFFLE_PENALTY * mult;

  let noHelpBonus = 0;
  let timeBonus = 0;
  if (won) {
    if (hints === 0 && undos === 0 && shuffles === 0) {
      noHelpBonus = Math.floor((pairTotal * NO_HELP_BONUS_NUM) / NO_HELP_BONUS_DEN);
    }
    const seconds = Math.floor(elapsedMs / 1000);
    timeBonus = Math.max(0, TIME_BONUS_BASE_SECONDS - seconds) * mult;
  }

  const total = Math.max(
    0,
    pairTotal + noHelpBonus + timeBonus - hintPenalty - undoPenalty - shufflePenalty,
  );
  return {
    total, pairPoints, hintPenalty, undoPenalty, shufflePenalty, noHelpBonus, timeBonus,
  };
}
