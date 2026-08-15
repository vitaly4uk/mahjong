// Tiny WebAudio synth for gameplay feedback (tile select/match/error, undo,
// hint, shuffle, win/lose) — no sample files: every sound is a short
// oscillator/noise burst shaped by a gain envelope, generated on the fly.
// Zero licensing/attribution concerns, zero bytes added to the bundle.
// Chosen over recorded samples for exactly that reason (see
// docs/superpowers/specs/2026-07-15-mahjong-solitaire-mvp-design.md, "poza
// mezhamy MVP": sound was the one item from that list never implemented).
//
// Pure module, no Phaser/DOM — matches board.js/stats.js/avatar.js. Every
// AudioContext access takes an injectable `AudioContextClass` (default
// globalThis.AudioContext) so tests can run under plain Node without a real
// audio backend.

export const STORAGE_KEY = 'mahjong.sound';

function defaultStorage() {
  return globalThis.localStorage;
}

export function isSoundOn(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw !== 'off';
  } catch {
    // Private-mode/quota errors etc. — fail open, sound stays on.
    return true;
  }
}

export function setSoundOn(on, storage = defaultStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

// Lazily-created shared AudioContext. Browsers require a user gesture before
// audio starts, so the context must NOT be created at module-import time —
// only on the first actual playSound() call, which always follows a click.
// Cached per AudioContextClass so swapping the class (only ever happens in
// tests) transparently creates a fresh context instead of reusing a stale
// double from a previous test.
let cachedCtx = null;
let cachedCtxClass = null;

function getContext(AudioContextClass) {
  if (!AudioContextClass) return null;
  if (cachedCtx && cachedCtxClass === AudioContextClass) return cachedCtx;
  cachedCtx = new AudioContextClass();
  cachedCtxClass = AudioContextClass;
  return cachedCtx;
}

// Plays a short tone (or quick sequence of tones for a melodic cue) — used
// only for the two cues that AREN'T a tile hitting a tile (hint/win/lose).
// `notes` is an array of { freq, at, duration } scheduled relative to
// `ctx.currentTime`.
function playTones(ctx, notes, { type = 'sine', peakGain = 0.3 } = {}) {
  const master = ctx.createGain();
  master.gain.value = peakGain;
  master.connect(ctx.destination);
  for (const { freq, at = 0, duration = 0.12 } of notes) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.frequency.setValueAtTime?.(freq, ctx.currentTime + at);
    const gain = ctx.createGain();
    const start = ctx.currentTime + at;
    const end = start + duration;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(1, start + Math.min(0.015, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

// A tile-on-tile "clack": a very short burst of noise with the decay baked
// directly into the buffer (steep exponential envelope per-sample, on top of
// the gain-node ramp below) so it reads as a hard, dry knock rather than a
// soft hiss — a sine/triangle tone here would sound like a game-UI chime,
// not two mahjong tiles touching. Bandpass-filtered around `freq` to give it
// a woodblock-like pitch instead of flat white noise.
function playClack(ctx, { at = 0, duration = 0.035, peakGain = 0.4, freq = 2000, q = 2.5 } = {}) {
  const sampleRate = ctx.sampleRate ?? 44100;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    const decay = Math.exp((-6 * i) / length);
    data[i] = (Math.random() * 2 - 1) * decay;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const start = ctx.currentTime + at;
  const end = start + duration;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peakGain, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  let node = source;
  if (ctx.createBiquadFilter) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    node.connect(filter);
    node = filter;
  }
  node.connect(gain);
  gain.connect(ctx.destination);
  source.start(start);
  source.stop(end + 0.02);
}

// Longer, lower-pitched noise sweep — used only for the shuffle "riffle"
// cue, where a percussive clack would be too abrupt for a quarter-second
// sound.
function playSweep(ctx, { duration = 0.22, peakGain = 0.28, filterFreq = 1400 } = {}) {
  const sampleRate = ctx.sampleRate ?? 44100;
  const length = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  const start = ctx.currentTime;
  const end = start + duration;
  gain.gain.setValueAtTime(peakGain, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  let node = source;
  if (ctx.createBiquadFilter) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    node.connect(filter);
    node = filter;
  }
  node.connect(gain);
  gain.connect(ctx.destination);
  source.start(start);
  source.stop(end + 0.02);
}

const SOUNDS = {
  // A single tap — picking up a tile.
  select: (ctx) => playClack(ctx, { duration: 0.03, peakGain: 0.32, freq: 1700 }),
  // Two clacks in quick succession — the pair actually knocking together.
  match: (ctx) => {
    playClack(ctx, { at: 0, duration: 0.03, peakGain: 0.4, freq: 1900 });
    playClack(ctx, { at: 0.035, duration: 0.035, peakGain: 0.42, freq: 2300 });
  },
  // Distinct from the clacks on purpose (a blocked-tile click isn't a tile
  // sound at all) — a short, dissonant two-tone buzz, the classic "nope" cue.
  error: (ctx) => playTones(ctx, [
    { freq: 180, at: 0, duration: 0.09 },
    { freq: 160, at: 0, duration: 0.09 },
  ], { type: 'square', peakGain: 0.22 }),
  undo: (ctx) => {
    playClack(ctx, { at: 0, duration: 0.03, peakGain: 0.38, freq: 2200 });
    playClack(ctx, { at: 0.04, duration: 0.03, peakGain: 0.3, freq: 1600 });
  },
  hint: (ctx) => playTones(ctx, [
    { freq: 523, at: 0, duration: 0.09 },
    { freq: 659, at: 0.07, duration: 0.12 },
  ], { peakGain: 0.28 }),
  // A quick run of small clacks — tiles being re-dealt.
  shuffle: (ctx) => {
    playSweep(ctx, { duration: 0.22, peakGain: 0.22 });
    for (let i = 0; i < 5; i += 1) {
      playClack(ctx, { at: 0.02 + i * 0.045, duration: 0.02, peakGain: 0.22, freq: 1800 + i * 200 });
    }
  },
  win: (ctx) => playTones(ctx, [
    { freq: 523, at: 0, duration: 0.12 },
    { freq: 659, at: 0.1, duration: 0.12 },
    { freq: 784, at: 0.2, duration: 0.12 },
    { freq: 1047, at: 0.3, duration: 0.25 },
  ], { peakGain: 0.32 }),
  lose: (ctx) => playTones(ctx, [
    { freq: 392, at: 0, duration: 0.15 },
    { freq: 330, at: 0.12, duration: 0.25 },
  ], { type: 'triangle', peakGain: 0.3 }),
};

// Plays a named gameplay sound. Silently does nothing if sound is off, the
// name is unknown, or WebAudio isn't available — never throws.
export function playSound(name, { storage = defaultStorage(), AudioContextClass = globalThis.AudioContext } = {}) {
  if (!isSoundOn(storage)) return;
  const cue = SOUNDS[name];
  if (!cue) return;
  try {
    const ctx = getContext(AudioContextClass);
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    cue(ctx);
  } catch {
    // Any WebAudio failure degrades to silence — never breaks gameplay.
  }
}
