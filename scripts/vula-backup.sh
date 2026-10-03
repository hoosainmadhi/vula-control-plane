#!/usr/bin/env bash
# vula-backup.sh — nightly SQLite backups for the whole Vula fleet on this host.
# Install:  scp to the host, chmod +x, add to root's crontab:
#   17 2 * * * /usr/local/bin/vula-backup.sh
# Requires: sqlite3, docker (for volume discovery), rsync (for off-host copy).
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
DEST=/backups/vula                      # a second disk, or rsync'd off-host below
mkdir -p "$DEST/cp" "$DEST/stores" "$DEST/ho" "$DEST/other"

# API-created deployments keep their /data in named Docker volumes under
# /var/lib/docker/volumes/<app-uuid>-<name>/_data — the storage names carry the
# slug, so discovery stays readable. .backup is self-contained (no WAL to carry).
for vol in $(docker volume ls --format '{{.Name}}' | grep -- '-vula-'); do
  for db in "/var/lib/docker/volumes/$vol/_data"/*.db; do
    [ -e "$db" ] || continue
    case "$vol" in
      *-vula-cp-*)    dest="$DEST/cp";;
      *-vula-store-*) dest="$DEST/stores";;
      *-vula-ho-*)    dest="$DEST/ho";;
      *)              dest="$DEST/other";;
    esac
    sqlite3 "$db" ".backup '$dest/$(basename "$db" .db)-${vol}-$STAMP.db'"
    echo "backed up: $db -> $dest"
  done
done

# Deployments given manual bind mounts under the host tree are backed up too.
for db in /data/apps/vula-app/cp/control-plane.db \
          /data/apps/vula-app/store/*/*-sqlite-db/za-pos.db \
          /data/apps/vula-app/ho/*/*-sqlite-db/head-office.db; do
  [ -e "$db" ] || continue
  case "$db" in
    *control-plane.db*) dest="$DEST/cp";;
    *za-pos.db*)        dest="$DEST/stores";;
    *)                  dest="$DEST/ho";;
  esac
  sqlite3 "$db" ".backup '$dest/$(basename "$db" .db)-$STAMP.db'"
  echo "backed up: $db -> $dest"
done

# Off-host, then prune. Off-host is the part that survives the host.
# Set BACKUP_RSYNC_TARGET (e.g. backup@backup-host:/srv/vula-backups/) to enable.
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  rsync -a --delete "$DEST/" "$BACKUP_RSYNC_TARGET/"
fi
find "$DEST" -name '*.db' -mtime +30 -delete
echo "backup complete: $DEST"
