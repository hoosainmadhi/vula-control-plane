#!/usr/bin/env bash
# Boot smoke for the Vula control plane (house style).
#
# Requires: API on :3240 (npm run dev / npm run dev:api / node dist/server.js)
# and the dev store stub on :3299 (npm run stub, token below).
# Exits non-zero on the first failed assertion.
set -euo pipefail

API="${API:-http://localhost:3240}"
STUB_URL="${STUB_URL:-http://localhost:3299}"
STUB_TOKEN="${STUB_TOKEN:-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef}"
EMAIL="${OFFICE_ADMIN_EMAIL:-admin@za-pos.local}"
PASS="${OFFICE_ADMIN_PASSWORD:-temp123}"
SLUG="smoke-$(date +%s)"

say() { echo "==> $*"; }
ok()  { echo "    PASS: $*"; }
fail(){ echo "    FAIL: $*"; exit 1; }

# GETs a value from a JSON doc on stdin by dotted path (e.g. store.id, 0.slug).
jget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);let v=o;for(const p of process.argv[1].split("."))v=v[p];process.stdout.write(v===null||v===undefined?"":String(v))}catch(e){process.exit(1)}})' "$1"; }

# req METHOD PATH [JSON-BODY] -> prints "<single-line body>\n<http-code>".
req() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method" -w $'\n%{http_code}')
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}" "$API$path"
}

# call METHOD PATH [JSON-BODY] -> body in $BODY, http code in $STATUS.
# NOTE: req runs inside a subshell, so STATUS/BODY are split back out in the
# parent via parameter expansion (JSON responses are single-line bodies).
call() {
  BODY=$(req "$@")
  STATUS="${BODY##*$'\n'}"
  BODY="${BODY%$'\n'*}"
}

STATUS=""
BODY=""
TOKEN=""

say "Health check"
curl -sf "$API/health" >/dev/null && ok "API is up on $API" || fail "API not reachable at $API"

say "Office login"
BODY=$(curl -sf -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$API/api/auth/login") || fail "login request failed"
TOKEN=$(printf '%s' "$BODY" | jget token)
[ -n "$TOKEN" ] && ok "got office token" || fail "no token in login response"

say "Create store (terminalCount 2, token supplied) pointed at the stub -> first push"
call POST /api/stores "{\"name\":\"Smoke Store\",\"slug\":\"$SLUG\",\"vatRegNo\":\"4530211828\",\"terminalCount\":2,\"baseUrl\":\"$STUB_URL\",\"controlPlaneToken\":\"$STUB_TOKEN\"}"
[ "$STATUS" = "201" ] || fail "create: HTTP $STATUS — $BODY"
ID=$(printf '%s' "$BODY" | jget store.id)
[ "$(printf '%s' "$BODY" | jget firstPush.ok)" = "true" ] && ok "store $ID created and first push ok" || fail "first push not ok: $BODY"
[ "$(printf '%s' "$BODY" | jget store.lastConfigStatus)" = "ok" ] && ok "lastConfigStatus ok" || fail "lastConfigStatus != ok"

say "List stores"
call GET /api/stores
[ "$(printf '%s' "$BODY" | jget "0.slug")" = "$SLUG" ] || fail "slug not listed first"
printf '%s' "$BODY" | grep -q "controlPlaneToken" && fail "list leaked the control plane token" || ok "token not exposed"

say "Health check against the stub"
call POST "/api/stores/$ID/health"
[ "$(printf '%s' "$BODY" | jget healthStatus)" = "up" ] && ok "store reported up" || fail "health not up: $BODY"

say "Reset admin -> one-time temp password"
call POST "/api/stores/$ID/reset-admin"
[ -n "$(printf '%s' "$BODY" | jget tempPassword)" ] && ok "temp password returned once" || fail "no tempPassword: $BODY"

say "Edit terminalCount to 4 (no auto-push), then push explicitly"
call PUT "/api/stores/$ID" '{"terminalCount":4}'
[ "$STATUS" = "200" ] || fail "PUT: HTTP $STATUS"
call POST "/api/stores/$ID/push"
[ "$(printf '%s' "$BODY" | jget ok)" = "true" ] || fail "push failed: $BODY"
call GET "/api/stores/$ID"
[ "$(printf '%s' "$BODY" | jget lastConfigSnapshot.applied.terminalCount)" = "4" ] && ok "snapshot terminalCount 4" || fail "snapshot mismatch"
[ "$(printf '%s' "$BODY" | jget "terminals.3.configured")" = "true" ] && ok "Till 4 configured" || fail "terminals preview wrong: $BODY"

say "Failure paths via a store pointed at a dead port"
call POST /api/stores "{\"name\":\"Dead Store\",\"slug\":\"$SLUG-dead\",\"terminalCount\":1,\"baseUrl\":\"http://localhost:3298\",\"controlPlaneToken\":\"$STUB_TOKEN\"}"
DEAD_ID=$(printf '%s' "$BODY" | jget store.id)
[ "$(printf '%s' "$BODY" | jget firstPush.ok)" = "false" ] && ok "first push failed but store created" || fail "expected failed first push"
call POST "/api/stores/$DEAD_ID/health"
[ "$(printf '%s' "$BODY" | jget healthStatus)" = "down" ] && ok "health recorded down" || fail "expected down: $BODY"

say "Pause blocks push; resume allows it"
call PATCH "/api/stores/$ID/pause"
[ "$STATUS" = "200" ] || fail "pause: HTTP $STATUS"
call POST "/api/stores/$ID/push"
[ "$STATUS" = "409" ] && ok "push blocked while paused (409)" || fail "expected 409, got $STATUS"
call PATCH "/api/stores/$ID/resume"
call POST "/api/stores/$ID/push"
[ "$(printf '%s' "$BODY" | jget ok)" = "true" ] && ok "push ok after resume" || fail "push after resume failed"

echo
echo "SMOKE PASSED — store $SLUG (id $ID) exercised end to end"
