#!/usr/bin/env bash
# Run on the Jellyfin host as root (normally through sudo). Stops Jellyfin long
# enough to make a consistent archive of its data and configuration.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "error: run this script with sudo on the Jellyfin host" >&2
  exit 1
fi

OWNER="${SUDO_USER:-root}"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
[[ -n $OWNER_HOME ]] || { echo "error: cannot find home for $OWNER" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-$OWNER_HOME/jellyfin-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/jellyfin-$STAMP.tar.gz"

install -d -m 0700 -o "$OWNER" -g "$OWNER" "$BACKUP_DIR"

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

tar --acls --xattrs --numeric-owner -C / -czf "$ARCHIVE" \
  var/lib/jellyfin etc/jellyfin
chown "$OWNER:$OWNER" "$ARCHIVE"
chmod 0600 "$ARCHIVE"

tar -tzf "$ARCHIVE" >/dev/null
printf 'Verified backup: %s\n' "$ARCHIVE"
