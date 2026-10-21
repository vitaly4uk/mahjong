// Scoring formula: a JS twin of gameplay/scoring.py. The server is
// authoritative (it computes the final score on /finish from its own replay
// and counters); this copy is for the live display. Both are verified against
// the same cases in tests/fixtures/scoring_cases.json — change one, change the
// other. A pure module, no Phaser/DOM.
import { DRAGONS, WINDS, matchKey } from './board.js';

export const LEVEL_MULTIPLIER = { easy: 1, normal: 2, hard: 3 };
export const PAIR_BASE = 10;
export const CHAIN_CAP = 5;
export const HINT_PENALTY = 20;
export const UNDO_PENALTY = 10;
export const SHUFFLE_PENALTY = 20;
// A win with no hints/undos/shuffles earns 1/NO_HELP_BONUS_DIVISOR of the
// pair points.
export const NO_HELP_BONUS_DIVISOR = 2;
export const TIME_BONUS_BASE_SECONDS = 600;

// Chain group of a tile kind: man/pin/sou, winds, dragons, flower, season.
// Flowers and seasons are wildcard groups (matchKey), so the suit of a bonus
// pair is its group, not its exact kind.
export function suitOf(kind) {
  const key = matchKey(kind);
  if (key === 'flower' || key === 'season') return key;
  if (WINDS.includes(key)) return 'winds';
  if (DRAGONS.includes(key)) return 'dragons';
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
      noHelpBonus = Math.floor(pairTotal / NO_HELP_BONUS_DIVISOR);
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

// Live (in-game) display numbers: no bonuses, penalties included. Client-only,
// no Python twin — the server only scores a finished game. `lastChain` is the
// chain multiplier applied to the most recent pair (1..CHAIN_CAP), recovered
// from computeScore's own per-pair points rather than re-deriving the chain.
export function liveScore({
  pairKinds, level, hints, undos, shuffles,
}) {
  const { total, pairPoints } = computeScore({
    pairKinds, level, hints, undos, shuffles, elapsedMs: 0, won: false,
  });
  const lastPoints = pairPoints.at(-1) ?? 0;
  const lastChain = lastPoints / (PAIR_BASE * LEVEL_MULTIPLIER[level]);
  return { total, lastPoints, lastChain };
}
