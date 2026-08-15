import datetime
import random
import uuid
from datetime import timedelta

from django.contrib.auth.models import User
from django.core.cache import cache
from django.db import IntegrityError
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .api import (  # noqa: F401 (SESSION_TTL import also registers the router when this module loads)
    RATE_LIMIT_MAX_IMPORTS,
    RATE_LIMIT_MAX_SHUFFLES,
    SESSION_TTL,
)
from .board import Board, Tile, is_free_position, match_key
from .daily import HINT_PENALTY_MS, UNDO_PENALTY_MS, daily_challenge
from .generator import DIFFICULTIES, generate_for_difficulty, reshuffle_layout
from .layouts import LAYOUTS_DIR, LayoutError, get_layout, list_boards, load_layouts, parse_layout
from .middleware import PLAYER_COOKIE_NAME
from .models import GameSession, Profile
from .schemas import AllStats, LevelStats
from .stats import apply_loss, apply_win, merge_imported


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
        # Rate-limit counters (gameplay/api.py: _enforce_rate_limit) live in
        # Django's cache, not the DB — TestCase's transaction rollback never
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


class StatsEndpointTests(TestCase):
    def setUp(self):
        cache.clear()  # see GameApiTests.setUp for why

    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _bump(self, token, counter):
        return self.client.post(
            f'/api/game/{token}/bump', data={'counter': counter}, content_type='application/json',
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

    def _make_winner(self, score_ms, claimed_at=None):
        """A GameSession row that already stands as a claimed daily win —
        bypasses the full start/finish flow for tests only about leaderboard
        ordering."""
        user = User.objects.create_user(username=f'daily-winner-{uuid.uuid4().hex}')
        Profile.objects.create(user=user)
        return GameSession.objects.create(
            level='easy', layout=[], seed='x', user=user, daily_date=timezone.localdate(),
            status=GameSession.Status.CLAIMED, won=True, score_ms=score_ms,
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
            status=GameSession.Status.CLAIMED, score_ms=1000,
        )
        with self.assertRaises(IntegrityError):
            GameSession.objects.create(
                level='normal', layout=[], seed='y', user=user, daily_date=today, won=True,
                status=GameSession.Status.CLAIMED, score_ms=2000,
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

    def test_daily_finish_sets_score_ms_with_hint_and_undo_penalties(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        token = data['token']
        for counter in ('hint', 'hint', 'undo'):
            self.client.post(
                f'/api/game/{token}/bump',
                data={'counter': counter}, content_type='application/json',
            )
        moves = self._win_moves(data['layout'])
        response = self.client.post(
            '/api/game/finish',
            data={'token': token, 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        body = response.json()
        self.assertTrue(body['valid'], body)
        session = GameSession.objects.get(token=token)
        expected = body['elapsed_ms'] + 2 * HINT_PENALTY_MS + 1 * UNDO_PENALTY_MS
        self.assertEqual(session.score_ms, expected)
        self.assertEqual(body['daily_rank'], 1)  # sole winner today

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
        # The response's own stats blob reflects the same untouched state.
        self.assertEqual(response.json()['stats']['normal'], before)

    def test_daily_loss_leaves_score_ms_null_and_off_leaderboard(self):
        data = self.client.post(
            '/api/game/daily/start', data={}, content_type='application/json',
        ).json()
        session = GameSession.objects.get(token=data['token'])
        session.status = GameSession.Status.CLAIMED
        session.won = False
        session.save(update_fields=['status', 'won'])

        leaderboard = self.client.get('/api/game/daily').json()['leaderboard']
        self.assertEqual(leaderboard, [])
        self.assertIsNone(GameSession.objects.get(token=data['token']).score_ms)

    # --- leaderboard / status -------------------------------------------------

    def test_leaderboard_orders_by_score_then_claimed_at(self):
        now = timezone.now()
        self._make_winner(score_ms=5000, claimed_at=now)
        self._make_winner(score_ms=3000, claimed_at=now)
        self._make_winner(score_ms=3000, claimed_at=now - timedelta(seconds=10))  # earlier tie

        body = self.client.get('/api/game/daily').json()
        self.assertEqual([e['score_ms'] for e in body['leaderboard']], [3000, 3000, 5000])
        self.assertEqual(body['total_participants'], 3)

    def test_leaderboard_nickname_uses_chosen_display_name_or_auto_fallback(self):
        named = self._make_winner(score_ms=1000)
        named.user.profile.display_name = 'Vitaly'
        named.user.profile.save(update_fields=['display_name'])
        unnamed = self._make_winner(score_ms=2000)

        body = self.client.get('/api/game/daily').json()
        by_score = {e['score_ms']: e['nickname'] for e in body['leaderboard']}
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
        # Seed one faster and one slower win *relative to the caller's own
        # real score* — avoids a flaky assumption about how fast the test's
        # greedy solve itself runs.
        my_score = GameSession.objects.get(token=data['token']).score_ms
        self._make_winner(score_ms=max(0, my_score - 100))
        self._make_winner(score_ms=my_score + 100)

        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_status'], 'won')
        self.assertEqual(body['your_rank'], 2)  # one faster winner ahead of me

    def test_daily_info_your_status_new_before_any_attempt(self):
        body = self.client.get('/api/game/daily').json()
        self.assertEqual(body['your_status'], 'new')
        self.assertIsNone(body['your_rank'])
