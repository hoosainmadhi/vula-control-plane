#!/bin/sh
# Prepare the data mount, then hand off to the app as the unprivileged `node` user.
#
# `/data` is a bind mount in production, so its ownership comes from the HOST
# directory: Docker creates a missing one as root, and the image's own
# `chown /data` is masked the moment the mount appears. The app runs as uid 1000,
# so a root-owned data directory means SQLite cannot create its `-wal` file and
# the container dies at boot with an error that names neither the mount nor the
# ownership. (The Optimed deployments never met this because their images carry no
# `USER`, so they run as root.)
#
# So: start as root, make the data directory writable by `node`, then drop the
# process to `node` before exec'ing the app. Nothing outside the data directory is
# touched, and the server itself never runs as root.
set -e

# Whichever the app uses: store DB_PATH, Head Office HO_DB_PATH, control plane CP_DB_PATH.
DATA_FILE="${DB_PATH:-${HO_DB_PATH:-${CP_DB_PATH:-/data/za-pos.db}}}"
DATA_DIR="$(dirname "$DATA_FILE")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Recursive: a directory from an earlier root-run can already hold root-owned
  # files, and those are exactly the ones SQLite needs to rewrite.
  chown -R node:node "$DATA_DIR" 2>/dev/null || true

  if [ -n "${BACKUP_DIR:-}" ]; then
    mkdir -p "$BACKUP_DIR"
    chown -R node:node "$BACKUP_DIR" 2>/dev/null || true
  fi

  exec su-exec node "$@"
fi

# Already unprivileged (a host that pre-chowned the directory, or a compose file
# with an explicit user): nothing to fix, just run.
exec "$@"
