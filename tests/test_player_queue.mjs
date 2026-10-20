import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};

class FakeAudio {
  volume = 1;
  muted = false;
  paused = true;
  currentTime = 0;
  duration = NaN;
  src = "";
  listeners = {};
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); }
  load() {}
  async play() { this.paused = false; this.fire("play"); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  getAttribute(name) { return name === "src" ? this.src || null : null; }
}
globalThis.Audio = FakeAudio;

const events = [];
globalThis.window = {
  addEventListener() {},
  dispatchEvent: (e) => events.push(e.type),
};

let requests = [];
let respond = () => new Response(null, { status: 204 });
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: new URL(url), method: init.method || "GET", body: init.body && JSON.parse(init.body) });
  return respond(new URL(url));
};

const { api } = await import("../js/api.js");
const { player } = await import("../js/player.js");
const Player = player.constructor;

const tick = () => new Promise((r) => setTimeout(r, 0));
const track = (Id, extra = {}) => ({ Id, Name: Id, MediaType: "Audio", ...extra });
const stopped = (id) =>
  requests.filter((r) => r.url.pathname === "/Sessions/Playing/Stopped" && r.body.ItemId === id);

beforeEach(() => {
  storage.clear();
  requests = [];
  events.length = 0;
  respond = () => new Response(null, { status: 204 });
  Object.assign(api, { server: "http://jf", token: "t", userId: "u" });
});

test("a track that plays to the end is reported stopped exactly once", async () => {
  const p = new Player();
  p.play([track("a"), track("b")]);
  await tick();
  p.audio.fire("ended");
  await tick();
  assert.equal(stopped("a").length, 1);

  p.audio.fire("ended"); // last track, repeat off: the queue stops
  await tick();
  assert.equal(stopped("b").length, 1);
});

test("switching shuffle off keeps tracks added and drops tracks removed while shuffled", async () => {
  const p = new Player();
  p.toggleShuffle(true);
  p.play([track("a"), track("b"), track("c"), track("d")], 0);
  await tick();
  p.addToQueue(track("e"));
  p.addNext(track("f"));
  p.removeAt(p.queue.findIndex((t) => t.Id === "c"));
  p.toggleShuffle(false);
  assert.deepEqual(p.queue.map((t) => t.Id), ["a", "f", "b", "d", "e"]);
  assert.equal(p.current.Id, "a");
});

test("shuffle with an out-of-range start index does not duplicate a track", () => {
  const p = new Player();
  p.toggleShuffle(true);
  p.play([track("a"), track("b"), track("c")], 9);
  assert.equal(new Set(p.queue.map((t) => t.Id)).size, 3);
  assert.equal(p.queue.length, 3);
});

test("removing the current track while paused does not start playback", async () => {
  const p = new Player();
  p.play([track("a"), track("b")]);
  await tick();
  p.pause();
  p.removeAt(0);
  await tick();
  assert.equal(p.current.Id, "b");
  assert.equal(p.audio.paused, true);
});

test("changing the bitrate cap restores the position once metadata loads", async () => {
  const p = new Player();
  p.play([track("a")]);
  await tick();
  p.audio.currentTime = 42;
  p.setMaxBitrate(128000);
  p.audio.currentTime = 0; // a fresh src starts from zero
  p.audio.fire("loadedmetadata");
  assert.equal(p.audio.currentTime, 42);
});

test("reports carry the real repeat mode, order and play method", async () => {
  const p = new Player();
  p.cycleRepeat(); // all
  p.toggleShuffle(true);
  p.play([track("a", { Container: "wma" })]);
  await tick();
  const start = requests.find((r) => r.url.pathname === "/Sessions/Playing");
  assert.equal(start.body.RepeatMode, "RepeatAll");
  assert.equal(start.body.PlaybackOrder, "Shuffle");
  assert.equal(start.body.PlayMethod, "Transcode");
});

test("play method follows container and bitrate cap", () => {
  assert.equal(api.playMethod(track("a", { Container: "flac" })), "DirectPlay");
  assert.equal(api.playMethod(track("a", { Container: "wma" })), "Transcode");
  assert.equal(
    api.playMethod(track("a", { MediaSources: [{ Container: "flac", Bitrate: 900000 }] }), 320000),
    "Transcode"
  );
  assert.equal(
    api.playMethod(track("a", { MediaSources: [{ Container: "mp3", Bitrate: 192000 }] }), 320000),
    "DirectPlay"
  );
});

test("transcodes use progressive MP3 where the browser has no native HLS", () => {
  const url = new URL(api.streamUrl(track("a")));
  assert.equal(url.searchParams.get("TranscodingProtocol"), "http");
  assert.equal(url.searchParams.get("TranscodingContainer"), "mp3");
});

test("parallel 401s sign the user out once", async () => {
  respond = () => new Response(null, { status: 401 });
  await Promise.allSettled([api.get("/Items"), api.get("/Genres")]);
  assert.deepEqual(events, ["tm:unauthorized"]);
});

test("whole-collection queries page until a short page", async () => {
  respond = (url) => {
    const start = Number(url.searchParams.get("StartIndex"));
    const n = start === 0 ? 500 : 3;
    const Items = Array.from({ length: n }, (_, i) => ({ Id: String(start + i) }));
    return new Response(JSON.stringify({ Items, TotalRecordCount: 9999 }), { status: 200 });
  };
  const { items } = await api.genres();
  assert.equal(items.length, 503);
  assert.deepEqual(requests.map((r) => r.url.searchParams.get("StartIndex")), ["0", "500"]);
});

test("the next direct-play track is buffered near the end and takes over on ended", async () => {
  const p = new Player();
  p.play([track("a", { Container: "flac" }), track("b", { Container: "flac" })]);
  await tick();
  const first = p.audio;
  first.duration = 200;
  first.currentTime = 185;
  first.fire("timeupdate");
  assert.match(p._standby.src, /\/Audio\/b\//);

  first.fire("ended");
  await tick();
  assert.notEqual(p.audio, first);
  assert.equal(p.current.Id, "b");
  assert.equal(p.audio.paused, false);
  assert.equal(first.src, "");
  assert.equal(stopped("a").length, 1);
});

test("tracks that need a transcode are not preloaded", async () => {
  const p = new Player();
  p.play([track("a", { Container: "flac" }), track("b", { Container: "wma" })]);
  await tick();
  p.audio.duration = 200;
  p.audio.currentTime = 185;
  p.audio.fire("timeupdate");
  assert.equal(p._preload, null);
});

test("events from the standby element do not drive the player", async () => {
  const p = new Player();
  p.play([track("a", { Container: "flac" }), track("b", { Container: "flac" })]);
  await tick();
  p.audio.duration = 200;
  p.audio.currentTime = 185;
  p.audio.fire("timeupdate");
  p._standby.fire("ended");
  await tick();
  assert.equal(p.current.Id, "a");
});

test("the queue and position survive a reload, paused", async () => {
  const p1 = new Player();
  p1.play([track("a"), track("b"), track("c")], 1, { type: "album", id: "x", name: "X" });
  await tick();
  p1.audio.currentTime = 42;
  p1._saveQueue();

  const p2 = new Player();
  assert.equal(p2.restoreQueue(), true);
  assert.deepEqual(p2.queue.map((t) => t.Id), ["a", "b", "c"]);
  assert.equal(p2.current.Id, "b");
  assert.equal(p2.context.name, "X");
  assert.equal(p2.audio.paused, true);
  p2.audio.fire("loadedmetadata");
  assert.equal(p2.audio.currentTime, 42);
});

test("a saved queue keeps its pre-shuffle order", async () => {
  const p1 = new Player();
  p1.toggleShuffle(true);
  p1.play([track("a"), track("b"), track("c"), track("d")], 0);
  await tick();
  p1._saveQueue();

  const p2 = new Player(); // shuffle preference is restored too
  p2.restoreQueue();
  p2.toggleShuffle(false);
  assert.deepEqual(p2.queue.map((t) => t.Id), ["a", "b", "c", "d"]);
});

test("another user's saved queue is ignored", async () => {
  const p1 = new Player();
  p1.play([track("a")]);
  await tick();
  p1._saveQueue();
  api.userId = "someone-else";
  assert.equal(new Player().restoreQueue(), false);
});
