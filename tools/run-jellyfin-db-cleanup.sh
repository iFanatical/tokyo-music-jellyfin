#!/usr/bin/env bash
# Run on the Jellyfin server as root. Jellyfin is restarted through the trap.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
was_active=false
if systemctl is-active --quiet jellyfin; then
  was_active=true
  systemctl stop jellyfin
fi
restart() {
  if $was_active; then
    systemctl start jellyfin
  fi
}
trap restart EXIT

python3 "$SCRIPT_DIR/cleanup-jellyfin-db.py" \
  --apply --confirm /jellyfin/Music
