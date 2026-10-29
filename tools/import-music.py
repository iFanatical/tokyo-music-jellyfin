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
_disc_tool = None
AUDIO_EXTS = {"flac", "mp3", "m4a", "mp4", "ogg", "oga", "opus", "wma"}
# Album artwork copied along with an album's audio; lyrics travel per track.
COVER_NAMES = {"cover.jpg", "cover.png", "folder.jpg", "folder.png"}
LYRIC_EXTS = (".lrc", ".elrc", ".txt")
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


def load_disc_tool():
    global _disc_tool
    if _disc_tool is None:
        path = Path(__file__).with_name("fix-disc-numbers.py")
        spec = importlib.util.spec_from_file_location("tokyo_music_discs", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _disc_tool = module
    return _disc_tool


@dataclass
class ImportItem:
    source: Path
    artists: list[str]
    albumartists: list[str]
    title: str
    album: str
    library_artist: str = ""
    destination: Path | None = None
    track: int | None = None
    disc: int | None = None
    skipped: bool = False  # album already in the library (--skip-existing)


CONTROL_RX = re.compile(r"[\x00-\x1f\x7f]")


def safe_component(value: str) -> str:
    """Return one readable path component with traversal made impossible."""
    value = CONTROL_RX.sub("", str(value)).replace("/", " - ").strip()
    # Jellyfin ignores dot-prefixed directories. Keep the original album tag,
    # but make names such as "...And Justice for All" visible on disk.
    value = value.lstrip(".").lstrip()
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
        try:
            track_no, disc_no = load_disc_tool().read_numbers(str(path))
        except Exception:  # noqa: BLE001 - numbering only feeds a warning
            track_no, disc_no = None, None
        items.append(ImportItem(path, artists, albumartists, str(title), str(album),
                                track=track_no, disc=disc_no))
    if not items and not errors:
        errors.append(f"{source}: no supported audio files found")
    return items, errors


def assign_destinations(items: list[ImportItem], library: Path, compilation_artist: str,
                        skip_existing: bool = False) -> list[str]:
    """Choose folders, recognizing tag-empty multi-artist compilations. With
    skip_existing, an album with any file already in the library is marked
    skipped as a whole instead of refusing the import."""
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
            if dest.exists() and skip_existing:
                for other in group:
                    other.skipped = True
            elif dest.exists():
                errors.append(f"destination already exists: {dest}")
    return errors


def sidecars(items: list[ImportItem]) -> list[tuple[Path, Path]]:
    """(source, destination) for covers and lyrics next to the imported audio.
    Existing files in the library are left alone."""
    out, seen = [], set()
    for item in items:
        if item.skipped or item.destination is None:
            continue
        folder, dest_dir = item.source.parent, item.destination.parent
        if folder not in seen:
            seen.add(folder)
            for path in sorted(folder.iterdir()):
                if path.is_file() and path.name.lower() in COVER_NAMES:
                    out.append((path, dest_dir / path.name))
        for ext in LYRIC_EXTS:
            lyric = item.source.with_suffix(ext)
            if lyric.is_file():
                out.append((lyric, item.destination.with_suffix(ext)))
    return [(src, dst) for src, dst in out if not dst.exists()]


def copy_sidecar(src: Path, dest: Path) -> None:
    temp = dest.parent / f".{dest.name}.tokyo-import-{uuid.uuid4().hex}.tmp"
    try:
        shutil.copy2(src, temp)
        if temp.stat().st_size != src.stat().st_size:
            raise RuntimeError(f"{src}: copy is incomplete")
        os.replace(temp, dest)
    finally:
        if temp.exists():
            temp.unlink()


def disc_number_warnings(items: list[ImportItem]) -> list[str]:
    """Albums whose numbering will make Jellyfin play tracks out of order.

    The usual cause is a ripper that restarts track numbers on each disc but
    writes no DISCNUMBER, so Jellyfin sorts every disc onto disc 1.
    """
    albums: dict[tuple[Path, str], list[ImportItem]] = {}
    for item in items:
        albums.setdefault((item.source.parent, item.album.casefold()), []).append(item)

    warnings = []
    for (folder, _), group in albums.items():
        pairs = [(i.disc, i.track) for i in group if i.track is not None]
        repeats = len(pairs) - len(set(pairs))
        if not repeats:
            continue
        name = group[0].album
        if all(i.disc is None for i in group):
            warnings.append(
                f"album {name!r}: {repeats} track number(s) repeat and no disc numbers are set, "
                f"so Jellyfin will interleave the discs. Fix before importing with:\n"
                f"      tools/fix-disc-numbers.py {str(folder)!r} --apply")
        else:
            warnings.append(
                f"album {name!r}: {repeats} file(s) share a disc+track number "
                f"(two copies of a track, or wrong disc tags); check {folder}")
    return warnings


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


def main(argv: list[str] | None = None,
         planned_numbers: dict[str, tuple[int, int]] | None = None) -> int:
    """`planned_numbers` maps a source path to the (disc, track) a caller is about
    to write, so a dry run warns about the numbering the import will really get."""
    ap = argparse.ArgumentParser(description="Import tagged audio into Artist/Album folders")
    ap.add_argument("source", help="inbox directory containing new audio")
    ap.add_argument("--library", default="/mnt/servers/jellyfin/srv/music/library")
    ap.add_argument("--apply", action="store_true", help="copy files (default: dry run)")
    ap.add_argument("--move", action="store_true", help="remove sources after every copy verifies")
    ap.add_argument("--canonical", help="JSON map of settled artist spellings")
    ap.add_argument("--fix-encoding", action="store_true")
    ap.add_argument("--compilation-artist", default="Various Artists")
    ap.add_argument("--skip-existing", action="store_true",
                    help="skip albums already in the library instead of refusing the import")
    ap.add_argument("--jellyfin-url", help="trigger a scan after a successful import")
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN",
                    help="environment variable holding the Jellyfin token")
    args = ap.parse_args(argv)

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
    for item in items:
        if planned := (planned_numbers or {}).get(str(item.source.resolve())):
            item.disc, item.track = planned
    errors.extend(assign_destinations(items, library, args.compilation_artist, args.skip_existing))
    skipped = [i for i in items if i.skipped]
    items = [i for i in items if not i.skipped]
    print(f"Found {len(items)} importable audio file(s).")
    for item in items:
        if item.destination:
            print(f"  {item.source.relative_to(source)} -> {item.destination.relative_to(library)}")
    if skipped:
        albums = sorted({str(i.source.parent.relative_to(source)) for i in skipped})
        print(f"\nSkipping {len(albums)} album(s) already in the library (left in {source}):")
        for album in albums:
            print(f"  {album}")
    extras = sidecars(items)
    if extras:
        print(f"\nAlso copying {len(extras)} cover/lyric file(s).")
    warnings = disc_number_warnings(items)
    if warnings:
        print(f"\nWarning: {len(warnings)} album(s) will play out of order in Jellyfin:")
        for warning in warnings:
            print(f"  {warning}")
    if errors:
        print(f"\nRefusing import: {len(errors)} problem(s):", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 2
    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply after reviewing this plan.")
        return 0

    completed, copied_extras = [], []
    try:
        for item in items:
            copy_one(item)
            completed.append(item)
        for src, dest in extras:
            copy_sidecar(src, dest)
            copied_extras.append(src)
    except Exception as exc:  # noqa: BLE001
        print(f"error: import stopped after {len(completed)} file(s): {exc}", file=sys.stderr)
        return 1

    if args.move:
        for item in completed:
            item.source.unlink()
        for src in copied_extras:
            src.unlink()
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
