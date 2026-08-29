/* App chrome: sidebar, topbar, player bar and queue panel. */

import { api } from "./api.js";
import { player } from "./player.js";
import { icons } from "./icons.js";
import { navigate, routes, linkify } from "./nav.js";
import {
  artBox,
  toggleFavorite,
  contextMenu,
  trackMenu,
  toast,
} from "./ui.js";
import {
  el,
  $,
  $$,
  clear,
  fmtTime,
  artistsOf,
  artistIdOf,
  debounce,
  displayName,
} from "./util.js";

/* ============================================================
   Range control (seek + volume)
   ============================================================ */

function rangeControl({ onInput, onCommit, label }) {
  const fill = el("div.range-fill");
  const buffer = el("div.range-buffer");
  const thumb = el("div.range-thumb");
  const track = el("div.range-track", {}, [buffer, fill]);
  const root = el("div.range", {
    role: "slider",
    tabindex: "0",
    "aria-label": label,
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  }, [track, thumb]);

  let dragging = false;

  const ratioFromEvent = (e) => {
    const r = root.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  root.addEventListener("pointerdown", (e) => {
    dragging = true;
    root.classList.add("dragging");
    root.setPointerCapture(e.pointerId);
    const v = ratioFromEvent(e);
    root.setValue(v);
    onInput?.(v);
  });

  root.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const v = ratioFromEvent(e);
    root.setValue(v);
    onInput?.(v);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("dragging");
    const v = ratioFromEvent(e);
    root.setValue(v);
    onCommit?.(v);
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);

  root.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    let v = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") v = root.value + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") v = root.value - step;
    else if (e.key === "Home") v = 0;
    else if (e.key === "End") v = 1;
    if (v === null) return;
    e.preventDefault();
    v = Math.max(0, Math.min(1, v));
    root.setValue(v);
    onCommit?.(v);
  });

  root.value = 0;
  root.isDragging = () => dragging;
  root.setValue = (v) => {
    root.value = v;
    const pct = `${v * 100}%`;
    fill.style.width = pct;
    thumb.style.left = pct;
    root.setAttribute("aria-valuenow", String(Math.round(v * 100)));
  };
  root.setBuffer = (v) => {
    buffer.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
  };
  return root;
}

/* ============================================================
   Sidebar
   ============================================================ */

const NAV = [
  { id: "home", label: "Home", icon: "home", href: routes.home() },
  { id: "albums", label: "Albums", icon: "album", href: routes.albums() },
  { id: "artists", label: "Artists", icon: "artist", href: routes.artists() },
  { id: "songs", label: "Songs", icon: "note", href: routes.songs() },
  { id: "genres", label: "Genres", icon: "genre", href: routes.genres() },
];

const NAV2 = [
  { id: "favorites", label: "Favorites", icon: "heart", href: routes.favorites() },
  { id: "playlists", label: "Playlists", icon: "list", href: routes.playlists() },
];

export function buildSidebar({ onLogout }) {
  const navEl = el("nav.nav");
  const items = new Map();

  const addItem = (spec) => {
    const node = el("a.nav-item", { href: `#${spec.href}` }, [
      el("span.nav-icon", { html: icons[spec.icon] }),
      el("span.nav-label", { text: spec.label }),
    ]);
    items.set(spec.id, node);
    navEl.append(node);
  };

  NAV.forEach(addItem);
  navEl.append(el("div.nav-heading", { text: "Library" }));
  NAV2.forEach(addItem);

  const plList = el("div.sidebar-playlists");

  // The initial stays in the DOM as the layer underneath: if the user has no
  // Jellyfin avatar, or the image fails, it is simply what shows through. Same
  // stacking idea as .art / .art-fallback for album covers.
  const avatar = el("div.user-avatar", {
    text: (api.userName || "?")[0].toUpperCase(),
  });

  const showAvatarImage = (url) => {
    if (!url || avatar.querySelector("img")) return;
    const img = el("img", { alt: "", decoding: "async", src: url });
    img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
    img.addEventListener("error", () => img.remove(), { once: true });
    avatar.append(img);
  };

  showAvatarImage(api.avatarUrl());
  // A session restored from localStorage may not know the tag yet; fetch it once
  // and fill the picture in when it arrives.
  if (api.userImageTag === null) {
    api.loadUserImageTag().then(() => showAvatarImage(api.avatarUrl()));
  }

  const userChip = el("button.user-chip", {
    onclick: (e) =>
      contextMenu(e, [
        {
          label: `Signed in as ${api.userName}`,
          icon: "artist",
          onClick: () => {},
        },
        "sep",
        {
          label: "Keyboard shortcuts",
          icon: "keyboard",
          onClick: () => window.dispatchEvent(new CustomEvent("tm:shortcuts")),
        },
        {
          label: "Reload library",
          icon: "refresh",
          onClick: () => window.dispatchEvent(new CustomEvent("tm:refresh")),
        },
        "sep",
        { label: "Sign out", icon: "logout", danger: true, onClick: onLogout },
      ]),
  }, [
    avatar,
    el("span", { text: api.userName || "Account" }),
  ]);

  const root = el("aside.sidebar", {}, [
    el("div.brand", {}, [
      el("div.brand-mark", { html: icons.wave }),
      el("span", { text: "Tokyo Music" }),
    ]),
    navEl,
    el("div.nav-heading", { text: "Playlists" }),
    plList,
    el("div.sidebar-foot", {}, [userChip]),
  ]);

  root.setActive = (id) => {
    items.forEach((node, key) => node.classList.toggle("active", key === id));
  };

  root.loadPlaylists = async () => {
    try {
      const { items: pls } = await api.playlists();
      clear(plList);
      if (!pls.length) {
        plList.append(
          el("div.sidebar-pl", {
            style: { color: "var(--text-faint)", cursor: "default" },
          }, [el("span", { text: "No playlists yet" })])
        );
        return;
      }
      for (const pl of pls) {
        const node = el("div.sidebar-pl", { title: displayName(pl, "Untitled playlist") }, [
          el("span.sidebar-pl-icon", { html: icons.list }),
          el("span", { text: displayName(pl, "Untitled playlist") }),
        ]);
        node.dataset.id = pl.Id;
        linkify(node, routes.playlist(pl.Id));
        plList.append(node);
      }
    } catch {
      /* sidebar playlists are non-critical */
    }
  };

  root.markActivePlaylist = (id) => {
    $$(".sidebar-pl", plList).forEach((n) =>
      n.classList.toggle("active", n.dataset.id === id)
    );
  };

  return root;
}

/* ============================================================
   Topbar
   ============================================================ */

export function buildTopbar() {
  const back = el("button.icon-btn", {
    html: icons.chevronLeft,
    title: "Back",
    onclick: () => history.back(),
  });
  const fwd = el("button.icon-btn", {
    html: icons.chevronRight,
    title: "Forward",
    onclick: () => history.forward(),
  });

  const input = el("input", {
    type: "search",
    placeholder: "Search songs, albums, artists…",
    "aria-label": "Search",
    spellcheck: "false",
  });

  const clearBtn = el("button.clear-search", {
    html: icons.x,
    title: "Clear",
    onclick: () => {
      input.value = "";
      box.classList.remove("has-value");
      input.focus();
      if (location.hash.startsWith("#/search")) navigate(routes.search(""));
    },
  });

  const box = el("div.searchbox", {}, [
    el("span", { html: icons.search }),
    input,
    clearBtn,
  ]);

  const run = debounce((v) => {
    navigate(routes.search(v), { replace: location.hash.startsWith("#/search") });
  }, 320);

  input.addEventListener("input", () => {
    const v = input.value.trim();
    box.classList.toggle("has-value", Boolean(input.value));
    if (v.length >= 2) run(v);
    else run.cancel();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      run.cancel();
      const v = input.value.trim();
      if (v) navigate(routes.search(v));
    }
    if (e.key === "Escape") input.blur();
  });

  const root = el("header.topbar", {}, [
    el("div.histnav", {}, [back, fwd]),
    box,
    el("div.topbar-spacer"),
  ]);

  root.focusSearch = () => {
    input.focus();
    input.select();
  };
  root.setSearchValue = (v) => {
    if (input.value !== v) {
      input.value = v;
      box.classList.toggle("has-value", Boolean(v));
    }
  };
  return root;
}

/* ============================================================
   Player bar
   ============================================================ */

export function buildPlayerBar({ onToggleQueue, onToggleFullscreen }) {
  /* --- now playing --- */
  const artWrap = el("div.np-art");
  const title = el("div.np-title", { text: "Nothing playing" });
  const artist = el("div.np-artist", { text: "—" });
  const favBtn = el("button.icon-btn.ghost.fav", {
    html: icons.heart,
    title: "Add to favorites",
    disabled: true,
  });

  const nowPlaying = el("div.now-playing", {}, [
    artWrap,
    el("div.np-text", {}, [title, artist]),
    favBtn,
  ]);

  /* --- transport --- */
  const shuffleBtn = el("button.icon-btn", {
    html: icons.shuffle,
    title: "Shuffle",
    onclick: () => player.toggleShuffle(),
  });
  const prevBtn = el("button.icon-btn", {
    html: icons.prev,
    title: "Previous",
    onclick: () => player.prev(),
  });
  const playBtn = el("button.btn-play", {
    html: icons.play,
    title: "Play",
    onclick: () => player.toggle(),
  });
  const nextBtn = el("button.icon-btn", {
    html: icons.next,
    title: "Next",
    onclick: () => player.next(),
  });
  const repeatBtn = el("button.icon-btn", {
    html: icons.repeat,
    title: "Repeat off",
    onclick: () => player.cycleRepeat(),
  });

  const curTime = el("div.time", { text: "0:00" });
  const durTime = el("div.time.right", { text: "0:00" });

  const seek = rangeControl({
    label: "Seek",
    onInput: (v) => {
      curTime.textContent = fmtTime(v * (player.duration || 0));
    },
    onCommit: (v) => player.seek(v * (player.duration || 0)),
  });

  const center = el("div.player-center", {}, [
    el("div.transport", {}, [shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn]),
    el("div.seek-row", {}, [curTime, seek, durTime]),
  ]);

  /* --- right side --- */
  const qualityTag = el("button.bitrate-tag", {
    text: "ORIG",
    title: "Streaming quality",
    onclick: (e) =>
      contextMenu(e, [
        { label: "Original quality", icon: "check", onClick: () => setQuality(0) },
        { label: "320 kbps", icon: "note", onClick: () => setQuality(320000) },
        { label: "192 kbps", icon: "note", onClick: () => setQuality(192000) },
        { label: "128 kbps", icon: "note", onClick: () => setQuality(128000) },
      ]),
  });

  function setQuality(bps) {
    player.setMaxBitrate(bps);
    toast(bps ? `Streaming at ${bps / 1000} kbps` : "Streaming original quality");
  }

  const volBtn = el("button.icon-btn.ghost", {
    html: icons.volHigh,
    title: "Mute",
    onclick: () => player.toggleMute(),
  });
  const vol = rangeControl({
    label: "Volume",
    onInput: (v) => player.setVolume(v),
    onCommit: (v) => player.setVolume(v),
  });
  vol.setValue(player.muted ? 0 : player.volume);

  const queueBtn = el("button.icon-btn.ghost", {
    html: icons.queue,
    title: "Queue (Q)",
    onclick: onToggleQueue,
  });

  const fullscreenBtn = el("button.icon-btn.ghost", {
    html: icons.fullscreen,
    title: "Fullscreen player (F)",
    "aria-label": "Fullscreen player",
    onclick: onToggleFullscreen,
  });

  const volWrap = el("div.volume-wrap", {}, [volBtn, vol]);

  /* Wheel over the volume cluster nudges the level. passive:false is required
     so the page behind the player bar does not scroll at the same time. */
  volWrap.addEventListener(
    "wheel",
    (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.02 : 0.05;
      const from = player.muted ? 0 : player.volume;
      player.setVolume(from + (e.deltaY < 0 ? step : -step));
    },
    { passive: false }
  );

  const right = el("div.player-right", {}, [
    qualityTag,
    fullscreenBtn,
    queueBtn,
    volWrap,
  ]);

  const root = el("footer.player", {}, [nowPlaying, center, right]);

  /* --- reactive wiring --- */

  function renderTrack() {
    const t = player.current;
    clear(artWrap);

    if (!t) {
      title.textContent = "Nothing playing";
      artist.textContent = "—";
      favBtn.disabled = true;
      favBtn.innerHTML = icons.heart;
      favBtn.classList.remove("on");
      seek.setValue(0);
      seek.setBuffer(0);
      curTime.textContent = "0:00";
      durTime.textContent = "0:00";
      artWrap.append(el("div.art-fallback", { html: icons.music }));
      return;
    }

    const art = artBox(t, { size: 160, cls: "np-art-inner" });
    art.style.width = "100%";
    art.style.height = "100%";
    art.style.margin = "0";
    art.style.borderRadius = "0";
    artWrap.append(art);
    if (t.AlbumId) {
      artWrap.onclick = () => navigate(routes.album(t.AlbumId));
      artWrap.style.cursor = "pointer";
      artWrap.title = "Go to album";
    } else {
      artWrap.onclick = null;
      artWrap.style.cursor = "default";
    }

    title.textContent = displayName(t, "Unknown track");
    title.title = displayName(t, "Unknown track");
    artist.textContent = artistsOf(t) || "Unknown artist";
    artist.title = artistsOf(t) || "";

    const aid = artistIdOf(t);
    artist.style.cursor = aid ? "pointer" : "default";
    artist.onclick = aid ? () => navigate(routes.artist(aid)) : null;

    const fav = Boolean(t.UserData?.IsFavorite);
    favBtn.disabled = false;
    favBtn.innerHTML = fav ? icons.heartFilled : icons.heart;
    favBtn.classList.toggle("on", fav);
    favBtn.onclick = () => toggleFavorite(t, favBtn);

    durTime.textContent = fmtTime(player.duration);
    document.title = `${displayName(t, "Unknown track")} — ${artistsOf(t)} · Tokyo Music`;
  }

  function renderState() {
    const playing = player.isPlaying;
    playBtn.innerHTML = playing ? icons.pause : icons.play;
    playBtn.title = playing ? "Pause" : "Play";

    shuffleBtn.classList.toggle("on", player.shuffle);
    shuffleBtn.title = player.shuffle ? "Shuffle on" : "Shuffle off";

    repeatBtn.innerHTML =
      player.repeat === "one" ? icons.repeatOne : icons.repeat;
    repeatBtn.classList.toggle("on", player.repeat !== "none");
    repeatBtn.title =
      player.repeat === "one"
        ? "Repeat one"
        : player.repeat === "all"
        ? "Repeat all"
        : "Repeat off";

    const q = player.maxBitrate;
    qualityTag.textContent = q ? `${q / 1000}K` : "ORIG";
    qualityTag.className = `bitrate-tag ${q ? "transcode" : "lossless"}`;
    qualityTag.title = q
      ? `Transcoding to ${q / 1000} kbps`
      : "Streaming original quality";

    const empty = !player.current;
    [prevBtn, nextBtn, playBtn].forEach((b) => (b.disabled = empty));
    document.querySelector(".app")?.setAttribute("data-playing", String(playing));
    if (!player.current) document.title = "Tokyo Music";
  }

  function renderVolume() {
    if (!vol.isDragging()) vol.setValue(player.muted ? 0 : player.volume);
    const v = player.muted ? 0 : player.volume;
    volBtn.innerHTML = v === 0 ? icons.volMute : v < 0.5 ? icons.volLow : icons.volHigh;
    volBtn.title = player.muted ? "Unmute" : "Mute";
  }

  player.on("track", () => {
    renderTrack();
    renderState();
  });
  player.on("state", renderState);
  player.on("queue", renderState);
  player.on("volume", renderVolume);
  player.on("time", ({ position, duration }) => {
    if (!seek.isDragging()) {
      seek.setValue(duration ? position / duration : 0);
      curTime.textContent = fmtTime(position);
    }
    durTime.textContent = fmtTime(duration);
  });
  player.on("buffer", ({ buffered, duration }) => {
    seek.setBuffer(duration ? buffered / duration : 0);
  });
  player.on("error", ({ message }) => toast(message, "err"));

  renderTrack();
  renderState();
  renderVolume();
  return root;
}

/* ============================================================
   Fullscreen player
   ============================================================ */

export function buildFullscreenPlayer() {
  const art = el("div.fullscreen-art");
  const title = el("div.fullscreen-title", { text: "Nothing playing" });
  const artist = el("div.fullscreen-artist", { text: "—" });
  const playBtn = el("button.btn-play.fullscreen-play", {
    html: icons.play,
    title: "Play",
    onclick: () => player.toggle(),
  });
  const curTime = el("div.time", { text: "0:00" });
  const durTime = el("div.time.right", { text: "0:00" });
  const seek = rangeControl({
    label: "Seek",
    onInput: (v) => {
      curTime.textContent = fmtTime(v * (player.duration || 0));
    },
    onCommit: (v) => player.seek(v * (player.duration || 0)),
  });

  const controls = el("div.fullscreen-controls", {}, [
    el("div.fullscreen-track", {}, [title, artist]),
    el("div.fullscreen-transport", {}, [
      el("button.icon-btn", {
        html: icons.prev,
        title: "Previous",
        onclick: () => player.prev(),
      }),
      playBtn,
      el("button.icon-btn", {
        html: icons.next,
        title: "Next",
        onclick: () => player.next(),
      }),
    ]),
    el("div.fullscreen-seek.seek-row", {}, [curTime, seek, durTime]),
  ]);
  const root = el("div.fullscreen-player", { hidden: true }, [art, controls]);
  let hideTimer = 0;

  function renderTrack() {
    const t = player.current;
    clear(art);
    title.textContent = t ? displayName(t, "Unknown track") : "Nothing playing";
    artist.textContent = t ? artistsOf(t) || "Unknown artist" : "—";
    if (!t) return;

    const url = api.bestImageUrl(t, { size: 1600 });
    if (url) {
      const alt = `Album art for ${displayName(t, "current track")}`;
      art.append(
        el("div.fullscreen-ambient", {}, [el("img", { src: url, alt: "" })]),
        el("div.fullscreen-art-stage", {}, [
          el("div.fullscreen-art-glow", {}, [el("img", { src: url, alt: "" })]),
          el("img.fullscreen-art-main", { src: url, alt }),
          el("div.fullscreen-art-reflection", {}, [
            el("img", { src: url, alt: "" }),
          ]),
        ])
      );
    } else {
      art.append(el("div.fullscreen-art-fallback", { html: icons.music }));
    }
    durTime.textContent = fmtTime(player.duration);
  }

  function renderState() {
    const playing = player.isPlaying;
    playBtn.innerHTML = playing ? icons.pause : icons.play;
    playBtn.title = playing ? "Pause" : "Play";
  }

  function showControls() {
    root.classList.remove("idle");
    clearTimeout(hideTimer);
    if (document.fullscreenElement === root) {
      hideTimer = window.setTimeout(() => {
        root.classList.add("idle");
      }, 2500);
    }
  }

  root.addEventListener("pointermove", showControls);
  root.addEventListener("pointerdown", showControls);
  root.addEventListener("keydown", showControls);
  controls.addEventListener("focusin", showControls);
  controls.addEventListener("focusout", showControls);

  document.addEventListener("fullscreenchange", () => {
    const active = document.fullscreenElement === root;
    root.hidden = !active;
    root.classList.remove("idle");
    clearTimeout(hideTimer);
    if (active) showControls();
  });

  root.toggle = async () => {
    if (document.fullscreenElement === root) {
      await document.exitFullscreen();
      return;
    }
    if (!player.current) {
      toast("Play a song before entering fullscreen");
      return;
    }
    renderTrack();
    renderState();
    root.hidden = false;
    try {
      await root.requestFullscreen();
    } catch {
      root.hidden = true;
      toast("Fullscreen is unavailable", "err");
    }
  };

  player.on("track", renderTrack);
  player.on("state", renderState);
  player.on("time", ({ position, duration }) => {
    if (!seek.isDragging()) {
      seek.setValue(duration ? position / duration : 0);
      curTime.textContent = fmtTime(position);
    }
    durTime.textContent = fmtTime(duration);
  });

  renderTrack();
  renderState();
  return root;
}

/* ============================================================
   Queue panel
   ============================================================ */

export function buildQueuePanel() {
  const scroll = el("div.queue-scroll");
  const subtitle = el("div", {
    style: { fontSize: "12px", color: "var(--text-muted)" },
  });

  const root = el("aside.queue-panel", {}, [
    el("div.queue-head", {}, [
      el("div", {}, [el("h3", { text: "Queue" }), subtitle]),
      el("div", { style: { marginLeft: "auto", display: "flex", gap: "2px" } }, [
        el("button.icon-btn.ghost", {
          html: icons.trash,
          title: "Clear queue",
          onclick: () => {
            player.clearQueue();
            toast("Queue cleared");
          },
        }),
        el("button.icon-btn.ghost", {
          html: icons.x,
          title: "Close",
          onclick: () =>
            document.querySelector(".app")?.setAttribute("data-queue", "closed"),
        }),
      ]),
    ]),
    scroll,
  ]);

  function qRow(track, i) {
    const isCurrent = i === player.index;
    const row = el("div.qitem", {
      class: isCurrent ? "current" : "",
      title: displayName(track, "Unknown track"),
      onclick: () => player.jumpTo(i),
      oncontextmenu: (e) => trackMenu(e, track, { tracks: player.queue, index: i }),
    }, [
      artBox(track, { size: 80, cls: "qitem-art" }),
      el("div.qitem-text", {}, [
        el("div.qitem-title", { text: displayName(track, "Unknown track") }),
        el("div.qitem-artist", { text: artistsOf(track) }),
      ]),
      el("button.qitem-remove", {
        html: icons.x,
        title: "Remove from queue",
        onclick: (e) => {
          e.stopPropagation();
          player.removeAt(i);
        },
      }),
    ]);

    /* Drag to reorder the queue. */
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      $$(".qitem", scroll).forEach((r) =>
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
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData("text/plain"));
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      let to = after ? i + 1 : i;
      if (from < to) to--;
      row.classList.remove("drop-before", "drop-after");
      if (!Number.isNaN(from) && from !== to) player.moveInQueue(from, to);
    });

    return row;
  }

  function render() {
    const q = player.queue;
    clear(scroll);

    subtitle.textContent = player.context?.name
      ? `From ${player.context.name}`
      : q.length
      ? `${q.length} track${q.length > 1 ? "s" : ""}`
      : "";

    if (!q.length) {
      scroll.append(
        el("div.empty", { style: { padding: "40px 12px" } }, [
          el("div", { html: icons.queue }),
          el("h3", { text: "Queue is empty" }),
          el("p", { text: "Play something to get started." }),
        ])
      );
      return;
    }

    if (player.index >= 0) {
      scroll.append(el("div.queue-section", { text: "Now playing" }));
      scroll.append(qRow(q[player.index], player.index));
    }

    const upcoming = q.slice(player.index + 1);
    if (upcoming.length) {
      scroll.append(el("div.queue-section", { text: "Next up" }));
      upcoming.forEach((t, n) => scroll.append(qRow(t, player.index + 1 + n)));
    }

    const history = q.slice(0, Math.max(0, player.index));
    if (history.length) {
      scroll.append(el("div.queue-section", { text: "Played" }));
      history.forEach((t, n) => scroll.append(qRow(t, n)));
    }
  }

  player.on("queue", render);
  player.on("track", render);
  render();
  return root;
}
