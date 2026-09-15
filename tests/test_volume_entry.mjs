import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVolumeDb, volumeGain } from "../js/volume.js";

test("typed dB maps to actual gain, not slider percent", () => {
  for (const input of ["-36", "0", "+3", "6", "-96", "-3.5", "+.5", " −36 dB "]) {
    const result = parseVolumeDb(input);
    assert.equal(result.error, undefined);
    const expected = Number(input.trim().replace("−", "-").replace(/\s*dB$/i, ""));
    assert(Math.abs(20 * Math.log10(volumeGain(result.position)) - expected) < 1e-8);
  }
  assert.equal(parseVolumeDb("0").position, 0.5);
  assert.equal(parseVolumeDb("6").position, 1);
});

test("unsafe boost and malformed input are rejected without a position", () => {
  for (const input of ["34", "+34", "6.01", "-97", "", " ", "abc", "3oops", "Infinity", "NaN", "0x10", "1e2", "--3", "3,4"]) {
    const result = parseVolumeDb(input);
    assert(result.error, input);
    assert.equal(result.position, undefined, input);
  }
});
