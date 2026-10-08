#!/usr/bin/env bash
# vula-bind-storage.sh — put a deployment's /data on the host tree.
#
# Coolify 4.3.23 refuses to create bind mounts through its API ("host_path ...
# is not allowed"), so a deployment's persistent storage is a Docker named
# volume whose data is then pointed at the client tree by hand. This script
# does that, safely:
#
#   vula-bind-storage.sh <coolify-app-uuid> <volume-name> <host-dir>
#
# It stops the app's container, makes sure <host-dir> holds the volume's
# current data (divergence is refused, never overwritten), parks the original
# payload under /root/vula-migration-backup, replaces the volume with a
# bind-backed one of the same name, and leaves the container stopped: deploy
# the app from Coolify so its container is recreated against the new storage.
# For a volume that has never been used (a brand-new deployment) there is
# nothing to copy — it just binds.
#
# Run on the Coolify host, with sudo. Idempotent: a volume that is already
# bind-backed exits without touching anything.
set -euo pipefail

UUID=${1:?usage: vula-bind-storage.sh <app-uuid> <volume-name> <host-dir>}
VOL=${2:?volume name required}
TARGET=${3:?host directory required}

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi

C=$(docker ps -a --format '{{.Names}}' | grep "^$UUID" | head -1 || true)
if [ -n "$C" ]; then echo "stopping $C"; docker stop "$C" >/dev/null; fi

if [ -n "$(docker volume inspect "$VOL" --format '{{index .Options "device"}}' 2>/dev/null)" ]; then
  echo "volume $VOL is already bind-backed — nothing to do"
  [ -n "$C" ] && docker start "$C" >/dev/null
  exit 0
fi

VOLSRC=$(docker volume inspect "$VOL" --format '{{.Mountpoint}}' 2>/dev/null || true)
if [ -n "$VOLSRC" ] && [ -d "$VOLSRC" ] && [ -n "$(ls -A "$VOLSRC" 2>/dev/null)" ]; then
  mkdir -p "$TARGET"
  if [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    if ! diff -rq "$VOLSRC" "$TARGET" >/dev/null 2>&1; then
      echo "REFUSING: $TARGET already holds data that differs from $VOLSRC" >&2
      echo "move the target aside (or pick another path) and run again" >&2
      [ -n "$C" ] && docker start "$C" >/dev/null
      exit 2
    fi
  else
    cp -a "$VOLSRC/." "$TARGET/"
  fi
  mkdir -p /root/vula-migration-backup
  mv "$VOLSRC" "/root/vula-migration-backup/${VOL}_data.$(date +%Y%m%d-%H%M%S)"
else
  mkdir -p "$TARGET"
fi

chown -R 1000:1000 "$TARGET"
[ -n "$C" ] && docker rm "$C" >/dev/null
docker volume rm "$VOL" >/dev/null 2>&1 || true
docker volume create --driver local --opt type=none --opt device="$TARGET" --opt o=bind "$VOL" >/dev/null
echo "bound: $VOL -> $TARGET"
echo "next: deploy the app from Coolify so its container is recreated against the new storage"
