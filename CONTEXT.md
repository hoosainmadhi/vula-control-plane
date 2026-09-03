# CONTEXT.md — Vula Control Plane domain reference

Read before changing any domain concept. The authoritative rule-set for the
fleet registry, terminal provisioning and the tenant internal-API contract.

## 1. What this is

The office control plane for the Vula fleet. One Vula **deployment = one
store** (its own SQLite DB, its own Coolify container on the za-pos codebase).
This app manages the fleet: it keeps the **store registry**, including the
**terminal count** per store, pushes generated terminal configuration
(`Till 1..N`) to each store's internal API, pings store health, and can reset
a store's admin password. It never runs store business logic (sales, stock,
VAT) and never holds store data beyond the registry.

House pattern: `~/apps/common-files/CONTROL-PLANE-SPEC.md`; reference
implementation `~/apps/optimed-control-plane`. Vocabulary here is _store_
(not practice/tenant), auth is the single **office admin** (not platform).

## 2. Domain glossary

| Term                | Meaning                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| store               | One fleet member: a deployed Vula instance with its own DB, reachable at its `base_url`                                                                                                                                                                                                                                             |
| slug                | URL-safe unique store id: `^[a-z0-9][a-z0-9-]*$`, ≤ 40 chars, lowercase. Immutable after creation (it names the deployment, so renaming would orphan the store's identity)                                                                                                                                                          |
| terminal / Till N   | A register device at a store. Terminal N is configured by a successful push that covers `till N`. V1 terminals are generated `Till 1..N` (names may later become custom)                                                                                                                                                            |
| terminal_count      | Desired terminal count, 1–99. Owned by the control plane; pushed to the store via `/api/internal/configure`                                                                                                                                                                                                                         |
| push                | The CP → store call that applies the terminal configuration. Create attempts a **first push**; afterwards pushes are explicit only (PUT edits never auto-push)                                                                                                                                                                      |
| config snapshot     | The store's response body from the last successful push, stored as `last_config_snapshot_json`; drives the "configured" ticks in the terminal preview                                                                                                                                                                               |
| health check        | CP → store `GET /api/internal/status` ping, manual in v1; outcome stored as `last_health_status` (up/down/unknown) + `last_health_at`                                                                                                                                                                                               |
| pause / resume      | Operator state on the registry row. Paused stores refuse push and reset-admin (409); health checks still allowed                                                                                                                                                                                                                    |
| office admin        | The single control-plane operator, authenticated from env (`OFFICE_ADMIN_EMAIL` / `OFFICE_ADMIN_PASSWORD`); JWT kind `office`. No users table in v1                                                                                                                                                                                 |
| control_plane_token | Per-store secret sent as `X-Control-Plane-Token` on every internal-API call. **Supplied at store creation** (64 hex chars — it must match the `CONTROL_PLANE_TOKEN` env already set on the store's container) **or generated** (32-byte hex) when omitted. Stored in the registry, **never returned by the API or shown in the UI** |
| last_config_status  | `pending` (never pushed) · `ok` (last push succeeded) · `failed` (last push failed). The error message itself is not persisted in v1                                                                                                                                                                                                |

## 3. Fleet topology

```
Office SPA (3241) ──JWT kind office──► CP API (3240)
                                          │ better-sqlite3
                                          ▼
                                  registry DB (stores)
                                          │ X-Control-Plane-Token, 5 s timeout
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
              store A (base_url)    store B (base_url)    store C …
              Vula container       Vula container
              /api/internal/*       /api/internal/*
```

A store is deployed manually (see `prompts/deploy-coolify-control-plane.md`)
with `CONTROL_PLANE_TOKEN` set; then it is added to the registry — the office
operator pastes the same token into the create form (blank = the CP generates
one, in which case the store's env must be updated to match before the first
push succeeds) — and its terminals are pushed. There is no Coolify API
integration in v1.

**Deployment naming (once vula-app.co.za is live):** every store answers at
`https://<slug>.vula-app.co.za` (wildcard `*.vula-app.co.za` → the Coolify
server; slug = the store's registry slug) and the control plane panel sits at
`https://cp.vula-app.co.za`. The store's `base_url` in the registry is the
`https://<slug>.vula-app.co.za` form.

## 4. Internal API contract (CP-authored)

This section is the authoritative wire contract. The tenant side shipped
2026-09-03 (za-pos: `terminals` table + `src/routes/internal.ts`, enabled by
its `CONTROL_PLANE_TOKEN` env) and matches the shapes below exactly —
`scripts/dev-store-stub.ts` in this repo remains a dev stand-in for CP
development when no store is running.

Base: `{base_url}/api/internal` (the registry keeps `base_url` with any
trailing slash stripped). All endpoints require header
`X-Control-Plane-Token: <control_plane_token>` and answer `401 { error }`
when it is missing or wrong. The store should 404 (not 401) these routes when
`CONTROL_PLANE_TOKEN` is unset on the container, so unconfigured stores don't
advertise the surface.

| Endpoint                         | CP client fn    | Request                                                                                          | Response (2xx)                                                                                                                               |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/internal/configure`   | `pushTerminals` | `{ terminalCount: N, terminals: [{ till: 1, name: "Till 1" }, …, { till: N, name: "Till N" }] }` | `{ ok: true, applied: { terminalCount: N, terminals: [...] } }` — full body is stored as the config snapshot                                 |
| `GET /api/internal/status`       | `ping`          | —                                                                                                | any JSON describing the store, e.g. `{ ok, storeName, vatRegNo, version, terminalCount, terminals }`                                         |
| `POST /api/internal/admin/reset` | `resetAdmin`    | —                                                                                                | `{ ok: true, tempPassword: "<one-time>" }` — the **store generates** the temp password; the CP only proxies it (shown once, never persisted) |

Error handling: non-2xx → CP throws `StoreClientError` (502) with the store's
`error` message when present; network failure/timeout (5 s) also 502. Health
and push _outcomes_ are recorded on the registry row regardless.

## 5. Registry schema (source of truth: `src/config/registryDb.ts`, mirrored in `schema.sql`)

`stores` — one row per fleet member:

| Column                      | Type / constraint                              | Notes                                             |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `id`                        | INTEGER PK AUTOINCREMENT                       |                                                   |
| `slug`                      | TEXT NOT NULL UNIQUE                           | Validated `^[a-z0-9][a-z0-9-]*$` ≤ 40; immutable  |
| `name`                      | TEXT NOT NULL                                  | Display name                                      |
| `vat_reg_no`                | TEXT NULL                                      | Shown on the dashboard; informational in v1       |
| `terminal_count`            | INTEGER NOT NULL DEFAULT 1 CHECK 1–99          | Pushed as Till 1..N                               |
| `base_url`                  | TEXT NOT NULL CHECK http(s)%                   | Trailing slash stripped at write                  |
| `control_plane_token`       | TEXT NOT NULL                                  | Never serialized by the API                       |
| `status`                    | TEXT DEFAULT 'active' CHECK active/paused      | Paused blocks push + reset-admin                  |
| `last_config_status`        | TEXT DEFAULT 'pending' CHECK pending/ok/failed | Last push outcome                                 |
| `last_config_at`            | TEXT NULL                                      | UTC `datetime('now')`                             |
| `last_config_snapshot_json` | TEXT NULL                                      | Store's configure response (kept only on success) |
| `last_health_at`            | TEXT NULL                                      | UTC                                               |
| `last_health_status`        | TEXT DEFAULT 'unknown' CHECK up/down/unknown   | up/down recorded on each manual check             |
| `created_at` / `updated_at` | TEXT NOT NULL DEFAULT (datetime('now'))        | UTC                                               |

Conventions: snake_case columns, CHECK-constrained enums, ISO-ish UTC
timestamps, JSON text for snapshots. No audit table, no users table, no
delete route in v1 (see `tidbits.md`).

## 6. Auth & session conventions

- Single office admin from env; password bcrypt-hashed once at boot, compared
  per login; JWT `{ kind: 'office', email, role: 'office' }`, 7-day expiry
  (`JWT_TTL_HOURS`), secret `JWT_SECRET`. Login rate-limited 20 req / 15 min
  per IP.
- Production boot fails fast when `OFFICE_ADMIN_EMAIL` / `OFFICE_ADMIN_PASSWORD`
  are unset or placeholders.
- Every store call carries the per-store `control_plane_token`, not the
  office JWT — the two credentials are unrelated and neither is ever echoed
  to the SPA.

## 7. Out of scope (later phases)

Live store insight (sales/cash-up dashboards across the fleet), central
catalogue, IBT, tenant-side internal API implementation, Coolify
auto-provisioning, audit trail, DELETE store, automated health sweep. Tracked
in `tidbits.md` and the za-pos `task_plan.md`.
