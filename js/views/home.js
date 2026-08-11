/* Home: a few curated rows over the music library. */

import { api } from "./../api.js";
import { player } from "./../player.js";
import { icons } from "./../icons.js";
import { navigate, routes } from "./../nav.js";
import {
  albumCard,
  playlistCard,
  grid,
  trackList,
  spinner,
  emptyState,
  errorState,
  toast,
} from "./../ui.js";
import { el, clear, albumsFromTracks } from "./../util.js";

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function row(title, items, renderer, moreHref) {
  if (!items?.length) return null;
  const header = el("h2.section-title", {}, [el("span", { text: title })]);
  if (moreHref) {
    const more = el("button.section-more", { text: "See all" });
    more.addEventListener("click", () => navigate(moreHref));
    header.append(more);
  }
  return el("section", {}, [header, grid(items, renderer, "row-scroll")]);
}

export async function homeView(container, _params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  page.append(
    el("div.page-header", {}, [
      el("div", {}, [
        el("h1.page-title", { text: `${greeting()}, ${api.userName}` }),
        el("p.page-sub", { text: "Your music, and nothing else." }),
      ]),
      el("div.page-tools", {}, [
        el("button.btn.primary", {
          html: `${icons.shuffle}<span>Shuffle library</span>`,
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              // A random slice keeps this quick on large libraries.
              const { total } = await api.songs({ limit: 1 });
              const take = Math.min(300, total);
              const start = Math.max(
                0,
                Math.floor(Math.random() * Math.max(1, total - take))
              );
              const { items } = await api.songs({
                startIndex: start,
                limit: take,
                sortBy: "Random",
              });
              if (!items.length) return toast("No tracks found", "err");
              player.playShuffled(items, { type: "library", name: "Your library" });
            } catch (err) {
              toast(err.message || "Could not shuffle", "err");
            } finally {
              btn.disabled = false;
            }
          },
        }),
      ]),
    ])
  );

  const body = el("div", {}, [spinner()]);
  page.append(body);

  try {
    const [recentAdded, recentPlayed, frequent, playlists] = await Promise.all([
      api.recentlyAdded(20, signal).catch(() => ({ items: [] })),
      api.recentlyPlayedTracks(60, signal).catch(() => ({ items: [] })),
      api.frequentlyPlayedTracks(12, signal).catch(() => ({ items: [] })),
      api.playlists(signal).catch(() => ({ items: [] })),
    ]);
    if (signal?.aborted) return;

    clear(body);

    // Recent listening is track-level; roll it up into the albums it came from.
    const recentAlbums = albumsFromTracks(recentPlayed.items, 20);

    const onRepeat = frequent.items.length
      ? el("section", {}, [
          el("h2.section-title", {}, [el("span", { text: "On repeat" })]),
          trackList(frequent.items.slice(0, 8), {
            context: { type: "on-repeat", name: "On repeat" },
            showArt: true,
            numbering: "index",
          }),
        ])
      : null;

    const sections = [
      row("Jump back in", recentAlbums, albumCard),
      row("Recently added", recentAdded.items, albumCard, routes.albums()),
      onRepeat,
      row("Your playlists", playlists.items, playlistCard, routes.playlists()),
    ].filter(Boolean);

    if (!sections.length) {
      body.append(
        emptyState(
          "No music found",
          "This Jellyfin account has no music libraries, or the library is still scanning."
        )
      );
      return;
    }
    sections.forEach((s) => body.append(s));
  } catch (e) {
    if (signal?.aborted) return;
    clear(body);
    body.append(errorState(e, () => homeView(container, _params, signal)));
  }
}
