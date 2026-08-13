/* Reusable presentation components: art, cards, track lists, menus, toasts. */

import { api } from "./api.js";
import { player } from "./player.js";
import { icons } from "./icons.js";
import { navigate, routes, linkify } from "./nav.js";
import {
  el,
  $,
  $$,
  clear,
  fmtTime,
  fmtCount,
  artistsOf,
  artistIdOf,
  ticksToSec,
  displayName,
} from "./util.js";

/** Artists frequently have a Backdrop but no Primary; fall back rather than
    render an empty placeholder. Logo is skipped: it is usually a wide
    transparent image that crops badly into a circular card. */
export const ARTIST_IMAGE_TYPES = ["Primary", "Backdrop"];

/* ============================================================
   Lazy images
   ============================================================ */

const imgObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      imgObserver.unobserve(img);
      const src = img.dataset.src;
      if (!src) continue;
      img.src = src;
      img.addEventListener("load", () => img.classList.add("loaded"), {
        once: true,
      });
      img.addEventListener(
        "error",
        () => {
          img.remove();
        },
        { once: true }
      );
    }
  },
  { rootMargin: "300px" }
);

/** Art tile with a placeholder that shows through until the image decodes. */
export function artBox(
  item,
  { size = 300, cls = "", icon = "music", types = ["Primary"] } = {}
) {
  // The shared `art` class owns the placeholder/image stacking; the second
  // class carries the size and shape for each context.
  const box = el(`div.art.${cls || "card-art"}`);
  box.append(el("div.art-fallback", { html: icons[icon] }));
  const url = api.bestImageUrl(item, { size, types });
  if (url) {
    const img = el("img", {
      alt: "",
      loading: "lazy",
      decoding: "async",
      dataset: { src: url },
    });
    box.append(img);
    imgObserver.observe(img);
  }
  return box;
}

/* ============================================================
   Cards
   ============================================================ */

function playButton(onPlay) {
  return el("button.card-play", {
    html: icons.play,
    title: "Play",
    "aria-label": "Play",
    onclick: (e) => {
      e.stopPropagation();
      onPlay();
    },
  });
}

export function albumCard(album) {
  const art = artBox(album, { size: 300, icon: "album" });
  art.append(
    playButton(async () => {
      const tracks = await api.albumTracks(album.Id);
      player.play(tracks, 0, { type: "album", id: album.Id, name: displayName(album, "Unknown album") });
    })
  );

  const card = el("div.card", { title: displayName(album, "Unknown album") }, [
    art,
    el("div.card-title", { text: displayName(album, "Unknown album") }),
    el("div.card-sub", {
      text: [album.AlbumArtist || artistsOf(album), album.ProductionYear]
        .filter(Boolean)
        .join(" · "),
    }),
  ]);
  card.addEventListener("contextmenu", (e) => albumMenu(e, album));
  return linkify(card, routes.album(album.Id));
}

export function artistCard(artist) {
  const card = el("div.card.artist", { title: displayName(artist, "Unknown artist") }, [
    artBox(artist, { size: 300, icon: "artist", types: ARTIST_IMAGE_TYPES }),
    el("div.card-title", { text: displayName(artist, "Unknown artist") }),
    el("div.card-sub", { text: "Artist" }),
  ]);
  return linkify(card, routes.artist(artist.Id));
}

export function playlistCard(pl) {
  const art = artBox(pl, { size: 300, icon: "list" });
  art.append(
    playButton(async () => {
      const tracks = await api.playlistItems(pl.Id);
      player.play(tracks, 0, { type: "playlist", id: pl.Id, name: displayName(pl, "Playlist") });
    })
  );
  const card = el("div.card", { title: displayName(pl, "Untitled playlist") }, [
    art,
    el("div.card-title", { text: displayName(pl, "Untitled playlist") }),
    el("div.card-sub", {
      text: pl.ChildCount != null ? fmtCount(pl.ChildCount, "track") : "Playlist",
    }),
  ]);
  card.addEventListener("contextmenu", (e) => playlistMenu(e, pl));
  return linkify(card, routes.playlist(pl.Id));
}

export function genreCard(genre) {
  const card = el("div.card", { title: displayName(genre, "Unknown genre") }, [
    artBox(genre, { size: 300, icon: "genre" }),
    el("div.card-title", { text: displayName(genre, "Unknown genre") }),
    el("div.card-sub", { text: "Genre" }),
  ]);
  return linkify(card, routes.genre(genre.Id, genre.Name));
}

export function grid(items, renderer, cls = "grid") {
  const g = el(`div.${cls}`);
  items.forEach((i) => g.append(renderer(i)));
  return g;
}

/* ============================================================
   Track list
   ============================================================ */

/**
 * @param {Array} tracks
 * @param {object} opts
 *   context      {type,id,name} passed to the player
 *   showAlbum    include the album column
 *   showArtist   include the artist column
 *   showArt      thumbnail per row
 *   numbering    "index" | "track" | "none"
 *   discDividers group by ParentIndexNumber
 *   playlistId   enables remove/reorder affordances
 *   onChange     called after a mutation (remove/reorder)
 */
export function trackList(tracks, opts = {}) {
  const {
    context = null,
    showAlbum = true,
    showArtist = true,
    showArt = true,
    numbering = "index",
    discDividers = false,
    playlistId = null,
    onChange = null,
  } = opts;

  const cols = [
    "40px",
    "minmax(0, 3fr)",
    showArtist ? "minmax(0, 2fr)" : null,
    showAlbum ? "minmax(0, 2fr)" : null,
    "90px",
    "56px",
  ]
    .filter(Boolean)
    .join(" ");

  const wrap = el("div.tracklist", { style: { "--tl-cols": cols } });

  const head = el("div.track-head", { style: { "--tl-cols": cols } }, [
    el("div", { text: "#", style: { textAlign: "right" } }),
    el("div", { text: "Title" }),
    showArtist ? el("div.hide-sm", { text: "Artist" }) : null,
    showAlbum ? el("div.hide-sm", { text: "Album" }) : null,
    el("div", { html: icons.clock, style: { justifySelf: "end", width: "15px" } }),
    el("div"),
  ]);
  wrap.append(head);

  /** Selection state, for bulk playlist building. */
  const selected = new Set();
  let lastClicked = -1;

  /* `tracks` is mutated in place by appendTracks so that the array the player
     receives always matches what is on screen, keeping row indices valid. */
  const rows = [];
  let lastDisc = null;

  function renderFrom(start) {
    for (let i = start; i < tracks.length; i++) {
      const track = tracks[i];
      if (discDividers) {
        const disc = track.ParentIndexNumber ?? null;
        if (disc != null && disc !== lastDisc) {
          lastDisc = disc;
          wrap.append(el("div.disc-divider", { text: `Disc ${disc}` }));
        }
      }
      const row = trackRow(track, i);
      rows.push(row);
      wrap.append(row);
    }
  }
  renderFrom(0);

  function refreshPlayingState() {
    const curId = player.current?.Id;
    rows.forEach((row) => {
      const isCur = curId && row.dataset.id === curId;
      row.classList.toggle("playing", Boolean(isCur));
    });
  }

  function applySelection() {
    rows.forEach((row, i) => row.classList.toggle("selected", selected.has(i)));
    wrap.dispatchEvent(
      new CustomEvent("selectionchange", {
        detail: { indices: [...selected], tracks: [...selected].map((i) => tracks[i]) },
      })
    );
  }

  function trackRow(track, i) {
    const num =
      numbering === "track"
        ? track.IndexNumber ?? i + 1
        : numbering === "none"
        ? ""
        : i + 1;

    const idxCell = el("div.track-index", {}, [
      el("span.num", { text: String(num) }),
      el("span.hover-play", { html: icons.play }),
      el("span.eq", { html: "<i></i><i></i><i></i>" }),
    ]);

    const main = el("div.track-main");
    if (showArt) main.append(artBox(track, { size: 80, cls: "track-art" }));
    main.append(
      el("div.track-text", {}, [
        el("div.track-title", { text: displayName(track, "Unknown track") }),
        !showArtist
          ? el("div.track-artist", { text: artistsOf(track) })
          : null,
      ])
    );

    const cells = [idxCell, main];

    if (showArtist) {
      const aid = artistIdOf(track);
      const c = el("div.track-cell.hide-sm", {
        text: artistsOf(track),
        title: artistsOf(track),
        class: aid ? "link" : "",
      });
      if (aid) linkify(c, routes.artist(aid));
      cells.push(c);
    }

    if (showAlbum) {
      const c = el("div.track-cell.hide-sm", {
        text: track.Album || "",
        title: track.Album || "",
        class: track.AlbumId ? "link" : "",
      });
      if (track.AlbumId) linkify(c, routes.album(track.AlbumId));
      cells.push(c);
    }

    cells.push(el("div.track-dur", { text: fmtTime(ticksToSec(track.RunTimeTicks)) }));

    const favOn = Boolean(track.UserData?.IsFavorite);
    const favBtn = el("button.icon-btn.fav", {
      html: favOn ? icons.heartFilled : icons.heart,
      title: favOn ? "Remove from favorites" : "Add to favorites",
      class: favOn ? "on" : "",
      onclick: async (e) => {
        e.stopPropagation();
        await toggleFavorite(track, favBtn);
      },
    });

    const moreBtn = el("button.icon-btn", {
      html: icons.dots,
      title: "More",
      onclick: (e) => {
        e.stopPropagation();
        trackMenu(e, track, {
          tracks,
          index: i,
          context,
          playlistId,
          onChange,
          selection: selected.has(i) ? [...selected].map((n) => tracks[n]) : null,
        });
      },
    });

    cells.push(el("div.track-actions", {}, [favBtn, moreBtn]));

    const row = el("div.track", {
      dataset: { id: track.Id, index: String(i) },
    }, cells);

    row.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        selected.has(i) ? selected.delete(i) : selected.add(i);
        lastClicked = i;
        applySelection();
        return;
      }
      if (e.shiftKey && lastClicked >= 0) {
        const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
        for (let n = a; n <= b; n++) selected.add(n);
        applySelection();
        return;
      }
      if (selected.size) {
        selected.clear();
        applySelection();
      }
      lastClicked = i;
      player.play(tracks, i, context);
    });

    row.addEventListener("contextmenu", (e) =>
      trackMenu(e, track, {
        tracks,
        index: i,
        context,
        playlistId,
        onChange,
        selection: selected.has(i) ? [...selected].map((n) => tracks[n]) : null,
      })
    );

    if (playlistId) attachReorder(row, i);
    return row;
  }

  /* Drag to reorder inside a playlist. */
  function attachReorder(row, i) {
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      $$(".track", wrap).forEach((r) =>
        r.classList.remove("drop-before", "drop-after")
      );
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      row.classList.toggle("drop-before", !after);
      row.classList.toggle("drop-after", after);
    });
    row.addEventListener("dragleave", () =>
      row.classList.remove("drop-before", "drop-after")
    );
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      let to = after ? i + 1 : i;
      if (from < to) to--;
      row.classList.remove("drop-before", "drop-after");
      if (from === to || Number.isNaN(from)) return;

      const moved = tracks[from];
      const entryId = moved.PlaylistItemId;
      if (!entryId) return toast("Cannot reorder this item", "err");
      try {
        await api.movePlaylistItem(playlistId, entryId, to);
        toast("Playlist reordered");
        onChange?.();
      } catch (err) {
        toast(err.message || "Reorder failed", "err");
      }
    });
  }

  /** Appends a page of tracks without rebuilding existing rows. */
  wrap.appendTracks = (more) => {
    if (!more?.length) return;
    const start = tracks.length;
    tracks.push(...more);
    renderFrom(start);
    refreshPlayingState();
  };

  wrap.refresh = refreshPlayingState;
  wrap.getSelection = () => [...selected].map((i) => tracks[i]);
  wrap.clearSelection = () => {
    selected.clear();
    applySelection();
  };

  refreshPlayingState();
  const off = player.on("track", refreshPlayingState);
  wrap.addEventListener("tm:destroy", off);

  return wrap;
}

export async function toggleFavorite(item, btn) {
  const next = !item.UserData?.IsFavorite;
  try {
    await api.setFavorite(item.Id, next);
    item.UserData = { ...(item.UserData || {}), IsFavorite: next };
    if (btn) {
      btn.innerHTML = next ? icons.heartFilled : icons.heart;
      btn.classList.toggle("on", next);
      btn.title = next ? "Remove from favorites" : "Add to favorites";
    }
    toast(next ? "Added to favorites" : "Removed from favorites");
  } catch (e) {
    toast(e.message || "Could not update favorite", "err");
  }
  return next;
}

/* ============================================================
   Context menus
   ============================================================ */

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener("click", closeMenu);
document.addEventListener("scroll", closeMenu, true);
window.addEventListener("resize", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

/** items: [{label, icon, onClick, danger}] or "sep" */
export function contextMenu(ev, items) {
  ev.preventDefault();
  ev.stopPropagation();
  closeMenu();

  const menu = el("div.ctx-menu", { role: "menu" });
  for (const it of items) {
    if (it === "sep") {
      menu.append(el("div.ctx-sep"));
      continue;
    }
    if (!it) continue;
    menu.append(
      el("button.ctx-item", {
        class: it.danger ? "danger" : "",
        role: "menuitem",
        onclick: (e) => {
          e.stopPropagation();
          closeMenu();
          it.onClick?.();
        },
      }, [
        el("span", { html: icons[it.icon] || "" }),
        el("span", { text: it.label }),
      ])
    );
  }

  document.body.append(menu);
  openMenu = menu;

  // Keep the menu inside the viewport.
  const { innerWidth: vw, innerHeight: vh } = window;
  const r = menu.getBoundingClientRect();
  const x = Math.min(ev.clientX, vw - r.width - 8);
  const y = Math.min(ev.clientY, vh - r.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  return menu;
}

export function trackMenu(ev, track, opts = {}) {
  const { tracks = [], index = 0, context, playlistId, onChange, selection } = opts;
  const targets = selection?.length ? selection : [track];
  const many = targets.length > 1;
  const artistId = artistIdOf(track);

  contextMenu(ev, [
    {
      label: many ? `Play ${targets.length} tracks` : "Play",
      icon: "play",
      onClick: () =>
        many ? player.play(targets, 0, null) : player.play(tracks, index, context),
    },
    {
      label: "Play next",
      icon: "queueNext",
      onClick: () => {
        player.addNext(targets);
        toast(many ? `${targets.length} tracks play next` : "Playing next");
      },
    },
    {
      label: "Add to queue",
      icon: "queue",
      onClick: () => {
        player.addToQueue(targets);
        toast(many ? `${targets.length} tracks queued` : "Added to queue");
      },
    },
    "sep",
    {
      label: "Add to playlist…",
      icon: "playlistAdd",
      onClick: () => addToPlaylistDialog(targets),
    },
    {
      label: track.UserData?.IsFavorite ? "Remove from favorites" : "Add to favorites",
      icon: track.UserData?.IsFavorite ? "heartFilled" : "heart",
      onClick: () => toggleFavorite(track),
    },
    {
      label: "Start radio",
      icon: "sparkle",
      onClick: async () => {
        try {
          const mix = await api.instantMix(track.Id);
          if (!mix.length) return toast("No similar tracks found", "err");
          player.play(mix, 0, { type: "mix", id: track.Id, name: `${displayName(track, "Track")} radio` });
          toast("Playing radio");
        } catch (e) {
          toast(e.message || "Could not start radio", "err");
        }
      },
    },
    "sep",
    track.AlbumId && {
      label: "Go to album",
      icon: "album",
      onClick: () => navigate(routes.album(track.AlbumId)),
    },
    artistId && {
      label: "Go to artist",
      icon: "artist",
      onClick: () => navigate(routes.artist(artistId)),
    },
    playlistId && "sep",
    playlistId && {
      label: many ? `Remove ${targets.length} from playlist` : "Remove from playlist",
      icon: "trash",
      danger: true,
      onClick: async () => {
        const entryIds = targets.map((t) => t.PlaylistItemId).filter(Boolean);
        if (!entryIds.length) return toast("Nothing to remove", "err");
        try {
          await api.removeFromPlaylist(playlistId, entryIds);
          toast(many ? `Removed ${entryIds.length} tracks` : "Removed from playlist");
          onChange?.();
        } catch (e) {
          toast(e.message || "Remove failed", "err");
        }
      },
    },
  ]);
}

export function albumMenu(ev, album) {
  contextMenu(ev, [
    {
      label: "Play",
      icon: "play",
      onClick: async () => {
        const t = await api.albumTracks(album.Id);
        player.play(t, 0, { type: "album", id: album.Id, name: album.Name });
      },
    },
    {
      label: "Shuffle",
      icon: "shuffle",
      onClick: async () => {
        const t = await api.albumTracks(album.Id);
        player.playShuffled(t, { type: "album", id: album.Id, name: album.Name });
      },
    },
    {
      label: "Play next",
      icon: "queueNext",
      onClick: async () => {
        player.addNext(await api.albumTracks(album.Id));
        toast("Album plays next");
      },
    },
    {
      label: "Add to queue",
      icon: "queue",
      onClick: async () => {
        player.addToQueue(await api.albumTracks(album.Id));
        toast("Album added to queue");
      },
    },
    "sep",
    {
      label: "Add to playlist…",
      icon: "playlistAdd",
      onClick: async () => addToPlaylistDialog(await api.albumTracks(album.Id)),
    },
    {
      label: album.UserData?.IsFavorite ? "Remove from favorites" : "Add to favorites",
      icon: album.UserData?.IsFavorite ? "heartFilled" : "heart",
      onClick: () => toggleFavorite(album),
    },
  ]);
}

export function playlistMenu(ev, pl, onChange) {
  contextMenu(ev, [
    {
      label: "Play",
      icon: "play",
      onClick: async () => {
        const t = await api.playlistItems(pl.Id);
        player.play(t, 0, { type: "playlist", id: pl.Id, name: pl.Name });
      },
    },
    {
      label: "Shuffle",
      icon: "shuffle",
      onClick: async () => {
        const t = await api.playlistItems(pl.Id);
        player.playShuffled(t, { type: "playlist", id: pl.Id, name: pl.Name });
      },
    },
    {
      label: "Add to queue",
      icon: "queue",
      onClick: async () => {
        player.addToQueue(await api.playlistItems(pl.Id));
        toast("Playlist added to queue");
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
          onChange?.();
          if (location.hash.includes(pl.Id)) navigate(routes.playlists());
        } catch (e) {
          toast(e.message || "Delete failed", "err");
        }
      },
    },
  ]);
}

/* ============================================================
   Modals
   ============================================================ */

export function modal({ title, subtitle, body, footer, onClose }) {
  const backdrop = el("div.modal-backdrop");
  const box = el("div.modal", { role: "dialog", "aria-modal": "true" });

  const head = el("div.modal-head", {}, [
    el("h2", { text: title }),
    subtitle ? el("p", { text: subtitle }) : null,
  ]);
  box.append(head);
  if (body) box.append(el("div.modal-body", {}, [body]));
  if (footer) box.append(el("div.modal-foot", {}, footer));

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);

  backdrop.append(box);
  document.body.append(backdrop);
  backdrop.close = close;
  setTimeout(() => box.querySelector("input, button")?.focus(), 40);
  return backdrop;
}

export function confirmDialog({ title, body, confirmLabel = "Confirm", danger }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };
    const m = modal({
      title,
      body: el("p", {
        text: body,
        style: { color: "var(--text-dim)", fontSize: "13.5px", margin: "0 0 6px" },
      }),
      footer: [
        el("button.btn", { text: "Cancel", onclick: () => done(false) }),
        el(`button.btn.${danger ? "danger" : "primary"}`, {
          text: confirmLabel,
          onclick: () => done(true),
        }),
      ],
      onClose: () => done(false),
    });
  });
}

/** Pick an existing playlist or create a new one, then add the given tracks. */
export async function addToPlaylistDialog(tracks) {
  const list = [].concat(tracks).filter(Boolean);
  if (!list.length) return;
  const ids = list.map((t) => t.Id);

  const bodyWrap = el("div", {}, [el("div.spinner")]);
  const m = modal({
    title: "Add to playlist",
    subtitle:
      list.length === 1
        ? displayName(list[0], "Unknown track")
        : `${list.length} tracks selected`,
    body: bodyWrap,
    footer: [el("button.btn", { text: "Cancel", onclick: () => m.close() })],
  });

  const newRow = el("div.pl-pick", {
    onclick: async () => {
      m.close();
      const name = await promptDialog({
        title: "New playlist",
        label: "Playlist name",
        placeholder: "My playlist",
        confirmLabel: "Create",
      });
      if (!name) return;
      try {
        await api.createPlaylist(name, ids);
        toast(`Created "${name}" with ${list.length} track${list.length > 1 ? "s" : ""}`);
        window.dispatchEvent(new CustomEvent("tm:playlists-changed"));
      } catch (e) {
        toast(e.message || "Could not create playlist", "err");
      }
    },
  }, [
    el("div.pl-pick-icon", { html: icons.plus }),
    el("div.pl-pick-text", {}, [
      el("div.pl-pick-name", { text: "New playlist" }),
      el("div.pl-pick-count", { text: "Create and add these tracks" }),
    ]),
  ]);

  try {
    const { items } = await api.playlists();
    clear(bodyWrap);
    bodyWrap.append(newRow);
    if (items.length) bodyWrap.append(el("div.ctx-sep"));
    for (const pl of items) {
      bodyWrap.append(
        el("div.pl-pick", {
          onclick: async () => {
            m.close();
            try {
              await api.addToPlaylist(pl.Id, ids);
              toast(`Added to "${pl.Name}"`);
              window.dispatchEvent(new CustomEvent("tm:playlists-changed"));
            } catch (e) {
              toast(e.message || "Could not add to playlist", "err");
            }
          },
        }, [
          el("div.pl-pick-icon", { html: icons.list }),
          el("div.pl-pick-text", {}, [
            el("div.pl-pick-name", { text: displayName(pl, "Untitled playlist") }),
            el("div.pl-pick-count", {
              text: pl.ChildCount != null ? fmtCount(pl.ChildCount, "track") : "",
            }),
          ]),
        ])
      );
    }
  } catch (e) {
    clear(bodyWrap);
    bodyWrap.append(newRow);
    bodyWrap.append(
      el("p", { text: e.message || "Could not load playlists", style: { color: "var(--bad)" } })
    );
  }
}

export function promptDialog({ title, label, placeholder, value = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    let settled = false;
    const input = el("input", { type: "text", placeholder, value });
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      m.close();
    };
    const submit = () => done(input.value.trim() || null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    const m = modal({
      title,
      body: el("div.field", {}, [el("label", { text: label }), input]),
      footer: [
        el("button.btn", { text: "Cancel", onclick: () => done(null) }),
        el("button.btn.primary", { text: confirmLabel, onclick: submit }),
      ],
      onClose: () => done(null),
    });
  });
}

/* ============================================================
   Toasts & states
   ============================================================ */

export function toast(message, type = "ok", ms = 2600) {
  let host = $(".toasts");
  if (!host) {
    host = el("div.toasts");
    document.body.append(host);
  }
  const t = el(`div.toast${type === "err" ? ".err" : ""}`, { text: message });
  host.append(t);
  setTimeout(() => {
    t.style.transition = "opacity .25s, transform .25s";
    t.style.opacity = "0";
    t.style.transform = "translateY(8px)";
    setTimeout(() => t.remove(), 260);
  }, ms);
}

export function emptyState(title, message, icon = "music") {
  return el("div.empty", {}, [
    el("div", { html: icons[icon] }),
    el("h3", { text: title }),
    el("p", { text: message }),
  ]);
}

export const spinner = () => el("div.spinner");

export function errorState(err, retry) {
  return el("div.empty", {}, [
    el("div", { html: icons.info }),
    el("h3", { text: "Something went wrong" }),
    el("p", { text: err?.message || String(err) }),
    retry
      ? el("div", { style: { marginTop: "16px" } }, [
          el("button.btn.primary", { text: "Retry", onclick: retry }),
        ])
      : null,
  ]);
}

/* ============================================================
   Infinite scroll
   ============================================================ */

/**
 * Calls loadMore() when the sentinel scrolls into view.
 * loadMore must resolve to false when there is nothing left.
 */
export function infiniteScroll(container, loadMore) {
  const sentinel = el("div.sentinel");
  container.append(sentinel);
  let busy = false;
  let done = false;

  const io = new IntersectionObserver(
    async (entries) => {
      if (!entries[0].isIntersecting || busy || done) return;
      busy = true;
      const loader = el("div.load-more-row", {}, [el("div.spinner.sm")]);
      container.insertBefore(loader, sentinel);
      try {
        const more = await loadMore();
        if (more === false) {
          done = true;
          io.disconnect();
          sentinel.remove();
        }
      } catch (e) {
        done = true;
        io.disconnect();
        container.insertBefore(
          el("p", {
            text: e.message || "Could not load more",
            style: { color: "var(--bad)", textAlign: "center", padding: "16px" },
          }),
          sentinel
        );
      } finally {
        loader.remove();
        busy = false;
      }
    },
    { rootMargin: "600px" }
  );
  io.observe(sentinel);
  return () => io.disconnect();
}
