#!/usr/bin/env bash
# Copy Tokyo Music onto the machine running Jellyfin, through a local mount of
# its filesystem (sshfs, autofs, NFS…).
#
# Run this from your workstation. It only writes into the target user's home
# directory, so it needs no root. Installing the systemd service is a separate
# one-time step that does need sudo — see server-setup.sh.
#
# Configure by copying deploy/config.env.example to deploy/config.env, or pass
# values as environment variables:
#
#   ./deploy/deploy.sh
#   MOUNT=/mnt/media REMOTE_USER=bob ./deploy/deploy.sh
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# config.env supplies defaults; anything already in the environment wins.
if [[ -f "$SRC/deploy/config.env" ]]; then
  # shellcheck disable=SC1091
  while IFS='=' read -r key value; do
    [[ $key =~ ^[A-Z_]+$ ]] || continue
    [[ -n ${!key:-} ]] && continue
    [[ -n $value ]] && export "$key=$value"
  done < <(grep -E '^[A-Z_]+=' "$SRC/deploy/config.env" || true)
fi

MOUNT="${MOUNT:-/mnt/jellyfin}"
REMOTE_USER="${REMOTE_USER:-$USER}"
REMOTE_HOME="$MOUNT/home/$REMOTE_USER"
DEST="${DEST:-$REMOTE_HOME/tokyo-music}"
HOST_HINT="${REMOTE_HOST:-<jellyfin-host>}"

if [[ ! -d $MOUNT ]]; then
  echo "error: mount point $MOUNT does not exist." >&2
  echo "Set MOUNT in deploy/config.env to where the server is mounted." >&2
  exit 1
fi

if [[ ! -d $REMOTE_HOME ]]; then
  echo "error: $REMOTE_HOME not found." >&2
  echo "Is the server mounted, and is REMOTE_USER correct? (currently '$REMOTE_USER')" >&2
  exit 1
fi

echo "Deploying Tokyo Music"
echo "  from: $SRC"
echo "    to: $DEST"

mkdir -p "$DEST"

# --delete keeps the target clean; the excludes guard local-only files.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '*.pyc' \
    --exclude '__pycache__' \
    --exclude 'deploy/config.env' \
    "$SRC"/ "$DEST"/
else
  echo "  (rsync not found, falling back to cp)"
  rm -rf "${DEST:?}"/*
  cp -r "$SRC"/index.html "$SRC"/css "$SRC"/js "$SRC"/serve.py "$SRC"/deploy "$DEST"/
  [[ -f "$SRC/README.md" ]] && cp "$SRC/README.md" "$DEST"/
  rm -f "$DEST/deploy/config.env"
fi

chmod +x "$DEST/serve.py" "$DEST/deploy/"*.sh 2>/dev/null || true

echo
echo "Files are in place at ~/tokyo-music on the server."
echo
echo "If the service is already installed, restart it on the server with:"
echo "    sudo systemctl restart tokyo-music"
echo
echo "First time only, run this once on the server:"
echo "    ssh $REMOTE_USER@$HOST_HINT 'sudo bash ~/tokyo-music/deploy/server-setup.sh'"
