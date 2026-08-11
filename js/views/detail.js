/* Detail views: album, artist, playlist, genre. */

import { api } from "./../api.js";
import { player } from "./../player.js";
import { icons } from "./../icons.js";
import { navigate, routes, linkify } from "./../nav.js";
import {
  artBox,
  albumCard,
  playlistCard,
  grid,
  trackList,
  spinner,
  emptyState,
  errorState,
  toggleFavorite,
  addToPlaylistDialog,
  contextMenu,
  confirmDialog,
  promptDialog,
  toast,
} from "./../ui.js";
import {
  el,
  clear,
  fmtCount,
  fmtDurationLong,
  ticksToSec,
  artistsOf,
  artistIdOf,
  displayName,
} from "./../util.js";

/* Deterministic Tokyo Night tint per item, so each page feels distinct
   without leaving the palette. */
const HERO_TINTS = [
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#9ece6a",
  "#e0af68",
  "#f7768e",
  "#2ac3de",
  "#9d7cd8",
];

function heroTint(id = "") {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HERO_TINTS[h % HERO_TINTS.length];
}

function heroBg(id) {
  const c = heroTint(id);
  return el("div.hero-bg", {
    style: {
      "--hero-grad": `radial-gradient(1200px 340px at 12% 0%, ${c}33, transparent 68%)`,
    },
  });
}

function dot() {
  return el("span.dot", { text: "·" });
}

function playPauseButton(getTracks, contextFor) {
  const btn = el("button.btn-play-lg", { html: icons.play, title: "Play" });

  const isThisContext = () => {
    const ctx = player.context;
    const want = contextFor();
    return ctx && want && ctx.type === want.type && ctx.id === want.id;
  };

  const sync = () => {
    const active = isThisContext() && player.isPlaying;
    btn.innerHTML = active ? icons.pause : icons.play;
    btn.classList.toggle("paused", active);
    btn.title = active ? "Pause" : "Play";
  };

  btn.addEventListener("click", async () => {
    if (isThisContext()) return player.toggle();
    const tracks = await getTracks();
    if (!tracks?.length) return toast("Nothing to play", "err");
    player.play(tracks, 0, contextFor());
  });

  player.on("state", sync);
  player.on("track", sync);
  sync();
  return btn;
}

function favButton(item) {
  const on = Boolean(item.UserData?.IsFavorite);
  const btn = el("button.icon-btn.ghost.fav", {
    html: on ? icons.heartFilled : icons.heart,
    class: on ? "on" : "",
    title: on ? "Remove from favorites" : "Add to favorites",
    style: { width: "38px", height: "38px" },
    onclick: () => toggleFavorite(item, btn),
  });
  return btn;
}

/* ============================================================
   Album
   ============================================================ */

export async function albumView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);
  page.append(spinner());

  try {
    const [album, tracks] = await Promise.all([
      api.getItem(params.id),
      api.albumTracks(params.id, signal),
    ]);
    if (signal?.aborted) return;
    clear(page);

    const totalSec = tracks.reduce((s, t) => s + ticksToSec(t.RunTimeTicks), 0);
    const artistId = artistIdOf(album);
    const ctx = () => ({ type: "album", id: album.Id, name: displayName(album, "Unknown album") });

    const artistLine = el("span.strong", { text: album.AlbumArtist || artistsOf(album) });
    if (artistId) linkify(artistLine, routes.artist(artistId));

    const hero = el("div.detail-hero", {}, [
      heroBg(album.Id),
      artBox(album, { size: 500, cls: "hero-art", icon: "album" }),
      el("div.hero-meta", {}, [
        el("div.hero-kind", { text: "Album" }),
        el("h1.hero-title", { text: displayName(album, "Unknown album") }),
        el("div.hero-line", {}, [
          artistLine,
          album.ProductionYear ? dot() : null,
          album.ProductionYear ? el("span", { text: String(album.ProductionYear) }) : null,
          dot(),
          el("span", { text: fmtCount(tracks.length, "track") }),
          dot(),
          el("span", { text: fmtDurationLong(totalSec) }),
          album.Genres?.length ? dot() : null,
          album.Genres?.length ? el("span", { text: album.Genres.join(", ") }) : null,
        ]),
      ]),
    ]);
    page.append(hero);

    const moreBtn = el("button.icon-btn.ghost", {
      html: icons.dots,
      title: "More",
      style: { width: "38px", height: "38px" },
      onclick: (e) =>
        contextMenu(e, [
          {
            label: "Play next",
            icon: "queueNext",
            onClick: () => {
              player.addNext(tracks);
              toast("Album plays next");
            },
          },
          {
            label: "Add to queue",
            icon: "queue",
            onClick: () => {
              player.addToQueue(tracks);
              toast("Album added to queue");
            },
          },
          {
            label: "Add to playlist…",
            icon: "playlistAdd",
            onClick: () => addToPlaylistDialog(tracks),
          },
          "sep",
          {
            label: "Start radio",
            icon: "sparkle",
            onClick: async () => {
              const mix = await api.instantMix(album.Id);
              if (!mix.length) return toast("No similar tracks found", "err");
              player.play(mix, 0, { type: "mix", id: album.Id, name: `${displayName(album, "Album")} radio` });
            },
          },
        ]),
    });

    page.append(
      el("div.detail-actions", {}, [
        playPauseButton(async () => tracks, ctx),
        el("button.btn", {
          html: `${icons.shuffle}<span>Shuffle</span>`,
          onclick: () => player.playShuffled(tracks, ctx()),
        }),
        favButton(album),
        moreBtn,
      ])
    );

    if (!tracks.length) {
      page.append(emptyState("Empty album", "No audio tracks in this album."));
      return;
    }

    const multiDisc = new Set(tracks.map((t) => t.ParentIndexNumber ?? 1)).size > 1;
    page.append(
      trackList(tracks, {
        context: ctx(),
        showAlbum: false,
        showArtist: true,
        showArt: false,
        numbering: "track",
        discDividers: multiDisc,
      })
    );
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, () => albumView(container, params, signal)));
  }
}

/* ============================================================
   Artist
   ============================================================ */

export async function artistView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);
  page.append(spinner());

  try {
    const [artist, albums, topTracks, appearsOn] = await Promise.all([
      api.getItem(params.id),
      api.artistAlbums(params.id, signal),
      api.artistTopTracks(params.id, 8, signal),
      api.artistAppearsOn(params.id, signal).catch(() => ({ items: [] })),
    ]);
    if (signal?.aborted) return;
    clear(page);

    const ctx = () => ({ type: "artist", id: artist.Id, name: displayName(artist, "Unknown artist") });
    const ownAlbumIds = new Set(albums.items.map((a) => a.Id));
    const otherAlbums = appearsOn.items.filter((a) => !ownAlbumIds.has(a.Id));

    page.append(
      el("div.detail-hero", {}, [
        heroBg(artist.Id),
        artBox(artist, { size: 500, cls: "hero-art round", icon: "artist" }),
        el("div.hero-meta", {}, [
          el("div.hero-kind", { text: "Artist" }),
          el("h1.hero-title", { text: displayName(artist, "Unknown artist") }),
          el("div.hero-line", {}, [
            el("span", { text: fmtCount(albums.items.length, "album") }),
            otherAlbums.length ? dot() : null,
            otherAlbums.length
              ? el("span", { text: `${otherAlbums.length} appearance${otherAlbums.length > 1 ? "s" : ""}` })
              : null,
          ]),
        ]),
      ])
    );

    // Loading every track up front would be wasteful; fetch on demand.
    const allTracks = async () => api.artistAllTracks(artist.Id, signal);

    page.append(
      el("div.detail-actions", {}, [
        playPauseButton(allTracks, ctx),
        el("button.btn", {
          html: `${icons.shuffle}<span>Shuffle</span>`,
          onclick: async () => {
            const t = await allTracks();
            if (!t.length) return toast("No tracks found", "err");
            player.playShuffled(t, ctx());
          },
        }),
        favButton(artist),
        el("button.btn", {
          html: `${icons.sparkle}<span>Radio</span>`,
          onclick: async () => {
            try {
              const mix = await api.instantMix(artist.Id);
              if (!mix.length) return toast("No similar tracks found", "err");
              player.play(mix, 0, { type: "mix", id: artist.Id, name: `${displayName(artist, "Artist")} radio` });
            } catch (e) {
              toast(e.message || "Could not start radio", "err");
            }
          },
        }),
      ])
    );

    if (topTracks.items.length) {
      page.append(el("h2.section-title", {}, [el("span", { text: "Popular" })]));
      page.append(
        trackList(topTracks.items, {
          context: { type: "artist-top", id: artist.Id, name: artist.Name },
          showArtist: false,
          showAlbum: true,
          showArt: true,
          numbering: "index",
        })
      );
    }

    if (albums.items.length) {
      page.append(el("h2.section-title", {}, [el("span", { text: "Albums" })]));
      page.append(grid(albums.items, albumCard));
    }

    if (otherAlbums.length) {
      page.append(el("h2.section-title", {}, [el("span", { text: "Appears on" })]));
      page.append(grid(otherAlbums, albumCard));
    }

    if (!albums.items.length && !topTracks.items.length) {
      page.append(emptyState("Nothing here", "No albums or tracks found for this artist.", "artist"));
    }
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, () => artistView(container, params, signal)));
  }
}

/* ============================================================
   Playlist
   ============================================================ */

export async function playlistView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);
  page.append(spinner());

  const reload = () => playlistView(container, params, signal);

  try {
    const [pl, tracks] = await Promise.all([
      api.getItem(params.id),
      api.playlistItems(params.id, signal),
    ]);
    if (signal?.aborted) return;
    clear(page);

    const totalSec = tracks.reduce((s, t) => s + ticksToSec(t.RunTimeTicks), 0);
    const ctx = () => ({ type: "playlist", id: pl.Id, name: displayName(pl, "Playlist") });

    page.append(
      el("div.detail-hero", {}, [
        heroBg(pl.Id),
        artBox(pl, { size: 500, cls: "hero-art", icon: "list" }),
        el("div.hero-meta", {}, [
          el("div.hero-kind", { text: "Playlist" }),
          el("h1.hero-title", { text: displayName(pl, "Untitled playlist") }),
          el("div.hero-line", {}, [
            el("span.strong", { text: api.userName }),
            dot(),
            el("span", { text: fmtCount(tracks.length, "track") }),
            tracks.length ? dot() : null,
            tracks.length ? el("span", { text: fmtDurationLong(totalSec) }) : null,
          ]),
        ]),
      ])
    );

    const moreBtn = el("button.icon-btn.ghost", {
      html: icons.dots,
      title: "More",
      style: { width: "38px", height: "38px" },
      onclick: (e) =>
        contextMenu(e, [
          {
            label: "Add to queue",
            icon: "queue",
            onClick: () => {
              player.addToQueue(tracks);
              toast("Playlist added to queue");
            },
          },
          {
            label: "Rename playlist",
            icon: "list",
            onClick: async () => {
              const name = await promptDialog({
                title: "Rename playlist",
                label: "Playlist name",
                value: pl.Name,
                confirmLabel: "Rename",
              });
              if (!name || name === pl.Name) return;
              try {
                await api.renamePlaylist(pl.Id, name);
                toast("Playlist renamed");
                window.dispatchEvent(new CustomEvent("tm:playlists-changed"));
                reload();
              } catch (err) {
                toast(err.message || "Rename failed", "err");
              }
            },
          },
          "sep",
          {
            label: "Delete playlist",
            icon: "trash",
            danger: true,
            onClick: async () => {
              const ok = await confirmDialog({
                title: "Delete playlist?",
                body: `"${pl.Name}" will be permanently removed from your Jellyfin server. The tracks themselves are not deleted.`,
                confirmLabel: "Delete",
                danger: true,
              });
              if (!ok) return;
              try {
                await api.deleteItem(pl.Id);
                toast("Playlist deleted");
                window.dispatchEvent(new CustomEvent("tm:playlists-changed"));
                navigate(routes.playlists());
              } catch (err) {
                toast(err.message || "Delete failed", "err");
              }
            },
          },
        ]),
    });

    page.append(
      el("div.detail-actions", {}, [
        playPauseButton(async () => tracks, ctx),
        el("button.btn", {
          html: `${icons.shuffle}<span>Shuffle</span>`,
          disabled: !tracks.length,
          onclick: () => player.playShuffled(tracks, ctx()),
        }),
        moreBtn,
      ])
    );

    if (!tracks.length) {
      page.append(
        emptyState(
          "This playlist is empty",
          "Right-click any track and choose “Add to playlist” to fill it up.",
          "list"
        )
      );
      return;
    }

    const list = trackList(tracks, {
      context: ctx(),
      showAlbum: true,
      showArtist: true,
      showArt: true,
      numbering: "index",
      playlistId: pl.Id,
      onChange: reload,
    });

    // Bulk actions appear only while rows are selected.
    const bulk = el("div", {
      style: { display: "none", gap: "8px", padding: "10px 0 4px", alignItems: "center" },
    });
    list.addEventListener("selectionchange", (e) => {
      const n = e.detail.tracks.length;
      clear(bulk);
      bulk.style.display = n ? "flex" : "none";
      if (!n) return;
      bulk.append(
        el("span.page-sub", { text: `${n} selected` }),
        el("button.btn", {
          html: `${icons.playlistAdd}<span>Add to playlist</span>`,
          onclick: () => addToPlaylistDialog(e.detail.tracks),
        }),
        el("button.btn", {
          html: `${icons.queue}<span>Queue</span>`,
          onclick: () => {
            player.addToQueue(e.detail.tracks);
            toast(`${n} tracks queued`);
          },
        }),
        el("button.btn.danger", {
          html: `${icons.trash}<span>Remove</span>`,
          onclick: async () => {
            const entryIds = e.detail.tracks.map((t) => t.PlaylistItemId).filter(Boolean);
            if (!entryIds.length) return;
            try {
              await api.removeFromPlaylist(pl.Id, entryIds);
              toast(`Removed ${entryIds.length} tracks`);
              reload();
            } catch (err) {
              toast(err.message || "Remove failed", "err");
            }
          },
        }),
        el("button.btn", { text: "Clear", onclick: () => list.clearSelection() })
      );
    });

    page.append(
      el("p.page-sub", {
        text: "Drag rows to reorder. Ctrl-click or shift-click to select several.",
        style: { marginBottom: "8px" },
      })
    );
    page.append(bulk);
    page.append(list);
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, reload));
  }
}

/* ============================================================
   Playlists index
   ============================================================ */

export async function playlistsView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  const sub = el("p.page-sub", { text: "Loading…" });
  const newBtn = el("button.btn.primary", {
    html: `${icons.plus}<span>New playlist</span>`,
    onclick: async () => {
      const name = await promptDialog({
        title: "New playlist",
        label: "Playlist name",
        placeholder: "My playlist",
        confirmLabel: "Create",
      });
      if (!name) return;
      try {
        const created = await api.createPlaylist(name, []);
        toast(`Created "${name}"`);
        window.dispatchEvent(new CustomEvent("tm:playlists-changed"));
        if (created?.Id) navigate(routes.playlist(created.Id));
        else playlistsView(container, params, signal);
      } catch (e) {
        toast(e.message || "Could not create playlist", "err");
      }
    },
  });

  page.append(
    el("div.page-header", {}, [
      el("div", {}, [el("h1.page-title", { text: "Playlists" }), sub]),
      el("div.page-tools", {}, [newBtn]),
    ])
  );

  const body = el("div", {}, [spinner()]);
  page.append(body);

  try {
    const { items } = await api.playlists(signal);
    if (signal?.aborted) return;
    clear(body);
    sub.textContent = fmtCount(items.length, "playlist");
    if (!items.length) {
      body.append(
        emptyState(
          "No playlists yet",
          "Create one here, or right-click any track and choose “Add to playlist”.",
          "list"
        )
      );
      return;
    }
    body.append(grid(items, playlistCard));
  } catch (e) {
    if (signal?.aborted) return;
    clear(body);
    body.append(errorState(e, () => playlistsView(container, params, signal)));
  }
}

/* ============================================================
   Genre
   ============================================================ */

export async function genreView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);
  page.append(spinner());

  try {
    const [albums, songs] = await Promise.all([
      api.albums({ limit: 60, GenreIds: params.id, sortBy: "SortName" }, signal),
      api.songs({ limit: 200, GenreIds: params.id, sortBy: "SortName" }, signal),
    ]);
    if (signal?.aborted) return;
    clear(page);

    const name = params.query?.name || "Genre";
    const ctx = () => ({ type: "genre", id: params.id, name });

    page.append(
      el("div.page-header", {}, [
        el("div", {}, [
          el("h1.page-title", { text: name }),
          el("p.page-sub", {
            text: [
              albums.total ? fmtCount(albums.total, "album") : null,
              songs.total ? fmtCount(songs.total, "song") : null,
            ]
              .filter(Boolean)
              .join(" · "),
          }),
        ]),
        el("div.page-tools", {}, [
          el("button.btn.primary", {
            html: `${icons.shuffle}<span>Shuffle</span>`,
            disabled: !songs.items.length,
            onclick: () => player.playShuffled(songs.items, ctx()),
          }),
        ]),
      ])
    );

    if (!albums.items.length && !songs.items.length) {
      page.append(emptyState("Nothing here", "No music tagged with this genre.", "genre"));
      return;
    }

    if (albums.items.length) {
      page.append(el("h2.section-title", {}, [el("span", { text: "Albums" })]));
      page.append(grid(albums.items, albumCard));
    }
    if (songs.items.length) {
      page.append(el("h2.section-title", {}, [el("span", { text: "Songs" })]));
      page.append(trackList(songs.items, { context: ctx(), numbering: "index" }));
    }
  } catch (e) {
    if (signal?.aborted) return;
    clear(page);
    page.append(errorState(e, () => genreView(container, params, signal)));
  }
}
