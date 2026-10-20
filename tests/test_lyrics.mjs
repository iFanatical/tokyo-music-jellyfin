import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.localStorage = { getItem: () => null };
const { parseLyrics, activeLineIndex } = await import("../js/lyrics.js");

const TICKS = 10000000;

test("synced lyrics keep their timings in seconds", () => {
  const out = parseLyrics({
    Lyrics: [
      { Text: "First", Start: 1 * TICKS },
      { Text: "", Start: 4 * TICKS },
      { Text: " Second ", Start: 6.5 * TICKS },
    ],
  });
  assert.equal(out.synced, true);
  assert.deepEqual(out.lines, [
    { text: "First", time: 1 },
    { text: "", time: 4 },
    { text: "Second", time: 6.5 },
  ]);
});

test("plain lyrics are unsynced", () => {
  const out = parseLyrics({ Lyrics: [{ Text: "Line one" }, { Text: "Line two" }] });
  assert.equal(out.synced, false);
  assert.deepEqual(out.lines.map((l) => l.time), [null, null]);
});

test("empty payloads mean no lyrics", () => {
  assert.equal(parseLyrics(null), null);
  assert.equal(parseLyrics({ Lyrics: [] }), null);
  assert.equal(parseLyrics({ Lyrics: [{ Text: "  " }] }), null);
});

test("the active line is the last one started, with a small lead", () => {
  const lines = [{ time: 1 }, { time: 4 }, { time: 6.5 }];
  assert.equal(activeLineIndex(lines, 0), -1);
  assert.equal(activeLineIndex(lines, 0.8), 0); // within the lead
  assert.equal(activeLineIndex(lines, 5), 1);
  assert.equal(activeLineIndex(lines, 99), 2);
});
