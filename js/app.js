/* Bootstrap: mounts either the login screen or the app shell, then wires
   global events and keyboard shortcuts. */

import { api } from "./api.js";
import { player } from "./player.js";
import { icons } from "./icons.js";
import { Router } from "./router.js";
import { loginScreen } from "./login.js";
import { initPwa } from "./pwa.js";
import {
  buildSidebar,
  buildTopbar,
  buildPlayerBar,
  buildFullscreenPlayer,
  buildQueuePanel,
} from "./shell.js";
import { modal, toast, closeMenu } from "./ui.js";
import { el, $, clear } from "./util.js";

const root = document.getElementById("root");

/** Message carried across the reload in showLogin(), shown on the sign-in card. */
const SS_LOGIN_NOTICE = "tokyomusic.loginNotice";

let appStarted = false;

/* ============================================================
   Login
   ============================================================ */

function showLogin(notice = "") {
  // startApp() wires global listeners (keyboard, router, player events) that
  // have no teardown, so once it has run a fresh page load is the only clean
  // slate; starting the shell twice in one page doubles every shortcut.
  if (appStarted) {
    try {
      if (notice) sessionStorage.setItem(SS_LOGIN_NOTICE, notice);
    } catch {
      /* storage blocked; the notice is a nicety */
    }
    location.reload();
    return;
  }
  clear(root);
  root.append(loginScreen(() => startApp(), notice));
}

function takeLoginNotice() {
  try {
    const notice = sessionStorage.getItem(SS_LOGIN_NOTICE) || "";
    sessionStorage.removeItem(SS_LOGIN_NOTICE);
    return notice;
  } catch {
    return "";
  }
}

/* ============================================================
   App
   ============================================================ */

function startApp() {
  appStarted = true;
  clear(root);

  const app = el("div.app", { dataset: { queue: "closed", playing: "false" } });
  const content = el("main.content", { id: "content" });

  const sidebar = buildSidebar({
    onLogout: async () => {
      player.stop();
      player.clearSavedQueue();
      await api.logout();
      showLogin();
    },
  });

  const topbar = buildTopbar();
  const main = el("div.main", {}, [topbar, content]);
  const queuePanel = buildQueuePanel();

  const toggleQueue = () => {
    const open = app.dataset.queue === "open";
    app.dataset.queue = open ? "closed" : "open";
  };

  const fullscreenPlayer = buildFullscreenPlayer();
  const playerBar = buildPlayerBar({
    onToggleQueue: toggleQueue,
    onToggleFullscreen: () => fullscreenPlayer.toggle(),
  });

  app.append(sidebar, main, queuePanel, playerBar, fullscreenPlayer);
  root.append(app);

  /* Topbar shadow once the page is scrolled. */
  content.addEventListener("scroll", () => {
    topbar.classList.toggle("scrolled", content.scrollTop > 4);
  });

  const router = new Router(content, {
    onRouteChange: (id, { path, query }) => {
      sidebar.setActive(id);
      sidebar.markActivePlaylist(
        path.startsWith("/playlist/") ? path.split("/")[2] : null
      );
      topbar.setSearchValue(path === "/search" ? query.q || "" : "");
      closeMenu();
    },
  });

  sidebar.loadPlaylists();
  router.start();
  player.restoreQueue();

  /* ---------------- global events ---------------- */

  window.addEventListener("tm:playlists-changed", () => {
    sidebar.loadPlaylists();
  });

  window.addEventListener("tm:refresh", () => {
    sidebar.loadPlaylists();
    router.refresh();
    toast("Refreshed");
  });

  window.addEventListener("tm:shortcuts", showShortcuts);

  window.addEventListener("tm:unauthorized", () => {
    // Pause rather than stop: the saved queue survives for the next sign-in.
    player.pause();
    showLogin("Your session expired. Please sign in again.");
  });

  /* ---------------- keyboard ---------------- */

  const typing = (e) => {
    const t = e.target;
    return (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      t?.isContentEditable
    );
  };

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "/" && !typing(e)) {
      e.preventDefault();
      topbar.focusSearch();
      return;
    }
    if (typing(e)) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        player.toggle();
        break;
      case "k":
      case "K":
        player.toggle();
        break;
      case "ArrowRight":
        e.preventDefault();
        player.seekBy(e.shiftKey ? 30 : 5);
        break;
      case "ArrowLeft":
        e.preventDefault();
        player.seekBy(e.shiftKey ? -30 : -5);
        break;
      case "l":
      case "L":
        player.seekBy(10);
        break;
      case "j":
      case "J":
        player.seekBy(-10);
        break;
      case "ArrowUp":
        e.preventDefault();
        player.setVolume(player.volume + (e.shiftKey ? 0.0025 : 0.01));
        break;
      case "ArrowDown":
        e.preventDefault();
        player.setVolume(player.volume - (e.shiftKey ? 0.0025 : 0.01));
        break;
      case "n":
      case "N":
        player.next();
        break;
      case "p":
      case "P":
        player.prev();
        break;
      case "s":
      case "S":
        player.toggleShuffle();
        toast(player.shuffle ? "Shuffle on" : "Shuffle off");
        break;
      case "r":
      case "R":
        player.cycleRepeat();
        toast(
          player.repeat === "one"
            ? "Repeat one"
            : player.repeat === "all"
            ? "Repeat all"
            : "Repeat off"
        );
        break;
      case "m":
      case "M":
        player.toggleMute();
        break;
      case "q":
      case "Q":
        toggleQueue();
        break;
      case "f":
      case "F":
        if (e.repeat) break;
        fullscreenPlayer.toggle();
        break;
      case "y":
      case "Y":
        if (e.repeat) break;
        fullscreenPlayer.toggleLyrics();
        break;
      case "?":
        showShortcuts();
        break;
      default:
        break;
    }
  });
}

/* ============================================================
   Shortcuts sheet
   ============================================================ */

const SHORTCUTS = [
  ["Space / K", "Play or pause"],
  ["← / →", "Seek 5 seconds (Shift: 30)"],
  ["J / L", "Seek 10 seconds"],
  ["N / P", "Next / previous track"],
  ["↑ / ↓", "Volume"],
  ["Wheel over volume", "Adjust volume (Shift: finer)"],
  ["M", "Mute"],
  ["S", "Shuffle"],
  ["R", "Repeat mode"],
  ["Q", "Toggle queue"],
  ["F", "Toggle fullscreen player"],
  ["Y", "Lyrics in the fullscreen player"],
  ["/", "Search"],
  ["Ctrl-click", "Select multiple tracks"],
  ["Shift-click", "Select a range of tracks"],
  ["Right-click", "Context menu"],
  ["?", "This help"],
];

function showShortcuts() {
  const rows = SHORTCUTS.map(([k, d]) =>
    el("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        gap: "18px",
        padding: "7px 0",
        borderBottom: "1px solid var(--border)",
      },
    }, [
      el("kbd", {
        text: k,
        style: {
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          color: "var(--accent)",
          whiteSpace: "nowrap",
        },
      }),
      el("span", {
        text: d,
        style: { fontSize: "13px", color: "var(--text-dim)", textAlign: "right" },
      }),
    ])
  );

  const m = modal({
    title: "Keyboard shortcuts",
    body: el("div", {}, rows),
    footer: [el("button.btn.primary", { text: "Got it", onclick: () => m.close() })],
  });
}

/* ============================================================
   Go
   ============================================================ */

initPwa();

if (api.isAuthed) {
  // Re-resolve music libraries in the background; the cached ids may be stale.
  api.loadViews().catch(() => {});
  startApp();
} else {
  showLogin(takeLoginNotice());
}
