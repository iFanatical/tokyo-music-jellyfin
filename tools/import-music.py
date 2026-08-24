#!/usr/bin/env python3
"""Safely import tagged audio into an Artist/Album Jellyfin library.

The command is a dry run unless --apply is supplied. It trusts embedded tags,
normalises the same conservative artist conventions as fix-artist-tags.py,
copies each file through a temporary file on the destination filesystem, and
only publishes it after re-reading and verifying its tags.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path


_tag_tool = None
AUDIO_EXTS = {"flac", "mp3", "m4a", "mp4", "ogg", "oga", "opus", "wma"}
UNSAFE_MULTIVALUE = {"wma"}


def load_tag_tool():
    global _tag_tool
    if _tag_tool is not None:
        return _tag_tool
    path = Path(__file__).with_name("fix-artist-tags.py")
    spec = importlib.util.spec_from_file_location("tokyo_music_tags", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    _tag_tool = module
    return _tag_tool


@dataclass
class ImportItem:
    source: Path
    artists: list[str]
    albumartists: list[str]
    title: str
    album: str
    library_artist: str = ""
    destination: Path | None = None


CONTROL_RX = re.compile(r"[\x00-\x1f\x7f]")


def safe_component(value: str) -> str:
    """Return one readable path component with traversal made impossible."""
    value = CONTROL_RX.sub("", str(value)).replace("/", " - ").strip()
    if value in {"", ".", ".."}:
        raise ValueError("empty or unsafe path component")
    return value


def normalise(values, canonical, fix_encoding):
    return load_tag_tool().split_artists(values, canonical, fix_encoding)


def scan_source(source: Path, canonical, fix_encoding: bool) -> tuple[list[ImportItem], list[str]]:
    tag_tool = load_tag_tool()
    items, errors = [], []
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.suffix.lower().lstrip(".") not in AUDIO_EXTS:
            continue
        track = tag_tool.Track(str(path))
        got = track.read()
        if not got:
            errors.append(f"{path}: unreadable or unsupported tags")
            continue
        artists, albumartists, title, album = got
        artists = normalise(artists, canonical, fix_encoding)
        # Jellyfin expects one album artist for stable album grouping. Match the
        # maintenance tool and keep the primary value if a ripper joined names.
        albumartists = normalise(albumartists, canonical, fix_encoding)[:1]
        if track.ext in UNSAFE_MULTIVALUE and len(artists) > 1:
            errors.append(f"{path}: WMA has multiple artists; fix it with --feat-in-title first")
            continue
        missing = [name for name, value in (("ARTIST", artists), ("TITLE", title), ("ALBUM", album)) if not value]
        if missing:
            errors.append(f"{path}: missing {', '.join(missing)} tag(s)")
            continue
        items.append(ImportItem(path, artists, albumartists, str(title), str(album)))
    if not items and not errors:
        errors.append(f"{source}: no supported audio files found")
    return items, errors


def assign_destinations(items: list[ImportItem], library: Path, compilation_artist: str) -> list[str]:
    """Choose folders, recognizing tag-empty multi-artist compilations."""
    album_groups: dict[tuple[Path, str], list[ImportItem]] = {}
    for item in items:
        # Source folder is part of the key so two artists importing albums with
        # a generic name such as "Greatest Hits" cannot be merged together.
        key = (item.source.parent, item.album.casefold())
        album_groups.setdefault(key, []).append(item)

    errors, claimed = [], {}
    for group in album_groups.values():
        explicit = {a for item in group for a in item.albumartists}
        track_artists = {item.artists[0] for item in group}
        if len(explicit) > 1:
            errors.append(f"album {group[0].album!r}: conflicting ALBUMARTIST tags: {sorted(explicit)}")
            continue
        group_artist = next(iter(explicit), "")
        if not group_artist:
            group_artist = next(iter(track_artists)) if len(track_artists) == 1 else compilation_artist

        for item in group:
            item.library_artist = group_artist
            try:
                artist_dir = safe_component(group_artist)
                album_dir = safe_component(item.album)
                filename = safe_component(item.source.name)
            except ValueError as exc:
                errors.append(f"{item.source}: {exc}")
                continue
            dest = library / artist_dir / album_dir / filename
            item.destination = dest
            key = os.path.normcase(str(dest))
            if key in claimed:
                errors.append(f"destination collision: {claimed[key]} and {item.source} -> {dest}")
            else:
                claimed[key] = item.source
            if dest.exists():
                errors.append(f"destination already exists: {dest}")
    return errors


def expected_tags(item: ImportItem):
    return item.artists, item.albumartists, item.title, item.album


def copy_one(item: ImportItem) -> None:
    tag_tool = load_tag_tool()
    dest = item.destination
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.parent / f".{dest.name}.tokyo-import-{uuid.uuid4().hex}.tmp{dest.suffix}"
    try:
        shutil.copy2(item.source, temp)
        track = tag_tool.Track(str(temp))
        if not track.read():
            raise RuntimeError("copied file could not be read")
        track.write(*expected_tags(item))
        if tag_tool.Track(str(temp)).read() != expected_tags(item):
            raise RuntimeError("tag verification failed after copy")
        os.replace(temp, dest)
    finally:
        if temp.exists():
            temp.unlink()


def scan_jellyfin(base: str, token: str) -> None:
    req = urllib.request.Request(base.rstrip("/") + "/Library/Refresh", method="POST")
    req.add_header(
        "Authorization",
        f'MediaBrowser Client="Tokyo Music Import", Device="cli", '
        f'DeviceId="tokyo-music-import", Version="1.0", Token="{token}"',
    )
    with urllib.request.urlopen(req, timeout=60):
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Import tagged audio into Artist/Album folders")
    ap.add_argument("source", help="inbox directory containing new audio")
    ap.add_argument("--library", default="/mnt/servers/jellyfin/srv/music/library")
    ap.add_argument("--apply", action="store_true", help="copy files (default: dry run)")
    ap.add_argument("--move", action="store_true", help="remove sources after every copy verifies")
    ap.add_argument("--canonical", help="JSON map of settled artist spellings")
    ap.add_argument("--fix-encoding", action="store_true")
    ap.add_argument("--compilation-artist", default="Various Artists")
    ap.add_argument("--jellyfin-url", help="trigger a scan after a successful import")
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN",
                    help="environment variable holding the Jellyfin token")
    args = ap.parse_args()

    source, library = Path(args.source).resolve(), Path(args.library).resolve()
    if not source.is_dir():
        ap.error(f"source is not a directory: {source}")
    if args.move and not args.apply:
        ap.error("--move requires --apply")
    if source == library or library in source.parents or source in library.parents:
        ap.error("source and library must not contain one another")

    canonical = {}
    if args.canonical:
        with open(args.canonical, encoding="utf-8") as fh:
            canonical = json.load(fh)
        if not isinstance(canonical, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in canonical.items()
        ):
            ap.error("--canonical must contain a JSON object of string pairs")

    items, errors = scan_source(source, canonical, args.fix_encoding)
    errors.extend(assign_destinations(items, library, args.compilation_artist))
    print(f"Found {len(items)} importable audio file(s).")
    for item in items:
        if item.destination:
            print(f"  {item.source.relative_to(source)} -> {item.destination.relative_to(library)}")
    if errors:
        print(f"\nRefusing import: {len(errors)} problem(s):", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 2
    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply after reviewing this plan.")
        return 0

    completed = []
    try:
        for item in items:
            copy_one(item)
            completed.append(item)
    except Exception as exc:  # noqa: BLE001
        print(f"error: import stopped after {len(completed)} file(s): {exc}", file=sys.stderr)
        return 1

    if args.move:
        for item in completed:
            item.source.unlink()
    if args.jellyfin_url:
        token = os.environ.get(args.token_env)
        if not token:
            print(f"error: {args.token_env} is not set; files imported but Jellyfin was not scanned",
                  file=sys.stderr)
            return 1
        try:
            scan_jellyfin(args.jellyfin_url, token)
        except Exception as exc:  # noqa: BLE001
            print(f"error: files imported but Jellyfin scan failed: {exc}", file=sys.stderr)
            return 1

    print(f"Imported and verified {len(completed)} file(s).")
    if args.jellyfin_url:
        print("Jellyfin library scan triggered.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
