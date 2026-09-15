import assert from "node:assert/strict";
import { test } from "node:test";
import { volumeGain, gainPosition, volumeLabel, VOLUME_SCALE } from "../js/volume.js";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
globalThis.Audio = class {
  volume = 1;
  muted = false;
  addEventListener() {}
  async play() { this.played = true; }
};
class Param {
  value = 1;
  calls = [];
  cancelScheduledValues(t) { this.calls.push(["cancel", t]); }
  setValueAtTime(v, t) { this.calls.push(["set", v, t]); this.value = v; }
  linearRampToValueAtTime(v, t) { this.calls.push(["ramp", v, t]); this.value = v; }
}
class Context {
  currentTime = 10;
  state = "suspended";
  destination = {};
  sources = 0;
  node() { return { connect() {}, disconnect() {} }; }
  createGain() { return { ...this.node(), gain: new Param() }; }
  createDelay() { return { ...this.node(), delayTime: new Param() }; }
  createDynamicsCompressor() {
    return { ...this.node(), ...Object.fromEntries(
      ["threshold", "knee", "ratio", "attack", "release"].map(k => [k, new Param()])) };
  }
  createMediaElementSource() { this.sources++; return this.node(); }
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
}
globalThis.window = { addEventListener() {}, AudioContext: Context };
const { player } = await import("../js/player.js");
const Player = player.constructor;
const PREFS = "tokyomusic.player";
function createPlayer(prefs = { volume: 0.5, volumeScale: VOLUME_SCALE }) {
  storage.set(PREFS, JSON.stringify(prefs));
  return new Player();
}
function close(actual, expected) {
  assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test("silence, neutral midpoint, bounded boost and decibel labels", () => {
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(0.5), 1);
  close(volumeGain(1), 10 ** (6 / 20));
  close(20 * Math.log10(volumeGain(0.4)), -2.4);
  assert.equal(volumeLabel(0), "Muted");
  assert.equal(volumeLabel(0.5), "0 dB");
  assert.equal(volumeLabel(1), "+6.0 dB");
});

test("curve is strictly increasing and round-trips across the entire fader", () => {
  let last = -1;
  for (let i = 0; i <= 1000; i++) {
    const gain = volumeGain(i / 1000);
    assert(gain > last);
    close(gainPosition(gain), i / 1000);
    last = gain;
  }
});

test("legacy preferences migrate by audible gain without a loudness jump", () => {
  for (const v of [0, 0.01, 0.05, 0.2, 0.5, 0.9, 1]) {
    const p = createPlayer({ volume: v, muted: true, repeat: "all", shuffle: true });
    close(volumeGain(p.volume), v ** 3);
    close(p.audio.volume, v ** 3);
    assert.equal(p.audio.muted, true);
    assert.equal(p.repeat, "all");
    assert.equal(p.shuffle, true);
  }
  assert.equal(createPlayer({ volume: 1 }).volume, 0.5);
});

test("versioned prefs save/reload without repeated migration", () => {
  const p = createPlayer();
  p.setVolume(0.75);
  assert.equal(JSON.parse(storage.get(PREFS)).volumeScale, VOLUME_SCALE);
  const restored = new Player();
  assert.equal(restored.volume, 0.75);
  assert.equal(restored.snapshot().volume, 0.75);
});

test("one audio graph survives track changes; gain changes ramp on the audio thread", async () => {
  const p = createPlayer();
  await p._playAudio();
  const context = p._audioContext;
  assert.equal(context.state, "running");
  assert.equal(p.audio.volume, 1);
  assert.equal(p._volumeGraph.dry.gain.value, 1);
  assert.equal(p._volumeGraph.wetGate.gain.value, 0);
  assert.equal(p._volumeGraph.protector.threshold.value, 0);
  assert.equal(p._volumeGraph.protector.knee.value, 0);
  assert.equal(p._volumeGraph.protector.attack.value, 0);
  p.setVolume(1);
  close(p._volumeGraph.boost.gain.value, volumeGain(1));
  close(p._volumeGraph.trim.gain.value, 10 ** (-1.3 / 20));
  assert.equal(p._volumeGraph.dryGate.gain.value, 0);
  assert.deepEqual(p._volumeGraph.boost.gain.calls[0], ["cancel", 10]);
  assert.equal(p._volumeGraph.boost.gain.calls[2][2], 10.025);
  context.currentTime = 10.0125;
  p.setVolume(0.5);
  close(p._volumeGraph.boost.gain.calls[4][1], (1 + volumeGain(1)) / 2);
  await p._playAudio();
  assert.equal(p._audioContext, context);
  assert.equal(context.sources, 1);
});

test("mute/unmute and silence do not lose the saved position", async () => {
  const p = createPlayer();
  await p._playAudio();
  p.toggleMute();
  assert.equal(p.audio.muted, true);
  p.setVolume(0);
  assert.equal(p.audio.muted, true);
  assert.equal(p._volumeGraph.dry.gain.value, 0);
  p.setVolume(0.4);
  assert.equal(p.audio.muted, false);
  close(p._volumeGraph.dry.gain.value, volumeGain(0.4));
});

test("invalid values ignored; out-of-range input clamped", () => {
  const p = createPlayer();
  p.setVolume(-1);
  assert.equal(p.volume, 0);
  p.setVolume(2);
  assert.equal(p.volume, 1);
  for (const v of [NaN, Infinity, -Infinity, undefined, null, "0.9"]) {
    p.setVolume(v);
    assert.equal(p.volume, 1);
  }
  storage.set(PREFS, "invalid JSON");
  assert.equal(new Player().volume, 0.5);
});

test("no Web Audio support falls back to attenuation and unity, not fictitious boost", () => {
  delete window.AudioContext;
  try {
    const p = createPlayer({ volume: 1, volumeScale: VOLUME_SCALE });
    assert.equal(p.volume, 0.5);
    p.setVolume(1);
    assert.equal(p.volume, 0.5);
    p.setVolume(0.4);
    close(p.audio.volume, volumeGain(0.4));
  } finally { window.AudioContext = Context; }
});

test("graph initialization failure keeps ordinary playback working", async () => {
  window.AudioContext = class { constructor() { throw new Error("unavailable"); } };
  try {
    const p = createPlayer();
    await p._playAudio();
    assert.equal(p.audio.played, true);
    assert.equal(p._boostAvailable, false);
    assert.equal(p.audio.volume, 1);
  } finally { window.AudioContext = Context; }
});
