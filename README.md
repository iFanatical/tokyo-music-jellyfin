# Tokyo Music

<img width="1878" height="901" alt="image" src="https://github.com/user-attachments/assets/5e6097e9-4cf1-4f17-85b0-4590f93c3fda" />

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
| `tools/` | tag maintenance script |

Everything is audio-scoped at the API layer: queries are restricted to
`MusicAlbum` / `MusicArtist` / `Audio` and to your music libraries, and
playlists are filtered to `MediaType: Audio`. Video cannot appear.

## Importing new music

`tools/import-music.py` provides a repeatable inbox-to-library workflow. It
reads embedded tags, normalises conservative multi-artist conventions, rejects
missing or conflicting metadata, and plans an `Artist/Album/original-file`
destination. A multi-artist compilation with no album artist is filed under
`Various Artists` without changing its deliberately empty `ALBUMARTIST` tag.

It is always a dry run first:

```bash
tools/import-music.py ~/Music/inbox
```

Review every destination, then copy and verify the files and ask Jellyfin to
scan. Put the token in the environment rather than the command line so it does
not appear in shell history:

```bash
export JELLYFIN_TOKEN='<api-key>'
tools/import-music.py ~/Music/inbox --apply \
  --jellyfin-url http://jellyfin.bush.home.arpa:8096
```

The library defaults to `/mnt/servers/jellyfin/srv/music/library`; override it
with `--library`. Add `--move` only when you want successfully verified source
files removed. Existing destinations, filename collisions, unreadable files,
and missing `ARTIST`, `ALBUM`, or `TITLE` tags abort the whole import before it
writes anything. Use `--canonical canonical.json` for established spelling
corrections and `--fix-encoding` for the same conservative encoding repair as
the maintenance tool.

## Filling missing artwork

`tools/fill-missing-artwork.py` searches Jellyfin's configured remote image
providers for Primary images only where artwork is currently missing. It
handles artists, albums, or both, and uses the dedicated remote-image download
API so existing curated artwork is never refreshed or replaced.

The command reads `JELLYFIN_TOKEN` first, then falls back to the restricted
token file at `~/.config/tokyo-music/jellyfin-token`:

```bash
tools/fill-missing-artwork.py artists              # dry run
tools/fill-missing-artwork.py artists --probe --limit 10
tools/fill-missing-artwork.py artists --apply
tools/fill-missing-artwork.py albums --apply
tools/fill-missing-artwork.py both --apply --limit 25
```

The URL defaults to `http://jellyfin.bush.home.arpa:8096`. Searches use
whichever artist and album image providers are enabled there. The tool reports
which items received art, which had no provider match, and writes details to
`artwork-report.json`. Start with a small `--limit` before processing the entire
library.

Add `--move` to an `artists` or `albums` apply run to quarantine items for which
the provider returns no image:

```bash
tools/fill-missing-artwork.py albums --probe --move --limit 10
tools/fill-missing-artwork.py albums --apply --move --limit 10
```

Jellyfin paths below `/srv/music/library` are mapped onto the local SSHFS mount
at `/mnt/servers/jellyfin/srv/music/library` and moved, with their relative
folder structure intact, under `/mnt/servers/jellyfin/srv/music/review`.
Existing destinations, stale paths, and paths outside the configured library
abort the move phase. `--move` cannot be combined with `both`, because artist
and album directory paths can overlap.

Known orphaned database items below the obsolete `/jellyfin/Music` prefix are
excluded before provider searches. Override `--stale-prefix` only if the server
was migrated from a different path.

To inventory every regular file that is not named with a case-insensitive
`.flac` suffix—including cover images and text files—run:

```bash
tools/list-non-flac.py
tools/list-non-flac.py /another/music/path
```

Paths go to standard output and an extension summary goes to standard error,
so the results can be redirected without mixing in the summary.

For a LibreOffice-compatible track spreadsheet, use `--csv`. Spreadsheet mode
automatically excludes cover images, text files, and other sidecars, and adds
embedded artist, album artist, album, title, track, date, format, and size
columns when Mutagen can read them:

```bash
.venv/bin/python tools/list-non-flac.py --csv non-flac-tracks.csv
libreoffice non-flac-tracks.csv
```

Before database cleanup, `tools/backup-jellyfin.sh` can be streamed to the
server and run with sudo. It briefly stops Jellyfin, archives
`/var/lib/jellyfin` and `/etc/jellyfin`, verifies the archive, and restarts the
service through an exit trap:

```bash
ssh -t jellyfin.bush.home.arpa 'sudo bash -s' < tools/backup-jellyfin.sh
```

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

## Keeping tags clean (`tools/fix-artist-tags.py`)

Most "Jellyfin split my artist" problems are a tagging convention, not a
Jellyfin bug. Rippers commonly write several artists into one string:

```
ARTIST=Breaking Benjamin; Valora
```

Jellyfin does not split on `;`, `/` or `feat.`, so that whole string becomes
its own artist. Every new combination adds another phantom entry, and a
polluted `ALBUMARTIST` splits the album off from the rest of the discography.
**Every fresh import brings the problem back**, so this needs to be part of
the import routine rather than a one-off cleanup.

```bash
pip install mutagen                     # once, a venv is fine

tools/fix-artist-tags.py /srv/music/library                    # dry run
tools/fix-artist-tags.py /srv/music/library --apply     --canonical canonical.json --fix-encoding     --jellyfin-url http://<host>:8096 --token <api-key>
```

It is a dry run unless `--apply` is given, backs up every file it touches,
writes an `undo.json`, and is idempotent.

| Flag | Purpose |
|---|---|
| `--apply` | actually write; otherwise it only reports |
| `--canonical FILE` | JSON map of `{"wrong name": "right name"}` for spellings you have settled on |
| `--fix-encoding` | repair UTF-8 text that was decoded as CP1251 (`JГіnsi` → `Jónsi`) |
| `--jellyfin-url` / `--token` | refresh the affected albums and rescan afterwards |
| `--media-root` / `--server-root` | path translation when the library is mounted elsewhere |
| `--refresh-only` | skip tag work; just make Jellyfin re-read a path |
| `--feat-in-title` | for WMA, keep the primary artist and credit guests in the title |
| `--report-duplicates` | list duplicate-looking artist records in Jellyfin; changes nothing |

Deliberate limits, each learned the hard way:

- **`&` and `,` are never split.** `Mumford & Sons` is one artist and no
  heuristic can distinguish that from a collaboration. Handle those by hand.
- **WMA is never split.** Multi-value ASF tags come back as a single value and
  Jellyfin drops every artist but the first, which is worse than leaving it.
  Move the featured artist into the track title instead.
- **An empty `ALBUMARTIST` is left empty.** It usually means a compilation;
  filling it in from one track's artist splits the album in two.
- **Jellyfin needs telling.** A plain library scan will not overwrite metadata
  it already holds. The affected albums need a refresh with
  `replaceAllMetadata=true`, *then* a scan — and the refreshes are async, so
  scanning too early silently does nothing. The tool sequences this for you.
- **Loose files** sitting directly in an artist folder belong to an album record
  with no directory, so the tool refreshes changed tracks individually as well.

### Finding duplicates the tag pass cannot fix

```bash
tools/fix-artist-tags.py . --report-duplicates \
    --jellyfin-url http://<host>:8096 --token <key>
```

Some duplicates are not tag problems at all. Jellyfin keeps artist records
around that no longer match anything, and it matches artist names
case-insensitively, so a leftover never looks orphaned and no scan prunes it.
The report lists three kinds: byte-identical names, the same artist under
different spellings, and names that are several artists joined together.

Identical names are the easy ones to miss — grouping by a normalised key and
reporting only when the spellings differ hides them completely, because the set
of spellings has size one.

Each record is labelled `library` or `metadata-stub` by its `Path`. A stub under
`/var/lib/jellyfin/metadata/artists/` is a leftover and `DELETE /Items/{id}` is
safe, even though `CanDelete` reports false. **A record pointing into the media
library is real music — deleting that can take the files with it.** Check the
path before deleting anything, and confirm a library-backed record with the same
name will survive.

### Preventing it at source

Better still, tag correctly on import. [MusicBrainz Picard](https://picard.musicbrainz.org/)
writes proper multi-value artist tags, and [beets](https://beets.io/) has an
`ftintitle` plugin that moves featured artists out of the artist field and into
the title. Either avoids the problem entirely.

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
- **Metadata providers fight your tags, and win at album level.** A default
  music library fetches `MusicAlbum` and `MusicArtist` metadata from MusicBrainz
  and TheAudioDB while `Audio` stays tags-only. The provider's spelling lands on
  the album record and Jellyfin then creates a *second* artist for it — so
  tracks tagged `blink-182` sat under an album credited to `blink‐182` with a
  U+2010 typographic hyphen, and `Angels and Airwaves` gained an
  `Angels & Airwaves` twin. Clearing the metadata fetchers for those two types
  (leaving the image fetchers alone, so artwork still downloads) makes tags
  authoritative and stops it recurring.
- **Artists often have a Backdrop or Logo but no Primary image.** A card that
  asks only for `Primary` then renders an empty placeholder even though Jellyfin
  holds artwork. Two things help: an image-only refresh
  (`metadataRefreshMode=None&imageRefreshMode=FullRefresh`) fetches missing art
  *without* touching names, so it is safe even with the metadata fetchers off;
  and `bestImageUrl` falls back through image types. Logo is skipped
  deliberately — it is usually a wide transparent image that crops badly into a
  circular card.
- **Tags mangled by a bad decode can be repaired losslessly.** Text written as
  UTF-8 but read as CP1251 shows up as Cyrillic soup (`JГіnsi` for `Jónsi`).
  `s.encode("cp1251").decode("utf-8")` reverses it. Guard the repair by
  requiring the result to contain no Cyrillic, so genuinely Cyrillic names are
  left alone. Such names also block artwork lookup, since no provider can match
  them.
- **Duplicate artist records cannot be pruned through the API.** Jellyfin's
  artist lookup is case-insensitive, so a leftover record differing only by case
  resolves to the same albums and never looks orphaned. Refreshes and scans
  won't remove it and `DELETE /Items` refuses. The client therefore collapses
  them for display — see `dedupeArtists` in `js/api.js`. It is lossless: grouped
  records return identical content. The survivor is chosen by `Path`, since the
  leftovers live under `/var/lib/jellyfin/metadata/artists/` while the record
  reflecting the library points at a media path — which conveniently picks the
  spelling your tags actually use.

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
