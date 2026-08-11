/* Library browse views: albums, artists, songs, genres, favorites. */

import { api } from "./../api.js";
import { player } from "./../player.js";
import { icons } from "./../icons.js";
import {
  albumCard,
  artistCard,
  genreCard,
  grid,
  trackList,
  spinner,
  emptyState,
  errorState,
  infiniteScroll,
  addToPlaylistDialog,
  toast,
} from "./../ui.js";
import { el, clear, fmtCount } from "./../util.js";

const PAGE_ALBUMS = 60;
const PAGE_ARTISTS = 80;
const PAGE_SONGS = 150;

const LS_SORT = "tokyomusic.sort";

function getSort(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(LS_SORT) || "{}")[key] || fallback;
  } catch {
    return fallback;
  }
}

function setSort(key, value) {
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem(LS_SORT) || "{}");
  } catch {
    /* start fresh */
  }
  all[key] = value;
  localStorage.setItem(LS_SORT, JSON.stringify(all));
}

function sortSelect(key, options, onChange) {
  const current = getSort(key, options[0].value);
  const sel = el("select.select", {
    "aria-label": "Sort by",
    onchange: (e) => {
      setSort(key, e.target.value);
      onChange(e.target.value);
    },
  });
  options.forEach((o) =>
    sel.append(el("option", { value: o.value, text: o.label, selected: o.value === current }))
  );
  return { node: sel, value: current };
}

function parseSort(value) {
  const [sortBy, sortOrder = "Ascending"] = value.split(":");
  return { sortBy, sortOrder };
}

function header(title, subtitleNode, tools) {
  return el("div.page-header", {}, [
    el("div", {}, [
      el("h1.page-title", { text: title }),
      subtitleNode || null,
    ]),
    tools ? el("div.page-tools", {}, tools) : null,
  ]);
}

/* ============================================================
   Albums
   ============================================================ */

const ALBUM_SORTS = [
  { value: "SortName:Ascending", label: "A–Z" },
  { value: "SortName:Descending", label: "Z–A" },
  { value: "DateCreated:Descending", label: "Recently added" },
  { value: "ProductionYear:Descending", label: "Newest year" },
  { value: "ProductionYear:Ascending", label: "Oldest year" },
  { value: "AlbumArtist:Ascending", label: "Artist" },
  { value: "PlayCount:Descending", label: "Most played" },
  { value: "Random:Ascending", label: "Random" },
];

export async function albumsView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  const sub = el("p.page-sub", { text: "Loading…" });
  let g = grid([], albumCard);
  let offset = 0;
  let stop = null;

  const sorter = sortSelect("albums", ALBUM_SORTS, () => {
    stop?.();
    albumsView(container, params, signal);
  });

  page.append(header("Albums", sub, [sorter.node]));
  page.append(g);

  const { sortBy, sortOrder } = parseSort(sorter.value);

  async function loadPage() {
    const { items, total } = await api.albums(
      { startIndex: offset, limit: PAGE_ALBUMS, sortBy, sortOrder },
      signal
    );
    if (signal?.aborted) return false;
    offset += items.length;
    items.forEach((a) => g.append(albumCard(a)));
    sub.textContent = fmtCount(total, "album");
    if (!items.length || offset >= total) return false;
    return true;
  }

  try {
    const more = await loadPage();
    if (signal?.aborted) return;
    if (!offset) {
      clear(page);
      page.append(header("Albums", null, null));
      page.append(emptyState("No albums", "Nothing in your music library yet."));
      return;
    }
    if (more) stop = infiniteScroll(page, loadPage);
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, () => albumsView(container, params, signal)));
  }
}

/* ============================================================
   Artists
   ============================================================ */

export async function artistsView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  const sub = el("p.page-sub", { text: "Loading…" });
  const g = grid([], artistCard, "grid artists");
  let offset = 0;
  let stop = null;

  const sorter = sortSelect(
    "artists",
    [
      { value: "SortName:Ascending", label: "A–Z" },
      { value: "SortName:Descending", label: "Z–A" },
    ],
    () => {
      stop?.();
      artistsView(container, params, signal);
    }
  );

  page.append(header("Artists", sub, [sorter.node]));
  page.append(g);

  const { sortOrder } = parseSort(sorter.value);

  async function loadPage() {
    const { items, total } = await api.artists(
      { startIndex: offset, limit: PAGE_ARTISTS, sortOrder },
      signal
    );
    if (signal?.aborted) return false;
    offset += items.length;
    items.forEach((a) => g.append(artistCard(a)));
    sub.textContent = fmtCount(total, "artist");
    if (!items.length || offset >= total) return false;
    return true;
  }

  try {
    const more = await loadPage();
    if (signal?.aborted) return;
    if (!offset) {
      clear(page);
      page.append(header("Artists", null, null));
      page.append(emptyState("No artists", "Nothing in your music library yet.", "artist"));
      return;
    }
    if (more) stop = infiniteScroll(page, loadPage);
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, () => artistsView(container, params, signal)));
  }
}

/* ============================================================
   Songs
   ============================================================ */

const SONG_SORTS = [
  { value: "SortName:Ascending", label: "A–Z" },
  { value: "SortName:Descending", label: "Z–A" },
  { value: "Album,ParentIndexNumber,IndexNumber:Ascending", label: "By album" },
  { value: "AlbumArtist,Album,ParentIndexNumber,IndexNumber:Ascending", label: "By artist" },
  { value: "DateCreated:Descending", label: "Recently added" },
  { value: "PlayCount:Descending", label: "Most played" },
  { value: "Random:Ascending", label: "Random" },
];

export async function songsView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  const sub = el("p.page-sub", { text: "Loading…" });
  let stop = null;

  const sorter = sortSelect("songs", SONG_SORTS, () => {
    stop?.();
    songsView(container, params, signal);
  });

  const shuffleBtn = el("button.btn.primary", {
    html: `${icons.shuffle}<span>Shuffle</span>`,
    onclick: async () => {
      try {
        const { items } = await api.songs({ limit: 300, sortBy: "Random" }, signal);
        if (!items.length) return toast("No tracks to shuffle", "err");
        player.playShuffled(items, { type: "library", name: "All songs" });
      } catch (e) {
        toast(e.message || "Could not shuffle", "err");
      }
    },
  });

  page.append(header("Songs", sub, [shuffleBtn, sorter.node]));

  const { sortBy, sortOrder } = parseSort(sorter.value);
  const loaded = [];
  let list = null;
  let offset = 0;

  async function loadPage() {
    const { items, total } = await api.songs(
      { startIndex: offset, limit: PAGE_SONGS, sortBy, sortOrder },
      signal
    );
    if (signal?.aborted) return false;
    offset += items.length;
    sub.textContent = fmtCount(total, "song");

    if (!list) {
      loaded.push(...items);
      list = trackList(loaded, {
        context: { type: "library", name: "All songs" },
        numbering: "index",
      });
      page.append(list);
    } else {
      list.appendTracks(items);
    }
    if (!items.length || offset >= total) return false;
    return true;
  }

  try {
    const more = await loadPage();
    if (signal?.aborted) return;
    if (!offset) {
      clear(page);
      page.append(header("Songs", null, null));
      page.append(emptyState("No songs", "Nothing in your music library yet."));
      return;
    }
    if (more) stop = infiniteScroll(page, loadPage);
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, () => songsView(container, params, signal)));
  }
}

/* ============================================================
   Genres
   ============================================================ */

export async function genresView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);
  page.append(header("Genres", el("p.page-sub", { text: "Loading…" })));
  const body = el("div", {}, [spinner()]);
  page.append(body);

  try {
    const { items } = await api.genres(signal);
    if (signal?.aborted) return;
    clear(body);
    page.querySelector(".page-sub").textContent = fmtCount(items.length, "genre");
    if (!items.length) {
      body.append(
        emptyState(
          "No genres",
          "Your tracks do not carry genre tags, or the library needs a metadata refresh.",
          "genre"
        )
      );
      return;
    }
    body.append(grid(items, genreCard));
  } catch (e) {
    if (signal?.aborted) return;
    clear(body);
    body.append(errorState(e, () => genresView(container, params, signal)));
  }
}

/* ============================================================
   Favorites
   ============================================================ */

export async function favoritesView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  const sub = el("p.page-sub", { text: "Loading…" });
  const playBtn = el("button.btn.primary", {
    html: `${icons.play}<span>Play</span>`,
    disabled: true,
  });
  page.append(header("Favorites", sub, [playBtn]));

  const body = el("div", {}, [spinner()]);
  page.append(body);

  try {
    const [songs, albums, artists] = await Promise.all([
      api.favoriteSongs({ limit: 500 }, signal),
      api.favoriteAlbums(signal),
      api.favoriteArtists(signal).catch(() => ({ items: [] })),
    ]);
    if (signal?.aborted) return;
    clear(body);

    const nSongs = songs.items.length;
    const counts = [
      nSongs ? fmtCount(nSongs, "song") : null,
      albums.items.length ? fmtCount(albums.items.length, "album") : null,
      artists.items.length ? fmtCount(artists.items.length, "artist") : null,
    ].filter(Boolean);
    sub.textContent = counts.length ? counts.join(" · ") : "Nothing favorited yet";

    if (!nSongs && !albums.items.length && !artists.items.length) {
      body.append(
        emptyState(
          "No favorites yet",
          "Tap the heart on any track, album or artist and it will show up here.",
          "heart"
        )
      );
      return;
    }

    if (nSongs) {
      playBtn.disabled = false;
      playBtn.addEventListener("click", () =>
        player.play(songs.items, 0, { type: "favorites", name: "Favorites" })
      );
    }

    if (artists.items.length) {
      body.append(
        el("h2.section-title", {}, [el("span", { text: "Favorite artists" })])
      );
      body.append(grid(artists.items, artistCard, "row-scroll"));
    }

    if (albums.items.length) {
      body.append(
        el("h2.section-title", {}, [el("span", { text: "Favorite albums" })])
      );
      body.append(grid(albums.items, albumCard, "row-scroll"));
    }

    if (nSongs) {
      const head = el("h2.section-title", {}, [
        el("span", { text: "Favorite songs" }),
      ]);
      const addAll = el("button.section-more", {
        text: "Add all to playlist",
        onclick: () => addToPlaylistDialog(songs.items),
      });
      head.append(addAll);
      body.append(head);
      body.append(
        trackList(songs.items, {
          context: { type: "favorites", name: "Favorites" },
          numbering: "index",
        })
      );
    }
  } catch (e) {
    if (signal?.aborted) return;
    clear(body);
    body.append(errorState(e, () => favoritesView(container, params, signal)));
  }
}
