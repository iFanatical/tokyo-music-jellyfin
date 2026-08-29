#!/usr/bin/env python3
"""Normalise multi-artist tags so Jellyfin stops inventing artists.

THE PROBLEM
    Many rippers and taggers write several artists into one string:

        ARTIST=Breaking Benjamin; Valora

    Jellyfin does not split on ";" (or " / ", or "feat."), so that whole
    string becomes its own artist. Every distinct combination produces
    another phantom entry, and an album whose ALBUMARTIST is polluted the
    same way gets split off from the rest of the discography.

    The correct storage is one value per artist: repeated ARTIST fields in
    FLAC/Ogg, a multi-value TPE1 frame in ID3v2.4, a list in MP4.

WHAT THIS DOES
    - Splits delimited ARTIST values into proper multi-value tags.
    - Reduces a delimited ALBUMARTIST to its primary (first) artist.
    - Optionally applies canonical spellings and repairs mis-decoded text.
    - Backs up every file it touches and writes an undo log.
    - Optionally tells Jellyfin to re-read the affected albums.

    It is idempotent: a second run finds nothing to do.

USAGE
    tools/fix-artist-tags.py /path/to/music                 # dry run
    tools/fix-artist-tags.py /path/to/music --apply
    tools/fix-artist-tags.py /path/to/music --apply \
        --jellyfin-url http://myserver:8096 --token <api-key>

    Requires mutagen:  pip install mutagen  (a venv is fine)

WHY THE JELLYFIN STEP MATTERS
    Retagging alone changes nothing in Jellyfin. A plain library scan will
    not overwrite metadata it already holds, so the affected albums need a
    refresh with replaceAllMetadata=true, followed by a scan to rebuild the
    artist entries. --jellyfin-url does both.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
from collections import Counter

AUDIO_EXTS = {"flac", "mp3", "m4a", "mp4", "ogg", "oga", "opus", "wma"}

# Delimiters that reliably separate distinct artists. "&" and "," are
# deliberately absent: "Mumford & Sons" and "Earth, Wind & Fire" are single
# artists, and no heuristic can tell those from a collaboration.
SPLIT_RX = re.compile(r"\s*;\s*|\s+/\s+|\s+feat\.\s+|\s+ft\.\s+|\s+featuring\s+", re.I)

# Multi-value ASF (WMA) tags are read back as a single value by Jellyfin,
# which silently drops every artist but the first. Verified — never split these.
UNSAFE_MULTIVALUE = {"wma"}

CYRILLIC_RX = re.compile(r"[Ѐ-ӿ]")

# Titles that already credit the guests must not be credited twice.
FEAT_RX = re.compile(r"\b(feat\.?|ft\.?|featuring|with)\b", re.I)


def format_feat(guests):
    """'feat. A', 'feat. A & B', 'feat. A, B & C' — the usual convention."""
    if len(guests) == 1:
        return f"feat. {guests[0]}"
    return f"feat. {', '.join(guests[:-1])} & {guests[-1]}"


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


try:
    import mutagen
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3, TPE1, TPE2, TIT2, TALB, ID3NoHeaderError
    from mutagen.mp4 import MP4
    from mutagen.asf import ASF
    from mutagen.oggvorbis import OggVorbis
except ImportError:  # pragma: no cover
    die("mutagen is required:  pip install mutagen")


def repair_encoding(value: str) -> str:
    """Undo UTF-8 text that was decoded as CP1251 ('JГіnsi' -> 'Jónsi').

    Only returns a change when the result is free of Cyrillic, so genuinely
    Cyrillic names are left untouched.
    """
    if not value or not CYRILLIC_RX.search(value):
        return value
    try:
        fixed = value.encode("cp1251").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value
    if fixed == value or CYRILLIC_RX.search(fixed):
        return value
    return fixed


def split_artists(values, canonical, fix_encoding, split_map=None):
    """Expand delimited values into a de-duplicated list of artist names."""
    split_map = split_map or {}
    out = []
    for value in values:
        if fix_encoding:
            value = repair_encoding(value)
        parts = split_map.get(value, SPLIT_RX.split(value))
        for part in parts:
            part = part.strip().strip(",")
            if not part:
                continue
            part = canonical.get(part, part)
            if part not in out:
                out.append(part)
    return out


class Track:
    """Uniform read/write of artist tags across container formats."""

    def __init__(self, path: str):
        self.path = path
        self.ext = path.rsplit(".", 1)[-1].lower()
        self._tags = None

    def read(self):
        """Returns (artists, albumartists, title, album) or None if unreadable."""
        try:
            if self.ext == "flac":
                t = self._tags = FLAC(self.path)
                return (list(t.get("artist", [])), list(t.get("albumartist", [])),
                        (t.get("title") or [None])[0], (t.get("album") or [None])[0])
            if self.ext == "mp3":
                try:
                    t = self._tags = ID3(self.path)
                except ID3NoHeaderError:
                    return None
                g = lambda f: list(t[f].text) if f in t else []
                return (g("TPE1"), g("TPE2"),
                        (g("TIT2") or [None])[0], (g("TALB") or [None])[0])
            if self.ext in ("m4a", "mp4"):
                t = self._tags = MP4(self.path)
                return (list(t.get("\xa9ART", [])), list(t.get("aART", [])),
                        (t.get("\xa9nam") or [None])[0], (t.get("\xa9alb") or [None])[0])
            if self.ext == "wma":
                t = self._tags = ASF(self.path)
                s = lambda k: [str(v) for v in t.get(k, [])]
                return (s("Author"), s("WM/AlbumArtist"),
                        (s("Title") or [None])[0], (s("WM/AlbumTitle") or [None])[0])
            if self.ext in ("ogg", "oga", "opus"):
                # An Ogg container may hold Opus, Vorbis or FLAC, and the
                # extension does not reliably say which. Reading a .opus file
                # as OggVorbis throws, so let mutagen sniff the actual codec.
                t = self._tags = mutagen.File(self.path)
                if t is None:
                    raise ValueError("unrecognised Ogg codec")
                return (list(t.get("artist", [])), list(t.get("albumartist", [])),
                        (t.get("title") or [None])[0], (t.get("album") or [None])[0])
        except Exception as exc:  # noqa: BLE001 - report and skip
            print(f"    ! unreadable ({exc.__class__.__name__}): {self.path}")
            return None
        return None

    def write(self, artists, albumartists, title=None, album=None):
        t = self._tags
        if self.ext in ("flac", "ogg", "oga", "opus"):  # VorbisComment-style
            t["artist"] = artists
            if albumartists:
                t["albumartist"] = albumartists
            if title:
                t["title"] = [title]
            if album:
                t["album"] = [album]
            t.save()
        elif self.ext == "mp3":
            t.setall("TPE1", [TPE1(encoding=3, text=artists)])
            if albumartists:
                t.setall("TPE2", [TPE2(encoding=3, text=albumartists)])
            if title:
                t.setall("TIT2", [TIT2(encoding=3, text=[title])])
            if album:
                t.setall("TALB", [TALB(encoding=3, text=[album])])
            # v2.4 is required for multi-value frames.
            t.save(v2_version=4)
        elif self.ext in ("m4a", "mp4"):
            t["\xa9ART"] = artists
            if albumartists:
                t["aART"] = albumartists
            if title:
                t["\xa9nam"] = [title]
            if album:
                t["\xa9alb"] = [album]
            t.save()
        elif self.ext == "wma":
            t["Author"] = artists
            if albumartists:
                t["WM/AlbumArtist"] = albumartists
            if title:
                t["Title"] = [title]
            if album:
                t["WM/AlbumTitle"] = [album]
            t.save()


def plan_changes(root, canonical, fix_encoding, feat_in_title=False, split_map=None):
    changes, skipped, scanned = [], [], 0
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if ext not in AUDIO_EXTS:
                continue
            scanned += 1
            path = os.path.join(dirpath, name)
            track = Track(path)
            got = track.read()
            if not got:
                continue
            artists, albumartists, title, album = got

            new_artists = split_artists(artists, canonical, fix_encoding, split_map)
            # Only ever *reduce* a polluted album artist. Never invent one:
            # an empty ALBUMARTIST usually means a compilation, and filling it
            # from one track's artist splits the album.
            if albumartists:
                if any(SPLIT_RX.search(v) for v in albumartists):
                    new_albumartists = split_artists(albumartists, canonical, fix_encoding)[:1]
                else:
                    new_albumartists = [
                        canonical.get(repair_encoding(v) if fix_encoding else v,
                                      repair_encoding(v) if fix_encoding else v)
                        for v in albumartists
                    ]
            else:
                new_albumartists = []

            new_title = repair_encoding(title) if (fix_encoding and title) else title
            new_album = repair_encoding(album) if (fix_encoding and album) else album

            splitting = len(new_artists) > len(artists)
            if ext in UNSAFE_MULTIVALUE and splitting:
                if not feat_in_title:
                    skipped.append((path, artists, new_artists))
                    continue
                # Multi-value tags are unusable in this format, so keep the
                # primary artist alone and name the guests in the title. The
                # information survives and no phantom artist is created, but
                # the guests are not browsable as artists — a limitation of
                # the format, not of the tagging.
                guests = new_artists[1:]
                if title and not FEAT_RX.search(title):
                    new_title = f"{title} ({format_feat(guests)})"
                new_artists = new_artists[:1]

            if (new_artists == artists and new_albumartists == albumartists
                    and new_title == title and new_album == album):
                continue

            changes.append({
                "path": path, "ext": ext, "track": track,
                "old_artists": artists, "new_artists": new_artists,
                "old_albumartist": albumartists, "new_albumartist": new_albumartists,
                "old_title": title, "new_title": new_title,
                "old_album": album, "new_album": new_album,
            })
    return changes, skipped, scanned


def report_duplicates(base, token, library_id=None):
    """List artist records that look like duplicates of one another.

    Catches three kinds, the first of which is easy to miss: two records with
    byte-identical names. Grouping only by a normalised key and reporting when
    the distinct spellings differ hides those completely, because the set of
    spellings has size one.
    """
    params = {"Limit": "5000", "Fields": "Path"}
    if library_id:
        params["ParentId"] = library_id
    try:
        data = jellyfin_request(base, token, "/Artists", params=params) or {}
    except Exception as exc:  # noqa: BLE001
        die(f"could not query Jellyfin: {exc}")

    items = data.get("Items", [])
    print(f"{len(items)} artist record(s)\n")

    def kind(item):
        return ("metadata-stub"
                if "/metadata/artists/" in (item.get("Path") or "")
                else "library")

    # 1. byte-identical names
    by_name = {}
    for i in items:
        by_name.setdefault(i["Name"], []).append(i)
    identical = {n: v for n, v in by_name.items() if len(v) > 1}
    print(f"=== identical names: {len(identical)} ===")
    for name, group in sorted(identical.items()):
        print(f"  {name!r}")
        for i in group:
            print(f"     {kind(i):14} id={i['Id']}  {i.get('Path')!r}")

    # 2. same artist, different spelling
    dashes = dict.fromkeys(map(ord, "‐‑‒–—―−"), "-")
    def key(name):
        n = unicodedata.normalize("NFKC", name).casefold().translate(dashes)
        return re.sub(r"\s+", " ", n.replace("&", "and")).strip()

    by_key = {}
    for i in items:
        by_key.setdefault(key(i["Name"]), []).append(i)
    variants = {k: v for k, v in by_key.items()
                if len({i["Name"] for i in v}) > 1}
    print(f"\n=== same artist, different spelling: {len(variants)} ===")
    for _k, group in sorted(variants.items()):
        for i in group:
            print(f"  {i['Name']!r:34} {kind(i):14} {i.get('Path')!r}")
        print()

    # 3. names that are really several artists joined together
    joined = sorted(i["Name"] for i in items if SPLIT_RX.search(i["Name"]))
    print(f"=== delimiter-joined names: {len(joined)} ===")
    for n in joined:
        print(f"  {n!r}")

    total = len(identical) + len(variants) + len(joined)
    print(f"\n{'no duplicates found' if not total else str(total) + ' issue group(s) to look at'}")
    print("A metadata-stub record with no library path is a leftover; deleting "
          "one\nvia the API is safe. A record pointing into the library is real "
          "music —\nnever delete that, it can take the files with it.")
    return 0


def jellyfin_request(base, token, path, method="GET", params=None):
    url = base.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization",
                   f'MediaBrowser Client="fix-artist-tags", Device="cli", '
                   f'DeviceId="fix-artist-tags", Version="1.0", Token="{token}"')
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read()
        return json.loads(body) if body else None


def refresh_jellyfin(base, token, changed_dirs, media_root, server_root,
                     changed_files=()):
    """Refresh albums covering the changed files, then rescan the library.

    Loose files sitting directly in an artist folder belong to an album record
    with no directory of its own, so album-by-directory matching misses them.
    changed_files closes that gap by refreshing those items directly.
    """
    print("\nJellyfin: locating affected albums")
    try:
        data = jellyfin_request(base, token, "/Items", params={
            "IncludeItemTypes": "MusicAlbum", "Recursive": "true",
            "Limit": "5000", "Fields": "Path",
        })
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"  ! could not query Jellyfin: {exc}")
        return

    def to_server_path(local):
        # server_root may legitimately be empty, e.g. a library mounted at
        # /mnt/host/srv/music that the server itself sees as /srv/music.
        if media_root and local.startswith(media_root):
            return (server_root or "") + local[len(media_root):]
        return local

    wanted = {to_server_path(d) for d in changed_dirs}
    albums = []
    for album in (data or {}).get("Items", []):
        apath = album.get("Path")
        if apath and any(w == apath or w.startswith(apath.rstrip("/") + "/") for w in wanted):
            albums.append(album["Id"])

    print(f"  refreshing {len(albums)} album(s) with replaceAllMetadata=true")
    for album_id in albums:
        try:
            jellyfin_request(base, token, f"/Items/{album_id}/Refresh", method="POST",
                             params={"metadataRefreshMode": "FullRefresh",
                                     "imageRefreshMode": "None",
                                     "replaceAllMetadata": "true",
                                     "replaceAllImages": "false",
                                     "recursive": "true"})
        except Exception as exc:  # noqa: BLE001
            print(f"  ! refresh failed for {album_id}: {exc}")

    if changed_files:
        wanted_files = {to_server_path(f) for f in changed_files}
        try:
            tracks = jellyfin_request(base, token, "/Items", params={
                "IncludeItemTypes": "Audio", "Recursive": "true",
                "Limit": "20000", "Fields": "Path",
            }) or {}
        except Exception as exc:  # noqa: BLE001
            print(f"  ! could not list tracks: {exc}")
            tracks = {}
        ids = [t["Id"] for t in tracks.get("Items", [])
               if t.get("Path") in wanted_files]
        if ids:
            print(f"  refreshing {len(ids)} track(s) directly")
            for track_id in ids:
                try:
                    jellyfin_request(base, token, f"/Items/{track_id}/Refresh",
                                     method="POST",
                                     params={"metadataRefreshMode": "FullRefresh",
                                             "imageRefreshMode": "None",
                                             "replaceAllMetadata": "true",
                                             "replaceAllImages": "false"})
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! refresh failed for {track_id}: {exc}")

    # Refreshes are asynchronous. Scanning immediately races them, and the
    # artist entries then get rebuilt from metadata that has not been
    # rewritten yet — the symptom is tags fixed on disk but unchanged in the
    # UI. Wait for them to settle first.
    settle = min(120, max(20, 4 * len(albums)))
    print(f"  waiting {settle}s for those refreshes to settle")
    time.sleep(settle)

    print("  triggering library scan")
    try:
        jellyfin_request(base, token, "/Library/Refresh", method="POST")
    except Exception as exc:  # noqa: BLE001
        print(f"  ! scan failed: {exc}")
        return

    for _ in range(60):
        time.sleep(5)
        try:
            tasks = jellyfin_request(base, token, "/ScheduledTasks") or []
        except Exception:  # noqa: BLE001
            break
        scan = next((t for t in tasks if t.get("Name") == "Scan Media Library"), None)
        if scan and scan.get("State") == "Idle":
            break
    print("  done — artist entries rebuilt")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Split delimited multi-artist tags into proper multi-value tags.")
    ap.add_argument("path", help="music directory to scan")
    ap.add_argument("--apply", action="store_true",
                    help="write changes (default is a dry run)")
    ap.add_argument("--backup-dir", default="./tag-backups",
                    help="where originals are copied before writing")
    ap.add_argument("--fix-encoding", action="store_true",
                    help="also repair UTF-8-read-as-CP1251 text")
    ap.add_argument("--canonical", help="JSON file of {\"wrong name\": \"right name\"}")
    ap.add_argument("--split-map",
                    help="JSON map of exact compound artist names to artist arrays")
    ap.add_argument("--jellyfin-url", help="e.g. http://myserver:8096 (refresh after applying)")
    ap.add_argument("--token", help="Jellyfin API key or access token")
    ap.add_argument("--media-root", help="local path prefix, if the library is mounted elsewhere")
    ap.add_argument("--server-root", help="matching path prefix as the Jellyfin server sees it")
    ap.add_argument("--feat-in-title", action="store_true",
                    help="for formats where multi-value tags do not work (WMA), "
                         "keep the primary artist and move guests into the "
                         "track title as '(feat. ...)' instead of skipping")
    ap.add_argument("--report-duplicates", action="store_true",
                    help="list duplicate-looking artist records in Jellyfin and "
                         "exit; makes no changes")
    ap.add_argument("--library-id", help="restrict --report-duplicates to one library")
    ap.add_argument("--refresh-only", action="store_true",
                    help="skip tag work; just make Jellyfin re-read this path "
                         "(useful if tags were fixed by another tool)")
    args = ap.parse_args()

    if not os.path.isdir(args.path):
        die(f"not a directory: {args.path}")

    canonical = {}
    if args.canonical:
        with open(args.canonical, encoding="utf-8") as fh:
            canonical = json.load(fh)
        print(f"loaded {len(canonical)} canonical name(s)")

    split_map = {}
    if args.split_map:
        with open(args.split_map, encoding="utf-8") as fh:
            split_map = json.load(fh)
        if not isinstance(split_map, dict) or not all(
                isinstance(key, str) and isinstance(value, list) and value
                and all(isinstance(part, str) and part.strip() for part in value)
                for key, value in split_map.items()):
            die("--split-map must be a JSON object of non-empty string arrays")
        print(f"loaded {len(split_map)} explicit artist split(s)")

    if args.report_duplicates:
        if not (args.jellyfin_url and args.token):
            die("--report-duplicates needs --jellyfin-url and --token")
        return report_duplicates(args.jellyfin_url, args.token, args.library_id)

    if args.refresh_only:
        if not (args.jellyfin_url and args.token):
            die("--refresh-only needs --jellyfin-url and --token")
        dirs, files = set(), []
        for dirpath, _d, fs in os.walk(args.path):
            audio = [f for f in fs if f.rsplit(".", 1)[-1].lower() in AUDIO_EXTS]
            if audio:
                dirs.add(dirpath)
                files.extend(os.path.join(dirpath, f) for f in audio)
        print(f"refresh-only: {len(dirs)} directory(ies), {len(files)} file(s)")
        refresh_jellyfin(args.jellyfin_url, args.token, dirs,
                         args.media_root, args.server_root, changed_files=files)
        return 0

    print(f"scanning {args.path}")
    changes, skipped, scanned = plan_changes(args.path, canonical, args.fix_encoding,
                                              args.feat_in_title, split_map)
    print(f"  {scanned} audio file(s) scanned, {len(changes)} need changes\n")

    if skipped:
        print(f"SKIPPED — multi-value tags are unreliable in these formats ({len(skipped)}):")
        for path, old, new in skipped:
            print(f"  {os.path.basename(path)}")
            print(f"     {old} would become {new}")
        print("  Re-run with --feat-in-title to move the guests into the title.\n")

    if not changes:
        print("Nothing to do.")
        return 0

    by_ext = Counter(c["ext"] for c in changes)
    for change in changes:
        print(f"  {os.path.relpath(change['path'], args.path)}")
        if change["old_artists"] != change["new_artists"]:
            print(f"     ARTIST      {change['old_artists']} -> {change['new_artists']}")
        if change["old_albumartist"] != change["new_albumartist"]:
            print(f"     ALBUMARTIST {change['old_albumartist']} -> {change['new_albumartist']}")
        if change["old_title"] != change["new_title"]:
            print(f"     TITLE       {change['old_title']!r} -> {change['new_title']!r}")
        if change["old_album"] != change["new_album"]:
            print(f"     ALBUM       {change['old_album']!r} -> {change['new_album']!r}")

    print(f"\n  by format: {dict(by_ext)}")

    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply to make these changes.")
        return 0

    os.makedirs(args.backup_dir, exist_ok=True)
    undo, failed, changed_dirs = [], [], set()
    for change in changes:
        path = change["path"]
        flat = os.path.relpath(path, args.path).replace(os.sep, "__")
        backup = os.path.join(args.backup_dir, flat)
        try:
            if not os.path.exists(backup):
                shutil.copy2(path, backup)
            change["track"].write(change["new_artists"], change["new_albumartist"],
                                 change["new_title"], change["new_album"])
            verify = Track(path).read()
            # Check every field that was meant to change, not just artists —
            # a write path that silently ignores titles would otherwise pass.
            ok = bool(verify) and (
                verify[0] == change["new_artists"]
                and verify[1] == change["new_albumartist"]
                and verify[2] == change["new_title"]
                and verify[3] == change["new_album"]
            )
            undo.append({k: v for k, v in change.items() if k != "track"} | {
                "backup": backup, "verified": ok})
            if not ok:
                failed.append(path)
            changed_dirs.add(os.path.dirname(path))
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{path}: {exc}")

    log = os.path.join(args.backup_dir, "undo.json")
    with open(log, "w", encoding="utf-8") as fh:
        json.dump(undo, fh, indent=1, ensure_ascii=False)

    print(f"\nwrote {len(undo)} file(s); verified {sum(1 for u in undo if u['verified'])}")
    print(f"backups + undo log: {args.backup_dir}")
    if failed:
        print(f"FAILURES ({len(failed)}):")
        for f in failed[:20]:
            print(f"  {f}")

    if args.jellyfin_url and args.token:
        refresh_jellyfin(args.jellyfin_url, args.token, changed_dirs,
                         args.media_root, args.server_root,
                         changed_files=[u["path"] for u in undo])
    else:
        print("\nJellyfin still needs to re-read these files. Either pass"
              "\n  --jellyfin-url URL --token TOKEN"
              "\nor, in the web UI, refresh each affected album with"
              "\n'Replace all metadata' and then run Scan Media Library."
              "\nA plain scan on its own will NOT pick these up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
