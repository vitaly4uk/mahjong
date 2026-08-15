"""Daily tournament: everyone gets the identical, deterministic, solvable
board for a given local calendar day (gameplay/api.py: daily_info/start_daily
use timezone.localdate() as the day boundary). Board/seed derive purely from
the date — no DB state, no scheduling, nothing to configure per day.
"""
from .layouts import load_layouts

# The daily tournament is always 'normal' difficulty — a single leaderboard
# per day, comparable across players, rather than one per difficulty level.
DAILY_LEVEL = 'normal'

# Score penalties for hints/undos (server-authoritative counters on
# GameSession, incremented via the existing /bump endpoint — gameplay/api.py:
# bump_stat). Lower score wins; only used for daily tournament ranking, not
# for lifetime stats.
HINT_PENALTY_MS = 5_000
UNDO_PENALTY_MS = 3_000


def daily_challenge(date):
    """(board_slug, level, seed) for the given date.date — identical for
    every player, deterministic across processes/restarts. level is always
    DAILY_LEVEL; only the board rotates day to day for variety. The seed is
    plain text derived from the date, not a secret."""
    # load_layouts() is lru_cached and already returns slugs in sorted order.
    slugs = list(load_layouts())
    ordinal = date.toordinal()
    board_slug = slugs[ordinal % len(slugs)]
    seed = f'daily-{date.isoformat()}'
    return board_slug, DAILY_LEVEL, seed


def nickname_for(profile):
    """Display name for the leaderboard/toolbar: the player's own choice
    (gameplay/models.py: Profile.display_name) if set, else an
    auto-generated one derived from public_id. This is the single source of
    truth for "what name is shown" — it's also the DiceBear avatar seed
    (static/game/avatar.js), so the client never needs a separate seed."""
    if profile.display_name:
        return profile.display_name
    return f'Player #{profile.public_id.hex[:4]}'
