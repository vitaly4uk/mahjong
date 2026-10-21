import datetime
import importlib
import json
import random
import uuid
from datetime import timedelta
from io import StringIO

from django.apps import apps as django_apps
from django.conf import settings
from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .api import (  # noqa: F401 (SESSION_TTL import also registers the router when this module loads)
    RATE_LIMIT_MAX_BUMPS,
    RATE_LIMIT_MAX_IMPORTS,
    RATE_LIMIT_MAX_SHUFFLES,
    SESSION_TTL,
)
from .board import FLOWERS, SEASONS, Board, Tile, is_free_position, match_key
from .daily import daily_challenge
from .generator import DIFFICULTIES, KINDS, generate_for_difficulty, reshuffle_layout
from .layouts import (
    LAYOUTS_DIR,
    LayoutError,
    board_thumbnail,
    get_layout,
    list_boards,
    load_layouts,
    parse_layout,
)
from .middleware import NEW_PROFILE_RATE_LIMIT, PLAYER_COOKIE_NAME
from .models import GameSession, Profile
from .ratelimit import IpRateThrottle
from .schemas import AllStats, LevelStats, OverallStats
from .scoring import compute_score, suit_of
from .stats import apply_best_score, apply_loss, apply_score, apply_win, merge_imported


class LayoutParserTests(TestCase):
    """Coverage for gameplay/layouts.py — parsing the kmahjongg-format
    `.layout` files in layouts/ (project root)."""

    def test_turtle_layout_is_144_tiles_with_authentic_layer_split(self):
        layout = get_layout('turtle')
        self.assertIsNotNone(layout)
        self.assertEqual(len(layout.positions), 144)
        by_layer = [0, 0, 0, 0, 0]
        for _, _, z in layout.positions:
            by_layer[z] += 1
        self.assertEqual(by_layer, [87, 36, 16, 4, 1])

    def test_turtle_layout_known_coordinates(self):
        """Spot-checks against the shape this project has always used
        (formerly hardcoded in board.py: _TURTLE_CELLS) — the head/tail
        protrusions and the peak apex, all on ODD half-tile coordinates."""
        positions = set(get_layout('turtle').positions)
        self.assertIn((0, 7, 0), positions)  # head
        self.assertIn((26, 7, 0), positions)  # tail
        self.assertIn((28, 7, 0), positions)  # tail
        self.assertIn((13, 7, 4), positions)  # peak apex
        self.assertNotIn((0, 0, 0), positions)  # shell corner is absent

    def test_all_bundled_boards_are_144_tiles(self):
        for slug, layout in load_layouts().items():
            self.assertEqual(len(layout.positions), 144, slug)
            self.assertEqual(len(set(layout.positions)), 144, f'{slug}: duplicate position')

    @override_settings(LANGUAGE_CODE='en')
    def test_list_boards_exposes_slug_and_name(self):
        # Asserts the English msgid itself (list_boards() translates it via
        # the active language, gameplay/layouts.py) — pin the language so this
        # doesn't depend on LANGUAGE_CODE's default (uk).
        boards = list_boards()
        slugs = {b['slug'] for b in boards}
        self.assertIn('turtle', slugs)
        turtle = next(b for b in boards if b['slug'] == 'turtle')
        self.assertEqual(turtle['name'], 'Turtle')

    def test_get_layout_unknown_slug_returns_none(self):
        self.assertIsNone(get_layout('does-not-exist'))

    def test_board_thumbnail_renders_one_rect_per_tile(self):
        for slug in load_layouts():
            svg = board_thumbnail(slug)
            self.assertTrue(svg.startswith('<svg'), slug)
            self.assertIn('viewBox', svg)
            self.assertEqual(svg.count('<rect'), 144, slug)

    def test_board_thumbnail_unknown_slug_returns_none(self):
        self.assertIsNone(board_thumbnail('does-not-exist'))

    def test_list_boards_includes_thumbnail(self):
        for board in list_boards():
            self.assertIn('<svg', board['thumbnail'])

    def test_parse_layout_rejects_unknown_header(self):
        with self.assertRaises(LayoutError):
            parse_layout('not-a-kmahjongg-header\n', 'bad')

    def test_parse_layout_rejects_wrong_tile_count(self):
        # A minimal well-formed but tiny grid — nowhere near 144 tiles.
        text = 'kmahjongg-layout-v1.1\nw4\nh4\nd1\n1234\n4321\n....\n....\n'
        with self.assertRaises(LayoutError):
            parse_layout(text, 'tiny')

    def test_parse_layout_rejects_broken_quadrant(self):
        # A '1' anchor whose neighbouring quadrants aren't 2/3/4 — corrupted grid.
        text = 'kmahjongg-layout-v1.1\nw4\nh4\nd1\n1.1.\n....\n....\n....\n'
        with self.assertRaises(LayoutError):
            parse_layout(text, 'broken')

    def test_real_turtle_layout_file_parses_and_matches_get_layout(self):
        text = (LAYOUTS_DIR / 'turtle.layout').read_text(encoding='utf-8')
        layout = parse_layout(text, 'turtle')
        self.assertEqual(set(layout.positions), set(get_layout('turtle').positions))


class BoardRuleTests(TestCase):
    def test_wildcard_flowers_and_seasons_match_within_group(self):
        # Two DIFFERENT flowers match (same group); a flower and a season don't.
        plum = Tile(0, 0, 0, 0, 'Plum')
        orchid = Tile(1, 1, 0, 0, 'Orchid')
        spring = Tile(2, 3, 0, 0, 'Spring')
        board = Board([plum, orchid, spring])
        self.assertEqual(match_key('Plum'), match_key('Orchid'))
        self.assertNotEqual(match_key('Plum'), match_key('Spring'))
        self.assertTrue(board.can_match(plum, orchid))
        self.assertFalse(board.can_match(plum, spring))

    def test_is_free_position_blocked_by_tile_above(self):
        occupied = {(0, 0, 0), (0, 0, 1)}
        self.assertFalse(is_free_position(occupied, 0, 0, 0))

    def test_is_free_position_above_tolerates_half_tile_offset(self):
        """kmahjongg's rule: the 3×3 window on the layer above catches overlap
        even if the tile above it is offset to an odd (half-tile) coordinate —
        this is exactly how the peak apex (13,7) covers all four base tiles
        (12/14,6/8)."""
        occupied = {
            (12, 6, 0), (12, 8, 0), (14, 6, 0), (14, 8, 0),
            (13, 7, 1),
        }
        for x, y in ((12, 6), (12, 8), (14, 6), (14, 8)):
            self.assertFalse(is_free_position(occupied, x, y, 0), f'{(x, y)} should be covered')

    def test_is_free_position_blocked_both_sides(self):
        occupied = {(2, 0, 0), (0, 0, 0), (4, 0, 0)}
        self.assertFalse(is_free_position(occupied, 2, 0, 0))

    def test_is_free_position_free_with_one_open_side(self):
        occupied = {(2, 0, 0), (0, 0, 0)}
        self.assertTrue(is_free_position(occupied, 2, 0, 0))

    def test_is_free_position_side_check_tolerates_half_row_offset(self):
        """The head (0,7) is on an odd y; the only real neighbours in column 2
        stand at y=6 and y=8 (even) — both should block the right side."""
        occupied = {(0, 7, 0), (2, 6, 0), (2, 8, 0)}
        # Right side is occupied by both; left side (x=-2) is off the board — always free.
        self.assertTrue(is_free_position(occupied, 0, 7, 0))

    def test_remove_pair_and_find_matching_pair(self):
        tiles = [Tile(0, 0, 0, 0, 'Man1'), Tile(1, 2, 0, 0, 'Man1')]
        board = Board(tiles)
        pair = board.find_matching_pair()
        self.assertIsNotNone(pair)
        self.assertTrue(board.remove_pair(*pair))
        self.assertTrue(board.is_won())

    def test_remove_pair_rejects_non_matching_and_covered(self):
        bottom = Tile(0, 0, 0, 0, 'Man1')
        top = Tile(1, 0, 0, 1, 'Pin1')
        board = Board([bottom, top])
        self.assertFalse(board.remove_pair(bottom, top))  # different kind
        self.assertFalse(board.is_free(bottom))  # covered from above

    def test_is_deadlocked_when_no_free_pair_exists(self):
        blocked_man = Tile(0, 2, 0, 0, 'Man1')
        pin1 = Tile(1, 0, 0, 0, 'Pin1')
        pin2 = Tile(2, 4, 0, 0, 'Pin2')
        free_man = Tile(3, 8, 8, 0, 'Man1')
        board = Board([pin1, blocked_man, pin2, free_man])
        self.assertIsNone(board.find_matching_pair())
        self.assertTrue(board.is_deadlocked())
        self.assertFalse(board.is_won())


def _solve(tiles):
    """A greedy solver: removes any legal pair for as long as possible.
    True if the board is fully cleared — proves the field is solvable."""
    board = Board([Tile(i, x, y, z, kind) for i, (x, y, z, kind) in enumerate(tiles)])
    while board.remaining > 0:
        pair = board.find_matching_pair()
        if pair is None:
            return False
        board.remove_pair(*pair)
    return True


class GeneratorTests(TestCase):
    def test_generated_layout_is_solvable_across_seeds_and_boards(self):
        for slug, layout in load_layouts().items():
            for level in DIFFICULTIES:
                for seed in range(10):
                    tiles = generate_for_difficulty(level, layout, seed=f'{slug}-{level}-{seed}')
                    self.assertEqual(
                        len(tiles), 144, f'{slug}/{level} seed={seed}: expected 144 tiles',
                    )
                    self.assertTrue(
                        _solve(tiles), f'{slug}/{level} seed={seed}: board is unsolvable',
                    )

    def test_generated_layout_is_authentic_deck(self):
        """A full mahjong deck: 34 regular kinds × 4 copies + 8 bonus
        (flowers/seasons) × 1 copy = 144 tiles."""
        tiles = generate_for_difficulty('normal', get_layout('turtle'), seed=1)
        kinds = [kind for _, _, _, kind in tiles]
        self.assertEqual(len(kinds), 144)
        regular = {k for k in kinds if match_key(k) == k}
        bonus = {k for k in kinds if match_key(k) != k}
        self.assertEqual(len(regular), 34)
        self.assertEqual(len(bonus), 8)
        for kind in regular:
            self.assertEqual(kinds.count(kind), 4, f'{kind}: expected 4 copies')
        for kind in bonus:
            self.assertEqual(kinds.count(kind), 1, f'{kind}: expected 1 copy')

    def test_generate_for_difficulty_deterministic_by_seed(self):
        turtle = get_layout('turtle')
        a = generate_for_difficulty('hard', turtle, seed=42)
        b = generate_for_difficulty('hard', turtle, seed=42)
        self.assertEqual(a, b)

    def test_reshuffle_layout_preserves_positions_and_kind_multiset_and_is_solvable(self):
        """reshuffle_layout is used mid-game (an arbitrary remaining subset,
        not the full 72-pair deck, gameplay/api.py: shuffle_game) — it must
        never move a tile, never change the multiset of kinds, and must still
        guarantee solvability for that subset."""
        positions = [(0, 0, 0), (2, 0, 0), (4, 0, 0), (6, 0, 0)]
        kinds = ['Man1', 'Man1', 'Pin1', 'Pin1']
        for seed in range(10):
            rng = random.Random(seed)
            tiles = reshuffle_layout(rng, positions, kinds, placement='uniform')
            self.assertEqual({(x, y, z) for x, y, z, _ in tiles}, set(positions), seed)
            self.assertEqual(sorted(kind for *_, kind in tiles), sorted(kinds), seed)
            self.assertTrue(_solve(tiles), f'seed={seed}: unsolvable')


class GameApiTests(TestCase):
    def setUp(self):
        # Rate-limit counters (gameplay/ratelimit.py: IpRateThrottle, used
        # via each route's throttle= kwarg) live in Django's cache, not the
        # DB — TestCase's transaction rollback never
        # clears them, so calls from any earlier test in the same process
        # would otherwise carry over and eventually trip a real 429 here.
        cache.clear()

    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _win_moves(self, layout):
        """A legal full solution for the given layout via the greedy solver —
        returns the move log as pairs of indices, in the format finish expects."""
        tiles = [Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(layout)]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        return moves

    def test_start_returns_144_tile_layout_and_valid_token(self):
        data = self._start()
        self.assertEqual(len(data['layout']), 144)
        uuid.UUID(data['token'])  # doesn't raise ValueError

    def test_start_rejects_unknown_level(self):
        response = self.client.post(
            '/api/game/start', data={'level': 'impossible'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_start_rejects_unknown_board(self):
        response = self.client.post(
            '/api/game/start',
            data={'level': 'easy', 'board': 'does-not-exist'},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_start_defaults_to_turtle_board_when_omitted(self):
        data = self._start()
        positions = {(t['x'], t['y'], t['z']) for t in data['layout']}
        turtle = get_layout('turtle')
        self.assertEqual(positions, set(turtle.positions))
        self.assertEqual(data['board_width'], turtle.width)
        self.assertEqual(data['board_height'], turtle.height)
        self.assertEqual(data['board_layers'], turtle.layers)

    def test_start_accepts_explicit_board_choice(self):
        response = self.client.post(
            '/api/game/start',
            data={'level': 'easy', 'board': 'dragon'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        positions = {(t['x'], t['y'], t['z']) for t in response.json()['layout']}
        self.assertEqual(positions, set(get_layout('dragon').positions))

    def test_finish_accepts_valid_full_solution(self):
        data = self._start()
        moves = self._win_moves(data['layout'])
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = response.json()
        self.assertTrue(body['valid'], body)
        self.assertTrue(body['won'])
        self.assertIsInstance(body['elapsed_ms'], int)

    def test_finish_rejects_illegal_move(self):
        data = self._start()
        layout = data['layout']
        # Deliberately illegal pair: two tiles of different kinds (if they
        # happen to match by kind, pick a different second tile).
        # Deterministically illegal regardless of the generated layout,
        # unlike an arbitrary [0,1].
        second_idx = next(
            i for i in range(1, len(layout)) if layout[i]['kind'] != layout[0]['kind']
        )
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [[0, second_idx]], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_finish_rejects_move_on_covered_tile_even_with_matching_kind(self):
        """A legal move needs BOTH same kind AND both tiles free
        (gameplay/board.py: Board.can_match) — same kind alone must never be
        enough. idx0 is directly covered by idx1 (same kind, stacked) — a
        forged log claiming to remove them as a pair must be rejected even
        though `match_key(a) == match_key(b)` holds."""
        data = self._start()
        token = data['token']
        layout = [
            {'x': 0, 'y': 0, 'z': 0, 'kind': 'Man1'},  # covered
            {'x': 0, 'y': 0, 'z': 1, 'kind': 'Man1'},  # covers idx0, same kind
        ]
        GameSession.objects.filter(token=token).update(layout=layout)
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': [[0, 1]], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_finish_rejects_out_of_range_tile_index(self):
        """An idx with no corresponding tile at all (board.get_by_idx
        returns None) — distinct from reusing an already-removed idx."""
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [[0, 9999]], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    @override_settings(LANGUAGE_CODE='en')
    def test_finish_rejects_fake_deadlock_claim_when_board_still_solvable(self):
        # Pinned to English — asserts the msgid itself, not a translation.
        # generate_for_difficulty guarantees a fresh board is solvable, so
        # it's never actually deadlocked — claiming outcome='deadlock' here
        # is a bald-faced "give up and still get a result" attempt.
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )
        body = response.json()
        self.assertFalse(body['valid'])
        self.assertEqual(body['reason'], 'board is not deadlocked')

    def test_finish_rejects_fake_win_without_clearing_board(self):
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_finish_rejects_replay_of_claimed_session(self):
        data = self._start()
        moves = self._win_moves(data['layout'])
        payload = {'token': data['token'], 'moves': moves, 'outcome': 'win'}
        first = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertTrue(first.json()['valid'])
        second = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertFalse(second.json()['valid'])

    @override_settings(LANGUAGE_CODE='en')
    def test_finish_double_claim_race_is_atomic(self):
        """Simulates a race: both requests read ACTIVE, but only one atomic
        UPDATE actually changes the status — the other gets 0 updated rows.
        Pinned to English — asserts the msgid itself, not a translation."""
        data = self._start()
        moves = self._win_moves(data['layout'])
        payload = {'token': data['token'], 'moves': moves, 'outcome': 'win'}

        session = GameSession.objects.get(token=data['token'])
        self.assertEqual(session.status, GameSession.Status.ACTIVE)

        # The first finish performs the atomic ACTIVE->CLAIMED UPDATE.
        first = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertTrue(first.json()['valid'])

        # The second, even if it had read status=ACTIVE before the first
        # write (a race), still fails the conditional UPDATE because the row
        # is already CLAIMED.
        second = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertFalse(second.json()['valid'])
        self.assertEqual(second.json()['reason'], 'session already claimed')

    def test_finish_rejects_unknown_token(self):
        response = self.client.post(
            '/api/game/finish',
            data={'token': str(uuid.uuid4()), 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_session_state_active_returns_elapsed(self):
        data = self._start()
        response = self.client.get(f"/api/game/{data['token']}")
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(body['status'], 'active')
        self.assertIsInstance(body['elapsed_ms'], int)
        self.assertGreaterEqual(body['elapsed_ms'], 0)

    def test_session_state_claimed_after_finish(self):
        data = self._start()
        moves = self._win_moves(data['layout'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = self.client.get(f"/api/game/{data['token']}").json()
        self.assertEqual(body['status'], 'claimed')
        self.assertIsNone(body['elapsed_ms'])

    def test_session_state_reports_expired_past_ttl_without_db_write(self):
        data = self._start()
        GameSession.objects.filter(token=data['token']).update(
            created_at=timezone.now() - SESSION_TTL - timedelta(minutes=1),
        )
        body = self.client.get(f"/api/game/{data['token']}").json()
        self.assertEqual(body['status'], 'expired')
        self.assertIsNone(body['elapsed_ms'])
        # Lazy marking is left to finish — GET writes nothing.
        session = GameSession.objects.get(token=data['token'])
        self.assertEqual(session.status, GameSession.Status.ACTIVE)

    def test_session_state_unknown_token(self):
        body = self.client.get(f'/api/game/{uuid.uuid4()}').json()
        self.assertEqual(body['status'], 'unknown')
        self.assertIsNone(body['elapsed_ms'])

    def test_missing_csrf_token_is_rejected_when_enforced(self):
        # The Django test Client disables CSRF checking by default — here we
        # enable it explicitly, to prove that NinjaAPI(csrf=True) actually
        # protects the endpoint, not just present in config.
        strict_client = Client(enforce_csrf_checks=True)
        response = strict_client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)


class ShuffleApiTests(TestCase):
    """Coverage for gameplay/api.py: shuffle_game and its interplay with
    finish_game's shared `_replay` helper. A hand-built 4-tile deadlock (two
    same-kind pairs, each stacked so only the top tile of each stack is free
    — a real 144-tile game deadlocks the same way, just with more tiles)
    replaces the real 144-tile board.layout from a normal /start, so these
    tests can force a dead end deterministically instead of hoping a random
    seed produces one."""

    # Two stacked pairs: within each stack the bottom tile is covered by the
    # top one (gameplay/board.py: is_free_position's "anything on top" check)
    # so only the top tile of each stack is ever free — and since the two
    # free tiles (Man1, Pin1) don't share a kind, no legal pair exists.
    DEADLOCK_LAYOUT = [
        {'x': 0, 'y': 0, 'z': 0, 'kind': 'Man1'},
        {'x': 0, 'y': 0, 'z': 1, 'kind': 'Man1'},
        {'x': 10, 'y': 10, 'z': 0, 'kind': 'Pin1'},
        {'x': 10, 'y': 10, 'z': 1, 'kind': 'Pin1'},
    ]

    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _force_deadlock(self, token):
        GameSession.objects.filter(token=token).update(layout=self.DEADLOCK_LAYOUT)

    def _shuffle(self, token, moves=()):
        return self.client.post(
            f'/api/game/{token}/shuffle',
            data={'moves': list(moves)}, content_type='application/json',
        )

    def test_shuffle_rejects_when_board_not_deadlocked(self):
        data = self._start()  # a fresh 144-tile board is never a dead end
        response = self._shuffle(data['token'])
        self.assertEqual(response.status_code, 400)

    def test_shuffle_rejects_illegal_move_log(self):
        data = self._start()
        layout = data['layout']
        second_idx = next(
            i for i in range(1, len(layout)) if layout[i]['kind'] != layout[0]['kind']
        )
        response = self._shuffle(data['token'], [[0, second_idx]])
        self.assertEqual(response.status_code, 400)

    def test_shuffle_rejects_move_on_covered_tile_even_with_matching_kind(self):
        """Same forgery as test_finish_rejects_move_on_covered_tile_even_with_
        matching_kind, against the shuffle endpoint's own _replay call: same
        kind alone (idx0 covered by idx1, both 'Man1') must never satisfy
        Board.can_match. This 2-tile board is itself a genuine dead end
        (idx0 blocked, idx1 free but alone) — proving the forged move is
        rejected as illegal BEFORE the deadlock check ever runs, not
        because the precondition happens to fail too."""
        data = self._start()
        token = data['token']
        layout = [
            {'x': 0, 'y': 0, 'z': 0, 'kind': 'Man1'},
            {'x': 0, 'y': 0, 'z': 1, 'kind': 'Man1'},
        ]
        GameSession.objects.filter(token=token).update(layout=layout)
        response = self._shuffle(token, [[0, 1]])
        self.assertEqual(response.status_code, 400)

    def test_shuffle_rejects_out_of_range_tile_index(self):
        data = self._start()
        response = self._shuffle(data['token'], [[0, 9999]])
        self.assertEqual(response.status_code, 400)

    def test_shuffle_succeeds_on_deadlock_and_preserves_kind_multiset(self):
        data = self._start()
        self._force_deadlock(data['token'])

        response = self._shuffle(data['token'])
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(set(body['kinds'].keys()), {'0', '1', '2', '3'})
        self.assertEqual(sorted(body['kinds'].values()), ['Man1', 'Man1', 'Pin1', 'Pin1'])
        self.assertEqual(body['stats']['easy']['shufflesTotal'], 1)

        session = GameSession.objects.get(token=data['token'])
        self.assertEqual(len(session.shuffles), 1)
        self.assertEqual(session.shuffles[0]['after_moves'], 0)

    def test_shuffle_duplicate_request_is_idempotent(self):
        data = self._start()
        self._force_deadlock(data['token'])

        first = self._shuffle(data['token'])
        second = self._shuffle(data['token'])
        self.assertEqual(first.json()['kinds'], second.json()['kinds'])
        # A duplicate request (same move-log length) doesn't charge a second
        # shufflesTotal increment or append a second event.
        self.assertEqual(second.json()['stats']['easy']['shufflesTotal'], 1)
        session = GameSession.objects.get(token=data['token'])
        self.assertEqual(len(session.shuffles), 1)

    def test_finish_after_shuffle_replays_new_kinds_and_wins(self):
        data = self._start()
        token = data['token']
        self._force_deadlock(token)

        shuffle_response = self._shuffle(token)
        self.assertEqual(shuffle_response.status_code, 200, shuffle_response.content)

        # Solve the now-reshuffled board with the same greedy solver used
        # elsewhere in this file, to build a legal move log for finish.
        session = GameSession.objects.get(token=token)
        shuffled_kinds = session.shuffles[0]['kinds']
        tiles = [
            Tile(idx, t['x'], t['y'], t['z'], shuffled_kinds.get(str(idx), t['kind']))
            for idx, t in enumerate(session.layout)
        ]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)

        finish_response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = finish_response.json()
        self.assertTrue(body['valid'], body)
        self.assertTrue(body['won'])

    def test_finish_replays_multiple_shuffle_events_at_different_anchors(self):
        """_replay (shared by shuffle_game and finish_game) must thread
        through an arbitrary NUMBER of shuffle events, not just one — a real
        144-tile game can hit a second dead end after the first reshuffle.
        Two independent stacked dead-end pairs (idx2/3, idx4/5) plus a
        trivially matchable pair (idx0/1): after removing idx0/1, the board
        is deadlocked (mismatched kinds on the two free top tiles) — shuffle
        #1 fixes idx2/3 but deliberately still leaves idx4/5 mismatched — a
        second dead end — shuffle #2 (a different anchor) finally fixes it."""
        data = self._start()
        token = data['token']
        layout = [
            {'x': 0, 'y': 0, 'z': 0, 'kind': 'Man1'},
            {'x': 2, 'y': 0, 'z': 0, 'kind': 'Man1'},
            {'x': 0, 'y': 10, 'z': 0, 'kind': 'Pin1'},
            {'x': 0, 'y': 10, 'z': 1, 'kind': 'Pin1'},
            {'x': 10, 'y': 10, 'z': 0, 'kind': 'Sou1'},
            {'x': 10, 'y': 10, 'z': 1, 'kind': 'Sou1'},
        ]
        # anchor=1: right after removing idx0/1 (1 move made so far) — the
        # two now-visible top tiles (idx3, idx5) are re-kinded to MATCH
        # ('Man1' each), so the greedy solve below can remove them next.
        # anchor=2: right after also removing idx3/idx5 (2 moves made so
        # far) — the last two (now-visible bottom) tiles idx2/idx4 are
        # re-kinded to match too ('Chun' each), a genuinely SEPARATE anchor.
        GameSession.objects.filter(token=token).update(layout=layout, shuffles=[
            {'after_moves': 1, 'kinds': {'2': 'Pin1', '3': 'Man1', '4': 'Sou1', '5': 'Man1'}},
            {'after_moves': 2, 'kinds': {'2': 'Chun', '4': 'Chun'}},
        ])

        moves = [[0, 1], [3, 5], [2, 4]]
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = response.json()
        self.assertTrue(body['valid'], body)
        self.assertTrue(body['won'])

    def test_shuffle_cannot_be_forged_by_the_client(self):
        """The client can never supply its own kinds/shuffles — ShuffleRequest
        and FinishRequest only accept `moves`/`outcome`; any extra fields are
        silently ignored by ninja's schema validation, never applied."""
        data = self._start()
        token = data['token']
        self._force_deadlock(token)

        forged_kinds = {'0': 'Chun', '1': 'Chun', '2': 'Chun', '3': 'Chun'}
        response = self.client.post(
            f'/api/game/{token}/shuffle',
            data={'moves': [], 'kinds': forged_kinds, 'stats': {'shufflesTotal': 999}},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        # The forged kinds are ignored — the server's own reshuffle_layout
        # output preserves the real kind multiset (Man1×2, Pin1×2), not the
        # all-Chun payload the client tried to inject.
        self.assertNotEqual(response.json()['kinds'], forged_kinds)
        self.assertEqual(
            sorted(response.json()['kinds'].values()), ['Man1', 'Man1', 'Pin1', 'Pin1'],
        )

        session = GameSession.objects.get(token=token)
        # Server-computed shufflesTotal (1), not the forged 999.
        self.assertEqual(session.user.profile.stats['easy']['shufflesTotal'], 1)

    def test_finish_rejects_fake_shuffle_injected_via_finish_payload(self):
        """FinishRequest has no `shuffles`/`kinds` field at all — a client
        cannot smuggle a self-serving reshuffle into finish. A move log that
        would only be legal under a fabricated kind change is rejected."""
        data = self._start()
        token = data['token']
        # idx0/1 = 'Man1' stack, idx2/3 = 'Pin1' stack — no legal move exists.
        self._force_deadlock(token)

        # This move would only be legal if idx1 were 'Man1' (its real kind
        # per DEADLOCK_LAYOUT) — try smuggling a kind override via `shuffles`,
        # a field FinishRequest doesn't even declare.
        response = self.client.post(
            '/api/game/finish',
            data={
                'token': token,
                'moves': [[0, 1]],
                'outcome': 'win',
                'shuffles': [{'after_moves': 0, 'kinds': {'0': 'Pin1'}}],  # not a real field
            },
            content_type='application/json',
        )
        body = response.json()
        # idx0 is covered (blocked) in DEADLOCK_LAYOUT — illegal regardless
        # of the forged shuffle payload, proving it was never applied.
        self.assertFalse(body['valid'], body)


class AntiCheatTests(TestCase):
    """Deliberately hostile inputs across gameplay/api.py: malformed request
    bodies, replay/self-match tricks, acting on a session that's already
    over, and rate-limit enforcement. Complements the more scenario-specific
    forgery tests in GameApiTests/ShuffleApiTests above."""

    # Same 4-tile stacked dead end as ShuffleApiTests.DEADLOCK_LAYOUT — kept
    # local rather than shared, matching this file's existing convention of
    # each test class owning its small fixtures (see _start/_win_moves
    # duplicated across GameApiTests/StatsEndpointTests/ShuffleApiTests).
    DEADLOCK_LAYOUT = [
        {'x': 0, 'y': 0, 'z': 0, 'kind': 'Man1'},
        {'x': 0, 'y': 0, 'z': 1, 'kind': 'Man1'},
        {'x': 10, 'y': 10, 'z': 0, 'kind': 'Pin1'},
        {'x': 10, 'y': 10, 'z': 1, 'kind': 'Pin1'},
    ]

    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _win_moves(self, layout):
        tiles = [Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(layout)]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        return moves

    # --- Replay/self-match tricks -----------------------------------------

    def test_finish_rejects_self_matched_pair(self):
        """[idx, idx] — matching a tile with itself. Board.can_match's `a is
        not b` check must reject this; without it, a single free tile could
        be "removed" against itself, silently shrinking the board for free."""
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [[0, 0]], 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    def test_finish_rejects_reusing_an_already_removed_tile(self):
        """Replays the same legal pair twice — the second occurrence must
        fail (the tile is already gone from the board), not silently no-op
        or double-count towards a win."""
        data = self._start()
        moves = self._win_moves(data['layout'])
        rigged = [moves[0], moves[0], *moves[1:]]
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': rigged, 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertFalse(response.json()['valid'])

    @override_settings(LANGUAGE_CODE='en')
    def test_finish_rejects_unknown_outcome(self):
        # Pinned to English — asserts the msgid itself, not a translation.
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [], 'outcome': 'i-win-obviously'},
            content_type='application/json',
        )
        body = response.json()
        self.assertFalse(body['valid'])
        self.assertEqual(body['reason'], 'unknown outcome')

    # --- Acting on a session that's already over ---------------------------

    def test_shuffle_rejects_on_already_claimed_session(self):
        data = self._start()
        token = data['token']
        GameSession.objects.filter(token=token).update(layout=self.DEADLOCK_LAYOUT)
        # Legitimately claim it as a loss first.
        finish = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )
        self.assertTrue(finish.json()['valid'], finish.content)

        response = self.client.post(
            f'/api/game/{token}/shuffle', data={'moves': []}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_shuffle_rejects_on_expired_session(self):
        data = self._start()
        token = data['token']
        GameSession.objects.filter(token=token).update(
            layout=self.DEADLOCK_LAYOUT,
            created_at=timezone.now() - SESSION_TTL - timedelta(minutes=1),
        )
        response = self.client.post(
            f'/api/game/{token}/shuffle', data={'moves': []}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    # --- Malformed request bodies (schema-level rejection, 422) ------------

    def test_finish_rejects_non_integer_move_indices(self):
        data = self._start()
        response = self.client.post(
            '/api/game/finish',
            data={
                'token': data['token'], 'moves': [['not-an-index', 'also-not']], 'outcome': 'win',
            },
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 422)

    def test_shuffle_rejects_non_integer_move_indices(self):
        data = self._start()
        response = self.client.post(
            f"/api/game/{data['token']}/shuffle",
            data={'moves': [['not-an-index', 'also-not']]},
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 422)

    def test_bump_rejects_shuffle_as_a_generic_counter(self):
        """BumpRequest.counter is a closed Literal['hint','undo','pair'] —
        'shuffle' isn't in it. shufflesTotal must only ever move via the
        dedicated, server-computed /shuffle endpoint, never by a client
        just POSTing an arbitrary counter name to the generic /bump route."""
        data = self._start()
        response = self.client.post(
            f"/api/game/{data['token']}/bump",
            data={'counter': 'shuffle'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 422)

    # --- Rate limiting ------------------------------------------------------

    def test_shuffle_rate_limit_returns_429_past_the_quota(self):
        data = self._start()
        token = data['token']
        GameSession.objects.filter(token=token).update(layout=self.DEADLOCK_LAYOUT)
        # A unique IP so this test's quota can't collide with any other
        # test's requests sharing the process-wide LocMemCache.
        headers = {'HTTP_CF_CONNECTING_IP': '203.0.113.42'}
        for _ in range(RATE_LIMIT_MAX_SHUFFLES):
            response = self.client.post(
                f'/api/game/{token}/shuffle',
                data={'moves': []}, content_type='application/json', **headers,
            )
            self.assertNotEqual(response.status_code, 429)
        response = self.client.post(
            f'/api/game/{token}/shuffle',
            data={'moves': []}, content_type='application/json', **headers,
        )
        self.assertEqual(response.status_code, 429)

    def test_stats_import_rate_limit_returns_429_past_the_quota(self):
        headers = {'HTTP_CF_CONNECTING_IP': '203.0.113.99'}
        payload = {'stats': {'easy': {'gamesPlayed': 1}}}
        for _ in range(RATE_LIMIT_MAX_IMPORTS):
            response = self.client.post(
                '/api/game/stats/import', data=payload, content_type='application/json', **headers,
            )
            self.assertNotEqual(response.status_code, 429)
        response = self.client.post(
            '/api/game/stats/import', data=payload, content_type='application/json', **headers,
        )
        self.assertEqual(response.status_code, 429)


class StatsTransformerTests(TestCase):
    """Parity with tests/stats.test.js (applyWin/applyLoss) + cases specific
    to the pydantic layer (clamping/merging) that don't exist in the JS version."""

    def test_apply_win_increments_played_won_streak_tracks_best_time(self):
        stats = LevelStats()
        stats = apply_win(stats, 5000)
        self.assertEqual(stats.games_played, 1)
        self.assertEqual(stats.games_won, 1)
        self.assertEqual(stats.current_streak, 1)
        self.assertEqual(stats.best_streak, 1)
        self.assertEqual(stats.best_time_ms, 5000)

        stats = apply_win(stats, 3000)
        self.assertEqual(stats.current_streak, 2)
        self.assertEqual(stats.best_streak, 2)
        self.assertEqual(stats.best_time_ms, 3000)  # a faster win becomes the record

        stats = apply_win(stats, 9000)
        self.assertEqual(stats.best_time_ms, 3000)  # a slower one doesn't overwrite the record
        self.assertEqual(stats.best_streak, 3)

    def test_apply_loss_increments_played_resets_streak_keeps_best(self):
        stats = LevelStats()
        stats = apply_win(stats, 1000)
        stats = apply_win(stats, 1000)
        stats = apply_loss(stats)
        self.assertEqual(stats.games_played, 3)
        self.assertEqual(stats.games_won, 2)
        self.assertEqual(stats.current_streak, 0)
        self.assertEqual(stats.best_streak, 2)

    def test_negative_field_rejected_by_validation(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            LevelStats.model_validate({'gamesPlayed': -1})

    def test_best_streak_clamped_up_to_current_streak(self):
        stats = LevelStats.model_validate({'currentStreak': 5, 'bestStreak': 1})
        self.assertEqual(stats.best_streak, 5)

    def test_merge_imported_sums_counters_min_time_max_streak(self):
        server = AllStats()
        imported = AllStats()
        imported.normal = LevelStats.model_validate({
            'gamesPlayed': 4, 'gamesWon': 2, 'hintsTotal': 3, 'undosTotal': 1, 'pairsTotal': 20,
            'bestTimeMs': 9000, 'currentStreak': 2, 'bestStreak': 2,
        })
        merged = merge_imported(server, imported)
        self.assertEqual(merged.normal.games_played, 4)
        self.assertEqual(merged.normal.games_won, 2)
        self.assertEqual(merged.normal.hints_total, 3)
        self.assertEqual(merged.normal.best_time_ms, 9000)
        self.assertEqual(merged.normal.best_streak, 2)
        # server hasn't played this level yet — currentStreak is taken from the import
        self.assertEqual(merged.normal.current_streak, 2)
        # The legacy blob had no "started" counter — gamesStarted is pulled up
        # to gamesPlayed from the import, otherwise started < played would result.
        self.assertEqual(merged.normal.games_started, 4)

    def test_merge_imported_keeps_games_started_at_least_games_played(self):
        server = AllStats()
        server.normal = LevelStats.model_validate({'gamesStarted': 1, 'gamesPlayed': 0})
        imported = AllStats()
        imported.normal = LevelStats.model_validate({'gamesPlayed': 5, 'gamesWon': 3})
        merged = merge_imported(server, imported)
        self.assertEqual(merged.normal.games_played, 5)
        self.assertGreaterEqual(merged.normal.games_started, merged.normal.games_played)
        self.assertEqual(merged.normal.games_started, 6)

    def test_merge_imported_keeps_server_current_streak_when_server_has_played(self):
        server = AllStats()
        server.normal = apply_win(server.normal, 1000)  # server.games_played == 1
        imported = AllStats()
        imported.normal = LevelStats.model_validate({'gamesPlayed': 3, 'currentStreak': 3})
        merged = merge_imported(server, imported)
        self.assertEqual(merged.normal.games_played, 4)
        self.assertEqual(merged.normal.current_streak, 1)  # the server-side streak takes precedence


class OverallStatsTests(TestCase):
    """The points-based lifetime block (schemas.OverallStats)."""

    def test_apply_score_tracks_totals_best_wins_and_streaks(self):
        stats = apply_score(OverallStats(), 100, won=True)
        stats = apply_score(stats, 300, won=True)
        self.assertEqual(
            (stats.games_scored, stats.total_score, stats.best_score), (2, 400, 300),
        )
        self.assertEqual((stats.games_won, stats.current_streak, stats.best_streak), (2, 2, 2))

        # A loss still scores its points but resets the streak, keeps the record.
        stats = apply_score(stats, 50, won=False)
        self.assertEqual(
            (stats.games_scored, stats.total_score, stats.best_score), (3, 450, 300),
        )
        self.assertEqual((stats.games_won, stats.current_streak, stats.best_streak), (2, 0, 2))

    def test_missing_overall_is_seeded_from_per_level_wins_and_best_streak(self):
        blob = AllStats().model_dump(by_alias=True)
        del blob['overall']
        blob['easy'].update(gamesWon=3, bestStreak=2)
        blob['hard'].update(gamesWon=4, bestStreak=5)
        overall = AllStats.model_validate(blob).overall
        self.assertEqual(overall.games_won, 7)
        self.assertEqual(overall.best_streak, 5)
        # Scores never existed before — they start from zero.
        self.assertEqual(
            (overall.games_scored, overall.total_score, overall.current_streak), (0, 0, 0),
        )

    def test_existing_overall_is_not_reseeded(self):
        stats = AllStats.model_validate({'easy': {'gamesWon': 9}, 'overall': {'gamesWon': 1}})
        self.assertEqual(stats.overall.games_won, 1)

    def test_merge_imported_adds_wins_and_best_streak_but_keeps_server_scores(self):
        server = AllStats(overall=OverallStats(
            games_scored=2, total_score=500, best_score=300, games_won=2,
            current_streak=2, best_streak=2,
        ))
        imported = AllStats()
        imported.normal = LevelStats.model_validate(
            {'gamesPlayed': 4, 'gamesWon': 3, 'bestStreak': 3},
        )
        merged = merge_imported(server, imported).overall
        self.assertEqual(merged.games_won, 5)
        self.assertEqual(merged.best_streak, 3)
        self.assertEqual(
            (merged.games_scored, merged.total_score, merged.best_score), (2, 500, 300),
        )
        self.assertEqual(merged.current_streak, 2)


class BackfillScoresMigrationTests(TestCase):
    """gameplay/migrations/0009_backfill_scores.py, run against live rows."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.migration = importlib.import_module('gameplay.migrations.0009_backfill_scores')

    def _session(self, user, **kwargs):
        defaults = dict(
            level='normal', layout=[{}] * 144, seed='x', user=user,
            status=GameSession.Status.CLAIMED, won=True, elapsed_ms=100_000,
        )
        return GameSession.objects.create(**{**defaults, **kwargs})

    def _user(self, stats=None):
        user = User.objects.create(username='p')
        kwargs = {} if stats is None else {'stats': stats}
        Profile.objects.create(user=user, **kwargs)
        return user

    def test_estimate_is_the_chain_free_lower_bound_with_exact_other_terms(self):
        clean = self._session(self._user())
        # 72 pairs x 10 x 2 = 1440; no-help +720; time (600-100) x 2 = 1000.
        self.assertEqual(self.migration.estimate_score(clean), 3160)

        helped = GameSession(
            level='hard', layout=[{}] * 144, shuffles=[{}], hints=1, undos=2, elapsed_ms=700_000,
        )
        # 72 x 10 x 3 = 2160, no bonuses, penalties (20 + 20 + 20) x 3 = 180.
        self.assertEqual(self.migration.estimate_score(helped), 1980)

    def test_estimate_never_exceeds_the_real_score(self):
        data = self.client.post(
            '/api/game/start', data={'level': 'normal'}, content_type='application/json',
        ).json()
        board = Board([
            Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(data['layout'])
        ])
        moves = []
        while board.remaining:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        body = self.client.post(
            '/api/game/finish', data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        ).json()
        session = GameSession.objects.get(token=data['token'])
        self.assertLessEqual(self.migration.estimate_score(session), body['score'])

    def test_backfill_scores_old_wins_and_folds_them_into_overall_once(self):
        user = self._user({'easy': {'gamesWon': 2, 'bestStreak': 2}})
        self._session(user, level='easy', elapsed_ms=0)  # 720 + 360 + 600 = 1680
        self._session(user, level='easy', elapsed_ms=0, hints=1)  # 720 + 600 - 20 = 1300
        self._session(user, won=False)  # a loss: unscored
        self._session(user, daily_date=datetime.date(2026, 1, 1))  # daily: untouched
        self._session(user, score=5)  # already scored: untouched

        self.migration.backfill(django_apps, None)
        self.migration.backfill(django_apps, None)  # a rerun must not double count

        scores = sorted(
            GameSession.objects.filter(user=user).values_list('score', flat=True),
            key=lambda v: (v is None, v),
        )
        self.assertEqual(scores, [5, 1300, 1680, None, None])
        overall = Profile.objects.get(user=user).stats['overall']
        self.assertEqual(
            (overall['gamesScored'], overall['totalScore'], overall['bestScore']), (2, 2980, 1680),
        )
        # Wins and best streak come from the seeding of the per-level blocks.
        self.assertEqual((overall['gamesWon'], overall['bestStreak']), (2, 2))


class BestScoreTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_apply_best_score_records_new_board_and_only_raises(self):
        best = apply_best_score({}, 'dragon', 'normal', 500)
        self.assertEqual(best, {'dragon': {'normal': 500}})
        self.assertEqual(apply_best_score(best, 'dragon', 'normal', 400), best)
        self.assertEqual(
            apply_best_score(best, 'dragon', 'normal', 900), {'dragon': {'normal': 900}},
        )
        self.assertEqual(
            apply_best_score(best, 'dragon', 'hard', 100),
            {'dragon': {'normal': 500, 'hard': 100}},
        )
        self.assertEqual(
            apply_best_score(best, 'cat', 'normal', 50),
            {'dragon': {'normal': 500}, 'cat': {'normal': 50}},
        )

    def test_apply_best_score_ignores_a_session_without_a_board(self):
        self.assertEqual(apply_best_score({}, '', 'normal', 500), {})

    def _play(self, board, win=True):
        data = self.client.post(
            '/api/game/start', data={'level': 'easy', 'board': board},
            content_type='application/json',
        ).json()
        tiles = [
            Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(data['layout'])
        ]
        b = Board(tiles)
        moves = []
        while b.remaining:
            x, y = b.find_matching_pair()
            moves.append([x.idx, y.idx])
            b.remove_pair(x, y)
        return self.client.post(
            '/api/game/finish', data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        ).json()

    def test_start_stores_the_board_on_the_session(self):
        data = self.client.post(
            '/api/game/start', data={'level': 'easy', 'board': 'dragon'},
            content_type='application/json',
        ).json()
        self.assertEqual(GameSession.objects.get(token=data['token']).board, 'dragon')

    def test_finish_writes_the_record_for_a_regular_game(self):
        body = self._play('dragon')
        self.assertEqual(body['stats']['bestScores'], {'dragon': {'easy': body['score']}})

    def test_daily_game_never_touches_records(self):
        today = timezone.localdate()
        board_slug, level, _seed = daily_challenge(today)
        data = self.client.post('/api/game/daily/start').json()
        self.assertEqual(GameSession.objects.get(token=data['token']).board, board_slug)
        tiles = [
            Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(data['layout'])
        ]
        b = Board(tiles)
        moves = []
        while b.remaining:
            x, y = b.find_matching_pair()
            moves.append([x.idx, y.idx])
            b.remove_pair(x, y)
        body = self.client.post(
            '/api/game/finish', data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        ).json()
        self.assertTrue(body['valid'], body)
        self.assertEqual(body['stats']['bestScores'], {})
        self.assertEqual(level, GameSession.objects.get(token=data['token']).level)


class BackfillBestScoresMigrationTests(TestCase):
    """gameplay/migrations/0013_backfill_best_scores.py, run against live rows."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.migration = importlib.import_module('gameplay.migrations.0013_backfill_best_scores')

    def _layout(self, slug):
        return [
            {'x': x, 'y': y, 'z': z, 'kind': 'a'}
            for x, y, z in load_layouts()[slug].positions
        ]

    def _session(self, user, slug='dragon', **kwargs):
        defaults = dict(
            level='normal', layout=self._layout(slug), seed='x', user=user,
            status=GameSession.Status.CLAIMED, won=True, score=100,
        )
        return GameSession.objects.create(**{**defaults, **kwargs})

    def test_every_layout_matches_only_itself(self):
        index = self.migration._positions_index()
        self.assertEqual(len(index), len(load_layouts()))
        for slug, layout in load_layouts().items():
            self.assertEqual(index[frozenset(layout.positions)], slug)

    def test_backfills_board_and_takes_the_max_per_board_and_level(self):
        user = User.objects.create(username='p')
        Profile.objects.create(user=user)
        self._session(user, 'dragon', score=300)
        self._session(user, 'dragon', score=700)
        self._session(user, 'dragon', level='hard', score=50)
        self._session(user, 'cat', score=200)
        self._session(user, 'cat', daily_date=datetime.date(2026, 1, 1), score=9999)
        self._session(user, 'cat', status=GameSession.Status.ACTIVE, score=None)
        unmatched = self._session(user, 'cat', layout=[], score=9999)

        self.migration.backfill(django_apps, None)
        self.migration.backfill(django_apps, None)  # a rerun changes nothing

        self.assertEqual(
            Profile.objects.get(user=user).stats['bestScores'],
            {'dragon': {'normal': 700, 'hard': 50}, 'cat': {'normal': 200}},
        )
        self.assertEqual(GameSession.objects.get(pk=unmatched.pk).board, '')
        self.assertEqual(
            GameSession.objects.filter(user=user, board='cat').count(), 3,
        )


class BackfillDailyScoresMigrationTests(TestCase):
    """gameplay/migrations/0011_backfill_daily_scores.py, run against live rows."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.migration = importlib.import_module('gameplay.migrations.0011_backfill_daily_scores')

    def _session(self, user, **kwargs):
        defaults = dict(
            level='normal', layout=[], seed='x', user=user, elapsed_ms=100_000,
            status=GameSession.Status.CLAIMED, won=True, daily_date=datetime.date(2026, 1, 1),
        )
        return GameSession.objects.create(**{**defaults, **kwargs})

    def test_scores_unscored_daily_wins_even_with_a_purged_layout(self):
        user = User.objects.create(username='p')
        Profile.objects.create(user=user)
        win = self._session(user)
        # 72 pairs x 10 x 2 = 1440; no-help +720; time (600-100) x 2 = 1000.
        helped = self._session(user, daily_date=datetime.date(2026, 1, 2), hints=1)
        loss = self._session(user, daily_date=datetime.date(2026, 1, 3), won=False)
        regular = self._session(user, daily_date=None)
        scored = self._session(user, daily_date=datetime.date(2026, 1, 4), score=5)
        stats_before = Profile.objects.get(user=user).stats

        self.migration.backfill(django_apps, None)
        self.migration.backfill(django_apps, None)  # idempotent

        scores = {
            s.pk: GameSession.objects.get(pk=s.pk).score
            for s in (win, helped, loss, regular, scored)
        }
        self.assertEqual(scores[win.pk], 3160)
        self.assertEqual(scores[helped.pk], 1440 + 1000 - 40)
        self.assertIsNone(scores[loss.pk])
        self.assertIsNone(scores[regular.pk])  # regular games are 0009's job
        self.assertEqual(scores[scored.pk], 5)
        # Daily games never fed lifetime stats; neither does the backfill.
        self.assertEqual(Profile.objects.get(user=user).stats, stats_before)


class PlayerIdentityMiddlewareTests(TestCase):
    def test_start_without_cookie_creates_user_profile_and_cookie_binds_session(self):
        response = self.client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn(PLAYER_COOKIE_NAME, response.cookies)
        self.assertEqual(User.objects.count(), 1)
        self.assertEqual(Profile.objects.count(), 1)

        token = response.json()['token']
        session = GameSession.objects.get(token=token)
        self.assertIsNotNone(session.user_id)
        self.assertEqual(session.user.profile, Profile.objects.get())

    def test_repeated_requests_with_same_cookie_reuse_profile(self):
        self.client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(Profile.objects.count(), 1)
        self.client.post(
            '/api/game/start', data={'level': 'normal'}, content_type='application/json',
        )
        self.assertEqual(Profile.objects.count(), 1)
        self.assertEqual(GameSession.objects.count(), 2)
        self.assertEqual(GameSession.objects.first().user_id, GameSession.objects.last().user_id)

    def test_paths_outside_prefix_do_not_create_profile(self):
        self.client.get('/api/background/')
        self.assertEqual(Profile.objects.count(), 0)

    def test_unknown_subpath_under_prefix_does_not_create_profile(self):
        response = self.client.get('/api/game/this-endpoint-does-not-exist')
        self.assertEqual(response.status_code, 404)
        self.assertEqual(Profile.objects.count(), 0)

    def test_new_profile_rate_limit_returns_429_and_creates_no_row_past_quota(self):
        cache.clear()  # a fresh quota window, isolated from other tests' counters
        # A unique IP so this test's quota can't collide with any other
        # test's requests sharing the process-wide LocMemCache.
        headers = {'HTTP_CF_CONNECTING_IP': '203.0.113.77'}
        for _i in range(NEW_PROFILE_RATE_LIMIT):
            # A distinct client (no cookie carried over) each time — this
            # quota is about *first-time* visitors, so a returning one must
            # never count against it.
            response = Client().post(
                '/api/game/start', data={'level': 'easy'}, content_type='application/json',
                **headers,
            )
            self.assertNotEqual(response.status_code, 429, response.content)
        self.assertEqual(Profile.objects.count(), NEW_PROFILE_RATE_LIMIT)

        response = Client().post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json', **headers,
        )
        self.assertEqual(response.status_code, 429)
        self.assertEqual(Profile.objects.count(), NEW_PROFILE_RATE_LIMIT)

    def test_returning_player_unaffected_by_exhausted_new_profile_quota(self):
        cache.clear()
        headers = {'HTTP_CF_CONNECTING_IP': '203.0.113.78'}
        client = Client()
        start = client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json', **headers,
        )
        self.assertEqual(start.status_code, 200, start.content)
        self.assertEqual(Profile.objects.count(), 1)

        # Exhaust the quota with OTHER, cookie-less clients on the same IP.
        for _ in range(NEW_PROFILE_RATE_LIMIT):
            Client().post(
                '/api/game/start', data={'level': 'easy'}, content_type='application/json',
                **headers,
            )

        # The original client, cookie intact, still works.
        response = client.post(
            '/api/game/start', data={'level': 'normal'}, content_type='application/json',
            **headers,
        )
        self.assertEqual(response.status_code, 200, response.content)


class StatsEndpointTests(TestCase):
    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _bump(self, token, counter, **extra):
        return self.client.post(
            f'/api/game/{token}/bump', data={'counter': counter}, content_type='application/json',
            **extra,
        )

    def _win_moves(self, layout):
        tiles = [Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(layout)]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        return moves

    def test_get_stats_bootstraps_empty_profile(self):
        response = self.client.get('/api/game/stats')
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertTrue(body['legacy_import_available'])
        self.assertEqual(body['stats']['easy']['gamesPlayed'], 0)

    def test_start_increments_games_started_and_returns_stats(self):
        data = self._start('normal')
        self.assertEqual(data['stats']['normal']['gamesStarted'], 1)
        data2 = self._start('normal')
        self.assertEqual(data2['stats']['normal']['gamesStarted'], 2)

    def test_bump_increments_matching_counter_and_accumulates(self):
        data = self._start('easy')
        token = data['token']
        counters = (('hint', 'hintsTotal'), ('undo', 'undosTotal'), ('pair', 'pairsTotal'))
        for counter, field in counters:
            response = self._bump(token, counter)
            self.assertEqual(response.status_code, 200, response.content)
            self.assertEqual(response.json()['stats']['easy'][field], 1)

        response = self._bump(token, 'hint')
        self.assertEqual(response.json()['stats']['easy']['hintsTotal'], 2)

    def test_bump_rejects_unknown_token(self):
        response = self._bump(uuid.uuid4(), 'hint')
        self.assertEqual(response.status_code, 400)

    def test_bump_rejects_already_claimed_session(self):
        data = self._start('easy')
        moves = self._win_moves(data['layout'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        response = self._bump(data['token'], 'hint')
        self.assertEqual(response.status_code, 400)

    def test_finish_updates_only_win_loss_fields_not_bump_totals(self):
        data = self._start('easy')
        token = data['token']
        self._bump(token, 'pair')
        moves = self._win_moves(data['layout'])
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = response.json()
        self.assertTrue(body['valid'])
        self.assertEqual(body['stats']['easy']['gamesPlayed'], 1)
        self.assertEqual(body['stats']['easy']['gamesWon'], 1)
        self.assertEqual(body['stats']['easy']['pairsTotal'], 1)  # from bump, not from finish

    def test_full_playthrough_totals_add_up_without_double_counting(self):
        data = self._start('easy')
        token = data['token']
        for _ in range(3):
            self._bump(token, 'pair')
        self._bump(token, 'hint')
        moves = self._win_moves(data['layout'])
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        stats = response.json()['stats']['easy']
        self.assertEqual(stats['pairsTotal'], 3)
        self.assertEqual(stats['hintsTotal'], 1)
        self.assertEqual(stats['gamesPlayed'], 1)
        self.assertEqual(stats['gamesWon'], 1)
        self.assertEqual(stats['gamesStarted'], 1)

    @override_settings(LANGUAGE_CODE='en')
    def test_import_accepted_once_then_rejected(self):
        # Pinned to English — asserts the msgid itself, not a translation.
        legacy = {
            'easy': {
                'gamesPlayed': 2, 'gamesWon': 1, 'bestTimeMs': 4000,
                'currentStreak': 1, 'bestStreak': 1,
            },
        }
        first = self.client.post(
            '/api/game/stats/import', data={'stats': legacy}, content_type='application/json',
        )
        self.assertEqual(first.status_code, 200, first.content)
        body = first.json()
        self.assertTrue(body['imported'])
        self.assertEqual(body['stats']['easy']['gamesPlayed'], 2)

        second = self.client.post(
            '/api/game/stats/import', data={'stats': legacy}, content_type='application/json',
        )
        second_body = second.json()
        self.assertFalse(second_body['imported'])
        self.assertEqual(second_body['reason'], 'already imported')

    def test_import_sanitizes_malformed_payload(self):
        response = self.client.post(
            '/api/game/stats/import',
            data={'stats': {'easy': {'gamesPlayed': -5}}},
            content_type='application/json',
        )
        # Field(ge=0) rejects negative values at the ninja request-validation layer.
        self.assertEqual(response.status_code, 422)

    def test_bump_rate_limit_returns_429_past_the_quota(self):
        data = self._start()
        token = data['token']
        # A unique IP so this test's quota can't collide with any other
        # test's requests sharing the process-wide LocMemCache.
        headers = {'HTTP_CF_CONNECTING_IP': '203.0.113.201'}
        for _ in range(RATE_LIMIT_MAX_BUMPS):
            response = self._bump(token, 'hint', **headers)
            self.assertNotEqual(response.status_code, 429)
        response = self._bump(token, 'hint', **headers)
        self.assertEqual(response.status_code, 429)


class ProfileEndpointTests(TestCase):
    """Coverage for gameplay/api.py: update_profile (POST /api/game/profile)
    and gameplay/daily.py: nickname_for — the player's chosen display name
    (also the client-side DiceBear avatar seed, static/game/avatar.js)."""

    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def test_update_profile_sets_name_and_stats_reports_it(self):
        response = self.client.post(
            '/api/game/profile', data={'name': 'Vitaly'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['name'], 'Vitaly')

        stats = self.client.get('/api/game/stats')
        self.assertEqual(stats.json()['player_name'], 'Vitaly')

    def test_update_profile_trims_whitespace(self):
        response = self.client.post(
            '/api/game/profile', data={'name': '  Vitaly  '}, content_type='application/json',
        )
        self.assertEqual(response.json()['name'], 'Vitaly')

    def test_update_profile_empty_name_falls_back_to_auto_nickname(self):
        response = self.client.post(
            '/api/game/profile', data={'name': '   '}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertRegex(response.json()['name'], r'^Player #[0-9a-f]{4}$')

    def test_update_profile_truncates_long_name(self):
        response = self.client.post(
            '/api/game/profile', data={'name': 'x' * 100}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['name'], 'x' * 24)

    def test_get_stats_defaults_to_auto_nickname_before_any_name_chosen(self):
        response = self.client.get('/api/game/stats')
        self.assertRegex(response.json()['player_name'], r'^Player #[0-9a-f]{4}$')


class DailyTournamentTests(TestCase):
    """Coverage for gameplay/daily.py (deterministic board/level/seed
    selection) and the /api/game/daily* endpoints (gameplay/api.py:
    daily_info/start_daily) — the shared-seed daily challenge and its
    per-day, penalty-adjusted leaderboard."""

    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def _win_moves(self, layout):
        tiles = [Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(layout)]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        return moves

    def _make_winner(self, score, claimed_at=None):
        """A GameSession row that already stands as a claimed daily win —
        bypasses the full start/finish flow for tests only about leaderboard
        ordering."""
        user = User.objects.create_user(username=f'daily-winner-{uuid.uuid4().hex}')
        Profile.objects.create(user=user)
        return GameSession.objects.create(
            level='easy', layout=[], seed='x', user=user, daily_date=timezone.localdate(),
            status=GameSession.Status.CLAIMED, won=True, score=score,
            claimed_at=claimed_at or timezone.now(),
        )

    # --- daily_challenge (pure) ---------------------------------------------

    def test_daily_challenge_deterministic_for_a_fixed_date(self):
        date = datetime.date(2026, 7, 28)
        self.assertEqual(daily_challenge(date), daily_challenge(date))

    def test_daily_challenge_rotates_board_but_always_normal_level(self):
        slugs = sorted(load_layouts().keys())
        base = datetime.date(2026, 7, 28)
        seen_boards = set()
        for offset in range(len(slugs)):
            board_slug, level, _seed = daily_challenge(base + timedelta(days=offset))
            self.assertIn(board_slug, slugs)
            self.assertEqual(level, 'normal')
            seen_boards.add(board_slug)
        self.assertEqual(seen_boards, set(slugs))

    def test_daily_challenge_seed_reproduces_identical_layout(self):
        board_slug, level, seed = daily_challenge(datetime.date(2026, 7, 28))
        board = get_layout(board_slug)
        a = generate_for_difficulty(level, board, seed=seed)
        b = generate_for_difficulty(level, board, seed=seed)
        self.assertEqual(a, b)

    # --- /daily/start --------------------------------------------------------

    def test_daily_start_is_idempotent_same_token_and_layout(self):
        first = self.client.post('/api/game/daily/start', data={}, content_type='application/json')
        second = self.client.post('/api/game/daily/start', data={}, content_type='application/json')
        self.assertEqual(first.status_code, 200, first.content)
        self.assertFalse(first.json()['finished'])
        self.assertEqual(first.json()['token'], second.json()['token'])
        self.assertEqual(first.json()['layout'], second.json()['layout'])
        self.assertEqual(GameSession.objects.filter(daily_date=timezone.localdate()).count(), 1)

    def test_daily_start_after_finish_reports_finished_with_no_board(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        moves = self._win_moves(data['layout'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        again = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        self.assertTrue(again['finished'])
        self.assertIsNone(again['token'])
        self.assertEqual(again['layout'], [])

    def test_two_regular_games_same_day_do_not_collide(self):
        """The one-attempt constraint is scoped to daily_date IS NOT NULL —
        ordinary /start games (always daily_date=NULL) never collide."""
        first = self.client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        second = self.client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(first.status_code, 200, first.content)
        self.assertNotEqual(first.json()['token'], second.json()['token'])

    def test_two_lost_daily_attempts_same_day_do_not_collide(self):
        """A lost/never-finished attempt doesn't hold an exclusive slot —
        only a WIN does (gameplay/models.py: one_daily_win_per_user_per_day)."""
        user = User.objects.create_user(username='daily-tester')
        Profile.objects.create(user=user)
        today = timezone.localdate()
        GameSession.objects.create(level='easy', layout=[], seed='x', user=user, daily_date=today)
        GameSession.objects.create(  # doesn't raise
            level='normal', layout=[], seed='y', user=user, daily_date=today,
        )
        self.assertEqual(
            GameSession.objects.filter(user=user, daily_date=today).count(), 2,
        )

    def test_two_daily_wins_same_day_violates_constraint(self):
        user = User.objects.create_user(username='daily-winner')
        Profile.objects.create(user=user)
        today = timezone.localdate()
        GameSession.objects.create(
            level='normal', layout=[], seed='x', user=user, daily_date=today, won=True,
            status=GameSession.Status.CLAIMED, score=1000,
        )
        with self.assertRaises(IntegrityError):
            GameSession.objects.create(
                level='normal', layout=[], seed='y', user=user, daily_date=today, won=True,
                status=GameSession.Status.CLAIMED, score=2000,
            )

    def _force_deadlock(self, token):
        # Same fixture as ShuffleApiTests.DEADLOCK_LAYOUT — two same-kind
        # stacked pairs whose free top tiles don't match each other.
        GameSession.objects.filter(token=token).update(layout=[
            {'x': 0, 'y': 0, 'z': 0, 'kind': 'Man1'},
            {'x': 0, 'y': 0, 'z': 1, 'kind': 'Man1'},
            {'x': 10, 'y': 10, 'z': 0, 'kind': 'Pin1'},
            {'x': 10, 'y': 10, 'z': 1, 'kind': 'Pin1'},
        ])

    def test_daily_start_after_deadlock_loss_allows_retry_with_fresh_session(self):
        first = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        self._force_deadlock(first['token'])
        lost = self.client.post(
            '/api/game/finish',
            data={'token': first['token'], 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )
        self.assertTrue(lost.json()['valid'], lost.content)

        retry = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        self.assertFalse(retry['finished'])
        self.assertNotEqual(retry['token'], first['token'])
        # Deterministic per-day seed — the retry is the exact same board.
        self.assertEqual(retry['layout'], first['layout'])
        self.assertEqual(
            GameSession.objects.filter(daily_date=timezone.localdate()).count(), 2,
        )

    def test_daily_info_status_lost_after_deadlock_allows_retry(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        self._force_deadlock(data['token'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )
        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_status'], 'lost')

    def test_win_after_retry_locks_out_further_attempts(self):
        first = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        self._force_deadlock(first['token'])
        self.client.post(
            '/api/game/finish',
            data={'token': first['token'], 'moves': [], 'outcome': 'deadlock'},
            content_type='application/json',
        )

        retry = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        moves = self._win_moves(retry['layout'])
        win = self.client.post(
            '/api/game/finish',
            data={'token': retry['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertTrue(win.json()['valid'], win.content)

        again = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        self.assertTrue(again['finished'])
        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_status'], 'won')

    # --- finish (scoring) -----------------------------------------------------

    def test_daily_finish_stores_score_and_ranks_by_it(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        token = data['token']
        moves = self._win_moves(data['layout'])
        # Seed one clearly higher and one clearly lower win around the caller.
        self._make_winner(score=10**9)
        self._make_winner(score=0)
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = response.json()
        self.assertTrue(body['valid'], body)
        self.assertEqual(GameSession.objects.get(token=token).score, body['score'])
        self.assertEqual(body['daily_rank'], 2)

    def test_daily_play_never_touches_lifetime_normal_stats(self):
        """Tournament and regular-play stats must never mix: hints/undos/
        shuffles/a win on a daily session leave Profile.stats['normal']
        exactly as it was (gameplay/api.py: _lifetime_stats_after) — the
        tournament's own record lives entirely in GameSession rows."""
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        token = data['token']
        profile = GameSession.objects.get(token=token).user.profile
        before = profile.stats['normal']
        overall_before = profile.stats['overall']

        self.client.post(
            f'/api/game/{token}/bump', data={'counter': 'hint'}, content_type='application/json',
        )
        moves = self._win_moves(data['layout'])
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        self.assertTrue(response.json()['valid'], response.content)

        profile.refresh_from_db()
        self.assertEqual(profile.stats['normal'], before)
        self.assertEqual(profile.stats['overall'], overall_before)
        # The response's own stats blob reflects the same untouched state.
        self.assertEqual(response.json()['stats']['normal'], before)

    def test_daily_loss_is_off_leaderboard(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        session = GameSession.objects.get(token=data['token'])
        session.status = GameSession.Status.CLAIMED
        session.won = False
        session.save(update_fields=['status', 'won'])

        leaderboard = self.client.get('/api/game/daily').json()['leaderboard']
        self.assertEqual(leaderboard, [])

    # --- leaderboard / status -------------------------------------------------

    def test_leaderboard_orders_by_score_desc_then_claimed_at(self):
        now = timezone.now()
        self._make_winner(score=3000, claimed_at=now)
        self._make_winner(score=5000, claimed_at=now)
        self._make_winner(score=5000, claimed_at=now - timedelta(seconds=10))  # earlier tie

        body = self.client.get('/api/game/daily').json()
        self.assertEqual([e['score'] for e in body['leaderboard']], [5000, 5000, 3000])
        self.assertEqual(body['total_participants'], 3)

    def test_leaderboard_ignores_unscored_legacy_wins(self):
        self._make_winner(score=None)
        self._make_winner(score=700)

        response = self.client.get('/api/game/daily')
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual([e['score'] for e in body['leaderboard']], [700])
        self.assertEqual(body['total_participants'], 1)

    def test_tied_scores_rank_matches_leaderboard_position(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        moves = self._win_moves(data['layout'])
        finish = self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        ).json()
        mine = GameSession.objects.get(token=data['token'])
        # One tied win claimed earlier (ahead of me), one claimed later (behind).
        self._make_winner(score=mine.score, claimed_at=mine.claimed_at - timedelta(seconds=5))
        self._make_winner(score=mine.score, claimed_at=mine.claimed_at + timedelta(seconds=5))

        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_rank'], 2)
        self.assertEqual(finish['daily_rank'], 1)  # before the other two existed
        self.assertEqual(body['leaderboard'][1]['rank'], 2)
        self.assertEqual(body['your_score'], mine.score)

    def test_own_rank_reported_outside_displayed_top(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        moves = self._win_moves(data['layout'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        for _i in range(25):
            self._make_winner(score=10**9)

        body = self.client.get('/api/game/daily').json()
        self.assertEqual(len(body['leaderboard']), 20)
        self.assertEqual(body['your_rank'], 26)
        self.assertEqual(body['total_participants'], 26)

    def test_leaderboard_nickname_uses_chosen_display_name_or_auto_fallback(self):
        named = self._make_winner(score=1000)
        named.user.profile.display_name = 'Vitaly'
        named.user.profile.save(update_fields=['display_name'])
        unnamed = self._make_winner(score=2000)

        body = self.client.get('/api/game/daily').json()
        by_score = {e['score']: e['nickname'] for e in body['leaderboard']}
        self.assertEqual(by_score[1000], 'Vitaly')
        self.assertEqual(
            by_score[2000], f'Player #{unnamed.user.profile.public_id.hex[:4]}',
        )

    def test_your_rank_reflects_standing_among_wins(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        moves = self._win_moves(data['layout'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        # Seed one higher and one lower win *relative to the caller's own
        # real score* — avoids a flaky assumption about the exact total.
        my_score = GameSession.objects.get(token=data['token']).score
        self._make_winner(score=max(0, my_score - 100))
        self._make_winner(score=my_score + 100)

        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_status'], 'won')
        self.assertEqual(body['your_rank'], 2)  # one higher-scoring winner ahead of me

    def test_daily_info_your_status_new_before_any_attempt(self):
        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_status'], 'new')
        self.assertIsNone(body['your_rank'])


@override_settings(
    CACHES={
        'default': {
            # A closed loopback port — refused instantly, no server needed,
            # no network access, so this is fast and deterministic in CI too.
            'BACKEND': 'django_redis.cache.RedisCache',
            'LOCATION': 'redis://127.0.0.1:6399/0',
            'OPTIONS': {
                'IGNORE_EXCEPTIONS': True,
                'SOCKET_CONNECT_TIMEOUT': 1,
                'SOCKET_TIMEOUT': 1,
            },
        },
    },
)
class RedisFailOpenTests(TestCase):
    """Guards the config/settings.py choice (IGNORE_EXCEPTIONS + django-redis
    over Django's built-in redis backend), not django-redis's own code: with
    the cache backend unreachable, rate limiting must fail open — a cache
    miss, not a 500 — rather than propagating redis.exceptions.RedisError.
    Must not call cache.clear() (that's a real op against this same
    unreachable backend, and there's nothing in it to reset anyway)."""

    def test_throttle_allows_request_when_cache_unreachable(self):
        throttle = IpRateThrottle('redis_fail_open_test', num_requests=1)
        request = type('_Req', (), {'META': {'HTTP_CF_CONNECTING_IP': '203.0.113.99'}})()
        # Called repeatedly, well past num_requests=1 — a raising backend
        # would surface on the first call already, but this also confirms
        # nothing here quietly starts throttling once a fallback engages.
        for _ in range(3):
            self.assertTrue(throttle.allow_request(request))

    def test_throttled_endpoint_still_responds_when_cache_unreachable(self):
        response = self.client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)


class PurgeSessionsTests(TestCase):
    """gameplay/management/commands/purge_sessions.py."""

    def _make_session(self, *, daily=False, age_days=0, layout=None, shuffles=None):
        user = User.objects.create_user(username=f'purge-test-{uuid.uuid4().hex}')
        Profile.objects.create(user=user)
        session = GameSession.objects.create(
            level='easy', layout=layout if layout is not None else [{'idx': 0}], seed='x',
            user=user, daily_date=timezone.localdate() if daily else None,
            shuffles=shuffles if shuffles is not None else [],
        )
        # created_at is auto_now_add — only .update() on the queryset can
        # backdate it, a plain .save() would stamp "now" right back over it.
        GameSession.objects.filter(pk=session.pk).update(
            created_at=timezone.now() - timezone.timedelta(days=age_days),
        )
        return session

    def _call(self, *args):
        out = StringIO()
        call_command('purge_sessions', *args, stdout=out)
        return out.getvalue()

    def test_old_non_daily_session_is_deleted(self):
        old = self._make_session(age_days=10)
        self._call('--days', '7')
        self.assertFalse(GameSession.objects.filter(pk=old.pk).exists())

    def test_recent_non_daily_session_is_kept(self):
        recent = self._make_session(age_days=1)
        self._call('--days', '7')
        self.assertTrue(GameSession.objects.filter(pk=recent.pk).exists())

    def test_old_daily_session_is_kept_but_blanked(self):
        old = self._make_session(daily=True, age_days=10, layout=[{'idx': 0}], shuffles=[{'x': 1}])
        self._call('--days', '7')
        old.refresh_from_db()
        self.assertEqual(old.layout, [])
        self.assertEqual(old.shuffles, [])
        # The lifetime-relevant fields survive the purge.
        self.assertIsNotNone(old.daily_date)
        self.assertIsNotNone(old.user_id)

    def test_recent_daily_session_is_untouched(self):
        recent = self._make_session(daily=True, age_days=1, layout=[{'idx': 0}])
        self._call('--days', '7')
        recent.refresh_from_db()
        self.assertEqual(recent.layout, [{'idx': 0}])

    def test_dry_run_changes_nothing(self):
        old_non_daily = self._make_session(age_days=10)
        old_daily = self._make_session(daily=True, age_days=10, layout=[{'idx': 0}])
        output = self._call('--days', '7', '--dry-run')

        self.assertTrue(GameSession.objects.filter(pk=old_non_daily.pk).exists())
        old_daily.refresh_from_db()
        self.assertEqual(old_daily.layout, [{'idx': 0}])
        self.assertIn('Would delete', output)
        self.assertIn('1 non-daily', output)
        self.assertIn('1 daily', output)


class ScoringTests(TestCase):
    """gameplay/scoring.py against tests/fixtures/scoring_cases.json — the
    same file tests/scoring.test.js asserts on, so the two implementations
    cannot drift."""

    def test_matches_shared_fixture_cases(self):
        path = settings.BASE_DIR / 'tests' / 'fixtures' / 'scoring_cases.json'
        cases = json.loads(path.read_text(encoding='utf-8'))
        self.assertTrue(cases)
        for case in cases:
            with self.subTest(case['name']):
                args = case['input']
                result = compute_score(
                    args['pairKinds'], args['level'], args['hints'], args['undos'],
                    args['shuffles'], args['elapsedMs'], args['won'],
                )
                self.assertEqual(result.model_dump(by_alias=True), case['expected'])

    def test_every_tile_kind_has_a_known_suit(self):
        # A kind added to the generator but not grouped would silently become
        # its own one-kind suit and never chain.
        known = {'man', 'pin', 'sou', 'winds', 'dragons', 'flower', 'season'}
        for kind in [*KINDS, *FLOWERS, *SEASONS]:
            with self.subTest(kind):
                self.assertIn(suit_of(kind), known)

    def test_suit_of_groups_kinds(self):
        self.assertEqual(suit_of('Man5'), 'man')
        self.assertEqual(suit_of('Pin9'), 'pin')
        self.assertEqual(suit_of('Sou3'), 'sou')
        self.assertEqual(suit_of('Pei'), 'winds')
        self.assertEqual(suit_of('Chun'), 'dragons')
        self.assertEqual(suit_of('Plum'), 'flower')
        self.assertEqual(suit_of('Winter'), 'season')


class FinishScoreTests(TestCase):
    """finish_game computes the point score only from the server's replay and
    its own hint/undo/shuffle counters, stores it on the session and returns
    it with the breakdown."""

    # A free Sou1 pair (idx 0/1, side by side) plus two stacked pairs that
    # can't match anything — removing the Sou1 pair leaves a dead end.
    DEADLOCK_AFTER_ONE_PAIR = [
        {'x': 30, 'y': 0, 'z': 0, 'kind': 'Sou1'},
        {'x': 32, 'y': 0, 'z': 0, 'kind': 'Sou1'},
        *ShuffleApiTests.DEADLOCK_LAYOUT,
    ]

    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _bump(self, token, counter):
        response = self.client.post(
            f'/api/game/{token}/bump',
            data={'counter': counter}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)

    def _finish(self, token, moves, outcome='win', **extra):
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': outcome, **extra},
            content_type='application/json',
        )
        return response.json()

    def _assert_score(self, body, kinds, level, hints, undos, shuffles, won=True):
        expected = compute_score(kinds, level, hints, undos, shuffles, body['elapsed_ms'], won)
        self.assertEqual(body['score'], expected.total)
        self.assertEqual(body['score_breakdown'], expected.model_dump(by_alias=True))

    def _solve(self, tiles):
        """Greedy full solution: (move log, kind of each removed pair)."""
        board = Board(tiles)
        moves, kinds = [], []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            kinds.append(a.kind)
            board.remove_pair(a, b)
        return moves, kinds

    def _tiles(self, layout, shuffled_kinds=None):
        shuffled_kinds = shuffled_kinds or {}
        return [
            Tile(i, t['x'], t['y'], t['z'], shuffled_kinds.get(str(i), t['kind']))
            for i, t in enumerate(layout)
        ]

    def test_win_stores_score_and_returns_breakdown(self):
        data = self._start('normal')
        moves, kinds = self._solve(self._tiles(data['layout']))
        body = self._finish(data['token'], moves)
        self.assertTrue(body['valid'], body)

        self._assert_score(body, kinds, 'normal', 0, 0, 0)
        self.assertEqual(len(body['score_breakdown']['pairPoints']), 72)
        self.assertGreater(body['score_breakdown']['noHelpBonus'], 0)
        self.assertEqual(GameSession.objects.get(token=data['token']).score, body['score'])

    def test_hints_and_undos_come_from_server_counters(self):
        data = self._start()
        token = data['token']
        for counter in ('hint', 'undo', 'undo'):
            self._bump(token, counter)
        moves, kinds = self._solve(self._tiles(data['layout']))
        body = self._finish(token, moves)

        self._assert_score(body, kinds, 'easy', 1, 2, 0)
        self.assertEqual(body['score_breakdown']['noHelpBonus'], 0)

    def test_client_cannot_influence_score(self):
        data = self._start()
        token = data['token']
        self._bump(token, 'hint')
        moves, kinds = self._solve(self._tiles(data['layout']))
        body = self._finish(
            token, moves, score=999999, hints=0, undos=0, shuffles=0,
            score_breakdown={'total': 999999},
        )
        self.assertTrue(body['valid'], body)
        self._assert_score(body, kinds, 'easy', 1, 0, 0)

    def test_shuffled_game_scores_post_shuffle_kinds_and_charges_the_shuffle(self):
        data = self._start()
        token = data['token']
        GameSession.objects.filter(token=token).update(layout=ShuffleApiTests.DEADLOCK_LAYOUT)
        response = self.client.post(
            f'/api/game/{token}/shuffle', data={'moves': []}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)

        session = GameSession.objects.get(token=token)
        moves, kinds = self._solve(
            self._tiles(session.layout, session.shuffles[0]['kinds']),
        )
        body = self._finish(token, moves)
        self.assertTrue(body['valid'], body)

        self._assert_score(body, kinds, 'easy', 0, 0, 1)

    def test_finish_folds_the_score_into_overall_stats(self):
        data = self._start('hard')
        moves, kinds = self._solve(self._tiles(data['layout']))
        body = self._finish(data['token'], moves)
        self.assertTrue(body['valid'], body)

        overall = body['stats']['overall']
        self.assertEqual(overall['gamesScored'], 1)
        self.assertEqual(overall['totalScore'], body['score'])
        self.assertEqual(overall['bestScore'], body['score'])
        self.assertEqual((overall['gamesWon'], overall['currentStreak']), (1, 1))

    def test_loss_adds_its_points_and_resets_the_streak(self):
        data = self._start()
        token = data['token']
        GameSession.objects.filter(token=token).update(layout=self.DEADLOCK_AFTER_ONE_PAIR)
        body = self._finish(token, [[0, 1]], outcome='deadlock')
        overall = body['stats']['overall']
        self.assertEqual((overall['gamesScored'], overall['totalScore']), (1, 10))
        self.assertEqual((overall['gamesWon'], overall['currentStreak']), (0, 0))

    def test_deadlock_loss_is_scored_without_bonuses(self):
        data = self._start()
        token = data['token']
        GameSession.objects.filter(token=token).update(layout=self.DEADLOCK_AFTER_ONE_PAIR)
        body = self._finish(token, [[0, 1]], outcome='deadlock')
        self.assertTrue(body['valid'], body)
        self.assertFalse(body['won'])
        self.assertEqual(body['score'], 10)
        self.assertEqual(body['score_breakdown']['pairPoints'], [10])
        self.assertEqual(body['score_breakdown']['noHelpBonus'], 0)
        self.assertEqual(body['score_breakdown']['timeBonus'], 0)
        self.assertEqual(GameSession.objects.get(token=token).score, 10)

    def test_rejected_finish_returns_no_score(self):
        data = self._start()
        body = self._finish(data['token'], [], outcome='win')
        self.assertFalse(body['valid'])
        self.assertIsNone(body['score'])
        self.assertIsNone(GameSession.objects.get(token=data['token']).score)
