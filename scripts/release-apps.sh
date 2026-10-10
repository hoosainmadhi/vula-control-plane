#!/usr/bin/env bash
# release-apps.sh — deploy the Vula apps deliberately.
#
# Auto-deploy is OFF for the fleet and the control planes (2026-10-08): the
# GitHub webhook on this host delivers late — often a minute or two, sometimes
# never — and a code push rebuilding thirteen apps looked like a stuck queue.
# This script is the release. Coolify still runs four builds at a time.
#
#   release-apps.sh fleet       the tenant apps: stores, Head Offices, rehearsal
#   release-apps.sh cp          the two control planes
#   release-apps.sh all         both sets
#   release-apps.sh <name>      one app (run `release-apps.sh list` for names)
#   release-apps.sh list        print the names, deploy nothing
#
# Credentials come from COOLIFY_API_URL / COOLIFY_API_TOKEN if set, otherwise
# from the optimed control plane's .env, where the token already lives — this
# script does not create another copy.
set -euo pipefail

if [ -z "${COOLIFY_API_URL:-}" ] || [ -z "${COOLIFY_API_TOKEN:-}" ]; then
  ENV_FILE=${COOLIFY_ENV_FILE:-$HOME/apps/optimed-control-plane/.env}
  if [ ! -f "$ENV_FILE" ]; then
    echo "COOLIFY_API_URL / COOLIFY_API_TOKEN unset and $ENV_FILE missing" >&2
    exit 1
  fi
  COOLIFY_API_URL=$(grep -m1 '^COOLIFY_API_URL=' "$ENV_FILE" | cut -d= -f2-)
  COOLIFY_API_TOKEN=$(grep -m1 '^COOLIFY_API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
fi
[ -n "$COOLIFY_API_URL" ] && [ -n "$COOLIFY_API_TOKEN" ] || { echo "credentials empty" >&2; exit 1; }

fleet_names=(
  demo-urban-threads-jhb demo-urban-threads-cpt demo-urban-threads-dbn
  demo-general demo-spares demo-restaurant demo-hardware demo-pharmacy
  demo-ho
)
fleet_uuids=(
  q20lwe1nrfxljrjfxn07fnq5 ojcdtrzyhwripfxcwmarffqd jeqhdcsmaiecvd0r72ecnxet
  cfpit8t3c3qpx0ldnf8qdzik tyzt97d9cwn467kgog5g9tep 3ryq7svgewjdm9trxtk3d9jq
  lqu4n6fxk0he5b6royou8j5x aux8ftmmtzooxmavwk2a0mjj cpnsg0e0lw3ggr07os8bknzg
)
cp_names=(vula-cp-staging vula-cp-prod)
cp_uuids=(d5thajqrlaxxpsrwesc9mh7j yx3ntdoau1qhula5i3mr7wpz)

deploy() { # name uuid
  local out msg
  out=$(curl -s -m 60 -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
        "$COOLIFY_API_URL/api/v1/deploy?uuid=$2&force=false") || { printf '%-26s request failed\n' "$1"; return; }
  msg=$(printf '%s' "$out" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)
  printf '%-26s %s\n' "$1" "${msg:-$out}"
}

deploy_set() { # label names... (pairs via the parallel arrays above)
  local -n names=$1 uuids=$2
  for i in "${!names[@]}"; do deploy "${names[$i]}" "${uuids[$i]}"; done
}

case "${1:-}" in
  list)
    echo "fleet: ${fleet_names[*]}"
    echo "cp:    ${cp_names[*]}"
    ;;
  fleet) deploy_set fleet_names fleet_uuids ;;
  cp)    deploy_set cp_names cp_uuids ;;
  all)   deploy_set fleet_names fleet_uuids; deploy_set cp_names cp_uuids ;;
  '')
    echo "usage: release-apps.sh fleet | cp | all | <name> | list" >&2; exit 1 ;;
  *)
    found=""
    for i in "${!fleet_names[@]}"; do
      [ "${fleet_names[$i]}" = "$1" ] && { deploy "$1" "${fleet_uuids[$i]}"; found=1; }
    done
    for i in "${!cp_names[@]}"; do
      [ "${cp_names[$i]}" = "$1" ] && { deploy "$1" "${cp_uuids[$i]}"; found=1; }
    done
    [ -n "$found" ] || { echo "unknown app '$1' — try: release-apps.sh list" >&2; exit 1; }
    ;;
esac

echo
echo "queued. Coolify builds four at a time (~4-5 min each); watch the Deployments page."
