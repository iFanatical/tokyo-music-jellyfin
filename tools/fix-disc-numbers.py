#!/usr/bin/env python3
"""Write missing disc numbers on multi-disc albums.

THE PROBLEM
    Some rippers number each disc of a box set from 1 again but never write
    DISCNUMBER. Jellyfin sorts an album by disc, then track, so every disc
    collapses onto "disc 1": all the track 1s play together, then all the
    track 2s, and so on. The filenames usually still carry the real order
    ("01.", "13.", "088."), because the ripper numbered those continuously.

THE RULE
    Within one album folder, files are taken in filename order. Each time the
    track number drops back (13 -> 1), a new disc starts. The result is only
    trusted when every file has a filename number, those numbers strictly
    increase, and every disc runs 1, 2, 3... without repeats. Anything else is
    reported for a human to look at and left untouched:

      partial     some files already have a disc number, others do not
      clash       disc numbers exist but two files share a disc+track
      ambiguous   the order cannot be proven (two rips mixed in one folder,
                  no filename numbers, a disc not starting at 1, ...)

    Single-disc albums are never touched.

SAFETY
    Dry run unless --apply. Only files without any disc tag are written, so an
    undo just removes what this tool added: every write is recorded in the
    undo log (saved after each album) and --undo LOG reverses it. After each
    write the file is re-read and the audio must be unchanged (length, sample
    rate and, for FLAC, the stream MD5), or the run stops. --backup-dir also
    keeps full copies, which is slow over a network mount.

    A plain Jellyfin scan does not re-read tags it already holds, so with
    --jellyfin-url the changed albums are refreshed with replaceAllMetadata
    and the library is rescanned (the same sequence as fix-artist-tags.py).

USAGE
    tools/fix-disc-numbers.py /path/to/music                     # dry run
    tools/fix-disc-numbers.py /path/to/music --apply --limit 5   # first 5 albums
    tools/fix-disc-numbers.py "Artist/Album 1" "Artist/Album 2" --apply
    tools/fix-disc-numbers.py /path/to/music --apply --jellyfin-url URL
    tools/fix-disc-numbers.py --undo disc-number-undo.json

    Requires mutagen:  pip install mutagen  (a venv is fine)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

AUDIO_EXTS = {"flac", "mp3", "m4a", "mp4", "ogg", "oga", "opus", "wma"}
VORBIS_EXTS = {"flac", "ogg", "oga", "opus"}
LEADING_NUMBER = re.compile(r"^\s*(\d+)")
DEFAULT_TOKEN_FILE = "~/.config/tokyo-music/jellyfin-token"
DEFAULT_MEDIA_ROOT = "/mnt/servers/jellyfin/srv/music/library"
DEFAULT_SERVER_ROOT = "/srv/music/library"

# Every key this tool may write, per format. Undo restores exactly these.
DISC_KEYS = {
    "vorbis": ["discnumber", "disctotal", "totaldiscs"],
    "mp3": ["TPOS"],
    "mp4": ["disk"],
    "wma": ["WM/PartOfSet"],
}


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


try:
    import mutagen
    from mutagen.id3 import TPOS
except ImportError:  # pragma: no cover
    mutagen = None


def require_mutagen() -> None:
    if mutagen is None:
        die("mutagen is required:  pip install mutagen")


def parse_number(value) -> int | None:
    """'3', '3/12', (3, 12), 3 -> 3. Missing, zero or unreadable -> None."""
    # MP4 nests the pair in a list: [(3, 12)].
    while isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if isinstance(value, int):
        return value or None
    m = re.match(r"\s*(\d+)", str(value)) if value is not None else None
    return (int(m.group(1)) or None) if m else None


def kind(ext: str) -> str | None:
    if ext in VORBIS_EXTS:
        return "vorbis"
    if ext == "mp3":
        return "mp3"
    if ext in ("m4a", "mp4"):
        return "mp4"
    if ext == "wma":
        return "wma"
    return None


def _open(path: str):
    audio = mutagen.File(path)
    if audio is None:
        raise ValueError("unsupported or unreadable file")
    if audio.tags is None:
        audio.add_tags()
    return audio


def _get(audio, k: str, key: str):
    tags = audio.tags
    if k == "mp3":
        frame = tags.get(key)
        return frame.text[0] if frame and frame.text else None
    value = tags.get(key)
    if not value:
        return None
    # ASF attributes are objects; MP4 numbers are (n, total) tuples.
    return str(value[0]) if k == "wma" else value[0]


def read_numbers(path: str) -> tuple[int | None, int | None]:
    """(track, disc) from a file's tags; either may be None."""
    require_mutagen()
    ext = path.rsplit(".", 1)[-1].lower()
    k = kind(ext)
    if k is None:
        return None, None
    audio = _open(path)
    track_key = {"vorbis": "tracknumber", "mp3": "TRCK", "mp4": "trkn", "wma": "WM/TrackNumber"}[k]
    disc_key = DISC_KEYS[k][0]
    return parse_number(_get(audio, k, track_key)), parse_number(_get(audio, k, disc_key))


def _snapshot(audio, k: str) -> dict:
    """Current values of every disc key, as JSON-safe data for the undo log."""
    out = {}
    for key in DISC_KEYS[k]:
        if k == "mp3":
            frame = audio.tags.get(key)
            out[key] = list(frame.text) if frame else None
        elif k == "mp4":
            value = audio.tags.get(key)
            out[key] = [list(v) for v in value] if value else None
        else:
            value = audio.tags.get(key)
            out[key] = [str(v) for v in value] if value else None
    return out


def _restore(audio, k: str, snapshot: dict) -> None:
    for key, value in snapshot.items():
        if k == "mp3":
            audio.tags.delall(key)
            if value:
                audio.tags.add(TPOS(encoding=3, text=value))
        elif value is None:
            if key in audio.tags:
                del audio.tags[key]
        elif k == "mp4":
            audio.tags[key] = [tuple(v) for v in value]
        else:
            audio.tags[key] = value


def _set_disc(audio, k: str, disc: int, total: int) -> None:
    if k == "vorbis":
        audio.tags["discnumber"] = [str(disc)]
        # Both spellings are in use; Picard writes TOTALDISCS, others DISCTOTAL.
        audio.tags["disctotal"] = [str(total)]
        audio.tags["totaldiscs"] = [str(total)]
    elif k == "mp3":
        audio.tags.delall("TPOS")
        audio.tags.add(TPOS(encoding=3, text=[f"{disc}/{total}"]))
    elif k == "mp4":
        audio.tags["disk"] = [(disc, total)]
    elif k == "wma":
        audio.tags["WM/PartOfSet"] = [f"{disc}/{total}"]


def audio_fingerprint(audio) -> tuple:
    """Properties a tag write must never change."""
    info = audio.info
    return (
        round(getattr(info, "length", 0) or 0, 3),
        getattr(info, "sample_rate", None),
        getattr(info, "channels", None),
        getattr(info, "md5_signature", None),
    )


@dataclass
class Entry:
    path: str
    file_number: int | None
    track: int | None
    disc: int | None


@dataclass
class AlbumPlan:
    folder: str
    status: str  # fix | single | has-discs | partial | clash | ambiguous
    reason: str = ""
    discs: list[list[Entry]] = field(default_factory=list)


def plan_album(folder: str, entries: list[Entry]) -> AlbumPlan:
    """Decide whether a folder is a multi-disc album missing disc numbers."""
    with_disc = [e for e in entries if e.disc is not None]
    pairs = [(e.disc, e.track) for e in entries if e.track is not None]
    clashing = len(pairs) != len(set(pairs))

    if with_disc and len(with_disc) < len(entries):
        return AlbumPlan(folder, "partial",
                         f"{len(with_disc)} of {len(entries)} files have a disc number")
    if with_disc:
        return AlbumPlan(folder, "clash" if clashing else "has-discs",
                         "two files share a disc+track number" if clashing else "")
    if not clashing:
        return AlbumPlan(folder, "single")

    if any(e.track is None for e in entries):
        return AlbumPlan(folder, "ambiguous", "some files have no track number")
    if any(e.file_number is None for e in entries):
        return AlbumPlan(folder, "ambiguous", "some filenames do not start with a number")
    ordered = sorted(entries, key=lambda e: (e.file_number, e.path))
    numbers = [e.file_number for e in ordered]
    if len(set(numbers)) != len(numbers):
        return AlbumPlan(folder, "ambiguous",
                         "filename numbers repeat (two rips in one folder?)")

    discs = [[ordered[0]]]
    for prev, cur in zip(ordered, ordered[1:]):
        if cur.track <= prev.track:
            discs.append([cur])
        else:
            discs[-1].append(cur)
    for n, disc in enumerate(discs, 1):
        if disc[0].track != 1:
            return AlbumPlan(folder, "ambiguous",
                             f"disc {n} would start at track {disc[0].track}, not 1")
    return AlbumPlan(folder, "fix", discs=discs)


def scan(root: str) -> tuple[list[AlbumPlan], list[str]]:
    plans, errors, reported = [], [], 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        if len(plans) >= reported + 250:
            reported = len(plans)
            print(f"  ...{reported} folders read", file=sys.stderr, flush=True)
        audio = sorted(f for f in filenames
                       if not f.startswith(".") and f.rsplit(".", 1)[-1].lower() in AUDIO_EXTS)
        if not audio:
            continue
        entries = []
        for name in audio:
            path = os.path.join(dirpath, name)
            try:
                track, disc = read_numbers(path)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{path}: {exc}")
                continue
            m = LEADING_NUMBER.match(name)
            entries.append(Entry(path, int(m.group(1)) if m else None, track, disc))
        if entries:
            plans.append(plan_album(dirpath, entries))
    return plans, errors


def write_disc(path: str, disc: int, total: int, backup_dir: str | None, root: str) -> dict:
    """Write one file and verify it. Returns the undo record."""
    k = kind(path.rsplit(".", 1)[-1].lower())
    audio = _open(path)
    before = audio_fingerprint(audio)
    snapshot = _snapshot(audio, k)
    if backup_dir:
        dest = os.path.join(backup_dir, os.path.relpath(path, root).replace(os.sep, "__"))
        if not os.path.exists(dest):
            shutil.copy2(path, dest)
    _set_disc(audio, k, disc, total)
    audio.save()

    check = _open(path)
    if audio_fingerprint(check) != before:
        raise RuntimeError("audio properties changed after writing; stopping")
    if read_numbers(path)[1] != disc:
        raise RuntimeError("disc number did not read back")
    return {"path": path, "kind": k, "before": snapshot, "disc": disc, "total": total}


def undo(log_path: str) -> int:
    require_mutagen()
    with open(log_path, encoding="utf-8") as fh:
        records = json.load(fh)
    restored, failed = 0, []
    for rec in reversed(records):
        try:
            audio = _open(rec["path"])
            _restore(audio, rec["kind"], rec["before"])
            audio.save()
            restored += 1
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{rec['path']}: {exc}")
    print(f"restored {restored} file(s)")
    for f in failed:
        print(f"  ! {f}")
    print("Refresh the affected albums in Jellyfin (replace all metadata) to see the old order again.")
    return 1 if failed else 0


def load_tag_tool():
    path = Path(__file__).with_name("fix-artist-tags.py")
    spec = importlib.util.spec_from_file_location("tokyo_music_tags", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def read_token(args) -> str | None:
    if args.token:
        return args.token
    if os.environ.get(args.token_env):
        return os.environ[args.token_env].strip()
    path = os.path.expanduser(args.token_file)
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip() or None
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Write missing disc numbers on multi-disc albums.")
    ap.add_argument("paths", nargs="*", metavar="path",
                    help="music directories to scan: the library, or individual albums")
    ap.add_argument("--apply", action="store_true", help="write changes (default is a dry run)")
    ap.add_argument("--limit", type=int, help="fix at most this many albums, for staged runs")
    ap.add_argument("--undo-log", default="disc-number-undo.json",
                    help="where to record writes (default: %(default)s); appended to if it exists")
    ap.add_argument("--undo", metavar="LOG", help="reverse the writes recorded in LOG and exit")
    ap.add_argument("--backup-dir", help="also keep a full copy of every file before writing")
    ap.add_argument("--verbose", action="store_true", help="list every file in each planned album")
    ap.add_argument("--jellyfin-url", help="refresh the changed albums after applying")
    ap.add_argument("--token", help="Jellyfin API key (or use --token-env / --token-file)")
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN")
    ap.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    ap.add_argument("--media-root", default=DEFAULT_MEDIA_ROOT,
                    help="library path on this machine (default: %(default)s)")
    ap.add_argument("--server-root", default=DEFAULT_SERVER_ROOT,
                    help="the same path as Jellyfin sees it (default: %(default)s)")
    args = ap.parse_args()

    if args.undo:
        return undo(args.undo)
    if not args.paths:
        ap.error("a music directory is required")
    for path in args.paths:
        if not os.path.isdir(path):
            ap.error(f"not a directory: {path}")
    require_mutagen()
    paths = [os.path.abspath(p) for p in args.paths]
    # Names are shown relative to the folder above everything scanned.
    root = os.path.dirname(os.path.commonpath(paths)) if len(paths) == 1 else os.path.commonpath(paths)

    plans, errors = [], []
    for path in paths:
        print(f"scanning {path}")
        found, failed = scan(path)
        plans += found
        errors += failed
    by_status: dict[str, list[AlbumPlan]] = {}
    for p in plans:
        by_status.setdefault(p.status, []).append(p)
    fixes = by_status.get("fix", [])

    def rel(path):
        return os.path.relpath(path, root)

    print(f"  {len(plans)} folder(s): " + ", ".join(
        f"{len(v)} {k}" for k, v in sorted(by_status.items())))
    for p in fixes:
        sizes = "+".join(str(len(d)) for d in p.discs)
        print(f"  FIX  {rel(p.folder)}  ->  {len(p.discs)} discs ({sizes} tracks)")
        if args.verbose:
            for n, disc in enumerate(p.discs, 1):
                for e in disc:
                    print(f"         disc {n} track {e.track:>3}  {os.path.basename(e.path)}")
    for status in ("partial", "clash", "ambiguous"):
        for p in by_status.get(status, []):
            print(f"  SKIP {status:9} {rel(p.folder)}  ({p.reason})")
    for e in errors:
        print(f"  ! {e}")

    if args.limit is not None:
        fixes = fixes[:args.limit]
    if not fixes:
        print("\nNothing to fix.")
        return 0
    if not args.apply:
        print(f"\nDry run — nothing written. {len(fixes)} album(s) would be fixed; "
              "re-run with --apply.")
        return 0

    if args.backup_dir:
        os.makedirs(args.backup_dir, exist_ok=True)
    records = []
    if os.path.exists(args.undo_log):
        with open(args.undo_log, encoding="utf-8") as fh:
            records = json.load(fh)

    def save_log():
        tmp = args.undo_log + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=1, ensure_ascii=False)
        os.replace(tmp, args.undo_log)

    changed_dirs, written = set(), 0
    try:
        for p in fixes:
            total = len(p.discs)
            for n, disc in enumerate(p.discs, 1):
                for e in disc:
                    records.append(write_disc(e.path, n, total, args.backup_dir, root))
                    written += 1
            changed_dirs.add(p.folder)
            save_log()
            print(f"  wrote {rel(p.folder)}")
    except Exception as exc:  # noqa: BLE001
        save_log()
        print(f"\nSTOPPED after {written} file(s): {exc}", file=sys.stderr)
        print(f"undo log: {args.undo_log}", file=sys.stderr)
        return 1

    print(f"\nwrote and verified {written} file(s) in {len(changed_dirs)} album(s)")
    print(f"undo log: {args.undo_log}  (reverse with --undo {args.undo_log})")

    if args.jellyfin_url:
        token = read_token(args)
        if not token:
            print("error: no Jellyfin token; tags are written but Jellyfin was not refreshed",
                  file=sys.stderr)
            return 1
        load_tag_tool().refresh_jellyfin(args.jellyfin_url, token, changed_dirs,
                                         args.media_root, args.server_root)
    else:
        print("\nJellyfin still needs to re-read these albums: re-run with --jellyfin-url,"
              "\nor refresh each album with 'Replace all metadata' in the web UI.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
