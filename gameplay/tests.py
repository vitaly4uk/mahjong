from django.test import TestCase

from .board import Board, Tile, is_free_position, target_positions
from .generator import DIFFICULTIES, generate_for_difficulty


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
