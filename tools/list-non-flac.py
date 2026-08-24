#!/usr/bin/env python3
"""List non-FLAC files or write a LibreOffice-compatible audio report."""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter
from pathlib import Path

DEFAULT_LIBRARY = "/mnt/servers/jellyfin/srv/music/library"
AUDIO_EXTS = {
    ".aac", ".aif", ".aiff", ".alac", ".m4a", ".m4b", ".mp3", ".mp4",
    ".oga", ".ogg", ".opus", ".wav", ".wave", ".wma",
}


def non_flac_files(root: Path, audio_only=False):
    for directory, names, files in os.walk(root):
        names.sort()
        for name in sorted(files):
            path = Path(directory) / name
            suffix = path.suffix.casefold()
            if suffix != ".flac" and (not audio_only or suffix in AUDIO_EXTS):
                yield path


def safe_cell(value):
    """Prevent a filename or tag from becoming a spreadsheet formula."""
    value = "" if value is None else str(value)
    return "'" + value if value.startswith(("=", "+", "-", "@")) else value


def metadata(path):
    try:
        import mutagen
        audio = mutagen.File(path, easy=True)
    except Exception:  # unreadable tags should not omit the file from the report
        return {}
    if audio is None:
        return {}
    def first(name):
        value = audio.get(name, [])
        return str(value[0]) if value else ""
    return {
        "artist": first("artist"), "album_artist": first("albumartist"),
        "album": first("album"), "title": first("title"),
        "track": first("tracknumber"), "date": first("date"),
    }


def write_csv(paths, root, output):
    fields = [
        "relative_path", "file_name", "extension", "size_bytes", "size_mib",
        "artist", "album_artist", "album", "title", "track", "date",
    ]
    with output.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for path in paths:
            tags = metadata(path)
            size = path.stat().st_size
            row = {
                "relative_path": path.relative_to(root), "file_name": path.name,
                "extension": path.suffix.casefold().lstrip("."),
                "size_bytes": size, "size_mib": f"{size / 1048576:.2f}", **tags,
            }
            writer.writerow({key: safe_cell(row.get(key, "")) for key in fields})


def main() -> int:
    ap = argparse.ArgumentParser(description="List files that are not FLAC")
    ap.add_argument("path", nargs="?", default=DEFAULT_LIBRARY)
    ap.add_argument("--null", action="store_true",
                    help="separate paths with NUL bytes for safe piping")
    ap.add_argument("--audio-only", action="store_true",
                    help="exclude artwork, text, and other non-audio files")
    ap.add_argument("--csv", metavar="FILE",
                    help="write a UTF-8 spreadsheet report with audio metadata")
    args = ap.parse_args()
    root = Path(args.path).resolve()
    if not root.is_dir():
        ap.error(f"not a directory: {root}")
    if args.csv and args.null:
        ap.error("--csv and --null cannot be combined")

    # A spreadsheet is a track report, so non-audio sidecars are excluded even
    # when --audio-only is omitted.
    paths = list(non_flac_files(root, audio_only=args.audio_only or bool(args.csv)))
    if args.csv:
        output = Path(args.csv).expanduser().resolve()
        write_csv(paths, root, output)
        print(f"Wrote {len(paths)} non-FLAC track(s) to {output}")
        return 0

    counts, total = Counter(), 0
    separator = "\0" if args.null else "\n"
    for path in paths:
        sys.stdout.write(str(path) + separator)
        counts[path.suffix.casefold() or "<no extension>"] += 1
        total += 1
    sys.stdout.flush()
    summary = ", ".join(f"{ext}: {count}" for ext, count in sorted(counts.items()))
    print(f"Found {total} non-FLAC file(s){': ' + summary if summary else ''}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
