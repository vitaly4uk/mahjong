import test from 'node:test';
import assert from 'node:assert/strict';
import { isSoundOn, setSoundOn, playSound, STORAGE_KEY } from '../static/game/audio.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

// Minimal AudioContext double: records every node it was asked to create so
// tests can assert on "how many contexts" without a real audio backend.
function fakeAudioContextClass() {
  let created = 0;
  class FakeGain {
    constructor() { this.gain = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }; }
    connect() { return this; }
  }
  class FakeOscillator {
    constructor() { this.frequency = { value: 0, setValueAtTime() {} }; }
    connect() { return this; }
    start() {}
    stop() {}
  }
  class FakeBufferSource {
    constructor() { this.buffer = null; }
    connect() { return this; }
    start() {}
    stop() {}
  }
  class FakeFilter {
    constructor() { this.frequency = { value: 0 }; this.Q = { value: 0 }; }
    connect() { return this; }
  }
  class FakeCtx {
    constructor() {
      created += 1;
      this.currentTime = 0;
      this.sampleRate = 44100;
      this.state = 'running';
      this.destination = {};
    }
    createGain() { return new FakeGain(); }
    createOscillator() { return new FakeOscillator(); }
    createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return new FakeBufferSource(); }
    createBiquadFilter() { return new FakeFilter(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }
  FakeCtx.createdCount = () => created;
  return FakeCtx;
}

test('isSoundOn: defaults to true when nothing stored', () => {
  assert.equal(isSoundOn(fakeStorage()), true);
});

test('setSoundOn: persists and is read back', () => {
  const storage = fakeStorage();
  setSoundOn(false, storage);
  assert.equal(isSoundOn(storage), false);
  setSoundOn(true, storage);
  assert.equal(isSoundOn(storage), true);
});

test('isSoundOn: does not throw when storage throws', () => {
  const badStorage = { getItem: () => { throw new Error('nope'); } };
  assert.equal(isSoundOn(badStorage), true);
});

test('playSound: does not create an AudioContext when sound is off', () => {
  const storage = fakeStorage();
  setSoundOn(false, storage);
  const AudioContextClass = fakeAudioContextClass();
  playSound('match', { storage, AudioContextClass });
  assert.equal(AudioContextClass.createdCount(), 0);
});

test('playSound: lazily creates exactly one AudioContext, reused across calls', () => {
  const storage = fakeStorage();
  const AudioContextClass = fakeAudioContextClass();
  playSound('select', { storage, AudioContextClass });
  playSound('match', { storage, AudioContextClass });
  playSound('win', { storage, AudioContextClass });
  assert.equal(AudioContextClass.createdCount(), 1);
});

test('playSound: unknown sound name does not throw', () => {
  const storage = fakeStorage();
  const AudioContextClass = fakeAudioContextClass();
  assert.doesNotThrow(() => playSound('nonexistent', { storage, AudioContextClass }));
});

test('playSound: missing AudioContext does not throw', () => {
  const storage = fakeStorage();
  assert.doesNotThrow(() => playSound('match', { storage, AudioContextClass: undefined }));
});

test('STORAGE_KEY: is the documented localStorage key', () => {
  assert.equal(STORAGE_KEY, 'mahjong.sound');
});
