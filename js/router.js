/* Hash router. Each navigation gets an AbortSignal so a slow view that the
   user has already navigated away from cannot paint over the new one. */

import { homeView } from "./views/home.js";
import {
  albumsView,
  artistsView,
  songsView,
  genresView,
  favoritesView,
} from "./views/library.js";
import {
  albumView,
  artistView,
  playlistView,
  playlistsView,
  genreView,
} from "./views/detail.js";
import { searchView } from "./views/search.js";
import { emptyState } from "./ui.js";
import { clear, el } from "./util.js";

const TABLE = [
  [/^\/?$/, homeView, "home"],
  [/^\/home$/, homeView, "home"],
  [/^\/albums$/, albumsView, "albums"],
  [/^\/artists$/, artistsView, "artists"],
  [/^\/songs$/, songsView, "songs"],
  [/^\/genres$/, genresView, "genres"],
  [/^\/genre\/([^/]+)$/, genreView, "genres", ["id"]],
  [/^\/playlists$/, playlistsView, "playlists"],
  [/^\/playlist\/([^/]+)$/, playlistView, "playlists", ["id"]],
  [/^\/album\/([^/]+)$/, albumView, "albums", ["id"]],
  [/^\/artist\/([^/]+)$/, artistView, "artists", ["id"]],
  [/^\/favorites$/, favoritesView, "favorites"],
  [/^\/search$/, searchView, "search"],
];

export class Router {
  constructor(outlet, { onRouteChange } = {}) {
    this.outlet = outlet;
    this.onRouteChange = onRouteChange;
    this.controller = null;
    this.scrollPositions = new Map();
    this._lastHash = null;

    window.addEventListener("hashchange", () => this.resolve());
  }

  start() {
    if (!location.hash) location.replace("#/home");
    this.resolve();
  }

  parse() {
    const raw = location.hash.replace(/^#/, "") || "/home";
    const [path, qs = ""] = raw.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs).entries());
    return { path, query };
  }

  async resolve() {
    // Remember where the previous page was scrolled to.
    if (this._lastHash != null) {
      this.scrollPositions.set(this._lastHash, this.outlet.scrollTop);
    }

    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const { path, query } = this.parse();
    this._lastHash = location.hash;

    const match = TABLE.find(([re]) => re.test(path));
    this.onRouteChange?.(match ? match[2] : null, { path, query });

    // Tear down listeners registered by the outgoing view's components.
    this.outlet
      .querySelectorAll(".tracklist")
      .forEach((n) => n.dispatchEvent(new CustomEvent("tm:destroy")));

    if (!match) {
      clear(this.outlet);
      this.outlet.append(
        el("div.page", {}, [
          emptyState("Page not found", `Nothing lives at ${path}.`, "info"),
        ])
      );
      return;
    }

    const [re, view, , paramNames = []] = match;
    const m = re.exec(path);
    const params = { query };
    paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });

    this.outlet.scrollTop = 0;
    try {
      await view(this.outlet, params, signal);
    } catch (e) {
      if (signal.aborted) return;
      console.error("View failed", e);
    }

    if (signal.aborted) return;
    const saved = this.scrollPositions.get(location.hash);
    if (saved) this.outlet.scrollTop = saved;
  }

  refresh() {
    this.resolve();
  }
}
