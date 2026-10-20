/* Audio engine: queue, transport, shuffle/repeat, reporting, MediaSession. */

import { api } from "./api.js";
import { emitter, shuffled, ticksToSec, artistsOf, throttle } from "./util.js";
import { VOLUME_SCALE, volumeGain, gainPosition, createVolumeGraph } from "./volume.js";

const LS_PREFS = "tokyomusic.player";
const LS_QUEUE = "tokyomusic.queue";
const REPEAT_MODES = ["none", "all", "one"];

/** Seconds before the end of a track at which the next one starts buffering. */
const PRELOAD_LEAD_SEC = 30;

/** Saved queues longer than this are trimmed around the current track. */
const MAX_SAVED_TRACKS = 3000;

/** Track fields the UI needs after a reload; everything else is dropped so a
    long queue stays well inside the localStorage quota. */
const SAVED_TRACK_FIELDS = [
  "Id", "Name", "Type", "MediaType", "Album", "AlbumId", "AlbumArtist",
  "AlbumArtists", "Artists", "ArtistItems", "AlbumPrimaryImageTag",
  "PrimaryImageTag", "RunTimeTicks", "IndexNumber", "ParentIndexNumber",
  "ProductionYear", "Container", "Bitrate", "HasLyrics",
];

function slimTrack(t) {
  const out = {};
  for (const k of SAVED_TRACK_FIELDS) if (t[k] != null) out[k] = t[k];
  if (t.ImageTags?.Primary) out.ImageTags = { Primary: t.ImageTags.Primary };
  const source = t.MediaSources?.[0];
  if (source) out.MediaSources = [{ Container: source.Container, Bitrate: source.Bitrate }];
  if (t.UserData) out.UserData = { IsFavorite: Boolean(t.UserData.IsFavorite) };
  return out;
}

function createAudio() {
  const a = new Audio();
  a.preload = "auto";
  a.crossOrigin = "anonymous";
  return a;
}

class Player {
  constructor() {
    const bus = emitter();
    this.on = bus.on;
    this._emit = bus.emit;

    /** The element currently playing. Gapless playback swaps it with
        `_standby`, which buffers the next track ahead of time. */
    this.audio = createAudio();
    this._standby = null;
    /** What `_standby` holds: { track, maxBitrate }. */
    this._preload = null;
    /** Media elements already routed into the Web Audio graph. */
    this._routed = new WeakSet();

    /** Tracks in play order. */
    this.queue = [];
    /** Pre-shuffle order, restored when shuffle is switched off. */
    this._unshuffled = null;
    this.index = -1;
    this.shuffle = false;
    this.repeat = "none";
    this.volume = 0.5; // center = 0 dB, unity
    this._audioContext = null;
    this._volumeGraph = null;
    this._boostAvailable = Boolean(window.AudioContext || window.webkitAudioContext);
    this.muted = false;
    this.maxBitrate = 0; // 0 = original quality
    /** Where the queue came from, e.g. { type: "album", id, name }. */
    this.context = null;

    this._loadPrefs();
    this._wireAudio(this.audio);
    this._wireMediaSession();

    /** The track Jellyfin was last told started, until it is told it stopped. */
    this._reportedItem = null;

    this._reportProgress = throttle(() => {
      const t = this.current;
      if (!t) return;
      api.reportProgress(t, this._reportState());
    }, 10000);

    // Persist the queue for the next page load. Structure changes are
    // batched; the position is saved every few seconds while playing.
    let saveTimer = 0;
    const scheduleSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => this._saveQueue(), 300);
    };
    this.on("queue", scheduleSave);
    this.on("track", scheduleSave);
    this._savePosition = throttle(() => this._saveQueue(), 5000);

    // Best-effort "stopped" report if the tab closes mid-track.
    window.addEventListener("pagehide", () => {
      this._saveQueue();
      if (!this.audio.paused) this._reportStop(this.audio.currentTime);
    });
  }

  /* ---------------- state ---------------- */

  get current() {
    return this.queue[this.index] || null;
  }

  get isPlaying() {
    return Boolean(this.current) && !this.audio.paused;
  }

  get duration() {
    if (isFinite(this.audio.duration) && this.audio.duration > 0)
      return this.audio.duration;
    return ticksToSec(this.current?.RunTimeTicks);
  }

  get position() {
    return this.audio.currentTime || 0;
  }

  _loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_PREFS) || "{}");
      if (Number.isFinite(p.volume)) {
        const saved = Math.max(0, Math.min(1, p.volume));
        // Migrate the previous cubic fader by audible gain, not position:
        // old 100% becomes center; a quiet saved level must not jump louder.
        this.volume = p.volumeScale === VOLUME_SCALE ? saved : gainPosition(saved ** 3);
      }
      if (!this._boostAvailable) this.volume = Math.min(0.5, this.volume);
      this.muted = Boolean(p.muted);
      this.shuffle = Boolean(p.shuffle);
      this.repeat = REPEAT_MODES.includes(p.repeat) ? p.repeat : "none";
      this.maxBitrate = p.maxBitrate || 0;
    } catch {
      /* defaults are fine */
    }
    this._applyVolume();
    this.audio.muted = this.muted;
  }

  /** Position, mute and mode fields for a progress or start report. */
  _reportState(overrides = {}) {
    return {
      positionSec: this.audio.currentTime,
      isPaused: this.audio.paused,
      volume: this.volume,
      isMuted: this.muted,
      mode: {
        playMethod: api.playMethod(this.current, this.maxBitrate),
        repeat: this.repeat,
        shuffle: this.shuffle,
      },
      ...overrides,
    };
  }

  _reportStart(track, positionSec = 0) {
    this._reportedItem = track;
    api.reportStart(track, this._reportState({ positionSec, isPaused: false }));
  }

  /** Reports the started track as stopped, exactly once per start. */
  _reportStop(positionSec) {
    const t = this._reportedItem;
    if (!t) return;
    this._reportedItem = null;
    api.reportStopped(t, positionSec);
  }

  _savePrefs() {
    localStorage.setItem(
      LS_PREFS,
      JSON.stringify({
        volume: this.volume,
        volumeScale: VOLUME_SCALE,
        muted: this.muted,
        shuffle: this.shuffle,
        repeat: this.repeat,
        maxBitrate: this.maxBitrate,
      })
    );
  }

  /** Wires an element's events. Both elements are wired once; events from
      the one not currently playing are ignored, except a failed preload. */
  _wireAudio(a) {
    const on = (type, fn) =>
      a.addEventListener(type, (e) => {
        if (a === this.audio) fn(e);
      });

    on("timeupdate", () => {
      this._emit("time", { position: a.currentTime, duration: this.duration });
      if (!a.paused) {
        this._reportProgress();
        this._savePosition();
        this._maybePreload();
      }
    });

    on("progress", () => {
      let buffered = 0;
      try {
        if (a.buffered.length)
          buffered = a.buffered.end(a.buffered.length - 1);
      } catch {
        /* buffered can throw before metadata loads */
      }
      this._emit("buffer", { buffered, duration: this.duration });
    });

    on("play", () => {
      this._emit("state", this.snapshot());
      this._updateMediaSessionState();
    });

    on("playing", () => {
      this._syncMediaSession();
    });

    on("pause", () => {
      this._emit("state", this.snapshot());
      this._syncMediaSession();
      const t = this.current;
      if (t) api.reportProgress(t, this._reportState({ isPaused: true }));
      this._saveQueue();
    });

    on("ended", () => this._onEnded());

    on("loadedmetadata", () => {
      if (this._pendingSeek != null) {
        a.currentTime = this._pendingSeek;
        this._pendingSeek = null;
      }
      this._emit("time", { position: a.currentTime, duration: this.duration });
    });

    a.addEventListener("error", () => {
      if (a !== this.audio) this._preload = null;
    });

    on("error", () => {
      const t = this.current;
      const code = a.error?.code;
      // code 4 = SRC_NOT_SUPPORTED; usually a container the browser refuses.
      this._emit("error", {
        item: t,
        message:
          code === 4
            ? `Can't play "${t?.Name || "track"}" — format unsupported by this browser.`
            : `Playback error on "${t?.Name || "track"}".`,
      });
      // Don't hammer through a broken queue: only auto-advance once.
      if (this._advancedOnError !== this.index) {
        this._advancedOnError = this.index;
        this.next(true);
      }
    });
  }

  /* ---------------- queue control ---------------- */

  /**
   * Replace the queue and start playing.
   * @param {Array} items tracks
   * @param {number} startIndex index within items
   * @param {object} context  { type, id, name }
   */
  play(items, startIndex = 0, context = null) {
    const tracks = (items || []).filter(
      (i) => i && (i.MediaType === "Audio" || i.Type === "Audio")
    );
    if (!tracks.length) return;

    this.context = context;
    this._unshuffled = null;

    const start = Math.max(0, Math.min(startIndex, tracks.length - 1));
    if (this.shuffle) {
      const first = tracks[start];
      const rest = tracks.filter((_, i) => i !== start);
      this._unshuffled = tracks;
      this.queue = [first, ...shuffled(rest)];
      this.index = 0;
    } else {
      this.queue = tracks;
      this.index = start;
    }

    this._emit("queue", this.snapshot());
    this._load(true);
  }

  /** Shuffle a set of tracks and play from a random start. */
  playShuffled(items, context = null) {
    if (!items?.length) return;
    if (!this.shuffle) this.toggleShuffle(true);
    const order = shuffled(items);
    this.context = context;
    this._unshuffled = items.slice();
    this.queue = order;
    this.index = 0;
    this._emit("queue", this.snapshot());
    this._load(true);
  }

  addNext(items) {
    const tracks = [].concat(items).filter(Boolean);
    if (!tracks.length) return;
    if (!this.queue.length) return this.play(tracks, 0, null);
    this.queue.splice(this.index + 1, 0, ...tracks);
    // Keep the pre-shuffle order in step, or switching shuffle off drops them.
    if (this._unshuffled) {
      const at = this._unshuffled.indexOf(this.current);
      this._unshuffled.splice(at + 1, 0, ...tracks);
    }
    this._emit("queue", this.snapshot());
  }

  addToQueue(items) {
    const tracks = [].concat(items).filter(Boolean);
    if (!tracks.length) return;
    if (!this.queue.length) return this.play(tracks, 0, null);
    this.queue.push(...tracks);
    this._unshuffled?.push(...tracks);
    this._emit("queue", this.snapshot());
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    const [removed] = this.queue.splice(i, 1);
    if (this._unshuffled) {
      const at = this._unshuffled.indexOf(removed);
      if (at >= 0) this._unshuffled.splice(at, 1);
    }
    if (i < this.index) this.index--;
    else if (i === this.index) {
      const wasPlaying = !this.audio.paused;
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      if (this.index < 0) return this.stop();
      this._load(wasPlaying);
    }
    this._emit("queue", this.snapshot());
  }

  moveInQueue(from, to) {
    if (from === to) return;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    const cur = this.index;
    if (from === cur) this.index = to;
    else if (from < cur && to >= cur) this.index--;
    else if (from > cur && to <= cur) this.index++;
    this._emit("queue", this.snapshot());
  }

  clearQueue() {
    const cur = this.current;
    this.queue = cur ? [cur] : [];
    this.index = cur ? 0 : -1;
    this._unshuffled = this.shuffle && cur ? [cur] : null;
    this._emit("queue", this.snapshot());
  }

  jumpTo(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this._load(true);
    this._emit("queue", this.snapshot());
  }

  /* ---------------- transport ---------------- */

  async _load(autoplay) {
    const track = this.current;
    if (!track) return;

    this._reportStop(this.audio.currentTime);
    this._pendingSeek = null;

    if (!this._swapToPreloaded(track)) {
      this.audio.src = api.streamUrl(track, { maxBitrate: this.maxBitrate });
      this.audio.load();
    }
    this._emit("track", this.snapshot());

    if (autoplay) {
      try {
        await this._playAudio();
        this._syncMediaSession();
        this._reportStart(track, 0);
      } catch (e) {
        if (e.name !== "AbortError") {
          this._emit("error", {
            item: track,
            message:
              e.name === "NotAllowedError"
                ? "Browser blocked autoplay — press play to start."
                : `Could not start "${track.Name}".`,
          });
        }
      }
    } else {
      this._syncMediaSession();
    }
    this._emit("state", this.snapshot());
  }

  /* ---------------- gapless ---------------- */

  /** Queue index that plays after the current track ends, or -1. */
  _nextIndex() {
    if (this.repeat === "one" || this.index < 0) return -1;
    if (this.index < this.queue.length - 1) return this.index + 1;
    return this.repeat === "all" && this.queue.length > 1 ? 0 : -1;
  }

  /**
   * Starts buffering the next track in the standby element once the current
   * one is near its end, so the switch on "ended" has no network wait.
   * Only direct-play tracks are preloaded: a second transcode for the same
   * device could make the server cut off the one that is playing.
   */
  _maybePreload() {
    const remaining = this.duration - this.audio.currentTime;
    if (!(remaining > 0 && remaining <= PRELOAD_LEAD_SEC)) return;
    const next = this.queue[this._nextIndex()];
    if (!next || next === this.current) return;
    if (this._preload?.track === next && this._preload.maxBitrate === this.maxBitrate) return;
    if (api.playMethod(next, this.maxBitrate) !== "DirectPlay") return;

    if (!this._standby) {
      this._standby = createAudio();
      this._standby.muted = this.muted;
      this._wireAudio(this._standby);
    }
    this._preload = { track: next, maxBitrate: this.maxBitrate };
    this._routeElement(this._standby);
    this._applyVolume(this._standby);
    this._standby.src = api.streamUrl(next, { maxBitrate: this.maxBitrate });
    this._standby.load();
  }

  /** Makes the standby element active if it already holds `track`. */
  _swapToPreloaded(track) {
    const pre = this._preload;
    this._preload = null;
    if (!pre || pre.track !== track || pre.maxBitrate !== this.maxBitrate) return false;
    const old = this.audio;
    this.audio = this._standby;
    this._standby = old;
    old.pause();
    old.removeAttribute("src");
    old.load();
    return true;
  }

  _clearPreload() {
    this._preload = null;
    if (this._standby?.getAttribute?.("src")) {
      this._standby.removeAttribute("src");
      this._standby.load();
    }
  }

  async toggle() {
    if (!this.current) return;
    if (this.audio.paused) {
      try {
        await this._playAudio();
        if (this._reportedItem !== this.current) {
          this._reportStart(this.current, this.audio.currentTime);
        }
      } catch {
        /* surfaced via the audio error handler */
      }
    } else {
      this.audio.pause();
    }
  }

  pause() {
    this.audio.pause();
  }

  next(auto = false) {
    if (!this.queue.length) return;

    if (this.index < this.queue.length - 1) {
      this.index++;
      this._load(true);
    } else if (this.repeat === "all") {
      this.index = 0;
      this._load(true);
    } else if (auto) {
      this.stop();
    } else {
      this.index = 0;
      this._load(true);
    }
    this._emit("queue", this.snapshot());
  }

  prev() {
    if (!this.queue.length) return;
    // Restart the track first, like every other music player.
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    if (this.index > 0) {
      this.index--;
    } else if (this.repeat === "all") {
      this.index = this.queue.length - 1;
    } else {
      this.audio.currentTime = 0;
      return;
    }
    this._load(true);
    this._emit("queue", this.snapshot());
  }

  _onEnded() {
    const t = this.current;
    this._reportStop(this.duration);

    if (this.repeat === "one") {
      this.audio.currentTime = 0;
      this._playAudio().catch(() => {});
      if (t) this._reportStart(t, 0);
      return;
    }
    this.next(true);
  }

  stop() {
    this._reportStop(this.audio.currentTime);
    this._clearPreload();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.index = -1;
    this._syncMediaSession();
    this._emit("track", this.snapshot());
    this._emit("state", this.snapshot());
  }

  seek(sec) {
    if (!this.current) return;
    const d = this.duration;
    this.audio.currentTime = Math.max(0, Math.min(sec, d || sec));
    this._emit("time", { position: this.audio.currentTime, duration: d });
  }

  seekBy(delta) {
    this.seek(this.position + delta);
  }

  async _playAudio() {
    if (!this._audioContext && this._boostAvailable) {
      const Context = window.AudioContext || window.webkitAudioContext;
      let context;
      let source;
      try {
        context = new Context();
        const graph = createVolumeGraph(context);
        graph.set(this.volume);
        // Create only one source per media element, reused for every track.
        source = context.createMediaElementSource(this.audio);
        source.connect(graph.input);
        this._routed.add(this.audio);
        this._audioContext = context;
        this._volumeGraph = graph;
        this.audio.volume = 1;
      } catch {
        // Keep ordinary playback usable if Web Audio cannot initialize.
        if (source) {
          // A media element cannot be detached from its source node again.
          // Retain a direct route if graph connection failed after capture.
          source.disconnect();
          source.connect(context.destination);
          this._audioContext = context;
        } else context?.close().catch(() => {});
        this._boostAvailable = false;
        this.setVolume(Math.min(0.5, this.volume));
        this._emit("error", { message: "Audio boost is unavailable in this browser; volume is limited to 0 dB." });
      }
    }
    this._routeElement(this.audio);
    if (this._audioContext?.state !== "running" && this._audioContext) {
      await this._audioContext.resume();
    }
    return this.audio.play();
  }

  /** Sends an element through the volume graph, once per element. Without a
      graph (no Web Audio, or it failed) elements play directly. */
  _routeElement(a) {
    if (!this._volumeGraph || this._routed.has(a)) return;
    try {
      this._audioContext.createMediaElementSource(a).connect(this._volumeGraph.input);
      this._routed.add(a);
      a.volume = 1;
    } catch {
      /* the element keeps playing directly at its own volume */
    }
  }

  _applyVolume(only) {
    if (this._volumeGraph) this._volumeGraph.set(this.volume);
    const level = Math.min(1, volumeGain(this.volume));
    for (const a of only ? [only] : [this.audio, this._standby]) {
      if (a && !this._routed.has(a)) a.volume = level;
    }
  }

  setVolume(v) {
    if (!Number.isFinite(v)) return;
    this.volume = Math.max(0, Math.min(this._boostAvailable ? 1 : 0.5, v));
    this._applyVolume();
    if (this.volume > 0 && this.muted) this.setMuted(false);
    this._savePrefs();
    this._emit("volume", { volume: this.volume, muted: this.muted });
  }

  setMuted(m) {
    this.muted = m;
    this.audio.muted = m;
    if (this._standby) this._standby.muted = m;
    this._savePrefs();
    this._emit("volume", { volume: this.volume, muted: this.muted });
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  setMaxBitrate(bps) {
    this.maxBitrate = bps || 0;
    this._savePrefs();
    this._clearPreload();
    // Re-open the stream at the new ceiling, preserving position.
    if (this.current) {
      const pos = this.audio.currentTime;
      const wasPlaying = !this.audio.paused;
      this.audio.src = api.streamUrl(this.current, {
        maxBitrate: this.maxBitrate,
      });
      this.audio.load();
      // Seeking before metadata loads is ignored, so restore the position
      // once the new stream can take it.
      this._pendingSeek = pos;
      if (wasPlaying) this._playAudio().catch(() => {});
    }
    this._emit("state", this.snapshot());
  }

  toggleShuffle(force) {
    const on = force === undefined ? !this.shuffle : force;
    this.shuffle = on;

    if (this.queue.length) {
      const cur = this.current;
      if (on) {
        this._unshuffled = this.queue.slice();
        const rest = this.queue.filter((_, i) => i !== this.index);
        this.queue = cur ? [cur, ...shuffled(rest)] : shuffled(rest);
        this.index = cur ? 0 : -1;
      } else if (this._unshuffled) {
        this.queue = this._unshuffled;
        this._unshuffled = null;
        let at = cur ? this.queue.indexOf(cur) : -1;
        if (cur && at < 0) at = this.queue.findIndex((t) => t.Id === cur.Id);
        this.index = cur ? Math.max(0, at) : -1;
      }
    }
    this._savePrefs();
    this._emit("queue", this.snapshot());
    this._emit("state", this.snapshot());
  }

  cycleRepeat() {
    const i = REPEAT_MODES.indexOf(this.repeat);
    this.repeat = REPEAT_MODES[(i + 1) % REPEAT_MODES.length];
    this._savePrefs();
    this._emit("state", this.snapshot());
  }

  snapshot() {
    return {
      current: this.current,
      index: this.index,
      queue: this.queue,
      isPlaying: this.isPlaying,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      muted: this.muted,
      context: this.context,
      maxBitrate: this.maxBitrate,
    };
  }

  /* ---------------- saved queue ---------------- */

  /** Writes the queue and position for restoreQueue(). Tied to the signed-in
      user and server, so another account never inherits it. */
  _saveQueue() {
    try {
      // Signed out (or the session just expired): leave any saved queue be,
      // so signing back in as the same user picks it up again.
      if (!api.userId) return;
      if (!this.current) {
        localStorage.removeItem(LS_QUEUE);
        return;
      }
      // Keep a window around the current track when the queue is huge.
      let from = 0;
      if (this.queue.length > MAX_SAVED_TRACKS) {
        from = Math.max(0, Math.min(this.index - 100, this.queue.length - MAX_SAVED_TRACKS));
      }
      const queue = this.queue.slice(from, from + MAX_SAVED_TRACKS);

      // The pre-shuffle order is saved as positions within `queue`.
      let unshuffled = null;
      if (this._unshuffled && !from && this._unshuffled.length === queue.length) {
        const slots = new Map();
        queue.forEach((t, i) => {
          if (!slots.has(t)) slots.set(t, []);
          slots.get(t).push(i);
        });
        unshuffled = this._unshuffled.map((t) => slots.get(t)?.shift() ?? -1);
        if (unshuffled.includes(-1)) unshuffled = null;
      }

      localStorage.setItem(
        LS_QUEUE,
        JSON.stringify({
          v: 1,
          server: api.server,
          userId: api.userId,
          queue: queue.map(slimTrack),
          index: this.index - from,
          position: this.audio.currentTime || 0,
          context: this.context,
          unshuffled,
        })
      );
    } catch {
      /* quota or storage blocked; losing the saved queue is harmless */
    }
  }

  /**
   * Puts back the queue from the previous page load, paused at the saved
   * position. Returns whether anything was restored.
   */
  restoreQueue() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(LS_QUEUE) || "null");
    } catch {
      return false;
    }
    if (
      saved?.v !== 1 ||
      saved.server !== api.server ||
      saved.userId !== api.userId ||
      !Array.isArray(saved.queue) ||
      !saved.queue.length ||
      this.queue.length
    ) {
      return false;
    }

    this.queue = saved.queue;
    this.index = Math.max(0, Math.min(Number(saved.index) || 0, this.queue.length - 1));
    this.context = saved.context || null;
    this._unshuffled =
      this.shuffle && Array.isArray(saved.unshuffled)
        ? saved.unshuffled.map((i) => this.queue[i]).filter(Boolean)
        : null;
    if (this._unshuffled?.length !== this.queue.length) this._unshuffled = null;

    this._emit("queue", this.snapshot());
    this._load(false);
    const position = Number(saved.position) || 0;
    if (position > 0) {
      this._pendingSeek = position;
      this._emit("time", { position, duration: this.duration });
    }
    return true;
  }

  clearSavedQueue() {
    try {
      localStorage.removeItem(LS_QUEUE);
    } catch {
      /* nothing to clear */
    }
  }

  /* ---------------- OS media keys ---------------- */

  _wireMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const safe = (fn) => () => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    };
    ms.setActionHandler("play", safe(() => this.toggle()));
    ms.setActionHandler("pause", safe(() => this.audio.pause()));
    ms.setActionHandler("previoustrack", safe(() => this.prev()));
    ms.setActionHandler("nexttrack", safe(() => this.next()));
    ms.setActionHandler("seekbackward", safe(() => this.seekBy(-10)));
    ms.setActionHandler("seekforward", safe(() => this.seekBy(10)));
    try {
      ms.setActionHandler("seekto", (d) => {
        if (d.seekTime != null) this.seek(d.seekTime);
      });
    } catch {
      /* not supported everywhere */
    }
  }

  _updateMediaSessionMetadata() {
    if (!("mediaSession" in navigator)) return;
    const t = this.current;
    if (!t) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const art = api.imageUrl(t, { size: 512 });
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.Name || "",
      artist: artistsOf(t),
      album: t.Album || "",
      artwork: art
        ? [
            { src: art, sizes: "512x512", type: "image/jpeg" },
          ]
        : [],
    });
  }

  _updateMediaSessionState() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = this.current
      ? this.isPlaying
        ? "playing"
        : "paused"
      : "none";
  }

  _syncMediaSession() {
    this._updateMediaSessionMetadata();
    this._updateMediaSessionState();
  }
}

export const player = new Player();
