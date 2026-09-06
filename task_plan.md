# Task Plan: Vula Control Plane (CP v1)

> Source of truth for scope, phases and locked decisions. Read `findings.md`
> and `progress.md` for how we got here. Statuses: pending → in_progress →
> complete.

## Goal

A control plane for the Vula fleet (house control-plane pattern, cf.
`~/apps/common-files/CONTROL-PLANE-SPEC.md`): one office panel that registers
per-store Vula Coolify deployments and provisions their terminals. CP v1 =
**stores CRUD + terminal provisioning only**. Each store runs its own Vula
container and exposes `/api/internal/*` guarded by a per-store
`CONTROL_PLANE_TOKEN` (tenant-side workstream; contract authored here in
CONTEXT.md "Internal API contract").

## Current Phase

CP v1 complete (delivered 2026-09-03). **Planned, not started:** fleet
phase set F1–F3 (2026-09-06) — see below.

## Phases

### Phase 1: Scaffold & docs

- [x] `git init -b main`; root backend npm project + `frontend/` Vite react-ts
- [x] .env.sample, .gitignore, .dockerignore, .nvmrc, prettier, jest config,
      tsconfigs
- [x] schema.sql mirror; AGENTS.md, CONTEXT.md, README, planning docs
- **Status:** complete

### Phase 2: Backend API

- [x] Registry DB (`data/control-plane.db`, WAL): `stores` table with slug
      UNIQUE, terminal_count CHECK 1..99, status/last_config__/last_health__
- [x] Office auth: single admin from `OFFICE_ADMIN_EMAIL` /
      `OFFICE_ADMIN_PASSWORD` (bcrypt compare at login, JWT kind `office`,
      rate-limited 20/15 min, production boot fails fast)
- [x] `services/storeClient.ts`: pushTerminals/ping/resetAdmin — 5 s timeouts,
      typed `StoreClientError` (502), registry updates
- [x] Routes: login; stores CRUD (create attempts first push); detail with
      terminal preview + config snapshot; PUT (no auto-push); pause/resume;
      push; health; reset-admin (one-time temp password, never stored)
- [x] 38 jest+supertest tests green (in-memory registry, mocked fetch)
- **Status:** complete

### Phase 3: Frontend

- [x] Login page; dashboard table (slug, name, terminals chips Till 1..N,
      VAT, config/health badges, status) with New store / Edit modal, row
      actions (Edit, Push now, Health, Admin password reveal-once, Pause/Resume)
- [x] Production build green (tsc -b + vite)
- **Status:** complete

### Phase 4: Packaging & verification

- [x] Dockerfile (node:22-alpine 2-stage, VOLUME /data), dev store stub,
      smoke script, deploy runbook (`prompts/deploy-coolify-control-plane.md`)
- [x] Boot smoke: login → create store against the dev stub → first push →
      health up → reset-admin → edit+push → failure paths → pause blocks push
- [x] Port registry update (3240/3241, PortPilot, Dashy) + commits
- **Status:** complete

## Key Questions

1. Tenant internal API not built yet — CP authors the wire contract
   (CONTEXT.md "Internal API contract"); tenant workstream implements
   `/api/internal/status|configure|admin/reset` to match.
2. Push triggers — resolved: create attempts a first push; afterwards only
   explicit "Push now" (PUT edits never auto-push).
3. Health outcome persistence — resolved: added `last_health_status`
   (up/down/unknown) beside `last_health_at` so the dashboard state survives
   refresh.

## Decisions Made

| #   | Decision                                                                                               | Rationale                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| D1  | Store vocabulary: `stores`, office auth (JWT kind `office`), routes `/api/auth/login` + `/api/stores`  | Diverges deliberately from optimed's platform/tenants naming per spec                                      |
| D2  | `CONTROL_PLANE_TOKEN` generated at create (32-byte hex), stored in registry, never returned by the API | CP must be able to push later; token is a push credential, not a UI secret                                 |
| D3  | Configure payload = `{ terminalCount, terminals: [Till 1..N] }`                                        | §14 wording "pushes generated terminal configuration (Till 1..N)"; snapshot self-describes the store state |
| D4  | Store generates the reset temp password; CP proxies it, shows once, persists nothing                   | "Shown once, never stored" house posture; CP never fabricates credentials                                  |
| D5  | Create attempts a synchronous first push; failure never fails creation (`last_config_status = failed`) | Registry row is the source of truth; retry via Push now                                                    |
| D6  | Explicit push only (no auto-push on PUT)                                                               | Predictable; no store calls mid-edit; drift visible via config badge                                       |
| D7  | Store calls: 5 s timeout (`AbortSignal.timeout`), errors typed 502                                     | House timeout pattern (optimed health) generalised                                                         |
| D8  | Slug regex `^[a-z0-9][a-z0-9-]*$` (max 40), immutable after create                                     | Per spec; trailing dash technically allowed                                                                |
| D9  | No audit table, no users table, no DELETE, no health sweep in v1                                       | Per spec scope; see tidbits.md backlog                                                                     |
| D10 | No Coolify integration in v1                                                                           | Store deployment is manual (runbook); auto-provisioning deferred                                           |

## Acceptance (verified)

- [x] `npm test` green (38)
- [x] `npm run typecheck` clean
- [x] `npm run build` (backend tsc + frontend build)
- [x] Boot smoke (`scripts/smoke-test.sh`) against the dev store stub
- [x] Ports 3240/3241 registered (PORT-REGISTRY.md, PortPilot, Dashy)
- [x] Committed per house style on `main`

## Phase 5 (post-v1): Store type moved to the control plane — 2026-09-03

- [x] `stores.vertical` TEXT NOT NULL DEFAULT 'general' (`STORES_DDL` +
      `schema.sql` mirror + `ensureColumns` auto-migration; no CHECK —
      SQLite can't ALTER one in, enum enforced at the API layer)
- [x] Wire: `StoreOut` + POST/PUT accept `vertical`
      (`general|clothing|spares|supermarket`); configure push body is now
      `{ terminalCount, vertical, terminals }`
- [x] Tenant (`~/apps/za-pos`) `/api/internal/configure` applies
      `vertical` to `settings.vertical` + seeds the starter pack
      (idempotent); `/status` reports it; internal API v0.2.0
- [x] UI: Store type select in the create/edit modal + Type column on the
      dashboard (no new page)
- [x] Dev stub parity (STUB_VERTICAL) + CONTEXT.md updated in both repos
- [x] CP `npm test` 42/42, typecheck clean, frontend build green; za-pos
      internal + verticals suites green
- **Status:** complete

### Decisions added (see progress.md 2026-09-03 late entry)

| #   | Decision                                                                                                   | Rationale                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D11 | Store type field is `vertical` everywhere (UI label "Store type"), values `general` · `clothing` · `spares` · `supermarket`, default `general` | Mirrors za-pos `settings.vertical` 1:1 so the push maps directly; tenant docs always called it "store type (vertical)" |
| D12 | Every configure push carries `vertical`; tenant applies it + seeds the pack idempotently; an absent `vertical` leaves the store's type untouched | Same trust model as terminal replacement; older CP builds stay compatible (tenant-side leniency) |

## Phase 6 (post-v1): verticals — supermarket merged into general, hardware added (2026-09-03)

- [x] Tenant `vertical.ts`: type set now `general | clothing | spares | hardware`
- [x] Merge rationale: identical starter packs; only diff was weighed toggle → general carries it
- [x] Hardware pack (7 categories, unique names across packs); no new product fields (deferred)
- [x] CP + tenant UI/docs/tests/stub mirrored; suites green (42/42 CP, 98/98 tenant)
- [x] Fleet: supermarket demo store replaced by builders-hardware on :3248; all 4 instances on new build
- **Status:** complete

## Phase set (planned 2026-09-06): fleet operations F1–F3

Owner decisions (2026-09-06): build the full fleet roadmap in three
phases — CP ops hardening first, then Coolify auto-provisioning, then
central-office-over-the-fleet. Implementation happens in this repo (F1,
F2) and across both repos (F3); each phase ships with the test suite
green, docs updated and one commit. Settle the uncommitted working tree
before F1 starts. Fleet verified from the registry: all 5 stores active,
health up, config ok.

- [ ] **F1 CP ops hardening** (this repo)
  - Automated health sweep (env-gated interval, default 10 min): ping
    every active store, update `last_health_status`/`_at`.
  - Persist last errors: `last_config_error`/`last_health_error`
    columns (ensureColumns) recorded by storeClient; badges and the
    detail view show the message so failures survive refresh.
  - `store_audit` table (house spec, deferred from v1): create/edit/
    push/health/reset/pause/resume rows with the acting office admin;
    `GET /api/stores/:id/audit` + a detail UI panel.
  - Store delete/teardown: pause-first policy, confirm by slug, hard
    delete + token revoked; blocked while status is active.
  - Custom terminal names per till (configure payload already carries
    a `name` per terminal — surface it in the edit modal).
  - Fleet header strip on the dashboard: total stores, up/down, config
    drift count.
- [ ] **F2 Coolify auto-provisioning** (this repo; prerequisite: the
      vula-app.co.za DNS wildcard live + a Coolify instance)
  - Env-gated Coolify API client (`COOLIFY_API_URL`/`COOLIFY_API_TOKEN`):
    create store → deploy the Vula image with env (PORT, DB_PATH,
    generated per-store JWT_SECRET + the registry CONTROL_PLANE_TOKEN,
    APP_URL `https://<slug>.vula-app.co.za`) and a /data volume.
  - `coolify_uuid`/`deploy_status` columns; "Provision" step in the
    create flow + "Redeploy" row action + deploy badge; without Coolify
    config the manual runbook path is unchanged.
  - The CP stores only its own token — the JWT secret lives in Coolify.
  - Tests against a mocked Coolify API; deploy runbook updated.
- [ ] **F3 central office over the fleet** (both repos; tenant internal
      API v0.3.0 in ~/apps/za-pos)
  - F3a fleet summary: `GET /api/internal/fleet/summary` (token-
    guarded) per store — app version, vertical, product count, today's
    orders/revenue, open tills, low-stock count; CP dashboard tab.
  - F3b catalogue push: a central catalogue in the CP, pushed to chosen
    stores via an internal upsert (SKU as the key) — same trust model
    as the verticals push.
  - F3c inter-store transfers (IBT): the CP orchestrates source
    decrement + destination increment over the internal API; both ends
    write audited stock_movements (reuse `kind 'adjustment'` with
    `IBT-…` reasons, or add kinds — decide at build; the CHECK rebuild
    pattern exists).
- Interplay: tenant P4 (restaurant vertical) adds `restaurant` to this
  repo's vertical vocabulary when it lands; tenant P2/P3 (returns) run
  on the za-pos track independently.
