/* Small shared helpers: DOM building, formatting, events. */

/** Jellyfin measures time in ticks: 10,000 ticks per millisecond. */
export const TICKS_PER_MS = 10000;
export const TICKS_PER_SEC = 10000000;

export const ticksToSec = (t) => (t || 0) / TICKS_PER_SEC;
export const secToTicks = (s) => Math.round((s || 0) * TICKS_PER_SEC);

/** 143 -> "2:23", 3725 -> "1:02:05" */
export function fmtTime(totalSeconds) {
  if (!isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Long-form duration for headers: "1 hr 24 min", "38 min" */
export function fmtDurationLong(totalSeconds) {
  const total = Math.round(totalSeconds || 0);
  if (total < 60) return `${total} sec`;
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return m ? `${h} hr ${m} min` : `${h} hr`;
  return `${m} min`;
}

export const fmtCount = (n, singular, plural) =>
  `${n.toLocaleString()} ${n === 1 ? singular : plural || singular + "s"}`;

/**
 * Safe display name. Real libraries contain items whose Name is empty or
 * pure whitespace, which would otherwise render as an invisible title.
 */
export function displayName(item, fallback = "Untitled") {
  const n = (typeof item === "string" ? item : item?.Name) || "";
  return n.trim() ? n : fallback;
}

/** Track artist string from a Jellyfin item. */
export function artistsOf(item) {
  if (!item) return "";
  if (Array.isArray(item.Artists) && item.Artists.length)
    return item.Artists.join(", ");
  if (item.AlbumArtist) return item.AlbumArtist;
  if (Array.isArray(item.AlbumArtists) && item.AlbumArtists.length)
    return item.AlbumArtists.map((a) => a.Name).join(", ");
  return "";
}

/**
 * Collapses a track list into distinct pseudo-album items, so album rows can
 * be built from track-level data without a request per album.
 */
export function albumsFromTracks(tracks, limit = 20) {
  const byId = new Map();
  for (const t of tracks || []) {
    if (!t.AlbumId || byId.has(t.AlbumId)) continue;
    byId.set(t.AlbumId, {
      Id: t.AlbumId,
      Name: t.Album,
      Type: "MusicAlbum",
      AlbumArtist: t.AlbumArtist || (t.Artists || [])[0] || "",
      ImageTags: t.AlbumPrimaryImageTag
        ? { Primary: t.AlbumPrimaryImageTag }
        : {},
    });
    if (byId.size >= limit) break;
  }
  return [...byId.values()];
}

/** Primary artist id for navigation, when available. */
export function artistIdOf(item) {
  if (item?.ArtistItems?.length) return item.ArtistItems[0].Id;
  if (item?.AlbumArtists?.length) return item.AlbumArtists[0].Id;
  return null;
}

export function bitrateLabel(bps) {
  if (!bps) return "";
  return `${Math.round(bps / 1000)} kbps`;
}

/* ---------------- DOM ---------------- */

/**
 * el("div.card", { onclick }, [children])
 * Tag syntax supports #id and .class shorthand.
 */
export function el(spec, props = {}, children = []) {
  // Accepts "div.a.b" and also space-separated forms like "div.grid artists".
  const tokens = String(spec).trim().split(/\s+/);
  const m = /^([a-z0-9-]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(tokens[0]);
  const node = document.createElement(m?.[1] || "div");
  if (m?.[2]) node.id = m[2].slice(1);

  const classes = [];
  if (m?.[3]) classes.push(...m[3].split(".").filter(Boolean));
  for (const t of tokens.slice(1)) classes.push(...t.split(".").filter(Boolean));
  if (classes.length) node.className = classes.join(" ");

  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = [node.className, v].filter(Boolean).join(" ");
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }

  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Minimal pub/sub. */
export function emitter() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      map.get(evt)?.forEach((fn) => {
        try {
          fn(payload);
        } catch (e) {
          console.error(`[${evt}] listener failed`, e);
        }
      });
    },
  };
}

export function debounce(fn, ms = 260) {
  let t;
  const wrapped = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttle(fn, ms = 200) {
  let last = 0;
  let timer;
  return (...a) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...a);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => {
        last = Date.now();
        fn(...a);
      }, wait);
    }
  };
}

/** Fisher-Yates, returns a new array. */
export function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function move(arr, from, to) {
  const a = arr.slice();
  const [item] = a.splice(from, 1);
  a.splice(to, 0, item);
  return a;
}

export const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

export const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
