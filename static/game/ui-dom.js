// DOM UI controller for the game chrome (toolbar, status bar, photographer
// credit, the 4 modals) — templates/game.html, styled by
// static/game/tailwind.src.css. The canvas (main.js: MainScene) draws only
// the board (tiles/effects/background) now; everything here is a
// Publisher/Subscriber view on the SAME `scene.registry` (Phaser
// DataManager) the canvas UI used to render from directly — game logic
// still just writes facts to the registry, this module is the one that
// happens to render them as DOM instead of canvas Text. See
// docs/superpowers/specs/2026-07-29-tailwind-dom-ui-migration.md.
import {
  fetchDaily, saveProfile, setLanguage,
} from './sync.js';
import { winRate, fmtTime, LEVELS } from './stats.js';
import { avatarDataUri } from './avatar.js';
import { setSoundOn } from './audio.js';

const { gettext, interpolate } = window;

// The ONE place a difficulty's icon is picked — templates/game.html's
// #newgame-modal buttons render an empty `.text-2xl` span (see
// createUiDom below, which fills it from here), and LEVEL_LABELS (status
// bar / stats modal) is built from this same object, so the new-game
// modal, the status bar and the stats modal can never show three
// different icons for the same level.
const DIFFICULTY_ICONS = { easy: '👶', normal: '🧑', hard: '😈' };
// gettext() calls stay literal (not looked up via a variable) — makemessages
// extracts djangojs msgids by statically scanning for gettext('...') calls,
// so a computed key here would silently drop 'Easy'/'Normal'/'Hard' from
// locale/*/LC_MESSAGES/djangojs.po.
const LEVEL_LABELS = {
  easy: `${DIFFICULTY_ICONS.easy} ${gettext('Easy')}`,
  normal: `${DIFFICULTY_ICONS.normal} ${gettext('Normal')}`,
  hard: `${DIFFICULTY_ICONS.hard} ${gettext('Hard')}`,
};

const HINT_LABEL = `💡 ${gettext('Hint')}`;
const HINT_TEMPLATE = gettext('Hint (%(n)s)');
const UNDO_LABEL = `↩️ ${gettext('Undo')}`;
const UNDO_TEMPLATE = gettext('Undo (%(n)s)');

const STATS_ROW_LABELS = {
  started: `🎲 ${gettext('Games started')}`,
  played: `📋 ${gettext('Games played')}`,
  wins: `🏆 ${gettext('Wins')}`,
  winRate: `📈 ${gettext('Win rate')}`,
  currentStreak: `🔥 ${gettext('Current streak')}`,
  bestStreak: `⭐ ${gettext('Best streak')}`,
  bestTime: `⏱️ ${gettext('Best time')}`,
  totalHints: `💡 ${gettext('Total hints')}`,
  totalUndos: `↩️ ${gettext('Total undos')}`,
  totalPairs: `🀄 ${gettext('Total pairs removed')}`,
  totalShuffles: `🔀 ${gettext('Total shuffles')}`,
};

// Sets up the DOM toolbar/status-bar/modals and wires them to `scene`
// (main.js: MainScene) — scene methods for actions (hint/undo/startGame/...),
// scene.registry for state. Returns a small handle the scene calls into for
// the two things that still originate on the canvas side: the photographer
// credit (loadBackground) and the "fly to the counter" animation's target
// (flightTarget).
export function createUiDom(scene) {
  const btnNew = document.getElementById('btn-new');
  const btnHint = document.getElementById('btn-hint');
  const btnUndo = document.getElementById('btn-undo');
  const btnStats = document.getElementById('btn-stats');
  const btnDaily = document.getElementById('btn-daily');
  const btnProfile = document.getElementById('btn-profile');
  const profileAvatarEl = document.getElementById('profile-avatar');
  const profileNameEl = document.getElementById('profile-name');

  const statusText = document.getElementById('status-text');
  const statusDifficulty = document.getElementById('status-difficulty');
  const statusSummary = document.getElementById('status-summary');
  const bgCredit = document.getElementById('bg-credit');

  const statsModal = document.getElementById('stats-modal');
  const statsTitleEl = document.getElementById('stats-title');
  const statsLevelsEl = document.getElementById('stats-levels');
  const newgameModal = document.getElementById('newgame-modal');
  const newgameLevelButtons = [...newgameModal.querySelectorAll('[data-level]')];
  // The modal's own icon spans start empty (templates/game.html) — fill them
  // from DIFFICULTY_ICONS so this module is the only place the glyph is
  // written, matching how btnHint/btnUndo's labels below are JS-driven too.
  for (const btn of newgameLevelButtons) {
    btn.querySelector('.text-2xl').textContent = DIFFICULTY_ICONS[btn.dataset.level];
  }
  const newgameBoardButtons = [...newgameModal.querySelectorAll('[data-board]')];
  // Real (non-"random") board slugs — computed once here, the single source
  // scene.js reuses for pref validation instead of each re-querying the DOM.
  const realBoardSlugs = newgameBoardButtons
    .map((btn) => btn.dataset.board)
    .filter((slug) => slug !== 'random');
  const newgameStartBtn = document.getElementById('btn-newgame-start');
  const newgameCloseBtn = document.getElementById('btn-newgame-close');
  const deadlockModal = document.getElementById('deadlock-modal');
  const deadlockShuffleBtn = document.getElementById('btn-deadlock-shuffle');
  const deadlockReplayBtn = document.getElementById('btn-deadlock-replay');
  const deadlockGiveupBtn = document.getElementById('btn-deadlock-giveup');
  const dailyModal = document.getElementById('daily-modal');
  const dailyInfoEl = document.getElementById('daily-info');
  const dailyBoardEl = document.getElementById('daily-board');
  const dailyPlayBtn = document.getElementById('btn-daily-play');
  const dailyCloseBtn = document.getElementById('btn-daily-close');
  const profileModal = document.getElementById('profile-modal');
  const profileModalAvatarEl = document.getElementById('profile-modal-avatar');
  const profileNameInput = document.getElementById('profile-name-input');
  const profileErrorEl = document.getElementById('profile-error');
  const profileSaveBtn = document.getElementById('btn-profile-save');
  const profileCloseBtn = document.getElementById('btn-profile-close');
  const soundButtons = [...profileModal.querySelectorAll('[data-sound]')];
  const langButtons = [...profileModal.querySelectorAll('[data-lang]')];

  // Static base labels — set once, immediately (mirrors the old canvas
  // toolbar's construction-time text: createToolbar() baked HINT_LABEL/
  // UNDO_LABEL in directly, renderStats() only ever overwrites hint/undo
  // with the "(N)" variant once a game has counters).
  btnHint.textContent = HINT_LABEL;
  btnUndo.textContent = UNDO_LABEL;

  function renderStats() {
    statusText.textContent = scene.registry.get('status') || '';

    const hints = scene.registry.get('gameHints') || 0;
    const undos = scene.registry.get('gameUndos') || 0;
    btnHint.textContent = hints > 0
      ? `💡 ${interpolate(HINT_TEMPLATE, { n: hints }, true)}`
      : HINT_LABEL;
    btnUndo.textContent = undos > 0
      ? `↩️ ${interpolate(UNDO_TEMPLATE, { n: undos }, true)}`
      : UNDO_LABEL;
    // scene.currentLevel isn't assigned until later in create() (after the
    // first 'allStats' registry.set, which this listener already reacts to
    // — attached earlier here than the old canvas code attached it) — guard
    // so an early tick doesn't render the literal string "undefined".
    if (scene.currentLevel) statusDifficulty.textContent = LEVEL_LABELS[scene.currentLevel];

    const stats = scene.currentLevel && scene.registry.get('allStats')?.[scene.currentLevel];
    const elapsed = scene.registry.get('gameElapsedMs') || 0;
    if (stats) {
      statusSummary.textContent = `🏆 ${stats.gamesWon}/${stats.gamesPlayed} · 🔥 ${stats.currentStreak} · ⏱️ ${fmtTime(elapsed)}`;
    }
  }

  // Toolbar's own name+avatar (top-right, templates/game.html: #btn-profile).
  // The avatar seed IS the name (gameplay/daily.py: nickname_for is the
  // single source of both, server-side) — no separate seed anywhere.
  function renderPlayer() {
    const name = scene.registry.get('player');
    if (!name) return;
    profileNameEl.textContent = name;
    profileAvatarEl.src = avatarDataUri(name, 24);
  }

  // The stats-modal HTML (3 levels × 9 rows) — split out from renderStats()
  // since it's far more expensive to rebuild (innerHTML) and doesn't need to
  // run on every registry tick, only when allStats changes or the modal opens.
  function renderStatsModal() {
    const allStats = scene.registry.get('allStats');
    if (!allStats) return;
    statsLevelsEl.innerHTML = LEVELS.map((level) => {
      const s = allStats[level];
      const current = level === scene.currentLevel ? ' current' : '';
      const currentTag = current ? ` <span class="current-tag">← ${gettext('current')}</span>` : '';
      return `
        <div class="level-block${current}">
          <h3>${LEVEL_LABELS[level]}${currentTag}</h3>
          <dl>
            <dt>${STATS_ROW_LABELS.started}</dt><dd>${s.gamesStarted}</dd>
            <dt>${STATS_ROW_LABELS.played}</dt><dd>${s.gamesPlayed}</dd>
            <dt>${STATS_ROW_LABELS.wins}</dt><dd>${s.gamesWon}</dd>
            <dt>${STATS_ROW_LABELS.winRate}</dt><dd>${winRate(s)}%</dd>
            <dt>${STATS_ROW_LABELS.currentStreak}</dt><dd>${s.currentStreak}</dd>
            <dt>${STATS_ROW_LABELS.bestStreak}</dt><dd>${s.bestStreak}</dd>
            <dt>${STATS_ROW_LABELS.bestTime}</dt><dd>${s.bestTimeMs == null ? '—' : fmtTime(s.bestTimeMs)}</dd>
            <dt>${STATS_ROW_LABELS.totalHints}</dt><dd>${s.hintsTotal}</dd>
            <dt>${STATS_ROW_LABELS.totalUndos}</dt><dd>${s.undosTotal}</dd>
            <dt>${STATS_ROW_LABELS.totalPairs}</dt><dd>${s.pairsTotal}</dd>
            <dt>${STATS_ROW_LABELS.totalShuffles}</dt><dd>${s.shufflesTotal}</dd>
          </dl>
        </div>
      `;
    }).join('');
  }

  // Fills the daily-tournament modal: today's board/level, the caller's own
  // status/rank, and the leaderboard (gameplay/api.py: daily_info). Fetched
  // fresh on every open — the standings change as other players finish.
  async function renderDailyModal() {
    dailyInfoEl.textContent = gettext('Loading…');
    dailyBoardEl.innerHTML = '';
    dailyPlayBtn.disabled = true;
    dailyPlayBtn.style.display = '';

    let info;
    try {
      info = await fetchDaily();
    } catch {
      dailyInfoEl.textContent = `⚠️ ${gettext('Failed to load the daily tournament')}`;
      dailyPlayBtn.disabled = false;
      dailyPlayBtn.textContent = `🔄 ${gettext('Retry')}`;
      return;
    }
    scene.dailyInfo = info;
    dailyPlayBtn.disabled = false;

    // A WIN closes the tournament for the day — the result (score/rank) and
    // the leaderboard below already show it inline, so a "view result"
    // action would just close the modal again, which read as a dead button.
    // A LOSS is retryable (gameplay/api.py: start_daily mints a fresh
    // session whenever there's no win on record — see daily tournament
    // design spec's retry-after-loss), so 'lost' still gets a Play action.
    const finished = info.yourStatus === 'won';
    dailyPlayBtn.style.display = finished ? 'none' : '';
    const playLabels = {
      new: `▶️ ${gettext('Play')}`,
      active: `▶️ ${gettext('Resume')}`,
      lost: `🔁 ${gettext('Play again')}`,
    };
    dailyPlayBtn.textContent = playLabels[info.yourStatus] || playLabels.new;

    // The daily tournament is always a single difficulty (gameplay/daily.py:
    // DAILY_LEVEL) — nothing to disambiguate, so unlike the regular-game
    // status bar, level is deliberately not shown here.
    const lines = [
      info.boardName,
      interpolate(gettext('Participants: %(n)s'), { n: info.totalParticipants }, true),
    ];
    if (info.yourStatus === 'won' && info.yourScoreMs != null) {
      lines.push(interpolate(
        gettext('Your score: %(time)s (rank #%(rank)s)'),
        { time: fmtTime(info.yourScoreMs), rank: info.yourRank }, true,
      ));
    } else if (info.yourStatus === 'lost') {
      lines.push(gettext("You didn't finish — try again!"));
    }
    dailyInfoEl.innerHTML = lines.map((line) => `<div>${line}</div>`).join('');

    dailyBoardEl.innerHTML = '';
    if (info.leaderboard.length) {
      for (const entry of info.leaderboard) {
        // Built via DOM API, not innerHTML — entry.nickname is a player-
        // chosen display name (gameplay/api.py: update_profile), so it must
        // never be interpolated into an HTML string (stored XSS otherwise).
        const li = document.createElement('li');
        if (entry.rank === info.yourRank) li.className = 'you';

        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = `#${entry.rank}`;

        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.alt = '';
        avatar.src = avatarDataUri(entry.nickname, 22);

        const nickname = document.createElement('span');
        nickname.className = 'nickname';
        nickname.textContent = entry.nickname;

        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = fmtTime(entry.scoreMs);

        li.append(rank, avatar, nickname, time);
        dailyBoardEl.appendChild(li);
      }
    } else {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = gettext('No winners yet today');
      dailyBoardEl.appendChild(li);
    }
  }

  function renderModal(modal) {
    const showStats = modal?.type === 'stats' || modal?.type === 'result';
    statsModal.classList.toggle('open', showStats);
    newgameModal.classList.toggle('open', modal?.type === 'newgame');
    deadlockModal.classList.toggle('open', modal?.type === 'deadlock');
    dailyModal.classList.toggle('open', modal?.type === 'daily');
    profileModal.classList.toggle('open', modal?.type === 'profile');

    if (showStats) {
      let title = `📊 ${gettext('Statistics')}`;
      if (modal.type === 'result') {
        if (modal.error) {
          title = `⚠️ ${gettext('The game was not confirmed by the server')}`;
        } else if (modal.won) {
          // A daily win never reaches here — finishGame() routes it to the
          // {type:'daily'} modal instead (see there for why).
          title = `🎉 ${gettext('Victory!')}`;
        } else {
          title = `🚫 ${gettext('Dead end — no moves left')}`;
        }
      }
      statsTitleEl.textContent = title;
      // Not just relying on the changedata-allStats listener: currentLevel
      // (which controls the "current" highlight) can change without a fresh
      // allStats push, so refresh the content on every open too.
      renderStatsModal();
    }
    if (modal?.type === 'newgame') {
      for (const btn of newgameLevelButtons) {
        btn.classList.toggle('selected', btn.dataset.level === scene.currentLevel);
      }
      for (const btn of newgameBoardButtons) {
        btn.classList.toggle('selected', btn.dataset.board === scene.boardChoice);
      }
      newgameCloseBtn.style.display = modal.canClose ? '' : 'none';
    }
    if (modal?.type === 'daily') renderDailyModal();
    if (modal?.type === 'profile') {
      const name = scene.registry.get('player') || '';
      profileNameInput.value = name;
      profileModalAvatarEl.src = avatarDataUri(name || ' ', 72);
      profileErrorEl.classList.add('hidden');
      const soundOn = scene.registry.get('soundOn');
      for (const btn of soundButtons) {
        btn.classList.toggle('selected', (btn.dataset.sound === 'on') === soundOn);
      }
      for (const btn of langButtons) {
        btn.classList.toggle('selected', btn.dataset.lang === window.MAHJONG_LANG);
      }
    }
  }

  scene.registry.events.on('changedata', renderStats);
  scene.registry.events.on('changedata-allStats', renderStatsModal);
  scene.registry.events.on('changedata-modal', (_parent, value) => renderModal(value));
  scene.registry.events.on('changedata-player', renderPlayer);
  // Phaser's DataManager only fires 'changedata'/'changedata-<key>' from the
  // SECOND write to a given key onward — the very first-ever .set() for a
  // key fires the separate 'setdata' event instead (and, unlike
  // 'changedata-<key>', there is no per-key 'setdata-<key>' variant at all).
  // Every registry key this module cares about (status, gameHints, allStats,
  // modal, ...) is written for the first time somewhere during boot/game
  // start, so without this, the very first render of each would silently
  // never happen — the old canvas UI never hit this because it hardcoded its
  // initial text at construction and only needed 'changedata' for updates
  // after that.
  scene.registry.events.on('setdata', (_parent, key) => {
    renderStats();
    if (key === 'allStats') renderStatsModal();
    if (key === 'modal') renderModal(scene.registry.get('modal'));
    if (key === 'player') renderPlayer();
  });

  btnNew.addEventListener('click', () => {
    if (scene.registry.get('modal')) return;
    scene.registry.set('modal', { type: 'newgame', canClose: true });
  });
  btnHint.addEventListener('click', () => { if (!scene.registry.get('modal')) scene.hint(); });
  btnUndo.addEventListener('click', () => { if (!scene.registry.get('modal')) scene.undo(); });
  btnStats.addEventListener('click', () => {
    if (scene.registry.get('modal')) return;
    const open = scene.registry.get('modal')?.type === 'stats';
    scene.registry.set('modal', open ? null : { type: 'stats' });
  });
  btnDaily.addEventListener('click', () => {
    if (scene.registry.get('modal')) return;
    const open = scene.registry.get('modal')?.type === 'daily';
    scene.registry.set('modal', open ? null : { type: 'daily' });
  });
  btnProfile.addEventListener('click', () => {
    if (scene.registry.get('modal')) return;
    scene.registry.set('modal', { type: 'profile' });
  });

  document.getElementById('btn-stats-close').addEventListener('click', () => scene.registry.set('modal', null));
  document.getElementById('btn-stats-new').addEventListener('click', () => {
    scene.registry.set('modal', { type: 'newgame', canClose: true });
  });
  newgameCloseBtn.addEventListener('click', () => scene.registry.set('modal', null));
  for (const btn of newgameBoardButtons) {
    btn.addEventListener('click', () => {
      scene.boardChoice = btn.dataset.board;
      scene.saveBoardChoicePref(scene.boardChoice);
      renderModal(scene.registry.get('modal'));
    });
  }
  for (const btn of newgameLevelButtons) {
    btn.addEventListener('click', () => {
      scene.currentLevel = btn.dataset.level;
      scene.saveDifficultyPref(scene.currentLevel);
      renderModal(scene.registry.get('modal'));
    });
  }
  newgameStartBtn.addEventListener('click', () => {
    scene.registry.set('modal', null);
    const board = scene.boardChoice === 'random'
      ? realBoardSlugs[Math.floor(Math.random() * realBoardSlugs.length)]
      : scene.boardChoice;
    scene.startGame(scene.currentLevel, board);
  });
  deadlockShuffleBtn.addEventListener('click', () => scene.shuffleGame());
  deadlockReplayBtn.addEventListener('click', () => scene.replayGame());
  deadlockGiveupBtn.addEventListener('click', () => scene.finishGame(false));
  dailyPlayBtn.addEventListener('click', () => scene.playDaily());
  dailyCloseBtn.addEventListener('click', () => scene.registry.set('modal', null));

  // Live avatar preview as the player types — the seed IS the name, so this
  // doubles as visual feedback for that rule (no separate "reroll" control).
  profileNameInput.addEventListener('input', () => {
    profileModalAvatarEl.src = avatarDataUri(profileNameInput.value.trim() || ' ', 72);
  });
  profileSaveBtn.addEventListener('click', async () => {
    profileErrorEl.classList.add('hidden');
    try {
      const name = await saveProfile(profileNameInput.value);
      scene.registry.set('player', name);
      scene.registry.set('modal', null);
    } catch {
      profileErrorEl.textContent = `⚠️ ${gettext('Failed to save — check your connection')}`;
      profileErrorEl.classList.remove('hidden');
    }
  });
  profileCloseBtn.addEventListener('click', () => scene.registry.set('modal', null));
  for (const btn of soundButtons) {
    btn.addEventListener('click', () => {
      const on = btn.dataset.sound === 'on';
      setSoundOn(on);
      scene.registry.set('soundOn', on);
      renderModal(scene.registry.get('modal'));
    });
  }
  for (const btn of langButtons) {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang === window.MAHJONG_LANG) return;
      setLanguage(btn.dataset.lang).finally(() => location.reload());
    });
  }

  return {
    // Called from main.js: playDaily() when the server reports the attempt
    // was already claimed/forfeited between the modal's last fetch and the
    // click — refreshes the daily modal in place to show that result.
    renderDailyModal,
    // The real (non-"random") board slugs, computed once above — scene.js
    // uses this for board-pref validation instead of re-querying the DOM.
    realBoardSlugs,
    // Called from main.js: loadBackground() when a new background photo
    // arrives — replaces the old canvas setBgCredit().
    setBgCredit(photographer, photographerUrl) {
      if (!photographer) {
        bgCredit.classList.add('hidden');
        return;
      }
      bgCredit.textContent = interpolate(gettext('Photo: %(name)s · Pexels'), { name: photographer }, true);
      // Harmless no-op target (stays on the page) when the API didn't send a
      // photographer URL — same tolerance the old canvas credit had (it only
      // attached a click handler when photographerUrl was present).
      bgCredit.href = photographerUrl || '#';
      bgCredit.classList.remove('hidden');
    },
    // The "Remaining: N" counter's on-screen rect — main.js: flightTarget()
    // maps this into canvas world-space (device-px) for the pair-flies-to-
    // the-counter animation.
    getCounterRect() {
      return statusText.getBoundingClientRect();
    },
  };
}
