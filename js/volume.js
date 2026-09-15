/* Fader position is UI state; decibels/gain are the audio-domain values. */
export const VOLUME_SCALE = "decibels-v1";
export const MAX_BOOST_DB = 6;
export const MIN_ENTRY_DB = -96;
const TAIL = 0.05;
const TAIL_DB = -60 * (1 - 2 * TAIL) ** 2;
const TAIL_GAIN = 10 ** (TAIL_DB / 20);

export function volumeGain(position) {
  const v = Math.max(0, Math.min(1, position));
  if (v < TAIL) return (v / TAIL) * TAIL_GAIN;
  const db = v <= 0.5 ? -60 * (1 - 2 * v) ** 2 : (v - 0.5) * 2 * MAX_BOOST_DB;
  return 10 ** (db / 20);
}

export function gainPosition(gain) {
  if (gain <= TAIL_GAIN) return Math.max(0, gain / TAIL_GAIN) * TAIL;
  const db = 20 * Math.log10(gain);
  return Math.min(1, db <= 0 ? (1 - Math.sqrt(-db / 60)) / 2 : 0.5 + db / (2 * MAX_BOOST_DB));
}

export function volumeLabel(position) {
  if (position <= 0) return "Muted";
  const db = 20 * Math.log10(volumeGain(position));
  if (Math.abs(db) < 0.05) return "0 dB";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/** Strict text entry: never turn blanks, malformed input or excessive boost
 * into a surprise change in output level. The mute button still gives −∞. */
export function parseVolumeDb(text) {
  const value = String(text).trim().replace(/\s*dB$/i, "").replace(/^−/, "-");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return { error: "Enter a number in dB, such as -36 or +3." };
  }
  const db = Number(value);
  if (!Number.isFinite(db) || db < MIN_ENTRY_DB || db > MAX_BOOST_DB) {
    return { error: `Enter ${MIN_ENTRY_DB} to +${MAX_BOOST_DB} dB. Use mute for silence.` };
  }
  return { position: db === MAX_BOOST_DB ? 1 : gainPosition(10 ** (db / 20)) };
}

/** Native audio-thread processing (works on the LAN's HTTP origin too).
 * At/below unity use a clean path; only boost goes through compression.
 * Crossfade the paths, delaying the dry path to match the 6 ms lookahead.
 * Boost trim compensates for the finite 20:1 ratio plus gives up to 1 dB
 * transient headroom. Boost labels indicate requested gain before protection.
 * This reduces peak overload, but is not a guarantee against intersample peaks,
 * already-clipped recordings, or distortion in the user's output device.
 */
export function createVolumeGraph(context) {
  const input = context.createGain();
  const dry = context.createGain();
  const dryGate = context.createGain();
  const delay = context.createDelay();
  delay.delayTime.value = 0.006;
  const boost = context.createGain();
  const protector = context.createDynamicsCompressor();
  protector.threshold.value = 0;
  protector.knee.value = 0;
  protector.ratio.value = 20;
  protector.attack.value = 0;
  protector.release.value = 0.15;
  const output = context.createGain();
  const trim = context.createGain();
  const wetGate = context.createGain();
  input.connect(delay);
  delay.connect(dry);
  dry.connect(dryGate);
  dryGate.connect(output);
  input.connect(boost);
  boost.connect(protector);
  protector.connect(trim);
  trim.connect(wetGate);
  wetGate.connect(output);
  output.connect(context.destination);
  let initialized = false;
  const ramps = new Map();
  function set(position) {
    const gain = volumeGain(position);
    const boosting = gain > 1;
    const safetyTrim = boosting ? gain ** (-1 / 20 - 1 / MAX_BOOST_DB) : 1;
    for (const [param, value] of [
      [dry.gain, Math.min(1, gain)], [boost.gain, gain], [trim.gain, safetyTrim],
      [dryGate.gain, boosting ? 0 : 1], [wetGate.gain, boosting ? 1 : 0],
    ]) {
      const now = context.currentTime;
      if (!initialized) {
        param.value = value;
        ramps.set(param, { from: value, to: value, start: now, end: now });
      } else {
        // Interpolate our own in-flight ramp so this also works in browsers
        // without cancelAndHoldAtTime. Rapid events never jump to old targets.
        const old = ramps.get(param);
        const fraction = old.end <= now ? 1 : Math.max(0, (now - old.start) / (old.end - old.start));
        const current = old.from + (old.to - old.from) * fraction;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
        param.linearRampToValueAtTime(value, now + 0.025);
        ramps.set(param, { from: current, to: value, start: now, end: now + 0.025 });
      }
    }
    initialized = true;
  }
  return { input, dry, boost, protector, output, trim, dryGate, wetGate, set };
}
