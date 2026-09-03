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

Complete (CP v1 delivered 2026-09-03)

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
