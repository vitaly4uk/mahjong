import uuid
from datetime import timedelta

from django.contrib.auth.models import User
from django.test import Client, TestCase
from django.utils import timezone

from .api import SESSION_TTL, router as gameplay_router  # noqa: F401 (реєструє роутер при імпорті тестового модуля)
from .board import Board, Tile, is_free_position, target_positions
from .generator import DIFFICULTIES, generate_for_difficulty
from .middleware import PLAYER_COOKIE_NAME
from .models import GameSession, Profile
from .schemas import AllStats, LevelStats
from .stats import apply_loss, apply_win, merge_imported


class BoardRuleTests(TestCase):
    def test_target_positions_is_136(self):
        self.assertEqual(len(target_positions()), 136)

    def test_is_free_position_blocked_by_tile_above(self):
        occupied = {(0, 0, 0), (0, 0, 1)}
        self.assertFalse(is_free_position(occupied, 0, 0, 0))

    def test_is_free_position_blocked_both_sides(self):
        occupied = {(1, 0, 0), (0, 0, 0), (2, 0, 0)}
        self.assertFalse(is_free_position(occupied, 1, 0, 0))

    def test_is_free_position_free_with_one_open_side(self):
        occupied = {(1, 0, 0), (0, 0, 0)}
        self.assertTrue(is_free_position(occupied, 1, 0, 0))

    def test_remove_pair_and_find_matching_pair(self):
        tiles = [Tile(0, 0, 0, 0, 'Man1'), Tile(1, 1, 0, 0, 'Man1')]
        board = Board(tiles)
        pair = board.find_matching_pair()
        self.assertIsNotNone(pair)
        self.assertTrue(board.remove_pair(*pair))
        self.assertTrue(board.is_won())

    def test_remove_pair_rejects_non_matching_and_covered(self):
        bottom = Tile(0, 0, 0, 0, 'Man1')
        top = Tile(1, 0, 0, 1, 'Pin1')
        board = Board([bottom, top])
        self.assertFalse(board.remove_pair(bottom, top))  # різний вид
        self.assertFalse(board.is_free(bottom))  # накрита зверху

    def test_is_deadlocked_when_no_free_pair_exists(self):
        blocked_man = Tile(0, 1, 0, 0, 'Man1')
        pin1 = Tile(1, 0, 0, 0, 'Pin1')
        pin2 = Tile(2, 2, 0, 0, 'Pin2')
        free_man = Tile(3, 4, 4, 0, 'Man1')
        board = Board([pin1, blocked_man, pin2, free_man])
        self.assertIsNone(board.find_matching_pair())
        self.assertTrue(board.is_deadlocked())
        self.assertFalse(board.is_won())


def _solve(tiles):
    """Жадібний солвер: знімає будь-яку легальну пару, поки можливо.
    True, якщо дошка повністю розібрана — доводить розв'язність поля."""
    board = Board([Tile(i, x, y, z, kind) for i, (x, y, z, kind) in enumerate(tiles)])
    while board.remaining > 0:
        pair = board.find_matching_pair()
        if pair is None:
            return False
        board.remove_pair(*pair)
    return True


class GeneratorTests(TestCase):
    def test_generated_layout_is_solvable_across_seeds(self):
        for level in DIFFICULTIES:
            for seed in range(30):
                tiles = generate_for_difficulty(level, seed=seed)
                self.assertEqual(len(tiles), 136, f'{level} seed={seed}: очікувано 136 кісток')
                self.assertTrue(_solve(tiles), f'{level} seed={seed}: поле нерозв\'язне')

    def test_generated_layout_is_authentic_deck(self):
        tiles = generate_for_difficulty('normal', seed=1)
        kinds = [kind for _, _, _, kind in tiles]
        self.assertEqual(len(kinds), 136)
        for kind in set(kinds):
            self.assertEqual(kinds.count(kind), 4, f'{kind}: очікувано 4 копії')

    def test_generate_for_difficulty_deterministic_by_seed(self):
        a = generate_for_difficulty('hard', seed=42)
        b = generate_for_difficulty('hard', seed=42)
        self.assertEqual(a, b)


class GameApiTests(TestCase):
    def _start(self, level='easy'):
        response = self.client.post(
            '/api/game/start', data={'level': level}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def _win_moves(self, layout):
        """Легальний повний розв'язок для заданого layout — жадібним
        солвером; повертає лог пар індексів у форматі, який очікує finish."""
        tiles = [Tile(i, t['x'], t['y'], t['z'], t['kind']) for i, t in enumerate(layout)]
        board = Board(tiles)
        moves = []
        while board.remaining > 0:
            a, b = board.find_matching_pair()
            moves.append([a.idx, b.idx])
            board.remove_pair(a, b)
        return moves

    def test_start_returns_136_tile_layout_and_valid_token(self):
        data = self._start()
        self.assertEqual(len(data['layout']), 136)
        uuid.UUID(data['token'])  # не кидає ValueError

    def test_start_rejects_unknown_level(self):
        response = self.client.post(
            '/api/game/start', data={'level': 'impossible'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

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
        # Свідомо нелегальна пара: дві кістки різного виду (якщо випадково
        # збіглися видом — беремо іншу другу кістку). Детерміновано нелегальна
        # незалежно від згенерованого layout, на відміну від довільних [0,1].
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

    def test_finish_double_claim_race_is_atomic(self):
        """Симулює гонку: обидва запити читають ACTIVE, але лише один атомарний
        UPDATE справді змінює статус — другий отримує 0 оновлених рядків."""
        data = self._start()
        moves = self._win_moves(data['layout'])
        payload = {'token': data['token'], 'moves': moves, 'outcome': 'win'}

        session = GameSession.objects.get(token=data['token'])
        self.assertEqual(session.status, GameSession.Status.ACTIVE)

        # Перший finish виконує атомарний UPDATE ACTIVE->CLAIMED.
        first = self.client.post('/api/game/finish', data=payload, content_type='application/json')
        self.assertTrue(first.json()['valid'])

        # Другий, навіть якби прочитав status=ACTIVE до першого запису (гонка),
        # усе одно провалить conditional UPDATE, бо рядок уже CLAIMED.
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
        # Ліниве маркування лишається за finish — GET нічого не пише.
        session = GameSession.objects.get(token=data['token'])
        self.assertEqual(session.status, GameSession.Status.ACTIVE)

    def test_session_state_unknown_token(self):
        body = self.client.get(f'/api/game/{uuid.uuid4()}').json()
        self.assertEqual(body['status'], 'unknown')
        self.assertIsNone(body['elapsed_ms'])

    def test_missing_csrf_token_is_rejected_when_enforced(self):
        # Django-тестовий Client за замовчуванням вимикає CSRF-перевірку —
        # тут вмикаємо її явно, щоб довести, що NinjaAPI(csrf=True) реально
        # захищає ендпоінт, а не просто присутній у конфігу.
        strict_client = Client(enforce_csrf_checks=True)
        response = strict_client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)


class StatsTransformerTests(TestCase):
    """Паритет із tests/stats.test.js (applyWin/applyLoss) + кейси, специфічні
    для pydantic-шару (клемпінг/мердж), яких у JS-версії нема."""

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
        self.assertEqual(stats.best_time_ms, 3000)  # швидша перемога стає рекордом

        stats = apply_win(stats, 9000)
        self.assertEqual(stats.best_time_ms, 3000)  # повільніша не перезаписує рекорд
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
        # server ще не грав на цьому рівні — currentStreak береться з імпорту
        self.assertEqual(merged.normal.current_streak, 2)
        # Легасі-блоб не мав лічильника стартів — gamesStarted підтягується
        # до gamesPlayed з імпорту, інакше вийшло б started < played.
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
        self.assertEqual(merged.normal.current_streak, 1)  # server-side стрік важливіший


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
        self.client.post('/api/game/start', data={'level': 'easy'}, content_type='application/json')
        self.assertEqual(Profile.objects.count(), 1)
        self.client.post('/api/game/start', data={'level': 'normal'}, content_type='application/json')
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
        for counter, field in (('hint', 'hintsTotal'), ('undo', 'undosTotal'), ('pair', 'pairsTotal')):
            response = self.client.post(
                f'/api/game/{token}/bump', data={'counter': counter}, content_type='application/json',
            )
            self.assertEqual(response.status_code, 200, response.content)
            self.assertEqual(response.json()['stats']['easy'][field], 1)

        response = self.client.post(
            f'/api/game/{token}/bump', data={'counter': 'hint'}, content_type='application/json',
        )
        self.assertEqual(response.json()['stats']['easy']['hintsTotal'], 2)

    def test_bump_rejects_unknown_token(self):
        response = self.client.post(
            f'/api/game/{uuid.uuid4()}/bump', data={'counter': 'hint'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_bump_rejects_already_claimed_session(self):
        data = self._start('easy')
        moves = self._win_moves(data['layout'])
        self.client.post(
            '/api/game/finish',
            data={'token': data['token'], 'moves': moves, 'outcome': 'win'},
            content_type='application/json',
        )
        response = self.client.post(
            f'/api/game/{data["token"]}/bump', data={'counter': 'hint'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_finish_updates_only_win_loss_fields_not_bump_totals(self):
        data = self._start('easy')
        token = data['token']
        self.client.post(f'/api/game/{token}/bump', data={'counter': 'pair'}, content_type='application/json')
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
        self.assertEqual(body['stats']['easy']['pairsTotal'], 1)  # з bump, не з finish

    def test_full_playthrough_totals_add_up_without_double_counting(self):
        data = self._start('easy')
        token = data['token']
        for _ in range(3):
            self.client.post(f'/api/game/{token}/bump', data={'counter': 'pair'}, content_type='application/json')
        self.client.post(f'/api/game/{token}/bump', data={'counter': 'hint'}, content_type='application/json')
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

    def test_import_accepted_once_then_rejected(self):
        legacy = {
            'easy': {'gamesPlayed': 2, 'gamesWon': 1, 'bestTimeMs': 4000, 'currentStreak': 1, 'bestStreak': 1},
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
        # Field(ge=0) відхиляє від'ємні значення на рівні ninja-валідації запиту.
        self.assertEqual(response.status_code, 422)
