/* Jellyfin API client, scoped to audio.
   Verified against Jellyfin 10.11.11. */

import { uuid, secToTicks } from "./util.js";

const CLIENT_NAME = "Tokyo Music";
const CLIENT_VERSION = "1.1.0";
const LS_SESSION = "tokyomusic.session";
const LS_DEVICE = "tokyomusic.deviceId";

/** Containers a browser can decode directly. Anything else the server transcodes. */
const DIRECT_CONTAINERS =
  "flac,mp3,aac,m4a|aac,alac,m4a|alac,ogg,oga,opus,webma,webm|webma,wav";

/** Bare container names from DIRECT_CONTAINERS, for guessing the play method. */
const DIRECT_CONTAINER_SET = new Set(
  DIRECT_CONTAINERS.split(",").map((c) => c.split("|")[0])
);

/** Page size and safety ceiling for queries that fetch a whole collection. */
const PAGE_SIZE = 500;
const MAX_ITEMS = 20000;

/** How long to wait for /System/Info/Public before calling a server unreachable. */
const PUBLIC_INFO_TIMEOUT_MS = 8000;

/**
 * Jellyfin answers a transcode request on /universal with an HLS playlist when
 * TranscodingProtocol is "hls". Only browsers with native HLS (Safari, recent
 * Chrome) can play that in a plain <audio>; everyone else gets a progressive
 * MP3 stream instead. HLS is kept where it works because it stays seekable.
 */
const NATIVE_HLS = (() => {
  try {
    return Boolean(
      typeof document !== "undefined" &&
        document.createElement("audio").canPlayType("application/vnd.apple.mpegurl")
    );
  } catch {
    return false;
  }
})();

const REPEAT_MODE_NAMES = { none: "RepeatNone", all: "RepeatAll", one: "RepeatOne" };

function deviceId() {
  let id = localStorage.getItem(LS_DEVICE);
  if (!id) {
    id = uuid();
    localStorage.setItem(LS_DEVICE, id);
  }
  return id;
}

/* ------------------------------------------------------------------
   Duplicate artist records
   ------------------------------------------------------------------
   Jellyfin can end up holding more than one artist record for the same
   artist, differing only by letter case, a typographic vs ASCII hyphen
   ("blink‐182" vs "blink-182"), "&" vs "and", or an exotic space. Its own
   artist lookup is case-insensitive, so both records resolve to the same
   albums and tracks and neither is ever pruned — they just show up as two
   cards. Usual causes are metadata providers writing their own spelling and
   records left behind by an earlier library layout.

   Fixing this server-side needs database surgery or a library rebuild, so
   the client collapses them for display instead. This is lossless here:
   grouped records return identical content.
   ------------------------------------------------------------------ */

const DASH_VARIANTS = /[‐‑‒–—―−]/g;

/** Collation key for artist names. Deliberately conservative: it folds only
    the differences observed to cause duplicates, and does not strip
    punctuation or a leading "The", which would merge distinct artists. */
export function artistKey(name) {
  return String(name || "")
    .normalize("NFKC")
    .replace(DASH_VARIANTS, "-")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ") // also folds U+3000 and other exotic spaces
    .trim()
    .toLowerCase();
}

/** A record under Jellyfin's own metadata folder is the leftover; one that
    points at a media path is the record reflecting the library. */
const isMetadataStub = (a) => /\/metadata\/(artists|people)\//.test(a?.Path || "");

function artistScore(a) {
  let score = 0;
  if (a?.Path && !isMetadataStub(a)) score += 4;
  if (a?.ImageTags?.Primary) score += 1;
  return score;
}

/**
 * Collapses duplicate artist records, keeping the best of each group.
 * Server sort order is preserved. Returns { items, removed }.
 */
export function dedupeArtists(items) {
  const groups = new Map();
  for (const a of items || []) {
    const key = artistKey(a?.Name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const kept = [];
  for (const group of groups.values()) {
    const winner = group.reduce((a, b) => (artistScore(b) > artistScore(a) ? b : a));
    // The survivor is picked for its name; artwork may live on a discarded
    // sibling, so borrow it rather than render an empty placeholder.
    if (!winner.ImageTags?.Primary) {
      const withArt = group.find((a) => a !== winner && a.ImageTags?.Primary);
      if (withArt) {
        kept.push({
          ...winner,
          ImageItemId: withArt.Id,
          ImageTags: withArt.ImageTags,
          BackdropImageTags: withArt.BackdropImageTags,
        });
        continue;
      }
    }
    kept.push(winner);
  }
  return { items: kept, removed: (items?.length || 0) - kept.length };
}

export class ApiError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
  }
}

class JellyfinApi {
  constructor() {
    this.server = "";
    this.token = "";
    this.userId = "";
    this.userName = "";
    // null = not looked up yet, "" = looked up and the user has no avatar.
    this.userImageTag = null;
    this.serverName = "";
    this.musicViewIds = [];
    this.playlistViewId = "";
    this._restore();
  }

  /* ---------------- session ---------------- */

  get isAuthed() {
    return Boolean(this.server && this.token && this.userId);
  }

  _restore() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SESSION) || "null");
      if (s?.server && s?.token && s?.userId) Object.assign(this, s);
    } catch {
      /* corrupt session — ignore and start logged out */
    }
  }

  _persist() {
    localStorage.setItem(
      LS_SESSION,
      JSON.stringify({
        server: this.server,
        token: this.token,
        userId: this.userId,
        userName: this.userName,
        userImageTag: this.userImageTag,
        serverName: this.serverName,
        musicViewIds: this.musicViewIds,
        playlistViewId: this.playlistViewId,
      })
    );
  }

  clearSession() {
    this.token = "";
    this.userId = "";
    this.userName = "";
    this.userImageTag = null;
    this.musicViewIds = [];
    localStorage.removeItem(LS_SESSION);
  }

  /** Normalizes "host:8096" / "http://x/" into a clean origin+path base. */
  setServer(url) {
    let u = String(url || "").trim().replace(/\/+$/, "");
    if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
    this.server = u;
  }

  authHeader() {
    const parts = [
      `Client="${CLIENT_NAME}"`,
      `Device="${this._deviceName()}"`,
      `DeviceId="${deviceId()}"`,
      `Version="${CLIENT_VERSION}"`,
    ];
    if (this.token) parts.push(`Token="${this.token}"`);
    return `MediaBrowser ${parts.join(", ")}`;
  }

  _deviceName() {
    const ua = navigator.userAgent;
    let browser = "Browser";
    if (/Firefox\//.test(ua)) browser = "Firefox";
    else if (/Edg\//.test(ua)) browser = "Edge";
    else if (/Chrome\//.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua)) browser = "Safari";
    return `${browser} (Tokyo Music)`;
  }

  /* ---------------- transport ---------------- */

  url(path, params = {}) {
    const u = new URL(
      path.startsWith("/") ? path.slice(1) : path,
      this.server + "/"
    );
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return u.toString();
  }

  async request(path, { method = "GET", params, body, signal, raw } = {}) {
    const url = this.url(path, params);
    const headers = { Authorization: this.authHeader() };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new ApiError(
        `Cannot reach ${this.server}. Check the server address and that you are on the same network.`,
        0,
        url
      );
    }

    if (res.status === 401) {
      // Several requests can be in flight when a session expires; only the
      // first should sign the user out. A 401 while signed out is just a bad
      // password and needs no global event.
      const wasAuthed = Boolean(this.token);
      this.clearSession();
      if (wasAuthed) window.dispatchEvent(new CustomEvent("tm:unauthorized"));
      throw new ApiError("Session expired. Please sign in again.", 401, url);
    }
    if (!res.ok) {
      throw new ApiError(
        `${method} ${path} failed (${res.status})`,
        res.status,
        url
      );
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  get = (p, params, signal) => this.request(p, { params, signal });
  post = (p, params, body) => this.request(p, { method: "POST", params, body });
  del = (p, params) => this.request(p, { method: "DELETE", params });

  /* ---------------- auth ---------------- */

  static async publicInfo(serverUrl) {
    const base = String(serverUrl).trim().replace(/\/+$/, "");
    const url = /^https?:\/\//i.test(base) ? base : `http://${base}`;
    const res = await fetch(`${url}/System/Info/Public`, {
      signal: AbortSignal.timeout(PUBLIC_INFO_TIMEOUT_MS),
    });
    if (!res.ok) throw new ApiError("Not a Jellyfin server", res.status, url);
    return res.json();
  }

  async loginWithPassword(username, password) {
    const data = await this.request("/Users/AuthenticateByName", {
      method: "POST",
      body: { Username: username, Pw: password },
    });
    return this._acceptAuth(data);
  }

  async quickConnectInitiate() {
    return this.request("/QuickConnect/Initiate", { method: "POST" });
  }

  async quickConnectPoll(secret) {
    return this.get("/QuickConnect/Connect", { Secret: secret });
  }

  async loginWithQuickConnect(secret) {
    const data = await this.request("/Users/AuthenticateWithQuickConnect", {
      method: "POST",
      body: { Secret: secret },
    });
    return this._acceptAuth(data);
  }

  async _acceptAuth(data) {
    this.token = data.AccessToken;
    this.userId = data.User.Id;
    this.userName = data.User.Name;
    this.userImageTag = data.User.PrimaryImageTag || "";
    await this.loadViews();
    this._persist();
    return data;
  }

  async logout() {
    try {
      await this.post("/Sessions/Logout");
    } catch {
      /* best effort — clear locally regardless */
    }
    this.clearSession();
  }

  /* ---------------- library scoping ---------------- */

  /** Finds music libraries so every query stays audio-only. */
  async loadViews() {
    const data = await this.get("/UserViews", { userId: this.userId });
    const items = data?.Items || [];
    this.musicViewIds = items
      .filter((v) => v.CollectionType === "music")
      .map((v) => v.Id);
    this.playlistViewId =
      items.find((v) => v.CollectionType === "playlists")?.Id || "";
    this._persist();
    return items;
  }

  /** ParentId is only usable when there is exactly one music library. */
  get musicParentId() {
    return this.musicViewIds.length === 1 ? this.musicViewIds[0] : undefined;
  }

  _scope(params = {}) {
    const p = { userId: this.userId, ...params };
    if (!p.ParentId && this.musicParentId) p.ParentId = this.musicParentId;
    return p;
  }

  /* ---------------- browse ---------------- */

  async getItems(params = {}, signal) {
    const data = await this.get("/Items", this._scope(params), signal);
    return { items: data?.Items || [], total: data?.TotalRecordCount ?? 0 };
  }

  async getItem(id) {
    return this.get(`/Items/${id}`, { userId: this.userId });
  }

  /**
   * Fetches every page of a list endpoint. Stops on a short page rather than
   * trusting TotalRecordCount, which Jellyfin over-reports for some queries.
   */
  async _getAll(path, params, signal) {
    const items = [];
    for (let start = 0; start < MAX_ITEMS; start += PAGE_SIZE) {
      const data = await this.get(
        path,
        { ...params, StartIndex: start, Limit: PAGE_SIZE },
        signal
      );
      const page = data?.Items || [];
      items.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return items;
  }

  /** Every matching item from /Items, scoped like getItems(). */
  async getAllItems(params = {}, signal) {
    const items = await this._getAll("/Items", this._scope(params), signal);
    return { items, total: items.length };
  }

  albums({ startIndex = 0, limit = 100, sortBy = "SortName", sortOrder = "Ascending", ...rest } = {}, signal) {
    return this.getItems(
      {
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        StartIndex: startIndex,
        Limit: limit,
        SortBy: sortBy,
        SortOrder: sortOrder,
        Fields: "PrimaryImageAspectRatio,ProductionYear,ChildCount,Genres,DateCreated",
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary",
        ...rest,
      },
      signal
    );
  }

  songs({ startIndex = 0, limit = 200, sortBy = "SortName", sortOrder = "Ascending", ...rest } = {}, signal) {
    return this.getItems(
      {
        IncludeItemTypes: "Audio",
        Recursive: true,
        StartIndex: startIndex,
        Limit: limit,
        SortBy: sortBy,
        SortOrder: sortOrder,
        Fields: "PrimaryImageAspectRatio,Genres,ParentId",
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary",
        ...rest,
      },
      signal
    );
  }

  /** Album artists only — /Items with MusicArtist is unreliable when tracks
      carry the artist metadata instead of dedicated artist folders. */
  async artists({ startIndex = 0, limit = 100, searchTerm, sortOrder = "Ascending" } = {}, signal) {
    const params = {
      userId: this.userId,
      StartIndex: startIndex,
      Limit: limit,
      SortBy: "SortName",
      SortOrder: sortOrder,
      // Path is requested purely to identify duplicate records (see dedupeArtists).
      Fields: "PrimaryImageAspectRatio,Path",
      ImageTypeLimit: 1,
      EnableImageTypes: "Primary",
      Recursive: true,
    };
    if (searchTerm) params.searchTerm = searchTerm;
    if (this.musicParentId) params.ParentId = this.musicParentId;
    const data = await this.get("/Artists/AlbumArtists", params, signal);
    const raw = data?.Items || [];
    const { items, removed } = dedupeArtists(raw);
    // `fetched` is the server-side count; callers must page by it, not by
    // items.length, or the start index drifts once duplicates are dropped.
    return {
      items,
      total: data?.TotalRecordCount ?? items.length,
      removed,
      fetched: raw.length,
    };
  }

  async genres(signal) {
    const params = {
      userId: this.userId,
      IncludeItemTypes: "Audio",
      Recursive: true,
      SortBy: "SortName",
    };
    if (this.musicParentId) params.ParentId = this.musicParentId;
    const items = await this._getAll("/Genres", params, signal);
    return { items, total: items.length };
  }

  /** Album track list, ordered by disc then track number. */
  async albumTracks(albumId, signal) {
    const data = await this.get(
      "/Items",
      {
        userId: this.userId,
        ParentId: albumId,
        SortBy: "ParentIndexNumber,IndexNumber,SortName",
        SortOrder: "Ascending",
        Fields: "MediaSources,Genres,ParentId",
      },
      signal
    );
    return data?.Items || [];
  }

  async artistAlbums(artistId, signal) {
    return this.getAllItems(
      {
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        AlbumArtistIds: artistId,
        SortBy: "ProductionYear,SortName",
        SortOrder: "Descending",
        Fields: "ProductionYear,ChildCount",
      },
      signal
    );
  }

  /** Albums the artist appears on but did not headline. */
  async artistAppearsOn(artistId, signal) {
    return this.getAllItems(
      {
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        ContributingArtistIds: artistId,
        SortBy: "ProductionYear,SortName",
        SortOrder: "Descending",
        Fields: "ProductionYear,ChildCount",
      },
      signal
    );
  }

  async artistTopTracks(artistId, limit = 10, signal) {
    return this.getItems(
      {
        IncludeItemTypes: "Audio",
        Recursive: true,
        ArtistIds: artistId,
        SortBy: "PlayCount,SortName",
        SortOrder: "Descending",
        Limit: limit,
        Fields: "ParentId",
      },
      signal
    );
  }

  async artistAllTracks(artistId, signal) {
    const { items } = await this.getAllItems(
      {
        IncludeItemTypes: "Audio",
        Recursive: true,
        ArtistIds: artistId,
        SortBy: "Album,ParentIndexNumber,IndexNumber",
        SortOrder: "Ascending",
        Fields: "ParentId",
      },
      signal
    );
    return items;
  }

  /* ---------------- home rows ---------------- */

  recentlyAdded(limit = 24, signal) {
    return this.albums(
      { limit, sortBy: "DateCreated", sortOrder: "Descending" },
      signal
    );
  }

  /* Jellyfin only ever flags *tracks* as played — MusicAlbum items keep
     Played=false and PlayCount=0 forever, so `Filters=IsPlayed` on albums
     returns nothing. Both "played" rows are therefore built from tracks. */

  frequentlyPlayedTracks(limit = 40, signal) {
    return this.songs(
      { limit, sortBy: "PlayCount", sortOrder: "Descending", Filters: "IsPlayed" },
      signal
    );
  }

  recentlyPlayedTracks(limit = 60, signal) {
    return this.songs(
      { limit, sortBy: "DatePlayed", sortOrder: "Descending", Filters: "IsPlayed" },
      signal
    );
  }

  /* ---------------- favorites ---------------- */

  favoriteSongs(signal) {
    return this.getAllItems(
      {
        IncludeItemTypes: "Audio",
        Recursive: true,
        Filters: "IsFavorite",
        SortBy: "SortName",
        SortOrder: "Ascending",
        Fields: "PrimaryImageAspectRatio,Genres,ParentId",
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary",
      },
      signal
    );
  }

  favoriteAlbums(signal) {
    return this.getAllItems(
      {
        IncludeItemTypes: "MusicAlbum",
        Recursive: true,
        Filters: "IsFavorite",
        SortBy: "SortName",
        SortOrder: "Ascending",
        Fields: "PrimaryImageAspectRatio,ProductionYear,ChildCount,Genres,DateCreated",
        ImageTypeLimit: 1,
        EnableImageTypes: "Primary",
      },
      signal
    );
  }

  /**
   * Favorite artists, gathered from both artist endpoints and merged.
   * /Artists/AlbumArtists is the reliable source for browsing this library
   * (see artists()), but favoriting an artist can also materialise a
   * MusicArtist item that only /Items reports. Querying both and deduping by
   * id avoids depending on which one a given library populates.
   */
  async favoriteArtists(signal) {
    const artistParams = {
      userId: this.userId,
      Filters: "IsFavorite",
      SortBy: "SortName",
      SortOrder: "Ascending",
      Fields: "PrimaryImageAspectRatio,Path",
      ImageTypeLimit: 1,
      EnableImageTypes: "Primary",
    };
    if (this.musicParentId) artistParams.ParentId = this.musicParentId;

    const [viaArtists, viaItems] = await Promise.all([
      this._getAll("/Artists/AlbumArtists", artistParams, signal).catch(() => []),
      this.getAllItems(
        {
          IncludeItemTypes: "MusicArtist",
          Recursive: true,
          Filters: "IsFavorite",
          SortBy: "SortName",
          Fields: "PrimaryImageAspectRatio",
          ImageTypeLimit: 1,
          EnableImageTypes: "Primary",
        },
        signal
      ).catch(() => ({ items: [] })),
    ]);

    const byId = new Map();
    for (const a of viaArtists) byId.set(a.Id, a);
    for (const a of viaItems.items || []) if (!byId.has(a.Id)) byId.set(a.Id, a);

    const merged = [...byId.values()].sort((x, y) =>
      (x.Name || "").localeCompare(y.Name || "")
    );
    const { items } = dedupeArtists(merged);
    return { items, total: items.length };
  }

  async setFavorite(itemId, isFavorite) {
    const path = `/UserFavoriteItems/${itemId}`;
    return this.request(path, {
      method: isFavorite ? "POST" : "DELETE",
      params: { userId: this.userId },
    });
  }

  /* ---------------- playlists ---------------- */

  /** Audio playlists only. Note: Jellyfin over-reports TotalRecordCount here,
      so callers must page off returned length, not the total. */
  async playlists(signal) {
    const data = await this.get(
      "/Items",
      {
        userId: this.userId,
        IncludeItemTypes: "Playlist",
        Recursive: true,
        SortBy: "SortName",
        Fields: "ChildCount,MediaType,DateCreated",
      },
      signal
    );
    const items = (data?.Items || []).filter(
      (p) => !p.MediaType || p.MediaType === "Audio"
    );
    return { items, total: items.length };
  }

  async playlistItems(playlistId, signal) {
    const data = await this.get(
      `/Playlists/${playlistId}/Items`,
      {
        userId: this.userId,
        Fields: "MediaSources,ParentId",
      },
      signal
    );
    return data?.Items || [];
  }

  async createPlaylist(name, itemIds = []) {
    return this.post("/Playlists", undefined, {
      Name: name,
      Ids: itemIds,
      UserId: this.userId,
      MediaType: "Audio",
    });
  }

  async addToPlaylist(playlistId, itemIds) {
    return this.post(`/Playlists/${playlistId}/Items`, {
      ids: itemIds.join(","),
      userId: this.userId,
    });
  }

  /** entryIds are PlaylistItemId values, not track ids. */
  async removeFromPlaylist(playlistId, entryIds) {
    return this.del(`/Playlists/${playlistId}/Items`, {
      entryIds: entryIds.join(","),
    });
  }

  async movePlaylistItem(playlistId, playlistItemId, newIndex) {
    return this.post(
      `/Playlists/${playlistId}/Items/${playlistItemId}/Move/${newIndex}`
    );
  }

  async renamePlaylist(playlistId, name) {
    return this.updatePlaylistSettings(playlistId, { name });
  }

  async playlistAccess(playlistId, signal) {
    const [playlist, permission] = await Promise.all([
      this.get(`/Playlists/${playlistId}`, undefined, signal),
      this.get(`/Playlists/${playlistId}/Users/${this.userId}`, undefined, signal)
        .catch((err) => {
          // A public viewer need not have an explicit share entry.
          if (err.status === 403 || err.status === 404) return null;
          throw err;
        }),
    ]);
    if (typeof playlist?.OpenAccess !== "boolean") {
      throw new Error("This server did not provide playlist visibility settings.");
    }
    return { isPublic: playlist.OpenAccess, canEdit: permission?.CanEdit === true };
  }

  async updatePlaylistSettings(playlistId, { name, isPublic }) {
    const body = {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) throw new Error("Enter a playlist name.");
      body.Name = name.trim();
    }
    if (isPublic !== undefined) {
      if (typeof isPublic !== "boolean") throw new Error("Choose private or public visibility.");
      body.IsPublic = isPublic;
    }
    if (!Object.keys(body).length) return;
    // Jellyfin's playlist-specific endpoint permits owners/shared editors.
    // Omit Ids and Users: resending them can replace tracks or invitations.
    return this.post(`/Playlists/${playlistId}`, undefined, body);
  }

  async deleteItem(itemId) {
    return this.del(`/Items/${itemId}`);
  }

  /* ---------------- search & discovery ---------------- */

  async search(term, limit = 24, signal) {
    const common = { searchTerm: term, Recursive: true, Limit: limit };
    const [songs, albums, artists] = await Promise.all([
      this.songs({ ...common, limit, sortBy: "SortName" }, signal),
      this.albums({ ...common, limit, sortBy: "SortName" }, signal),
      this.artists({ searchTerm: term, limit }, signal),
    ]);
    // Jellyfin's SearchTerm matches item titles, not their artist credits.
    // Include the catalog of matching artists without filtering those titles
    // again (e.g. searching Skillet must also find Comatose and Victorious).
    if (!artists.items.length) {
      return { songs: songs.items, albums: albums.items, artists: artists.items };
    }
    const ids = artists.items.map((artist) => artist.Id).join(",");
    const [artistSongs, artistAlbums] = await Promise.all([
      this.songs({ ArtistIds: ids, limit, sortBy: "SortName" }, signal),
      this.albums({ AlbumArtistIds: ids, limit, sortBy: "SortName" }, signal),
    ]);
    const merge = (direct, associated) =>
      [...new Map([...direct, ...associated].map((item) => [item.Id, item])).values()]
        .slice(0, limit);
    return {
      songs: merge(songs.items, artistSongs.items),
      albums: merge(albums.items, artistAlbums.items),
      artists: artists.items,
    };
  }

  async instantMix(itemId, limit = 60) {
    const data = await this.get(`/Items/${itemId}/InstantMix`, {
      userId: this.userId,
      Limit: limit,
      Fields: "ParentId",
    });
    return data?.Items || [];
  }

  async lyrics(itemId) {
    try {
      return await this.get(`/Audio/${itemId}/Lyrics`);
    } catch {
      return null;
    }
  }

  /* ---------------- media urls ---------------- */

  imageUrl(item, { size = 300, type = "Primary" } = {}) {
    if (!item) return null;
    // ImageItemId lets a record borrow artwork from a merged duplicate; the
    // tag is only valid against the item it came from.
    const id = item.ImageItemId || item.Id || item;
    const sizing = { maxHeight: size, maxWidth: size, quality: 90 };

    // An image tag is only valid for the item it belongs to: pairing a track
    // id with its album's tag yields a 404.
    const ownTag =
      item.ImageTags?.[type] ||
      (type === "Primary" ? item.PrimaryImageTag : null);
    if (ownTag) {
      return this.url(`/Items/${id}/Images/${type}`, { ...sizing, tag: ownTag });
    }

    // Tracks with no embedded art fall back to their album's cover.
    if (type === "Primary" && item.AlbumId && item.AlbumPrimaryImageTag) {
      return this.url(`/Items/${item.AlbumId}/Images/Primary`, {
        ...sizing,
        tag: item.AlbumPrimaryImageTag,
      });
    }
    return null;
  }

  /**
   * The signed-in user's Jellyfin avatar, or null when they have none.
   *
   * Two quirks of this endpoint, both confirmed against 10.11.11:
   *   - It ignores every sizing parameter (maxHeight, fillHeight, width...) and
   *     always returns the image at full resolution, so `size` cannot be used to
   *     ask for a thumbnail. `format=webp` is the only lever that helps: it
   *     re-encodes a 7 MB / 2048px PNG down to ~400 KB for the same pixels.
   *     Responses carry a year-long max-age, so this is a one-time cost per
   *     browser, and the tag in the query string busts it when the avatar changes.
   *   - It needs no Authorization header, which is why an <img> can load it
   *     directly the way album art does.
   *
   * Returns null rather than a URL when the user has no avatar, so callers can
   * keep showing the initial instead of firing a request that 404s.
   */
  avatarUrl() {
    if (!this.userId || !this.userImageTag) return null;
    return this.url(`/Users/${this.userId}/Images/Primary`, {
      tag: this.userImageTag,
      format: "webp",
    });
  }

  /**
   * Fills in `userImageTag` for sessions that predate it being stored (a session
   * restored from localStorage has no tag until the next sign-in). Safe to call
   * repeatedly: it only reaches the server while the tag is still unknown.
   */
  async loadUserImageTag() {
    if (this.userImageTag !== null || !this.userId) return this.userImageTag;
    try {
      const u = await this.get(`/Users/${this.userId}`);
      this.userImageTag = u?.PrimaryImageTag || "";
      if (u?.Name) this.userName = u.Name;
      this._persist();
    } catch {
      // Offline or the endpoint refused; leave it unknown and retry next load
      // rather than caching a wrong answer.
    }
    return this.userImageTag;
  }

  /**
   * First available image among `types`. Artists in particular often carry a
   * Backdrop or Logo but no Primary, which would otherwise render as an empty
   * placeholder even though Jellyfin has artwork for them.
   */
  bestImageUrl(item, { size = 300, types = ["Primary"] } = {}) {
    if (!item) return null;
    for (const type of types) {
      if (type === "Backdrop") {
        const tag = item.BackdropImageTags?.[0];
        if (!tag) continue;
        const id = item.ImageItemId || item.Id;
        return this.url(`/Items/${id}/Images/Backdrop/0`, {
          maxHeight: size,
          maxWidth: size,
          tag,
          quality: 90,
        });
      }
      const url = this.imageUrl(item, { size, type });
      if (url) return url;
    }
    return null;
  }

  /**
   * Direct-plays when the browser can decode the container, otherwise the
   * server transcodes. api_key goes in the query string because <audio>
   * cannot send an Authorization header.
   */
  streamUrl(item, { maxBitrate = 0, startSec = 0 } = {}) {
    const params = {
      UserId: this.userId,
      DeviceId: deviceId(),
      api_key: this.token,
      Container: DIRECT_CONTAINERS,
      ...(NATIVE_HLS
        ? { TranscodingContainer: "ts", TranscodingProtocol: "hls", AudioCodec: "aac" }
        : { TranscodingContainer: "mp3", TranscodingProtocol: "http", AudioCodec: "mp3" }),
      EnableRedirection: true,
      EnableRemoteMedia: false,
    };
    if (maxBitrate > 0) params.MaxStreamingBitrate = maxBitrate;
    if (startSec > 0) params.StartTimeTicks = secToTicks(startSec);
    return this.url(`/Audio/${item.Id}/universal`, params);
  }

  /**
   * Best guess at how the server will deliver a track, for playback reports.
   * The redirect from /universal is invisible to the page, so this mirrors the
   * server's decision: a browser-decodable container under the bitrate cap
   * plays as-is, anything else is transcoded.
   */
  playMethod(item, maxBitrate = 0) {
    const source = item?.MediaSources?.[0];
    const container = String(source?.Container || item?.Container || "")
      .split(",")[0]
      .toLowerCase();
    if (container && !DIRECT_CONTAINER_SET.has(container)) return "Transcode";
    const bitrate = source?.Bitrate || item?.Bitrate || 0;
    if (maxBitrate > 0 && (!bitrate || bitrate > maxBitrate)) return "Transcode";
    return "DirectPlay";
  }

  /* ---------------- playback reporting ---------------- */

  /** Fields shared by start and progress reports. `mode` comes from the player. */
  _playbackState(item, { positionSec = 0, isPaused = false, isMuted = false, mode = {} }) {
    return {
      ItemId: item.Id,
      MediaSourceId: item.Id,
      PositionTicks: secToTicks(positionSec),
      IsPaused: isPaused,
      IsMuted: isMuted,
      CanSeek: true,
      PlayMethod: mode.playMethod || "DirectPlay",
      RepeatMode: REPEAT_MODE_NAMES[mode.repeat] || "RepeatNone",
      PlaybackOrder: mode.shuffle ? "Shuffle" : "Default",
    };
  }

  reportStart(item, opts = {}) {
    return this.post(
      "/Sessions/Playing",
      undefined,
      this._playbackState(item, opts)
    ).catch(() => {});
  }

  reportProgress(item, { volume = 1, ...opts }) {
    return this.post("/Sessions/Playing/Progress", undefined, {
      ...this._playbackState(item, opts),
      VolumeLevel: Math.round(volume * 100),
      EventName: "timeupdate",
    }).catch(() => {});
  }

  reportStopped(item, positionSec) {
    return this.post("/Sessions/Playing/Stopped", undefined, {
      ItemId: item.Id,
      MediaSourceId: item.Id,
      PositionTicks: secToTicks(positionSec),
    }).catch(() => {});
  }
}

export const api = new JellyfinApi();
export { JellyfinApi };
