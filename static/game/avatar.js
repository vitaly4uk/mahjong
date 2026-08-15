// DiceBear avatar rendering: a pure module, no Phaser/DOM. The avatar seed
// is always the player's display name (gameplay/daily.py: nickname_for is
// the single source of that name, server- and client-side alike) — there is
// no separate seed field anywhere, so renaming always changes the avatar.
import { createAvatar } from '@dicebear/core';
import { funEmoji } from '@dicebear/collection';

// Memoized by `${name}|${size}` — the daily leaderboard rebuilds its <li>
// list (innerHTML) on every modal open, but the SVG for a given name/size is
// deterministic, so there's no reason to re-render it each time.
const cache = new Map();

// Returns a data: URI SVG for `name` at `size` px — safe to assign directly
// to an <img src>.
export function avatarDataUri(name, size = 28) {
  const key = `${name}|${size}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = createAvatar(funEmoji, { seed: name, size }).toDataUri();
    cache.set(key, uri);
  }
  return uri;
}
