#!/usr/bin/env bash
# vula-demo-reset.sh — restores the demo stores to their golden state.
# Nightly at 02:17 (after the 02:10 backup). Paths are the bind tree
# migrated 2026-10-06: /data/apps/vula-app/clients/<client>/[stores/<store>/]…
# Master copy lives here; install with:
#   scp scripts/vula-demo-reset.sh ubuntu@<host>:~ && ssh <host> \
#     'sudo install -m 755 ~/vula-demo-reset.sh /usr/local/bin/'
set -uo pipefail
LOG=/var/log/vula-demo-reset.log
G=/backups/vula-app/demo-golden
R=/data/apps/vula-app

{
  echo "==== $(date '+%F %T') demo reset starting"

  reset() { # name app-uuid target-db-under-R golden-file
    local name=$1 uuid=$2 target=$3 golden=$4
    local c
    c=$(docker ps -a --format '{{.Names}}' | grep "^$uuid" | head -1 || true)
    if [ -n "$c" ]; then docker stop "$c" >/dev/null 2>&1 || true; fi
    if [ -f "$G/$golden" ]; then
      cp "$G/$golden" "$R/$target"
      rm -f "$R/$target-wal" "$R/$target-shm"
      chown 1000:1000 "$R/$target"
      echo "reset: $name"
    else
      echo "MISSING golden: $golden (skipped $name)"
    fi
    if [ -n "$c" ]; then docker start "$c" >/dev/null 2>&1 || true; fi
  }

  reset demo-ho                cpnsg0e0lw3ggr07os8bknzg clients/urban-threads-demo/head-office/head-office.db                  demo-ho.db
  reset demo-urban-threads-jhb q20lwe1nrfxljrjfxn07fnq5 clients/urban-threads-demo/stores/demo-urban-threads-jhb/za-pos.db demo-urban-threads-jhb.db
  reset demo-urban-threads-cpt ojcdtrzyhwripfxcwmarffqd clients/urban-threads-demo/stores/demo-urban-threads-cpt/za-pos.db demo-urban-threads-cpt.db
  reset demo-urban-threads-dbn jeqhdcsmaiecvd0r72ecnxet clients/urban-threads-demo/stores/demo-urban-threads-dbn/za-pos.db demo-urban-threads-dbn.db
  reset demo-general           cfpit8t3c3qpx0ldnf8qdzik clients/demo-general/stores/demo-general/za-pos.db           demo-general.db
  reset demo-spares            tyzt97d9cwn467kgog5g9tep clients/demo-spares/stores/demo-spares/za-pos.db             demo-spares.db
  reset demo-restaurant        3ryq7svgewjdm9trxtk3d9jq clients/demo-restaurant/stores/demo-restaurant/za-pos.db     demo-restaurant.db
  reset demo-hardware          lqu4n6fxk0he5b6royou8j5x clients/demo-hardware/stores/demo-hardware/za-pos.db         demo-hardware.db
  reset demo-pharmacy          aux8ftmmtzooxmavwk2a0mjj clients/demo-pharmacy/stores/demo-pharmacy/za-pos.db         demo-pharmacy.db

  echo "demo reset complete"
} >> "$LOG" 2>&1

# keep the log short
if [ -f "$LOG" ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
