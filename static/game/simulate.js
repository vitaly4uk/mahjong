import { Board } from './board.js';

// Бот "неуважного гравця": на кожному кроці бере випадкову пару серед тих,
// що зачіпають найвищий ще не розібраний шар (гравець природно тягнеться до
// відкритих кісток зверху), без прорахунку наперед. Якщо на верхньому шарі
// пар немає — бере довільну доступну. Повертає true, якщо партія виграна.
export function carelessPlay(board, rng) {
  for (;;) {
    const byKind = new Map();
    let maxZ = -1;
    for (const tile of board.tiles()) {
      if (!board.isFree(tile)) continue;
      if (tile.z > maxZ) maxZ = tile.z;
      const list = byKind.get(tile.kind) ?? [];
      list.push(tile);
      byKind.set(tile.kind, list);
    }
    let pairs = [];
    for (const list of byKind.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (list[i].z === maxZ || list[j].z === maxZ) pairs.push([list[i], list[j]]);
        }
      }
    }
    if (pairs.length === 0) {
      for (const list of byKind.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) pairs.push([list[i], list[j]]);
        }
      }
    }
    if (pairs.length === 0) break;
    const [a, b] = pairs[Math.floor(rng() * pairs.length)];
    board.removePair(a, b);
  }
  return board.isWon();
}

// Частка перемог "неуважного гравця" за trials симуляцій на одному розкладі.
// Кожна спроба грає на свіжому Board (той самий набір tiles), з окремим rng
// для детермінізму й незалежності спроб одна від одної.
export function measureWinRate(tiles, rng, trials = 16) {
  let wins = 0;
  for (let i = 0; i < trials; i++) {
    const board = new Board(tiles);
    if (carelessPlay(board, rng)) wins += 1;
  }
  return wins / trials;
}
