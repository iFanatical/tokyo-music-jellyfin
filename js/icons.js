/* Inline SVG icons (stroke-based, 24x24 viewBox unless noted). */

const wrap = (body, opts = {}) =>
  `<svg viewBox="0 0 24 24" fill="${opts.fill || "none"}" stroke="${
    opts.stroke || "currentColor"
  }" stroke-width="${opts.sw || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const solid = (body) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;

export const icons = {
  // Brand / nav
  wave: solid(
    '<rect x="2" y="9" width="2.6" height="6" rx="1.3"/><rect x="6.5" y="5" width="2.6" height="14" rx="1.3"/><rect x="11" y="2" width="2.6" height="20" rx="1.3"/><rect x="15.5" y="6.5" width="2.6" height="11" rx="1.3"/><rect x="20" y="10" width="2.6" height="4" rx="1.3"/>'
  ),
  home: wrap('<path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  album: wrap('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/>'),
  artist: wrap(
    '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'
  ),
  note: wrap('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="17.5" cy="16" r="2.6"/>'),
  list: wrap('<path d="M3 6h13M3 12h13M3 18h9"/><path d="M18 12v8"/><path d="M18 12l4-1.6"/>'),
  heart: wrap(
    '<path d="M20.3 5.6a5 5 0 0 0-7.1 0l-1.2 1.2-1.2-1.2a5 5 0 1 0-7.1 7.1l8.3 8.3 8.3-8.3a5 5 0 0 0 0-7.1z"/>'
  ),
  heartFilled: solid(
    '<path d="M20.3 5.6a5 5 0 0 0-7.1 0l-1.2 1.2-1.2-1.2a5 5 0 1 0-7.1 7.1l8.3 8.3 8.3-8.3a5 5 0 0 0 0-7.1z"/>'
  ),
  clock: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>'),
  genre: wrap('<path d="M4 5h16M4 12h16M4 19h10"/>'),
  shuffleNav: wrap('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>'),

  // Transport
  play: solid('<path d="M7 4.5v15a1 1 0 0 0 1.54.84l11.5-7.5a1 1 0 0 0 0-1.68L8.54 3.66A1 1 0 0 0 7 4.5z"/>'),
  pause: solid('<rect x="6" y="4" width="4.2" height="16" rx="1.3"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.3"/>'),
  prev: solid('<path d="M18 5.2v13.6a1 1 0 0 1-1.55.83L7 13.2V19a1 1 0 0 1-2 0V5a1 1 0 0 1 2 0v5.8l9.45-6.43A1 1 0 0 1 18 5.2z"/>'),
  next: solid('<path d="M6 5.2v13.6a1 1 0 0 0 1.55.83L17 13.2V19a1 1 0 0 0 2 0V5a1 1 0 0 0-2 0v5.8L7.55 4.37A1 1 0 0 0 6 5.2z"/>'),
  shuffle: wrap('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>'),
  repeat: wrap('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
  repeatOne: wrap(
    '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11.4 10.2 12.8 9.4V15" stroke-width="2.2"/>'
  ),
  volHigh: wrap('<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.8a9 9 0 0 1 0 12.4"/>'),
  volLow: wrap('<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  volMute: wrap('<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/>'),

  // Actions
  search: wrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  x: wrap('<path d="M18 6 6 18M6 6l12 12"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  check: wrap('<path d="m4 12.5 5 5L20 6.5"/>'),
  chevronLeft: wrap('<path d="m15 18-6-6 6-6"/>'),
  chevronRight: wrap('<path d="m9 18 6-6-6-6"/>'),
  dots: solid('<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>'),
  queue: wrap('<path d="M3 6h11M3 12h11M3 18h7"/><path d="M17 9v9"/><path d="m17 9 4-1.6"/>'),
  fullscreen: wrap('<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>'),
  trash: wrap('<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7"/><path d="M10 11v6M14 11v6"/>'),
  playlistAdd: wrap('<path d="M3 6h12M3 12h12M3 18h7"/><path d="M18 10v9M13.5 14.5h9"/>'),
  queueNext: wrap('<path d="M3 6h12M3 12h9M3 18h9"/><path d="M17 8v8l5-4z" fill="currentColor" stroke="none"/>'),
  logout: wrap('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/>'),
  refresh: wrap('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  sparkle: wrap('<path d="M12 3v5M12 16v5M3 12h5M16 12h5"/><path d="m6.3 6.3 3 3M14.7 14.7l3 3M17.7 6.3l-3 3M9.3 14.7l-3 3"/>'),
  disc: wrap('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/>'),
  info: wrap('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r="0.9" fill="currentColor"/>'),
  music: wrap('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="17.5" cy="16" r="2.6"/>'),
  keyboard: wrap('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>'),
};

/** Convenience: returns an <svg> element rather than a string. */
export function iconEl(name) {
  const t = document.createElement("template");
  t.innerHTML = icons[name] || "";
  return t.content.firstElementChild;
}
