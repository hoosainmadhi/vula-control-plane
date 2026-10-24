#!/usr/bin/env bash
# vula-demo-reset.sh — restores the demo stores to their golden state.
# Nightly at 02:17 (after the 02:10 backup). Two bind trees:
#   R  = /data/apps/vula-app         legacy Dockerfile demo apps
#   RI = /data/apps/vula-app-image   shared-image demo apps
# Master copy lives here; install with:
#   scp scripts/vula-demo-reset.sh ubuntu@<host>:~ && ssh <host> \
#     'sudo install -m 755 ~/vula-demo-reset.sh /usr/local/bin/'
set -uo pipefail
LOG=/var/log/vula-demo-reset.log
G=/backups/vula-app/demo-golden
R=/data/apps/vula-app
RI=/data/apps/vula-app-image

{
  echo "==== $(date '+%F %T') demo reset starting"

  reset() { # name app-uuid target-db-under-root golden-file [root]
    local name=$1 uuid=$2 target=$3 golden=$4 root=${5:-$R}
    local c
    c=$(docker ps -a --format '{{.Names}}' | grep "^$uuid" | head -1 || true)
    if [ -n "$c" ]; then docker stop "$c" >/dev/null 2>&1 || true; fi
    if [ -f "$G/$golden" ]; then
      cp "$G/$golden" "$root/$target"
      rm -f "$root/$target-wal" "$root/$target-shm"
      chown 1000:1000 "$root/$target"
      echo "reset: $name"
    else
      echo "MISSING golden: $golden (skipped $name)"
    fi
    if [ -n "$c" ]; then docker start "$c" >/dev/null 2>&1 || true; fi
  }

  reset demo-ho                xjeobzicewspkecs6yijilkj clients/urban-threads-demo/head-office/head-office.db                  demo-ho.db                "$RI"
  reset demo-urban-threads-jhb r7duyq1hlo2otxgpfwv8oig2 clients/urban-threads-demo/stores/demo-urban-threads-jhb/za-pos.db demo-urban-threads-jhb.db "$RI"
  reset demo-urban-threads-cpt hki4r7n2qyatjxvfjjdurmh0 clients/urban-threads-demo/stores/demo-urban-threads-cpt/za-pos.db demo-urban-threads-cpt.db "$RI"
  reset demo-urban-threads-dbn 0z6pp7i1isxi6zidocd7yaeq clients/urban-threads-demo/stores/demo-urban-threads-dbn/za-pos.db demo-urban-threads-dbn.db "$RI"
  reset demo-general           xxlgl7dhq3js2wg4ju8pgnxr clients/demo-general/stores/demo-general/za-pos.db           demo-general.db           "$RI"
  reset demo-spares            ayouhkwonlzdjmpxqhlisbyo clients/demo-spares/stores/demo-spares/za-pos.db             demo-spares.db            "$RI"
  reset demo-restaurant        rwhuwrddzuhvzx1x9fmhb9gw clients/demo-restaurant/stores/demo-restaurant/za-pos.db     demo-restaurant.db        "$RI"
  reset demo-hardware          immflsogrir2ejloidm41yiy clients/demo-hardware/stores/demo-hardware/za-pos.db         demo-hardware.db          "$RI"
  reset demo-pharmacy          hqgzqt1x9pqwbl2oqhgcffli clients/demo-pharmacy/stores/demo-pharmacy/za-pos.db         demo-pharmacy.db          "$RI"
  reset demo-stationery        gihprbh91svfabckxl2ntpmj clients/demo-stationery/stores/demo-stationery/za-pos.db     demo-stationery.db        "$RI"

  echo "demo reset complete"
} >> "$LOG" 2>&1

# keep the log short
if [ -f "$LOG" ]; then
  tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
