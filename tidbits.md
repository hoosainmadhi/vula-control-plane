# Tidbits — small deferred items & backlog

> Prioritised for the next workspace. ~~Struck~~ items are done.

## Next workspace — fleet phase set F1–F3 (planned 2026-09-06)

Full roadmap in `task_plan.md` → "Phase set (planned 2026-09-06):
fleet operations F1–F3". Items below marked **F1/F2/F3** are promoted
into that plan.

- ~~Audit table (`store_audit`)~~ **planned F1** — house spec, deferred
  from v1, lands with the ops-hardening phase.
- ~~DELETE `/api/stores/:id`~~ **planned F1** — pause-first teardown
  policy (confirm by slug, revoke token, blocked while active).
- ~~Automated health sweep (10-min interval)~~ **planned F1** — env-
  gated, like optimed's `startHealthSweep`.
- ~~Persist the last push/health _error message_~~ **planned F1** —
  `last_config_error`/`last_health_error` columns.
- ~~Terminal names beyond "Till N"~~ **planned F1** — payload already
  supports a `name` per till; surface it in the edit modal.
- ~~Coolify auto-provisioning for stores~~ **planned F2** — env-gated
  client; needs the vula-app.co.za wildcard DNS live first; the manual
  runbook stays as fallback.
- ~~Live store insight (orders/cash-up dashboards per store), central
  catalogue, IBT~~ **planned F3** — F3a fleet summary, F3b catalogue
  push, F3c IBT; tenant side needs internal-API v0.3.0 in
  ~/apps/za-pos (cross-referenced there).

## Still deferred

- Auto-re-push on PUT when terminal_count/base_url changes (deliberately
  explicit-only in v1 — F1 adds drift visibility; revisit auto-push if
  drift bites).
- Restaurant vertical: add `restaurant` to the CP vocabulary when the
  tenant lands P4 (starter-pack vertical; mirror = StoreVertical +
  STORE_VERTICALS + UI/stub/tests, pharmacy precedent).
- Push this repo to GitHub (`gh repo create hoosainmadhi/za-pos-control-plane
--private --source . --remote origin --push`) when asked.
- CSP is minimal (`style-src 'unsafe-inline'`) — tighten if a CSP audit ever
  runs.
- `scripts/dev-store-stub.ts` compiles into the Docker image via tsc (src of
  truth tsconfig includes scripts/) — acceptable; exclude scripts/ from the
  prod tsc pass if size ever matters.
- **vula-app.co.za not registered yet** — docs assume the wildcard scheme
  (`<slug>.vula-app.co.za` + `cp.vula-app.co.za`); DNS must be added when the
  domain goes live (blocks F2 go-live).
- Dev-office email default is still `admin@za-pos.local` (env default +
  docs). A later pass could move to `@vula.local`-style defaults; branding
  pass deliberately left config defaults alone.
