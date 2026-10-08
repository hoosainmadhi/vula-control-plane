#!/usr/bin/env bash
# vula-backup.sh — nightly SQLite backups for the whole Vula fleet on this host.
# Install:  scp to the host, chmod +x, add to root's crontab:
#   10 2 * * * /usr/local/bin/vula-backup.sh
# Requires: sqlite3, docker (for the legacy-volume fallback), rsync (off-host copy).
#
# The fleet lives on bind-backed volumes in one tree (migrated 2026-10-06):
#   /data/apps/vula-app/control-plane/<env>/control-plane.db
#   /data/apps/vula-app/clients/<client>/head-office/head-office.db
#   /data/apps/vula-app/clients/<client>/stores/<store>/za-pos.db
# The backup mirrors that tree, so a restore is a copy back into place.
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
DEST=/backups/vula-app
ROOT=/data/apps/vula-app

backup() { # db-path relative-dest
  local db=$1 rel=$2
  [ -e "$db" ] || return 0
  mkdir -p "$DEST/$rel"
  sqlite3 "$db" ".backup '$DEST/$rel/$(basename "$db" .db)-$STAMP.db'"
  echo "backed up: $db -> $DEST/$rel"
}

# The bind tree, walked in its own shape. The demo fleet (clients named
# `demo-*` or `*-demo`) is SKIPPED, by the owner's decision 2026-10-07: those
# stores reset to their goldens nightly and are regenerable from the seeders,
# so dailies of them were pure noise. The goldens remain their protection.
for db in "$ROOT"/control-plane/*/control-plane.db; do
  [ -e "$db" ] || continue
  rel=${db#"$ROOT"/}
  backup "$db" "${rel%/*}"
done
for clientdir in "$ROOT"/clients/*/; do
  client=$(basename "$clientdir")
  case "$client" in
    demo-*|*-demo) continue;;
  esac
  for db in "$clientdir"head-office/*.db "$clientdir"stores/*/*.db; do
    [ -e "$db" ] || continue
    rel=${db#"$ROOT"/}
    backup "$db" "${rel%/*}"
  done
done

# Any deployment still on a plain named Docker volume (the provisioning
# fallback) is caught here, so a store is never left unbacked. Bind-backed
# volumes are skipped: their "_data" is just the mount point of the same
# directory the tree walk above already covered.
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
for vol in $(docker volume ls --format '{{.Name}}' | grep -- '-vula-' || true); do
  if [ -n "$(docker volume inspect "$vol" --format '{{index .Options "device"}}' 2>/dev/null)" ]; then
    continue
  fi
  for db in "$DOCKER_ROOT/volumes/$vol/_data"/*.db; do
    [ -e "$db" ] || continue
    backup "$db" "legacy-volumes/$vol"
  done
done

# Off-host, then prune. Off-host is the part that survives the host.
# Set BACKUP_RSYNC_TARGET (e.g. backup@backup-host:/srv/vula-backups/) to enable.
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  rsync -a --delete "$DEST/" "$BACKUP_RSYNC_TARGET/"
fi
# Prune aged backups — but never the demo goldens: the nightly reset depends on
# them, and they are refreshed by hand, so they can legitimately be older than
# the retention window. (-exec, not -delete: -delete implies -depth, which
# makes -prune a no-op.)
find "$DEST" -path "$DEST/demo-golden" -prune -o -name '*.db' -mtime +30 -exec rm -f {} +
echo "backup complete: $DEST"
