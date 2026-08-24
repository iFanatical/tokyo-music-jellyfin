#!/usr/bin/env python3
"""Audit Jellyfin items left behind under an obsolete media path.

This tool is intentionally read-only. It writes a JSON manifest suitable for
review before a separate, explicitly authorized cleanup operation.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


def load_artwork_tool():
    path = Path(__file__).with_name("fill-missing-artwork.py")
    spec = importlib.util.spec_from_file_location("tokyo_artwork_api", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


artwork = load_artwork_tool()


def beneath(path, prefix):
    prefix = prefix.rstrip("/")
    return path == prefix or path.startswith(prefix + "/")


def gather(client):
    artists = client.artists()
    media = client.paged("/Items", {
        "IncludeItemTypes": "MusicAlbum,Audio",
        "Recursive": "true",
        "Fields": "Path,AlbumArtist,Album,ParentId",
        "EnableImages": "false",
        "SortBy": "SortName",
    })
    return [("MusicArtist", item) for item in artists] + [
        (item.get("Type") or "Unknown", item) for item in media
    ]


def playlist_references(client, stale_ids):
    playlists = client.paged("/Items", {
        "IncludeItemTypes": "Playlist", "Recursive": "true",
        "Fields": "Path", "EnableImages": "false",
    })
    users = client.request("/Users") or []
    user_ids = [user.get("Id") for user in users if user.get("Id")]
    references, errors = defaultdict(list), []
    for playlist in playlists:
        data, last_error = None, None
        for user_id in user_ids or [None]:
            try:
                params = {"Fields": "Path", "Limit": 100000}
                if user_id:
                    params["userId"] = user_id
                data = client.request(f"/Playlists/{playlist['Id']}/Items",
                                      params=params) or {}
                break
            except artwork.JellyfinError as exc:
                last_error = exc
        if data is None:
            errors.append({"id": playlist.get("Id"),
                           "name": playlist.get("Name") or "Unknown",
                           "error": str(last_error)})
            continue
        for entry in data.get("Items", []):
            if entry.get("Id") in stale_ids:
                references[entry["Id"]].append({
                    "id": playlist["Id"], "name": playlist.get("Name") or "Unknown",
                })
    return references, len(playlists), errors


def build_report(items, stale_prefix, current_prefix, references, playlist_count,
                 playlist_errors):
    stale = [(kind, item) for kind, item in items
             if beneath(item.get("Path") or "", stale_prefix)]
    current = [(kind, item) for kind, item in items
               if beneath(item.get("Path") or "", current_prefix)]
    current_paths = {(kind, item.get("Path")): item for kind, item in current}
    current_names = defaultdict(list)
    for kind, item in current:
        current_names[(kind, (item.get("Name") or "").casefold())].append(item)

    records = []
    for kind, item in stale:
        path = item.get("Path") or ""
        relative = path[len(stale_prefix.rstrip("/")):].lstrip("/")
        expected = current_prefix.rstrip("/") + ("/" + relative if relative else "")
        path_match = current_paths.get((kind, expected))
        name_matches = current_names[(kind, (item.get("Name") or "").casefold())]
        records.append({
            "id": item.get("Id"),
            "type": kind,
            "name": item.get("Name") or "",
            "path": path,
            "expected_current_path": expected,
            "exact_current_path_id": path_match.get("Id") if path_match else None,
            "current_name_match_ids": [match.get("Id") for match in name_matches],
            "playlist_references": references.get(item.get("Id"), []),
        })

    type_counts = Counter(record["type"] for record in records)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stale_prefix": stale_prefix,
        "current_prefix": current_prefix,
        "summary": {
            "stale_records": len(records),
            "by_type": dict(sorted(type_counts.items())),
            "exact_current_path_matches": sum(bool(r["exact_current_path_id"]) for r in records),
            "records_with_current_name_matches": sum(bool(r["current_name_match_ids"]) for r in records),
            "records_referenced_by_playlists": sum(bool(r["playlist_references"]) for r in records),
            "playlists_checked": playlist_count,
            "unreadable_playlists": len(playlist_errors),
        },
        "playlist_errors": playlist_errors,
        "records": records,
    }


def main():
    ap = argparse.ArgumentParser(description="Audit stale Jellyfin library paths (read-only)")
    ap.add_argument("--url", default=artwork.DEFAULT_URL)
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN")
    ap.add_argument("--token-file", default=artwork.DEFAULT_TOKEN_FILE)
    ap.add_argument("--stale-prefix", default="/jellyfin/Music")
    ap.add_argument("--current-prefix", default="/srv/music/library")
    ap.add_argument("--report", default="stale-library-report.json")
    args = ap.parse_args()
    try:
        token = artwork.read_token(args.token_env, args.token_file)
        client = artwork.Jellyfin(args.url, token)
        items = gather(client)
        stale_ids = {item.get("Id") for _kind, item in items
                     if beneath(item.get("Path") or "", args.stale_prefix)}
        references, playlist_count, playlist_errors = playlist_references(client, stale_ids)
        report = build_report(items, args.stale_prefix, args.current_prefix,
                              references, playlist_count, playlist_errors)
    except artwork.JellyfinError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    path = Path(args.report).expanduser()
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(f"Stale records: {summary['stale_records']}")
    for kind, count in summary["by_type"].items():
        print(f"  {kind}: {count}")
    print(f"Exact current-path counterparts: {summary['exact_current_path_matches']}")
    print(f"Current same-name counterparts: {summary['records_with_current_name_matches']}")
    print(f"Referenced by playlists: {summary['records_referenced_by_playlists']} "
          f"across {summary['playlists_checked']} playlist(s)")
    print(f"Unreadable playlists: {summary['unreadable_playlists']}")
    print(f"Report: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
