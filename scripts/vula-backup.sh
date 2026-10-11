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
#
# A copy is only called a backup once it has proven itself: every snapshot is
# opened read-only and passes PRAGMA integrity_check plus a schema sanity query
# before the run continues. A store's product images (its /data/images — the
# one business content that lives outside SQLite) travel alongside the database
# as a tar.gz, because a database-only backup restores the sales but not the
# shelf photos the register shows.
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="${BACKUP_DEST:-/backups/vula-app}"
# Same root the provisioning code uses (coolify.ts vulaDataRoot), so one env
# var moves both.
ROOT="${VULA_DATA_ROOT:-/data/apps/vula-app}"
# A database is never pruned below this many verified dailies: age alone
# proves nothing if a run kept failing, and a silently-empty run must not
# prune the last good copies away.
MIN_KEEP="${BACKUP_MIN_KEEP:-7}"

verify_backup() { # backup-db-path
  local copy=$1
  # mode=ro: verifying must never create -wal/-shm files beside the snapshot.
  local integrity
  integrity=$(sqlite3 "file:$copy?mode=ro" 'PRAGMA integrity_check;') || {
    echo "FATAL: cannot open backup $copy for verification" >&2
    exit 1
  }
  if [ "$integrity" != "ok" ]; then
    echo "FATAL: integrity_check failed for $copy: $integrity" >&2
    exit 1
  fi
  local tables
  tables=$(sqlite3 "file:$copy?mode=ro" 'SELECT count(*) FROM sqlite_master;') || tables=0
  if [ -z "$tables" ] || [ "$tables" -lt 1 ]; then
    echo "FATAL: $copy holds no schema — refusing to count it as a backup" >&2
    exit 1
  fi
}

backup() { # db-path relative-dest
  local db=$1 rel=$2
  [ -e "$db" ] || return 0
  local dest_db="$DEST/$rel/$(basename "$db" .db)-$STAMP.db"
  mkdir -p "$DEST/$rel"
  sqlite3 "$db" ".backup '$dest_db'"
  verify_backup "$dest_db"
  # Store databases keep their product images beside them (the container's
  # IMAGE_DIR=/data/images). A store with no photos has no images dir — nothing
  # to archive. CP and Head Office databases hold no media.
  local images
  images="$(dirname "$db")/images"
  if [ -d "$images" ]; then
    tar -czf "$DEST/$rel/$(basename "$db" .db)-$STAMP-images.tar.gz" -C "$(dirname "$db")" images
  fi
  echo "backed up: $db -> $dest_db"
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
# directory the tree walk above already covered. Optional so a probe host
# without docker can still run the tree backup.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
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
fi

# Off-host, then prune. Off-host is the part that survives the host.
# Set BACKUP_RSYNC_TARGET (e.g. backup@backup-host:/srv/vula-backups/) to enable.
if [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
  rsync -a --delete "$DEST/" "$BACKUP_RSYNC_TARGET/"
else
  echo "WARNING: BACKUP_RSYNC_TARGET is not set — these backups exist on this host only." >&2
  echo "WARNING: one disk loss would take the fleet's history with it. Configure off-host replication." >&2
fi

# Prune aged backups — but only above the retention floor, and never the demo
# goldens: the nightly reset depends on them, and they are refreshed by hand,
# so they can legitimately be older than the retention window. Each backup
# directory mirrors one database; images tar.gz files sharing the pruned
# snapshots' age go with them.
while IFS= read -r dir; do
  count=$(find "$dir" -maxdepth 1 -name '*.db' | wc -l)
  if [ "$count" -gt "$MIN_KEEP" ]; then
    find "$dir" -maxdepth 1 -name '*.db' -mtime +30 -exec rm -f {} +
    find "$dir" -maxdepth 1 -name '*-images.tar.gz' -mtime +30 -exec rm -f {} +
  else
    echo "prune skipped: $dir holds $count backups (floor is $MIN_KEEP)"
  fi
done < <(find "$DEST" -path "$DEST/demo-golden" -prune -o -name '*.db' -printf '%h\n' | sort -u)

echo "backup complete: $DEST"
