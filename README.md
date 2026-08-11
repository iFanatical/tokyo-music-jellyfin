# Tokyo Music

A music-only web client for Jellyfin. No video, no TV, no "Continue Watching" —
just albums, artists, songs, playlists and a player, in the Tokyo Night
(night variant) palette.

Plain ES modules and CSS. No build step, no framework, no dependencies.

---

## Quick start

```bash
./serve.py                      # http://localhost:8097
./serve.py --port 9000          # different port
```

Open it, enter your Jellyfin address, and sign in with a password or Quick
Connect. The session is stored in `localStorage` and survives reloads.

Opening `index.html` directly off disk will **not** work — ES modules require
`http://`. Always serve it.

---

## Deploying to the Jellyfin box

The app is static and talks to Jellyfin from the browser, so it does not have to
live on the Jellyfin server — but putting it there means anything that can reach
Jellyfin can reach the app.

It is deliberately **not** installed into `/usr/share/jellyfin/web`. That
directory is root-owned and is replaced wholesale on every Jellyfin package
upgrade, which would silently delete the app. Instead it runs as its own tiny
service on port 8097.

**1. Configure** — tell the deploy script where the server is mounted locally
and which user to install as. This file is gitignored, so your hostnames stay
local:

```bash
cp deploy/config.env.example deploy/config.env
$EDITOR deploy/config.env
```

Every setting can be passed as an environment variable instead, e.g.
`MOUNT=/mnt/media REMOTE_USER=bob ./deploy/deploy.sh`.

**2. Copy the files** (from your workstation, over the mount):

```bash
./deploy/deploy.sh
```

**3. Install the service** (once, on the server, needs sudo):

```bash
ssh <user>@<jellyfin-host> 'sudo bash ~/tokyo-music/deploy/server-setup.sh'
```

Then browse to `http://<jellyfin-host>:8097`.

Updating later is just `./deploy/deploy.sh` followed by
`sudo systemctl restart tokyo-music` — or nothing at all, since files are read
per request and the server sends `Cache-Control: no-cache`.

```bash
systemctl status tokyo-music
journalctl -u tokyo-music -f
```

### Why a separate port works

Jellyfin ships `Access-Control-Allow-Origin: *`, so the browser is happy to call
`:8096` from a page served on `:8097`. Verified against 10.11.11.

### Serving over HTTPS

If you put this behind a TLS reverse proxy, Jellyfin must also be reachable over
HTTPS — a secure page cannot call a plain-HTTP API. Point both through the same
proxy.

---

## Layout

| Path | Purpose |
|---|---|
| `index.html` | Shell; loads `js/app.js` as a module |
| `css/tokyonight.css` | Palette and design tokens |
| `css/app.css` | Layout and components |
| `js/api.js` | Jellyfin client, scoped to audio |
| `js/player.js` | Audio engine: queue, shuffle, repeat, reporting |
| `js/shell.js` | Sidebar, topbar, player bar, queue panel |
| `js/ui.js` | Cards, track lists, menus, modals, toasts |
| `js/views/` | One module per screen |
| `js/router.js` | Hash routing with per-navigation `AbortController` |
| `serve.py` | Static server |
| `deploy/` | systemd unit template and install scripts |

Everything is audio-scoped at the API layer: queries are restricted to
`MusicAlbum` / `MusicArtist` / `Audio` and to your music libraries, and
playlists are filtered to `MediaType: Audio`. Video cannot appear.

---

## Features

**Browse** — Home, Albums, Artists, Songs, Genres, Favorites, Playlists, plus
album/artist/genre/playlist detail pages. Sorting is per-view and remembered.
Large lists page in on scroll.

**Play** — Persistent player bar, queue panel with drag-to-reorder, shuffle,
three repeat modes, seek, volume, and OS media-key support via the Media Session
API. Playback is reported to Jellyfin, so play counts, resume and "recently
played" stay in sync with your other clients.

**Playlists** — Create, rename, delete, add, remove, and drag to reorder.
Ctrl-click and shift-click select multiple tracks for bulk actions.

**Quality** — Streams original quality by default (FLAC direct-plays in Chrome
and Firefox). The `ORIG` chip in the player bar caps the bitrate and lets the
server transcode instead.

### Keyboard

| Key | Action |
|---|---|
| `Space` / `K` | Play or pause |
| `←` / `→` | Seek 5s (`Shift` 30s) |
| `J` / `L` | Seek 10s |
| `N` / `P` | Next / previous |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `S` / `R` | Shuffle / repeat |
| `Q` | Queue panel |
| `/` | Search |
| `?` | Shortcut list |

Mouse wheel over the volume control adjusts it in 5% steps (hold `Shift` for 2%).
Scrolling up while muted unmutes.

---

## Notes on real Jellyfin libraries

Behaviour found while testing against a live 10.11.11 server. These are the
reasons parts of the code look the way they do:

- **Jellyfin never marks albums as played.** `Filters=IsPlayed` on `MusicAlbum`
  always returns zero, even when the tracks have play counts in the hundreds.
  The "Jump back in" and "On repeat" rows are therefore built from track-level
  play data and rolled up into albums client-side.
- **Artists must come from `/Artists/AlbumArtists`.** Querying
  `IncludeItemTypes=MusicArtist` returned only 2 items on the test library,
  because artist metadata lives on the tracks rather than in dedicated artist
  folders. The aggregate endpoint returned all 270.
- **`TotalRecordCount` is not trustworthy.** Playlist queries over-report it
  (says 3, returns 1); favorite-artist queries under-report it (says 0, returns
  1). Every count shown in the UI for those views comes from the returned array
  length instead.
- **Favorite artists only surface through `/Artists/AlbumArtists`.**
  `/Items?IncludeItemTypes=MusicArtist&Filters=IsFavorite` returned nothing, for
  the same reason plain artist browsing does. The Favorites view queries both and
  merges by id, so it works either way.
- **Some albums have blank names.** Real libraries contain albums whose `Name`
  is empty or pure whitespace; they render as "Unknown album" rather than as an
  invisible title.
- An image tag is only valid for the item it belongs to — pairing a track id
  with its album's image tag returns 404. Tracks without embedded art fall back
  to the album id *and* the album's tag together.

---

## Troubleshooting

**"Could not reach …"** — Check the address includes the port (`http://<jellyfin-host>:8096`)
and that you are on the same network.

**Track won't play, format unsupported** — Chromium builds without proprietary
codecs may refuse some files. Set the quality chip to 320 kbps to force the
server to transcode to AAC.

**Signed out unexpectedly** — The token was revoked server-side (Dashboard →
Devices). Sign in again. Note that changing your Jellyfin password revokes the
tokens of *every* client, not just this one.

---

## License

Copyright (C) 2026 Aaron Bush

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE) for more
details.

Tokyo Music is an independent client and is not affiliated with or endorsed by
the Jellyfin project. The Tokyo Night palette originates from
[folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim).
