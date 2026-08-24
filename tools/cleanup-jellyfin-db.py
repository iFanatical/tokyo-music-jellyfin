#!/usr/bin/env python3
"""Offline removal of one obsolete Jellyfin BaseItems subtree."""

from __future__ import annotations

import argparse
import datetime
import shutil
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = "/var/lib/jellyfin/data/jellyfin.db"


def main():
    ap = argparse.ArgumentParser(description="Remove an obsolete Jellyfin path subtree")
    ap.add_argument("--database", default=DEFAULT_DB)
    ap.add_argument("--prefix", default="/jellyfin/Music")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--confirm")
    args = ap.parse_args()
    if args.apply and args.confirm != args.prefix:
        ap.error(f"--confirm must be exactly {args.prefix!r}")

    database = Path(args.database)
    if not database.is_file():
        ap.error(f"database does not exist: {database}")
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA foreign_keys=ON")
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        ap.error("database failed integrity_check before cleanup")

    roots = connection.execute(
        "SELECT Id, Type, Name FROM BaseItems WHERE Path = ?", (args.prefix,)
    ).fetchall()
    if len(roots) != 1:
        ap.error(f"expected exactly one root at {args.prefix}, found {len(roots)}")
    root_id = roots[0][0]
    subtree_sql = """
        WITH RECURSIVE subtree(Id, Type, Path) AS (
          SELECT Id, Type, Path FROM BaseItems WHERE Id = ?
          UNION ALL
          SELECT child.Id, child.Type, child.Path
          FROM BaseItems child JOIN subtree parent ON child.ParentId = parent.Id
        )
    """
    rows = connection.execute(
        subtree_sql + " SELECT Type, COUNT(*) FROM subtree GROUP BY Type ORDER BY Type",
        (root_id,),
    ).fetchall()
    total = sum(count for _kind, count in rows)
    escapes = connection.execute(
        subtree_sql + " SELECT COUNT(*) FROM subtree WHERE NOT (Path = ? OR Path LIKE ?)",
        (root_id, args.prefix, args.prefix.rstrip("/") + "/%"),
    ).fetchone()[0]
    print(f"Root: {args.prefix} ({roots[0][2]})")
    print(f"Subtree records: {total}")
    for kind, count in rows:
        print(f"  {kind}: {count}")
    if escapes:
        ap.error(f"refusing cleanup: {escapes} descendant path(s) escape the prefix")
    if not args.apply:
        print("Dry run — database unchanged.")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = database.with_name(f"{database.name}.precleanup-{stamp}.bak")
    shutil.copy2(database, backup)
    backup.chmod(0o600)
    check = sqlite3.connect(f"file:{backup}?mode=ro", uri=True)
    if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        ap.error(f"pre-cleanup database copy failed integrity_check: {backup}")
    check.close()
    print(f"Verified database copy: {backup}")

    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM BaseItems WHERE Id = ?", (root_id,))
        remaining = connection.execute(
            "SELECT COUNT(*) FROM BaseItems WHERE Path = ? OR Path LIKE ?",
            (args.prefix, args.prefix.rstrip("/") + "/%"),
        ).fetchone()[0]
        foreign_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        if remaining or foreign_errors:
            raise RuntimeError(
                f"validation failed: remaining={remaining}, foreign_keys={len(foreign_errors)}"
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    connection.close()
    if integrity != "ok":
        print(f"CRITICAL: post-cleanup integrity_check: {integrity}", file=sys.stderr)
        return 2
    print(f"Deleted obsolete subtree ({total} records); integrity_check: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
