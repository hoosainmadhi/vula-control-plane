# Tidbits — small deferred items & backlog

- **Tenant side (next big one):** implement `/api/internal/*` in za-pos per
  the CP-authored contract in CONTEXT.md — `terminals` storage (new table or
  settings columns), internal router guarded by `CONTROL_PLANE_TOKEN` env
  (no token set → routes 404), reset-admin generating the temp password.
- Audit table (`store_audit`) — house spec has one; spec'd out of v1.
- DELETE `/api/stores/:id` — needs a teardown story (pause first? hard
  delete only?).
- Automated health sweep (10-min interval) like optimed's
  `startHealthSweep` — v1 is manual only.
- Persist the last push/health _error message_ (schema has status + timestamps
  but no message column) so failures survive refresh.
- Auto-re-push on PUT when terminal_count/base_url changes (deliberately
  explicit-only in v1 — revisit if drift bites).
- Terminal names beyond "Till N" (custom names per terminal) — payload shape
  already supports a `name` per till.
- Coolify auto-provisioning for stores (runbook is manual today), incl.
  generating CONTROL_PLANE_TOKEN at deploy time.
- Live store insight (orders/cash-up dashboards per store), central
  catalogue, IBT — later phases per za-pos task_plan.
- Push this repo to GitHub (`gh repo create hoosainmadhi/za-pos-control-plane
--private --source . --remote origin --push`) when asked.
- CSP is minimal (`style-src 'unsafe-inline'`) — tighten if a CSP audit ever
  runs.
- `scripts/dev-store-stub.ts` compiles into the Docker image via tsc (src of
  truth tsconfig includes scripts/) — acceptable; exclude scripts/ from the
  prod tsc pass if size ever matters.
