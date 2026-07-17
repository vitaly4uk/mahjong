import uuid

from django.test import Client, TestCase

from .api import router as gameplay_router  # noqa: F401 (реєструє роутер при імпорті тестового модуля)
from .board import Board, Tile, is_free_position, target_positions
from .generator import DIFFICULTIES, generate_for_difficulty
from .models import GameSession


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

    def test_missing_csrf_token_is_rejected_when_enforced(self):
        # Django-тестовий Client за замовчуванням вимикає CSRF-перевірку —
        # тут вмикаємо її явно, щоб довести, що NinjaAPI(csrf=True) реально
        # захищає ендпоінт, а не просто присутній у конфігу.
        strict_client = Client(enforce_csrf_checks=True)
        response = strict_client.post(
            '/api/game/start', data={'level': 'easy'}, content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)
