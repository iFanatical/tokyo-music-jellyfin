#!/usr/bin/env python3
"""Minimal static file server for Tokyo Music.

Serves the app directory over HTTP with correct MIME types for ES modules and
revalidate-always caching, so a redeploy is picked up without a hard refresh.

    ./serve.py                 # 0.0.0.0:8097, serves this file's directory
    ./serve.py --port 9000
    ./serve.py --root /srv/tokyo-music --bind 127.0.0.1
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import signal
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Python's mimetypes DB varies by distro; pin the ones that matter for the app.
EXTRA_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
}


class Handler(SimpleHTTPRequestHandler):
    server_version = "TokyoMusic"
    sys_version = ""
    # The app loads ~15 ES modules; keep-alive avoids a connection per file.
    # Safe here because the base handler always sets Content-Length.
    protocol_version = "HTTP/1.1"

    def guess_type(self, path):  # noqa: A003 - matches base class name
        ext = Path(path).suffix.lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        # The app has no content hashing, so always revalidate rather than
        # risk serving a stale bundle after an update.
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")
        return None

    def log_message(self, fmt, *args):
        # One compact line per request; journald adds its own timestamp.
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    default_root = Path(__file__).resolve().parent

    ap = argparse.ArgumentParser(description="Serve the Tokyo Music web app.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8097)))
    ap.add_argument("--bind", default=os.environ.get("BIND", "0.0.0.0"))
    ap.add_argument("--root", default=os.environ.get("ROOT", str(default_root)))
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not (root / "index.html").is_file():
        print(f"error: no index.html in {root}", file=sys.stderr)
        return 1

    for ext, ctype in EXTRA_TYPES.items():
        mimetypes.add_type(ctype, ext)

    handler = partial(Handler, directory=str(root))
    httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    httpd.daemon_threads = True

    def shutdown(_signum, _frame):
        print("shutting down", file=sys.stderr)
        # Must not block the signal handler; close from another thread.
        import threading

        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"Tokyo Music serving {root} on http://{args.bind}:{args.port}", file=sys.stderr)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
