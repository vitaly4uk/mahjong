"""Scoring formula: a Python twin of static/game/scoring.js. The server is
authoritative (gameplay/api.py: finish_game computes the final score from its
own replay and counters); the JS copy only drives the live display. Both are
verified against the same cases in tests/fixtures/scoring_cases.json — change
one, change the other. The numbers are starting values, to be tuned after
playtesting."""
from .board import match_key
from .schemas import ScoreResult

LEVEL_MULTIPLIER = {'easy': 1, 'normal': 2, 'hard': 3}
PAIR_BASE = 10
CHAIN_CAP = 5
HINT_PENALTY = 20
UNDO_PENALTY = 10
SHUFFLE_PENALTY = 20
# A win with no hints/undos/shuffles earns this share of the pair points.
NO_HELP_BONUS_NUM = 1
NO_HELP_BONUS_DEN = 2
TIME_BONUS_BASE_SECONDS = 600

_WINDS = frozenset({'Ton', 'Nan', 'Shaa', 'Pei'})
_DRAGONS = frozenset({'Haku', 'Hatsu', 'Chun'})


def suit_of(kind):
    """Chain group of a tile kind: man/pin/sou, winds, dragons, flower,
    season. Flowers and seasons are wildcard groups (board.match_key), so the
    suit of a bonus pair is its group, not its exact kind."""
    key = match_key(kind)
    if key in ('flower', 'season'):
        return key
    if key in _WINDS:
        return 'winds'
    if key in _DRAGONS:
        return 'dragons'
    return key[:3].lower()


def compute_score(pair_kinds, level, hints, undos, shuffles, elapsed_ms, won):
    """`pair_kinds` — the kind of each removed pair in removal order (undone
    moves are not in it). A lost game still scores pairs minus penalties, with
    no bonuses; the total is never below 0."""
    mult = LEVEL_MULTIPLIER[level]

    pair_points = []
    prev_suit = None
    run = 0
    for kind in pair_kinds:
        suit = suit_of(kind)
        run = run + 1 if suit == prev_suit else 1
        prev_suit = suit
        pair_points.append(PAIR_BASE * mult * min(run, CHAIN_CAP))
    pair_total = sum(pair_points)

    hint_penalty = hints * HINT_PENALTY * mult
    undo_penalty = undos * UNDO_PENALTY * mult
    shuffle_penalty = shuffles * SHUFFLE_PENALTY * mult

    no_help_bonus = time_bonus = 0
    if won:
        if hints == 0 and undos == 0 and shuffles == 0:
            no_help_bonus = pair_total * NO_HELP_BONUS_NUM // NO_HELP_BONUS_DEN
        time_bonus = max(0, TIME_BONUS_BASE_SECONDS - elapsed_ms // 1000) * mult

    total = max(
        0,
        pair_total + no_help_bonus + time_bonus - hint_penalty - undo_penalty - shuffle_penalty,
    )
    return ScoreResult(
        total=total, pair_points=pair_points, hint_penalty=hint_penalty,
        undo_penalty=undo_penalty, shuffle_penalty=shuffle_penalty,
        no_help_bonus=no_help_bonus, time_bonus=time_bonus,
    )
