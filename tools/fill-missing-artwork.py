#!/usr/bin/env python3
"""Ask Jellyfin's metadata providers to fill missing artist and album art.

Dry-run by default. Existing Primary artwork is never selected for refresh and
replaceAllImages=false is sent as a second guard against replacing curated art.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://jellyfin.bush.home.arpa:8096"
DEFAULT_TOKEN_FILE = "~/.config/tokyo-music/jellyfin-token"
DEFAULT_SERVER_ROOT = "/srv/music/library"
DEFAULT_MEDIA_ROOT = "/mnt/servers/jellyfin/srv/music/library"
DEFAULT_REVIEW_ROOT = "/mnt/servers/jellyfin/srv/music/review"
DEFAULT_STALE_PREFIX = "/jellyfin/Music"


class JellyfinError(RuntimeError):
    pass


class Jellyfin:
    def __init__(self, base: str, token: str):
        self.base = base.rstrip("/")
        self.token = token

    def request(self, path: str, *, method="GET", params=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, method=method)
        req.add_header(
            "Authorization",
            f'MediaBrowser Client="Tokyo Music Artwork", Device="cli", '
            f'DeviceId="tokyo-music-artwork", Version="1.0", Token="{self.token}"',
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read(500).decode("utf-8", "replace").strip()
            suffix = f": {detail}" if detail else ""
            raise JellyfinError(f"{method} {path} failed: HTTP {exc.code}{suffix}") from exc
        except urllib.error.URLError as exc:
            raise JellyfinError(f"cannot reach {self.base}: {exc.reason}") from exc
        return json.loads(body) if body else None

    def paged(self, path: str, params: dict, page_size=500):
        items, start = [], 0
        while True:
            page = self.request(path, params={
                **params, "StartIndex": start, "Limit": page_size,
            }) or {}
            got = page.get("Items", [])
            items.extend(got)
            if not got or len(got) < page_size:
                break
            start += len(got)
        return items

    def artists(self, library_id=None):
        params = {
            "Recursive": "true", "Fields": "Path",
            "EnableImageTypes": "Primary", "ImageTypeLimit": 1,
            "SortBy": "SortName",
        }
        if library_id:
            params["ParentId"] = library_id
        # Include track-only collaborators as well as album artists. Restricting
        # this to /Artists/AlbumArtists left featured performers permanently
        # without artwork even though they appear in Jellyfin's artist index.
        return self.paged("/Artists", params)

    def albums(self, library_id=None):
        params = {
            "IncludeItemTypes": "MusicAlbum", "Recursive": "true",
            "Fields": "Path,ProductionYear", "EnableImageTypes": "Primary",
            "ImageTypeLimit": 1, "SortBy": "SortName",
        }
        if library_id:
            params["ParentId"] = library_id
        return self.paged("/Items", params)

    def remote_primary(self, item_id: str):
        result = self.request(
            f"/Items/{item_id}/RemoteImages",
            params={"type": "Primary", "limit": 1, "includeAllLanguages": "false"},
        ) or {}
        images = result.get("Images", [])
        return images[0] if images else None

    def remote_providers(self, item_id: str):
        return self.request(f"/Items/{item_id}/RemoteImages/Providers") or []

    def download_primary(self, item_id: str, image_url: str):
        return self.request(
            f"/Items/{item_id}/RemoteImages/Download", method="POST",
            params={"type": "Primary", "imageUrl": image_url},
        )

    def item(self, item_id: str):
        return self.request(f"/Items/{item_id}") or {}

    def primary_is_visible(self, kind: str, item: dict) -> bool:
        """Check the image through an endpoint valid for the item type.

        Some Jellyfin releases return HTTP 400 for ``/Items/{id}`` when the
        id belongs to an artist stub.  The artist index still exposes the
        freshly downloaded ImageTags, so use it as the verification source.
        """
        if kind == "artist":
            matches = self.paged("/Artists", {
                "SearchTerm": item.get("Name") or "",
                "EnableImageTypes": "Primary", "ImageTypeLimit": 1,
            })
            current = next(
                (candidate for candidate in matches
                 if candidate.get("Id") == item.get("Id")),
                {},
            )
        else:
            current = self.item(item["Id"])
        return bool(current.get("ImageTags", {}).get("Primary"))


def missing_primary(items):
    return [item for item in items if not item.get("ImageTags", {}).get("Primary")]


def read_token(env_name: str, token_file: str) -> str:
    token = os.environ.get(env_name, "").strip()
    if token:
        return token
    path = Path(token_file).expanduser()
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise JellyfinError(
            f"no token in ${env_name} and could not read {path}: {exc.strerror}"
        ) from exc
    if not token:
        raise JellyfinError(f"token file is empty: {path}")
    return token


def label(item, kind):
    name = item.get("Name") or "Unknown"
    artist = item.get("AlbumArtist") if kind == "album" else None
    return f"{artist + ' — ' if artist else ''}{name}"


def collect(client: Jellyfin, mode: str, library_id=None):
    found = []
    if mode in {"artists", "both"}:
        found.extend(("artist", item) for item in missing_primary(client.artists(library_id)))
    if mode in {"albums", "both"}:
        found.extend(("album", item) for item in missing_primary(client.albums(library_id)))
    seen, result = set(), []
    for kind, item in found:
        key = (kind, item.get("Id"))
        if item.get("Id") and key not in seen:
            seen.add(key)
            result.append((kind, item))
    return result


def split_stale(items, stale_prefix):
    prefix = stale_prefix.rstrip("/")
    current, stale = [], []
    for kind, item in items:
        path = item.get("Path") or ""
        target = stale if path == prefix or path.startswith(prefix + "/") else current
        target.append((kind, item))
    return current, stale


def plan_review_moves(unresolved, server_root, media_root, review_root):
    """Map Jellyfin paths onto the SSHFS mount and reject unsafe moves."""
    server_root = Path(server_root)
    media_root = Path(media_root).resolve()
    review_root = Path(review_root).resolve()
    plans, errors, seen = [], [], set()
    for kind, item in unresolved:
        raw = item.get("Path")
        if not raw:
            errors.append(f"[{kind}] {label(item, kind)}: Jellyfin has no Path")
            continue
        try:
            relative = Path(raw).relative_to(server_root)
        except ValueError:
            errors.append(
                f"[{kind}] {label(item, kind)}: {raw} is outside {server_root}"
            )
            continue
        if relative == Path("."):
            errors.append(f"[{kind}] {label(item, kind)}: refusing to move the library root")
            continue
        source = media_root / relative
        destination = review_root / relative
        key = os.path.normcase(str(source))
        if key in seen:
            continue
        seen.add(key)
        if not source.exists():
            errors.append(f"[{kind}] {label(item, kind)}: mounted path does not exist: {source}")
        elif destination.exists():
            errors.append(f"[{kind}] {label(item, kind)}: review destination exists: {destination}")
        else:
            plans.append((kind, item, source, destination))
    return plans, errors


def perform_review_moves(plans):
    moved, errors = [], []
    for kind, item, source, destination in plans:
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
            moved.append((kind, item, source, destination))
        except OSError as exc:
            errors.append((kind, item, source, destination, str(exc)))
    return moved, errors


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fill missing artist/album Primary artwork using Jellyfin providers"
    )
    ap.add_argument("mode", nargs="?", choices=("artists", "albums", "both"),
                    default="artists")
    ap.add_argument("--apply", action="store_true",
                    help="request image refreshes (default: dry run)")
    ap.add_argument("--probe", action="store_true",
                    help="search providers without downloading images")
    ap.add_argument("--move", action="store_true",
                    help="preview with --probe or move no-result items with --apply")
    ap.add_argument("--url", default=DEFAULT_URL, help="Jellyfin server URL")
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN")
    ap.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    ap.add_argument("--library-id", help="restrict work to one Jellyfin music library")
    ap.add_argument("--limit", type=int, default=0,
                    help="process at most this many missing items (0: all)")
    ap.add_argument("--delay", type=float, default=1.1,
                    help="seconds between provider searches")
    ap.add_argument("--report", default="artwork-report.json",
                    help="JSON report written when --apply is used")
    ap.add_argument("--server-root", default=DEFAULT_SERVER_ROOT,
                    help="library root as Jellyfin reports it")
    ap.add_argument("--media-root", default=DEFAULT_MEDIA_ROOT,
                    help="matching library root on this machine")
    ap.add_argument("--review-root", default=DEFAULT_REVIEW_ROOT,
                    help="where --move places no-result items")
    ap.add_argument("--stale-prefix", default=DEFAULT_STALE_PREFIX,
                    help="obsolete Jellyfin path prefix to exclude")
    args = ap.parse_args()
    if args.limit < 0 or args.delay < 0:
        ap.error("--limit and --delay cannot be negative")
    if args.move and not (args.apply or args.probe):
        ap.error("--move requires --probe (preview) or --apply")
    if args.move and args.mode == "both":
        ap.error("--move requires either artists or albums, not both (their paths overlap)")

    try:
        client = Jellyfin(args.url, read_token(args.token_env, args.token_file))
        candidates, stale = split_stale(
            collect(client, args.mode, args.library_id), args.stale_prefix
        )
    except JellyfinError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    total = len(candidates)
    if stale:
        print(f"Ignoring {len(stale)} stale item(s) under {args.stale_prefix}.")
    selected = candidates[:args.limit or None]
    print(f"Found {total} {args.mode} item(s) missing Primary artwork.")
    if args.limit and total > len(selected):
        print(f"Showing first {len(selected)} because --limit={args.limit}.")
    for kind, item in selected:
        print(f"  [{kind}] {label(item, kind)}  id={item['Id']}")

    if not selected:
        return 0
    if args.probe and args.apply:
        ap.error("--probe and --apply are mutually exclusive")
    if args.probe:
        found, no_result, errors, unresolved_probe = 0, 0, 0, []
        for index, (kind, item) in enumerate(selected, 1):
            try:
                image = client.remote_primary(item["Id"])
                if image and image.get("Url"):
                    found += 1
                    provider = image.get("ProviderName") or "unknown provider"
                    print(f"[{index}/{len(selected)}] found via {provider}: {label(item, kind)}")
                else:
                    no_result += 1
                    unresolved_probe.append((kind, item))
                    providers = client.remote_providers(item["Id"])
                    names = ", ".join(p.get("Name", "") for p in providers if p.get("Name"))
                    suffix = f" (providers: {names})" if names else " (no remote image providers)"
                    print(f"[{index}/{len(selected)}] no provider result{suffix}: {label(item, kind)}")
            except JellyfinError as exc:
                errors += 1
                print(f"[{index}/{len(selected)}] FAILED: {label(item, kind)}: {exc}",
                      file=sys.stderr)
            if index < len(selected) and args.delay:
                time.sleep(args.delay)
        if args.move and unresolved_probe:
            plans, move_errors = plan_review_moves(
                unresolved_probe, args.server_root, args.media_root, args.review_root
            )
            print("\nReview move preview:")
            for _kind, _item, source, destination in plans:
                print(f"  {source} -> {destination}")
            for error in move_errors:
                print(f"  CANNOT MOVE: {error}", file=sys.stderr)
            errors += len(move_errors)
        print(f"\nProvider results: {found}; no result: {no_result}; errors: {errors}")
        return 1 if errors else 0
    if not args.apply:
        print("\nDry run — nothing changed. Re-run with --apply to request artwork.")
        return 0

    report, filled, unresolved, failed = [], [], [], []
    for index, (kind, item) in enumerate(selected, 1):
        entry = {"kind": kind, "id": item["Id"], "name": label(item, kind)}
        try:
            image = client.remote_primary(item["Id"])
            if not image or not image.get("Url"):
                entry["status"] = "no-provider-result"
                unresolved.append((kind, item))
                print(f"[{index}/{len(selected)}] no provider result: {label(item, kind)}")
            else:
                entry["provider"] = image.get("ProviderName")
                client.download_primary(item["Id"], image["Url"])
                if client.primary_is_visible(kind, item):
                    entry["status"] = "filled"
                    filled.append((kind, item))
                    print(f"[{index}/{len(selected)}] filled: {label(item, kind)}")
                else:
                    entry["status"] = "downloaded-but-not-visible"
                    unresolved.append((kind, item))
                    print(f"[{index}/{len(selected)}] downloaded but not visible: {label(item, kind)}")
        except JellyfinError as exc:
            entry["status"] = "error"
            entry["error"] = str(exc)
            failed.append((kind, item, str(exc)))
            print(f"[{index}/{len(selected)}] FAILED: {label(item, kind)}: {exc}",
                  file=sys.stderr)
        report.append(entry)
        if index < len(selected) and args.delay:
            time.sleep(args.delay)

    moved = []
    if args.move and unresolved:
        plans, move_errors = plan_review_moves(
            unresolved, args.server_root, args.media_root, args.review_root
        )
        if move_errors:
            print("\nNo files were moved because review-path validation failed:",
                  file=sys.stderr)
            for error in move_errors:
                print(f"  {error}", file=sys.stderr)
            failed.extend(("move", {"Name": error}, error) for error in move_errors)
        else:
            moved, move_failures = perform_review_moves(plans)
            moved_ids = {item["Id"] for _kind, item, _source, _dest in moved}
            for entry in report:
                if entry["id"] in moved_ids:
                    entry["status"] = "moved-for-review"
            for kind, item, source, destination in moved:
                print(f"Moved [{kind}] {source} -> {destination}")
            for kind, item, source, destination, error in move_failures:
                message = f"{source} -> {destination}: {error}"
                failed.append((kind, item, message))
                print(f"move failed: {message}", file=sys.stderr)

    report_path = Path(args.report).expanduser()
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8")

    print(f"\nFilled: {len(filled)}; still missing: {len(unresolved) - len(moved)}; "
          f"moved: {len(moved)}; errors: {len(failed)}")
    if unresolved:
        print("No provider result was found for:")
        for kind, item in unresolved:
            print(f"  [{kind}] {label(item, kind)}")
    print(f"Report: {report_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
