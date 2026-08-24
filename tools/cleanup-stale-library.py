#!/usr/bin/env python3
"""Delete manifest-listed Jellyfin items under one obsolete path prefix."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def load_artwork_tool():
    path = Path(__file__).with_name("fill-missing-artwork.py")
    spec = importlib.util.spec_from_file_location("tokyo_cleanup_api", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


artwork = load_artwork_tool()
ORDER = {"Audio": 0, "MusicAlbum": 1, "MusicArtist": 2}


def beneath(path, prefix):
    prefix = prefix.rstrip("/")
    return path == prefix or path.startswith(prefix + "/")


def main():
    ap = argparse.ArgumentParser(description="Delete audited stale Jellyfin records")
    ap.add_argument("--manifest", default="stale-library-report.json")
    ap.add_argument("--result", default="stale-library-cleanup-result.json")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--confirm", help="must exactly match the manifest stale prefix")
    ap.add_argument("--url", default=artwork.DEFAULT_URL)
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN")
    ap.add_argument("--token-file", default=artwork.DEFAULT_TOKEN_FILE)
    ap.add_argument("--delay", type=float, default=0.02)
    args = ap.parse_args()
    if args.delay < 0:
        ap.error("--delay cannot be negative")

    manifest_path = Path(args.manifest).expanduser()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        ap.error(f"cannot read manifest {manifest_path}: {exc}")
    prefix = manifest.get("stale_prefix")
    records = manifest.get("records")
    if not prefix or not isinstance(records, list):
        ap.error("manifest is missing stale_prefix or records")
    if args.apply and args.confirm != prefix:
        ap.error(f"--confirm must be exactly {prefix!r}")
    invalid = [r for r in records if not beneath(r.get("path") or "", prefix)]
    if invalid:
        ap.error(f"manifest contains {len(invalid)} path(s) outside {prefix}")

    records.sort(key=lambda r: (ORDER.get(r.get("type"), 99), r.get("path") or ""))
    counts = Counter(r.get("type", "Unknown") for r in records)
    print(f"Manifest: {manifest_path}")
    print(f"Guarded prefix: {prefix}")
    print(f"Records: {len(records)} ({dict(counts)})")
    if not args.apply:
        print(f"Dry run — use --apply --confirm {prefix} to delete these records.")
        return 0

    try:
        token = artwork.read_token(args.token_env, args.token_file)
        client = artwork.Jellyfin(args.url, token)
        users = client.request("/Users") or []
        user = next((u for u in users if u.get("Policy", {}).get("IsAdministrator")),
                    users[0] if users else None)
        if not user:
            raise artwork.JellyfinError("Jellyfin returned no user for item verification")
        user_id = user["Id"]
    except artwork.JellyfinError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    result = {"started_at": datetime.now(timezone.utc).isoformat(),
              "prefix": prefix, "deleted": [], "already_gone": [],
              "skipped_path_changed": [], "errors": []}
    total = len(records)
    for index, record in enumerate(records, 1):
        item_id = record.get("id")
        try:
            current = client.request(f"/Items/{item_id}", params={"userId": user_id}) or {}
        except artwork.JellyfinError as exc:
            if "HTTP 404" in str(exc):
                result["already_gone"].append(record)
                continue
            result["errors"].append({**record, "error": str(exc), "phase": "verify"})
            continue
        live_path = current.get("Path") or ""
        if not beneath(live_path, prefix):
            result["skipped_path_changed"].append({**record, "live_path": live_path})
            continue
        try:
            client.request(f"/Items/{item_id}", method="DELETE")
            result["deleted"].append(record)
        except artwork.JellyfinError as exc:
            if "HTTP 404" in str(exc):
                result["already_gone"].append(record)
            else:
                result["errors"].append({**record, "error": str(exc), "phase": "delete"})
        if index % 100 == 0 or index == total:
            print(f"[{index}/{total}] deleted={len(result['deleted'])} "
                  f"gone={len(result['already_gone'])} errors={len(result['errors'])}",
                  flush=True)
        if args.delay:
            time.sleep(args.delay)

    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    result_path = Path(args.result).expanduser()
    result_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                           encoding="utf-8")
    print(f"Result: {result_path}")
    print(f"Deleted: {len(result['deleted'])}; already gone: {len(result['already_gone'])}; "
          f"path changed: {len(result['skipped_path_changed'])}; errors: {len(result['errors'])}")
    return 1 if result["errors"] or result["skipped_path_changed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
