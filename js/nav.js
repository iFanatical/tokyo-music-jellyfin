/* Hash routing primitives, kept in their own module so UI and views can
   navigate without importing the router (which imports them back). */

export function navigate(path, { replace = false } = {}) {
  const hash = path.startsWith("#") ? path : `#${path}`;
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, "", hash);
  else location.hash = hash;
  if (replace) window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export const routes = {
  home: () => "/home",
  albums: () => "/albums",
  artists: () => "/artists",
  songs: () => "/songs",
  genres: () => "/genres",
  genre: (id, name) => `/genre/${id}${name ? `?name=${encodeURIComponent(name)}` : ""}`,
  playlists: () => "/playlists",
  playlist: (id) => `/playlist/${id}`,
  album: (id) => `/album/${id}`,
  artist: (id) => `/artist/${id}`,
  favorites: () => "/favorites",
  search: (q) => `/search${q ? `?q=${encodeURIComponent(q)}` : ""}`,
};

/** Turns a node into a keyboard-accessible link target. */
export function linkify(node, path) {
  node.tabIndex = 0;
  node.setAttribute("role", "link");
  node.addEventListener("click", (e) => {
    e.stopPropagation();
    navigate(path);
  });
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      navigate(path);
    }
  });
  return node;
}
