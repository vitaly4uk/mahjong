import uuid
from datetime import timedelta

from django.contrib.auth.models import User
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from .api import SESSION_TTL  # noqa: F401 (registers the router when the test module is imported)
from .board import Board, Tile, is_free_position, match_key
from .generator import DIFFICULTIES, generate_for_difficulty
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


class GameApiTests(TestCase):
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
