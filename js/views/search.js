/* Search across songs, albums and artists — audio only. */

import { api } from "./../api.js";
import {
  albumCard,
  artistCard,
  grid,
  trackList,
  spinner,
  emptyState,
  errorState,
} from "./../ui.js";
import { el, clear } from "./../util.js";

export async function searchView(container, params, signal) {
  clear(container);
  const page = el("div.page");
  container.append(page);

  const term = (params.query?.q || "").trim();

  if (!term) {
    page.append(
      emptyState(
        "Search your library",
        "Find songs, albums and artists. Press / anywhere to jump to the search box.",
        "search"
      )
    );
    return;
  }

  page.append(
    el("div.page-header", {}, [
      el("div", {}, [
        el("h1.page-title", { text: `Results for “${term}”` }),
        el("p.page-sub", { text: "Searching…" }),
      ]),
    ])
  );

  const body = el("div", {}, [spinner()]);
  page.append(body);

  try {
    const { songs, albums, artists } = await api.search(term, 24, signal);
    if (signal?.aborted) return;
    clear(body);

    const counts = [
      songs.length ? `${songs.length} song${songs.length > 1 ? "s" : ""}` : null,
      albums.length ? `${albums.length} album${albums.length > 1 ? "s" : ""}` : null,
      artists.length ? `${artists.length} artist${artists.length > 1 ? "s" : ""}` : null,
    ].filter(Boolean);

    page.querySelector(".page-sub").textContent = counts.length
      ? counts.join(" · ")
      : "No matches";

    if (!songs.length && !albums.length && !artists.length) {
      body.append(
        emptyState(
          "No results",
          `Nothing in your music library matches “${term}”.`,
          "search"
        )
      );
      return;
    }

    if (artists.length) {
      body.append(el("h2.section-title", {}, [el("span", { text: "Artists" })]));
      body.append(grid(artists, artistCard, "grid artists"));
    }
    if (albums.length) {
      body.append(el("h2.section-title", {}, [el("span", { text: "Albums" })]));
      body.append(grid(albums, albumCard));
    }
    if (songs.length) {
      body.append(el("h2.section-title", {}, [el("span", { text: "Songs" })]));
      body.append(
        trackList(songs, {
          context: { type: "search", id: term, name: `Search: ${term}` },
          numbering: "index",
        })
      );
    }
  } catch (e) {
    if (signal?.aborted) return;
    clear(body);
    body.append(errorState(e, () => searchView(container, params, signal)));
  }
}
