/* Audio engine: queue, transport, shuffle/repeat, reporting, MediaSession. */

import { api } from "./api.js";
import { emitter, shuffled, ticksToSec, artistsOf, throttle } from "./util.js";

const LS_PREFS = "tokyomusic.player";
const REPEAT_MODES = ["none", "all", "one"];

class Player {
  constructor() {
    const bus = emitter();
    this.on = bus.on;
    this._emit = bus.emit;

    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.crossOrigin = "anonymous";

    /** Tracks in play order. */
    this.queue = [];
    /** Pre-shuffle order, restored when shuffle is switched off. */
    this._unshuffled = null;
    this.index = -1;
    this.shuffle = false;
    this.repeat = "none";
    this.volume = 1;
    this.muted = false;
    this.maxBitrate = 0; // 0 = original quality
    /** Where the queue came from, e.g. { type: "album", id, name }. */
    this.context = null;

    this._loadPrefs();
    this._wireAudio();
    this._wireMediaSession();

    this._reportProgress = throttle(() => {
      const t = this.current;
      if (!t) return;
      api.reportProgress(t, {
        positionSec: this.audio.currentTime,
        isPaused: this.audio.paused,
        volume: this.volume,
        isMuted: this.muted,
      });
    }, 10000);

    // Best-effort "stopped" report if the tab closes mid-track.
    window.addEventListener("pagehide", () => {
      const t = this.current;
      if (t && !this.audio.paused) api.reportStopped(t, this.audio.currentTime);
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
      this.volume = typeof p.volume === "number" ? p.volume : 1;
      this.muted = Boolean(p.muted);
      this.shuffle = Boolean(p.shuffle);
      this.repeat = REPEAT_MODES.includes(p.repeat) ? p.repeat : "none";
      this.maxBitrate = p.maxBitrate || 0;
    } catch {
      /* defaults are fine */
    }
    this.audio.volume = this.volume;
    this.audio.muted = this.muted;
  }

  _savePrefs() {
    localStorage.setItem(
      LS_PREFS,
      JSON.stringify({
        volume: this.volume,
        muted: this.muted,
        shuffle: this.shuffle,
        repeat: this.repeat,
        maxBitrate: this.maxBitrate,
      })
    );
  }

  _wireAudio() {
    const a = this.audio;

    a.addEventListener("timeupdate", () => {
      this._emit("time", { position: a.currentTime, duration: this.duration });
      if (!a.paused) this._reportProgress();
    });

    a.addEventListener("progress", () => {
      let buffered = 0;
      try {
        if (a.buffered.length)
          buffered = a.buffered.end(a.buffered.length - 1);
      } catch {
        /* buffered can throw before metadata loads */
      }
      this._emit("buffer", { buffered, duration: this.duration });
    });

    a.addEventListener("play", () => {
      this._emit("state", this.snapshot());
      this._updateMediaSessionState();
    });

    a.addEventListener("playing", () => {
      this._syncMediaSession();
    });

    a.addEventListener("pause", () => {
      this._emit("state", this.snapshot());
      this._syncMediaSession();
      const t = this.current;
      if (t) api.reportProgress(t, {
        positionSec: a.currentTime,
        isPaused: true,
        volume: this.volume,
        isMuted: this.muted,
      });
    });

    a.addEventListener("ended", () => this._onEnded());

    a.addEventListener("loadedmetadata", () => {
      this._emit("time", { position: a.currentTime, duration: this.duration });
    });

    a.addEventListener("error", () => {
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

    if (this.shuffle) {
      const first = tracks[startIndex] || tracks[0];
      const rest = tracks.filter((_, i) => i !== startIndex);
      this._unshuffled = tracks;
      this.queue = [first, ...shuffled(rest)];
      this.index = 0;
    } else {
      this.queue = tracks;
      this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
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
    this._unshuffled = items;
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
    this._emit("queue", this.snapshot());
  }

  addToQueue(items) {
    const tracks = [].concat(items).filter(Boolean);
    if (!tracks.length) return;
    if (!this.queue.length) return this.play(tracks, 0, null);
    this.queue.push(...tracks);
    this._emit("queue", this.snapshot());
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      if (this.index < 0) return this.stop();
      this._load(true);
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

    const prev = this._reportedItem;
    if (prev && prev.Id !== track.Id) api.reportStopped(prev, this._lastPos || 0);

    this.audio.src = api.streamUrl(track, { maxBitrate: this.maxBitrate });
    this.audio.load();
    this._emit("track", this.snapshot());

    if (autoplay) {
      try {
        await this.audio.play();
        this._syncMediaSession();
        this._reportedItem = track;
        api.reportStart(track, { positionSec: 0 });
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

  async toggle() {
    if (!this.current) return;
    if (this.audio.paused) {
      try {
        await this.audio.play();
        if (this._reportedItem?.Id !== this.current.Id) {
          this._reportedItem = this.current;
          api.reportStart(this.current, { positionSec: this.audio.currentTime });
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
    this._lastPos = this.audio.currentTime;

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
    if (t) api.reportStopped(t, this.duration);

    if (this.repeat === "one") {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {});
      if (t) api.reportStart(t, { positionSec: 0 });
      return;
    }
    this.next(true);
  }

  stop() {
    const t = this.current;
    if (t) api.reportStopped(t, this.audio.currentTime);
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.index = -1;
    this._reportedItem = null;
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

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.audio.volume = this.volume;
    if (this.volume > 0 && this.muted) this.setMuted(false);
    this._savePrefs();
    this._emit("volume", { volume: this.volume, muted: this.muted });
  }

  setMuted(m) {
    this.muted = m;
    this.audio.muted = m;
    this._savePrefs();
    this._emit("volume", { volume: this.volume, muted: this.muted });
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  setMaxBitrate(bps) {
    this.maxBitrate = bps || 0;
    this._savePrefs();
    // Re-open the stream at the new ceiling, preserving position.
    if (this.current) {
      const pos = this.audio.currentTime;
      const wasPlaying = !this.audio.paused;
      this.audio.src = api.streamUrl(this.current, {
        maxBitrate: this.maxBitrate,
      });
      this.audio.load();
      this.audio.currentTime = pos;
      if (wasPlaying) this.audio.play().catch(() => {});
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
        this.index = cur
          ? Math.max(0, this.queue.findIndex((t) => t.Id === cur.Id))
          : -1;
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
