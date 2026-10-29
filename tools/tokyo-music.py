#!/usr/bin/env python3
"""Discover, download and import new music into the Tokyo Music library.

    tokyo-music discover            album lists from the artists file (Amazon)
    tokyo-music download            fetch every list with lucida
    tokyo-music download --retry    fetch only what the last run failed
    tokyo-music import              plan the import (dry run)
    tokyo-music import --apply      fix tags, copy into the library, clean up

DISCOVER
    Each artist URL in the artists file gets one list, named after its Amazon
    ID, so re-running only discovers artists that have no list yet (--refresh
    re-discovers them). Every URL is preceded by a "# title" comment. Releases
    whose titles differ only by edition ("Deluxe", "Explicit", "Remastered") are
    flagged: delete the lines of the editions you do not want before
    downloading, or both end up in one album folder.

DOWNLOAD
    Comments are stripped and the remaining URLs are handed to lucida, which
    writes Artist/Album folders into the inbox. lucida.to needs a Cloudflare
    clearance cookie and the User-Agent it was issued to. The cookie is read
    from your Firefox profile (visit https://lucida.to in Firefox when it has
    expired) unless "cf_clearance" is set in the config or $TOKYO_CF_CLEARANCE;
    the User-Agent is "user_agent" in the config, or derived from
    `firefox --version`. Lists are archived after a run without failures.

IMPORT
    In order: repair Ogg files with a broken last page; set genres and box-set
    disc numbers from Deezer, filling gaps from the artist's albums already in
    Jellyfin, then MusicBrainz; warn about folders that hold two editions;
    then import-music.py copies audio, covers and lyrics into the library with
    the settled artist spellings, skipping albums that are already there, and
    Jellyfin rescans. Finally the inbox is cleaned: folders with no audio left
    are removed and lucida's reports are archived.

CONFIG
    ~/.config/tokyo-music/config.json, all keys optional:
      root          ~/Downloads/downloaded-music
      artists       <root>/ripped/artists.txt
      lists         <root>/album-lists
      inbox         <root>/move
      archive       <root>/archive
      library       /mnt/servers/jellyfin/srv/music/library
      jellyfin_url  https://fanatical.privatedns.org
      user_agent    exact User-Agent of the browser holding the cookie
      cf_clearance  a cookie to use instead of Firefox's
"""

from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_DIR = Path("~/.config/tokyo-music").expanduser()
DEFAULTS = {
    "root": "~/Downloads/downloaded-music",
    "artists": "{root}/ripped/artists.txt",
    "lists": "{root}/album-lists",
    "inbox": "{root}/move",
    "archive": "{root}/archive",
    "library": "/mnt/servers/jellyfin/srv/music/library",
    "jellyfin_url": "https://fanatical.privatedns.org",
    "user_agent": "",
    "cf_clearance": "",
}
LUCIDA_HOST = "lucida.to"
AUDIO_EXTS = (".flac", ".mp3", ".m4a", ".mp4", ".ogg", ".oga", ".opus", ".wma")
# Once a folder has no audio left, these are leftovers: artwork, lyrics, partials.
LEFTOVER_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".lrc", ".part")
# Bracketed title parts that name an edition rather than a different record.
EDITION_RX = re.compile(
    r"\s*[\(\[][^\)\]]*\b(deluxe|edition|explicit|clean|remaster(ed)?|expanded|anniversary|"
    r"bonus|version|special|super|tour|reissue|mono|stereo)\b[^\)\]]*[\)\]]", re.I)


def load_tool(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_config(path: Path | None = None) -> dict:
    cfg = dict(DEFAULTS)
    path = path or CONFIG_DIR / "config.json"
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    root = os.path.expanduser(cfg["root"])
    for key in ("root", "artists", "lists", "inbox", "archive", "library"):
        cfg[key] = os.path.expanduser(str(cfg[key]).replace("{root}", root))
    return cfg


# ---------------------------------------------------------------- discover

def artist_id(url: str) -> str | None:
    m = re.search(r"/artists?/([A-Z0-9]{8,})", url) or re.search(r"/artist/([A-Z0-9]{8,})", url)
    return m.group(1) if m else None


def pair_titles(stdout: str, stderr: str) -> list[tuple[str, str]]:
    """(url, "title — type") in discovery order. lucida prints one stderr line per
    release, in URL order, right before its "Found N unique release URLs" line."""
    urls = [line.strip() for line in stdout.splitlines() if line.strip()]
    lines = stderr.splitlines()
    found = next((i for i, line in enumerate(lines) if line.startswith("Found ")), None)
    titles = lines[found - len(urls):found] if found is not None and found >= len(urls) else []
    if len(titles) != len(urls):
        titles = [""] * len(urls)
    return list(zip(urls, titles))


def edition_key(title: str) -> str:
    base = title.split(" — ")[0]
    base = re.sub(r"^\d+\.\s+", "", base)  # Popular Albums ranks: "1. Title"
    base = EDITION_RX.sub("", base)
    return re.sub(r"[^a-z0-9]+", "", base.lower())


def edition_groups(pairs: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    groups: dict[str, list] = {}
    for url, title in pairs:
        if title:
            groups.setdefault(edition_key(title), []).append((url, title))
    return [g for g in groups.values() if len(g) > 1]


def render_list(artist_url: str, pairs: list[tuple[str, str]]) -> str:
    flagged = {url for group in edition_groups(pairs) for url, _ in group}
    out = [f"# {artist_url}",
           "# Delete the lines of releases you don't want, then: tokyo-music download"]
    for url, title in pairs:
        mark = "  [ALTERNATE EDITION - keep only one]" if url in flagged else ""
        out += [f"# {title or '(no title)'}{mark}", url]
    return "\n".join(out) + "\n"


def cmd_discover(cfg: dict, args) -> int:
    artists = Path(cfg["artists"])
    if not artists.exists():
        print(f"error: no artists file at {artists}", file=sys.stderr)
        return 1
    lists = Path(cfg["lists"])
    lists.mkdir(parents=True, exist_ok=True)
    urls = [line.strip() for line in artists.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")]
    failed, flagged_total = 0, 0
    for url in urls:
        aid = artist_id(url) or re.sub(r"[^A-Za-z0-9]+", "-", url)[-40:]
        target = lists / f"{aid}.txt"
        if target.exists() and not args.refresh:
            print(f"  {aid}: list exists, skipping ({target}; --refresh to redo)")
            continue
        cmd = ["lucida", "--discover-artist", url] + (["--all-releases"] if args.all_releases else [])
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            failed += 1
            last = (proc.stderr.strip().splitlines() or ["no output"])[-1]
            print(f"  {aid}: discovery failed: {last}")
            continue
        pairs = pair_titles(proc.stdout, proc.stderr)
        groups = edition_groups(pairs)
        flagged_total += sum(len(g) for g in groups)
        target.write_text(render_list(url, pairs), encoding="utf-8")
        print(f"  {aid}: {len(pairs)} release(s) -> {target}")
        for group in groups:
            print("      alternate editions: " + " | ".join(t.split(' — ')[0] for _, t in group))
    if flagged_total:
        print(f"\n{flagged_total} release(s) are flagged as alternate editions. Edit the lists "
              f"in {lists} and delete the ones you don't want before downloading.")
    return 1 if failed else 0


# ---------------------------------------------------------------- download

def firefox_cookie(host: str = LUCIDA_HOST, name: str = "cf_clearance",
                   profiles_glob: str = "~/.mozilla/firefox/*/cookies.sqlite") -> tuple[str, float] | None:
    """(value, expiry epoch) of the freshest unexpired cookie across Firefox
    profiles. The database is copied first: Firefox keeps it locked."""
    best = None
    for db in glob.glob(os.path.expanduser(profiles_glob)):
        with tempfile.TemporaryDirectory() as tmp:
            copy = os.path.join(tmp, "cookies.sqlite")
            shutil.copyfile(db, copy)
            if os.path.exists(db + "-wal"):
                shutil.copyfile(db + "-wal", copy + "-wal")
            try:
                con = sqlite3.connect(copy)
                rows = con.execute(
                    "SELECT value, expiry FROM moz_cookies WHERE name = ? AND "
                    "(host = ? OR host = ?)", (name, host, "." + host)).fetchall()
                con.close()
            except sqlite3.Error:
                continue
        for value, expiry in rows:
            expiry = expiry / 1000 if expiry > 1e11 else expiry  # newer Firefox stores ms
            if expiry > time.time() and (best is None or expiry > best[1]):
                best = (value, expiry)
    return best


def firefox_user_agent() -> str | None:
    try:
        out = subprocess.run(["firefox", "--version"], capture_output=True, text=True).stdout
    except OSError:
        return None
    m = re.search(r"(\d+)\.\d+", out)
    if not m:
        return None
    version = f"{m.group(1)}.0"
    return f"Mozilla/5.0 (X11; Linux x86_64; rv:{version}) Gecko/20100101 Firefox/{version}"


def credentials(cfg: dict) -> tuple[str, str] | str:
    """(cookie, user agent), or an explanation of what is missing."""
    cookie = os.environ.get("TOKYO_CF_CLEARANCE") or cfg.get("cf_clearance")
    if not cookie:
        found = firefox_cookie()
        if not found:
            return (f"No unexpired cf_clearance cookie for {LUCIDA_HOST} in Firefox. Open "
                    f"https://{LUCIDA_HOST} in Firefox, pass the check, then run this again.")
        cookie, expiry = found
        print(f"Using Firefox's {LUCIDA_HOST} cookie (expires {time.strftime('%Y-%m-%d %H:%M', time.localtime(expiry))}).")
    agent = cfg.get("user_agent") or firefox_user_agent()
    if not agent:
        return 'No User-Agent: set "user_agent" in ~/.config/tokyo-music/config.json.'
    return cookie, agent


def strip_list(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")]


def cmd_download(cfg: dict, args) -> int:
    inbox, lists = Path(cfg["inbox"]), Path(cfg["lists"])
    inbox.mkdir(parents=True, exist_ok=True)
    if args.retry:
        failed = sorted(inbox.glob("lucida-failed-*.txt"), key=os.path.getmtime)
        if not failed:
            print(f"Nothing to retry: no lucida-failed-*.txt in {inbox}.")
            return 0
        sources = [failed[-1]]
    else:
        sources = sorted(p for p in lists.glob("*.txt"))
    urls = list(dict.fromkeys(u for p in sources for u in strip_list(p.read_text(encoding="utf-8"))))
    if not urls:
        print(f"No URLs to download in {lists if not args.retry else sources[0]}.")
        return 0
    creds = credentials(cfg)
    if isinstance(creds, str):
        print(f"error: {creds}", file=sys.stderr)
        return 1
    cookie, agent = creds
    print(f"Downloading {len(urls)} release(s) from {len(sources)} list(s) into {inbox}")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("\n".join(urls) + "\n")
        combined = fh.name
    try:
        code = subprocess.run(["lucida", "--cf-clearance", cookie, "--user-agent", agent,
                               "-f", combined], cwd=inbox).returncode
    finally:
        os.remove(combined)
    if code == 0:
        if not args.retry:
            dest = Path(cfg["archive"]) / time.strftime("%Y-%m-%d_%H%M%S") / "lists"
            dest.mkdir(parents=True, exist_ok=True)
            for p in sources:
                shutil.move(str(p), dest / p.name)
            print(f"Lists archived to {dest}.")
        print("Done. Next: tokyo-music import")
    else:
        print("lucida reported failures (see its report above). Retry them with "
              "`tokyo-music download --retry`; the lists are kept.", file=sys.stderr)
        if code in (1, 2):
            print("If every request failed, the cookie may have expired: open "
                  f"https://{LUCIDA_HOST} in Firefox and try again.", file=sys.stderr)
    return code


# ---------------------------------------------------------------- import

def canonical_map(repo_file: Path = HERE / "artist-canonical.json",
                  user_file: Path = CONFIG_DIR / "canonical.json") -> dict[str, str]:
    """User spellings plus the repo's settled ones; the repo wins any conflict,
    including a user entry that would rename one of its settled names."""
    load = lambda p: json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    repo, user = load(repo_file), load(user_file)
    settled = {v.casefold(): v for v in repo.values()}
    merged = {k: settled.get(v.casefold(), v) for k, v in user.items() if k not in repo.values()}
    merged.update(repo)
    return merged


def jellyfin_artist_genres(url: str, token: str, page: int = 10000) -> dict[str, list[str]]:
    """Most common genre list per album artist (lowercased), from the tracks in
    Jellyfin. Album-level genres are not used: Jellyfin fills those from online
    metadata ("Thrash Metal"), while track genres come from the tags."""
    albums: dict[str, tuple[str, tuple]] = {}
    start = 0
    while True:
        q = urllib.parse.urlencode({"IncludeItemTypes": "Audio", "Recursive": "true",
                                    "Fields": "Genres", "StartIndex": start, "Limit": page})
        req = urllib.request.Request(f"{url.rstrip('/')}/Items?{q}",
                                     headers={"Authorization": f'MediaBrowser Token="{token}"'})
        with urllib.request.urlopen(req, timeout=300) as resp:
            items = json.load(resp).get("Items", [])
        for item in items:
            if item.get("Genres") and item.get("AlbumId"):
                albums.setdefault(item["AlbumId"], (item.get("AlbumArtist", ""), tuple(item["Genres"])))
        start += page
        if len(items) < page:
            break
    seen: dict[str, Counter] = {}
    for artist, genres in albums.values():
        if artist and artist.lower() != "various artists":
            seen.setdefault(artist.lower(), Counter())[genres] += 1
    return {a: list(c.most_common(1)[0][0]) for a, c in seen.items()}


def release_marks(path: str) -> tuple[str, str, str]:
    """(track total, date, UPC): what tells two releases of one album apart."""
    import mutagen
    tags = (mutagen.File(path, easy=True) or {}).tags or {}
    first = lambda *keys: next((str(tags[k][0]) for k in keys if tags.get(k)), "")
    track = first("tracknumber")
    total = track.split("/")[1] if "/" in track else first("tracktotal", "totaltracks")
    return total, first("date")[:10], first("upc", "barcode")


def mixed_editions(files) -> bool:
    """A folder holding two releases: disc/track slots repeat and the files
    disagree on track total, date or UPC."""
    slots = Counter((f.disc, f.track) for f in files if f.track is not None)
    if not any(c > 1 for c in slots.values()):
        return False
    marks = [release_marks(f.path) for f in files]
    return any(len({m[i] for m in marks if m[i]}) > 1 for i in range(3))


def clean_inbox(inbox: Path, archive: Path) -> list[str]:
    notes = []
    reports = sorted(inbox.glob("lucida-report-*.txt")) + sorted(inbox.glob("lucida-failed-*.txt"))
    if reports:
        dest = archive / time.strftime("%Y-%m-%d_%H%M%S") / "reports"
        dest.mkdir(parents=True, exist_ok=True)
        for p in reports:
            shutil.move(str(p), dest / p.name)
        notes.append(f"archived {len(reports)} lucida report(s) to {dest}")
    removed = 0
    # Deepest first, so an artist folder emptied by its albums' removal goes too.
    for dirpath in sorted((d for d, _, _ in os.walk(inbox)), key=len, reverse=True):
        if Path(dirpath) == inbox:
            continue
        entries = os.listdir(dirpath)
        if any(os.path.isdir(os.path.join(dirpath, e)) for e in entries):
            continue
        if all(e.lower().endswith(LEFTOVER_EXTS) for e in entries):
            shutil.rmtree(dirpath)
            removed += 1
    if removed:
        notes.append(f"removed {removed} emptied folder(s)")
    return notes


def cmd_import(cfg: dict, args) -> int:
    inbox = Path(cfg["inbox"])
    if not inbox.is_dir():
        print(f"error: no inbox at {inbox}", file=sys.stderr)
        return 1
    deezer = load_tool("fix-from-deezer.py", "tokyo_deezer")
    discs = deezer.discs
    discs.require_mutagen()
    token = discs.read_token(argparse.Namespace(token=None, token_env="JELLYFIN_TOKEN",
                                                token_file=discs.DEFAULT_TOKEN_FILE))

    print(f"scanning {inbox}")
    folders, errors = deezer.scan(str(inbox))
    if errors:
        for e in errors:
            print(f"  ! {e}")
    if not folders:
        print("Nothing to import.")
        return 0

    # 1. Ogg files with a broken last page cannot be tagged.
    broken = [f.path for _, files in folders for f in files if deezer.ogg_tail_broken(f.path)]
    if broken:
        print(f"\n{len(broken)} Ogg file(s) end in a broken page and will be repaired.")
        if args.apply:
            for path in broken:
                dropped = deezer.repair_ogg_tail(path)
                print(f"  repaired {os.path.relpath(path, inbox)} ({dropped} bytes dropped)")
            folders, _ = deezer.scan(str(inbox))

    # 2. Genres and box-set discs, before anything reaches the library.
    known = {}
    cache = Path("~/.cache/tokyo-music/artist-genres.json").expanduser()
    if cache.exists() and time.time() - cache.stat().st_mtime < 86400:
        known = json.loads(cache.read_text(encoding="utf-8"))
    elif token and cfg["jellyfin_url"]:
        print("reading artist genres from Jellyfin (cached for a day)", flush=True)
        try:
            known = jellyfin_artist_genres(cfg["jellyfin_url"], token)
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(known), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            print(f"  (could not read artist genres from Jellyfin: {exc})")
    dz = deezer.Deezer(str(HERE.parent / "deezer-cache.json"))
    mb = deezer.MusicBrainz(str(HERE.parent / "musicbrainz-cache.json"))
    try:
        plans = [deezer.plan_album(dz, folder, files, 0.8, True, True) for folder, files in folders]
        deezer.fill_missing_genres(plans, mb, known)
    finally:
        dz.save()
        mb.save()
    changes = [(p, f, c) for p in plans for f in p.files
               if (c := deezer.file_changes(p, f, True))]
    print(f"\nTags: {len(changes)} file(s) to update")
    for p in plans:
        rel = os.path.relpath(p.folder, inbox)
        genre = ", ".join(p.genres) or "no genre found"
        extra = f"; {len(p.discs)} disc/track fixes" if p.discs else ""
        note = f"  ({p.note})" if p.note and not p.discs else ""
        print(f"  {rel}: {genre} [{p.genre_source or '-'}]{extra}{note}")
        if mixed_editions(p.files):
            print(f"    ! {rel} looks like two editions in one folder; check it before importing")
    if args.apply and changes:
        log = Path(CONFIG_DIR / "import-undo" / f"{time.strftime('%Y-%m-%d_%H%M%S')}.json")
        log.parent.mkdir(parents=True, exist_ok=True)
        records = [deezer.write_file(f, c) for _, f, c in changes]
        log.write_text(json.dumps(records, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"  wrote and verified {len(records)} file(s); undo with "
              f"tools/fix-from-deezer.py --undo {log}")

    # 3. Copy into the library.
    canonical = canonical_map()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(canonical, fh)
        canon_path = fh.name
    argv = [str(inbox), "--library", cfg["library"], "--canonical", canon_path, "--skip-existing"]
    if args.apply:
        argv += ["--apply", "--move"]
        if token and cfg["jellyfin_url"]:
            os.environ.setdefault("JELLYFIN_TOKEN", token)
            argv += ["--jellyfin-url", cfg["jellyfin_url"]]
    print()
    try:
        # A dry run has not written the disc fixes yet; let the order check see them.
        planned = {str(Path(path).resolve()): (disc, track)
                   for p in plans for path, (disc, track, _) in p.discs.items()}
        code = load_tool("import-music.py", "tokyo_import").main(argv, planned)
    finally:
        os.remove(canon_path)

    # 4. Clean up what the import moved out.
    if args.apply and code == 0:
        for note in clean_inbox(inbox, Path(cfg["archive"])):
            print(f"Inbox: {note}")
    return code


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tokyo-music", description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", type=Path, help="config file (default: ~/.config/tokyo-music/config.json)")
    sub = ap.add_subparsers(dest="command", required=True)
    d = sub.add_parser("discover", help="build album lists from the artists file")
    d.add_argument("--all-releases", action="store_true", help="include EPs and singles")
    d.add_argument("--refresh", action="store_true", help="re-discover artists that already have a list")
    dl = sub.add_parser("download", help="download every album list with lucida")
    dl.add_argument("--retry", action="store_true", help="download only the last run's failures")
    im = sub.add_parser("import", help="fix tags and import the inbox (dry run unless --apply)")
    im.add_argument("--apply", action="store_true", help="write tags, copy, and clean the inbox")
    args = ap.parse_args(argv)
    cfg = load_config(args.config)
    return {"discover": cmd_discover, "download": cmd_download, "import": cmd_import}[args.command](cfg, args)


if __name__ == "__main__":
    raise SystemExit(main())
