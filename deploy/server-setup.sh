#!/usr/bin/env bash
# One-time systemd install. Run this ON the machine that will serve the app,
# with sudo, from wherever you deployed it:
#
#   sudo bash ~/tokyo-music/deploy/server-setup.sh
#
# Nothing is hardcoded: the install directory is taken from this script's own
# location and the service user from that directory's owner. Override with
# APP_DIR, RUN_USER, PORT or BIND if you want something else.
#
# Re-running it is safe: it reinstalls the unit and restarts the service.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TEMPLATE="$APP_DIR/deploy/tokyo-music.service.template"
UNIT_DEST="/etc/systemd/system/tokyo-music.service"

# Run as whoever owns the deployed files, not as root.
RUN_USER="${RUN_USER:-$(stat -c '%U' "$APP_DIR")}"
RUN_GROUP="${RUN_GROUP:-$(stat -c '%G' "$APP_DIR")}"
PORT="${PORT:-8097}"
BIND="${BIND:-0.0.0.0}"

[[ -f "$APP_DIR/index.html" ]] || { echo "error: no app at $APP_DIR — deploy first" >&2; exit 1; }
[[ -f $TEMPLATE ]] || { echo "error: missing $TEMPLATE" >&2; exit 1; }

PYTHON="$(command -v python3 || true)"
[[ -n $PYTHON ]] || { echo "error: python3 not installed" >&2; exit 1; }

if [[ $RUN_USER == root ]]; then
  echo "warning: $APP_DIR is owned by root, so the service would run as root." >&2
  echo "         Pass RUN_USER=<user> to run it unprivileged instead." >&2
fi

echo "Installing tokyo-music.service"
echo "  app dir : $APP_DIR"
echo "  user    : $RUN_USER:$RUN_GROUP"
echo "  listen  : $BIND:$PORT"

# Render the template. Paths go through sed's alternate delimiter to survive
# slashes; nothing here contains '|'.
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__RUN_USER__|$RUN_USER|g" \
    -e "s|__RUN_GROUP__|$RUN_GROUP|g" \
    -e "s|__PYTHON__|$PYTHON|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__BIND__|$BIND|g" \
    "$TEMPLATE" > "$UNIT_DEST.tmp"
# Guard against a typo'd placeholder silently installing a broken unit.
# Comment lines are exempt so the template's own header can describe them.
if grep -qE '^[^#]*__[A-Z_]+__' "$UNIT_DEST.tmp"; then
  echo "error: unsubstituted placeholders remain in the unit file:" >&2
  grep -nE '^[^#]*__[A-Z_]+__' "$UNIT_DEST.tmp" >&2
  rm -f "$UNIT_DEST.tmp"
  exit 1
fi
install -m 0644 "$UNIT_DEST.tmp" "$UNIT_DEST"
rm -f "$UNIT_DEST.tmp"

systemctl daemon-reload
systemctl enable tokyo-music
systemctl restart tokyo-music
sleep 1

if systemctl is-active --quiet tokyo-music; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  echo "Tokyo Music is running."
  echo "  http://${IP:-<server-ip>}:$PORT"
  echo "  http://$(hostname):$PORT"
else
  echo "Service failed to start. Recent log:" >&2
  journalctl -u tokyo-music -n 30 --no-pager >&2
  exit 1
fi

# Open the port if a firewall is active; harmless when none is configured.
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "Opening port $PORT in ufw"
  ufw allow "$PORT"/tcp >/dev/null || true
fi

echo
echo "Useful commands:"
echo "  systemctl status tokyo-music"
echo "  journalctl -u tokyo-music -f"
echo "  systemctl restart tokyo-music"
