/* Lyrics for the fullscreen player: parsing Jellyfin's lyric payload, finding
   the line being sung, and a panel that follows playback. */

import { api } from "./api.js";
import { el, clear, ticksToSec } from "./util.js";

/** Lines light up this many seconds early, so they read as on time. */
const LEAD_SEC = 0.25;

/** After the user scrolls the lyrics by hand, stop following for a moment. */
const MANUAL_SCROLL_PAUSE_MS = 4000;

const CACHE_LIMIT = 50;
const cache = new Map();

/**
 * Normalizes /Audio/{id}/Lyrics into { synced, lines: [{ text, time }] }.
 * `time` is in seconds, or null for unsynced lyrics. Returns null when the
 * payload holds no lines.
 */
export function parseLyrics(dto) {
  const raw = Array.isArray(dto?.Lyrics) ? dto.Lyrics : [];
  if (!raw.length) return null;
  const synced = raw.some((l) => Number.isFinite(l?.Start));
  const lines = raw.map((l) => ({
    text: String(l?.Text ?? "").trim(),
    time: synced && Number.isFinite(l?.Start) ? ticksToSec(l.Start) : null,
  }));
  if (!lines.some((l) => l.text)) return null;
  return { synced, lines };
}

/** Index of the line being sung at `position` seconds, or -1 before the first. */
export function activeLineIndex(lines, position) {
  const t = position + LEAD_SEC;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const time = lines[mid].time;
    if (time != null && time <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Cached lyrics for a track; resolves to parseLyrics() output or null. */
export function lyricsFor(track) {
  if (!track?.Id || track.HasLyrics === false) return Promise.resolve(null);
  if (!cache.has(track.Id)) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(track.Id, api.lyrics(track.Id).then(parseLyrics, () => null));
  }
  return cache.get(track.Id);
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Scrolling lyric sheet. Call load(track) when the track changes and
 * update(position) on every time tick. Clicking a synced line seeks to it.
 */
export function lyricsPanel({ onSeek }) {
  const status = el("div.lyrics-status");
  const list = el("div.lyrics-lines", { role: "list" });
  const root = el("div.lyrics-panel", { "aria-label": "Lyrics" }, [status, list]);

  let lines = [];
  let nodes = [];
  let synced = false;
  let active = -1;
  let loadedId = null;
  let followAfter = 0;

  const showStatus = (text) => {
    status.textContent = text;
    status.hidden = !text;
  };

  const pauseFollowing = () => {
    followAfter = Date.now() + MANUAL_SCROLL_PAUSE_MS;
  };
  list.addEventListener("wheel", pauseFollowing, { passive: true });
  list.addEventListener("touchmove", pauseFollowing, { passive: true });
  list.addEventListener("keydown", pauseFollowing);

  function scrollToActive(smooth) {
    const node = nodes[active];
    if (!node || Date.now() < followAfter) return;
    const top = node.offsetTop - list.clientHeight / 2 + node.offsetHeight / 2;
    list.scrollTo({ top, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  function render(result) {
    clear(list);
    lines = result?.lines || [];
    synced = Boolean(result?.synced);
    active = -1;
    root.classList.toggle("synced", synced);
    nodes = lines.map((line) =>
      el("div.lyric-line", {
        role: "listitem",
        class: line.text ? "" : "gap",
        text: line.text || "♪",
        onclick: synced && line.time != null ? () => onSeek(line.time) : null,
      })
    );
    list.append(...nodes);
    list.scrollTop = 0;
    showStatus(lines.length ? "" : "No lyrics for this track");
  }

  root.load = async (track) => {
    const id = track?.Id || null;
    if (id === loadedId) return;
    loadedId = id;
    render(null);
    if (!id) return showStatus("");
    showStatus("Loading lyrics…");
    const result = await lyricsFor(track);
    if (loadedId !== id) return; // the track changed while this loaded
    render(result);
    root.update(root.lastPosition || 0, false);
  };

  root.update = (position, smooth = true) => {
    root.lastPosition = position;
    if (!synced) return;
    const next = activeLineIndex(lines, position);
    if (next === active) return;
    nodes.forEach((n, i) => {
      n.classList.toggle("active", i === next);
      n.classList.toggle("past", i < next);
    });
    active = next;
    scrollToActive(smooth);
  };

  return root;
}
