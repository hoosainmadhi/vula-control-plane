# CONTEXT.md — Vula Control Plane domain reference

Read before changing any domain concept. The authoritative rule-set for the
fleet registry, terminal provisioning and the tenant internal-API contract.

## 1. What this is

The office control plane for the Vula fleet. One Vula **deployment = one
store** (its own SQLite DB, its own Coolify container on the za-pos codebase).
This app manages the fleet: it keeps the **store registry**, including the
**terminal count** and **store type (`vertical`)** per store, pushes generated
terminal configuration (`Till 1..N`) to each store's internal API, pings store
health, and can reset a store's admin password. It never runs store business
logic (sales, stock, VAT) and never holds store data beyond the registry.

House pattern: `~/apps/common-files/CONTROL-PLANE-SPEC.md`; reference
implementation `~/apps/optimed-control-plane`. Vocabulary here is _store_
(not practice/tenant), auth is the single **office admin** (not platform).

## 2. Domain glossary

| Term                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| store               | One fleet member: a deployed Vula instance with its own DB, reachable at its `base_url`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| slug                | URL-safe unique store id: `^[a-z0-9][a-z0-9-]*$`, ≤ 40 chars, lowercase. Immutable after creation (it names the deployment, so renaming would orphan the store's identity)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| terminal / Till N   | A register device at a store. Terminal N is configured by a successful push that covers `till N`. V1 terminals are generated `Till 1..N` (names may later become custom)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| terminal_count      | Desired terminal count, 1–99. Owned by the control plane; pushed to the store via `/api/internal/configure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| vertical            | Store type: `general` (default) · `clothing` · `spares` · `hardware` · `pharmacy` · `restaurant`. Tenant vocabulary (`settings.vertical` on the store — same values in `~/apps/za-pos/src/services/vertical.ts`). Owned by the control plane; pushed on every configure and applied by the store (which seeds the type's starter category pack). 2026-09-03: `supermarket` merged into `general`; `hardware` added. 2026-09-04: `pharmacy` added (starter pack only on the tenant — schedule-grouped categories). 2026-09-11: `restaurant` added (starter pack only on the tenant — menu categories; tables/KDS are P5–P7) |
| push                | The CP → store call that applies the terminal configuration. Create attempts a **first push**; afterwards pushes are explicit only (PUT edits never auto-push)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| config snapshot     | The store's response body from the last successful push, stored as `last_config_snapshot_json`; drives the "configured" ticks in the terminal preview                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| health check        | CP → store `GET /api/internal/status` ping, manual in v1; outcome stored as `last_health_status` (up/down/unknown) + `last_health_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| pause / resume      | Operator state on the registry row. Paused stores refuse push and reset-admin (409); health checks still allowed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| office admin        | The single control-plane operator, authenticated from env (`OFFICE_ADMIN_EMAIL` / `OFFICE_ADMIN_PASSWORD`); JWT kind `office`. No users table in v1                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| control_plane_token | Per-store secret sent as `X-Control-Plane-Token` on every internal-API call. **Supplied at store creation** (64 hex chars — it must match the `CONTROL_PLANE_TOKEN` env already set on the store's container) **or generated** (32-byte hex) when omitted. Stored in the registry, **never returned by the API or shown in the UI**                                                                                                                                                                                                                                                                                        |
| last_config_status  | `pending` (never pushed) · `ok` (last push succeeded) · `failed` (last push failed). The error message itself is not persisted in v1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 2a. Companies, plans and panels (2026-09)

### Naming — two planes, two products

| Port | Name                   | Audience                                    |
| ---- | ---------------------- | ------------------------------------------- |
| 3240 | **Vula Control Plane** | The SaaS vendor. One instance, all clients. |
| 3260 | **Head Office**        | The merchant. One instance per merchant.    |

"Control plane" is a term of art for the layer that manages a fleet, and only the
vendor app is one. The merchant's app is a business application, so naming it a
control plane is what makes the two confusable in conversation. Do not write
"SaaS CP" / "Multistore CP" — both end in CP and the ambiguity survives.

- **A company is the merchant account** — the unit of billing, and the owner of both
  the branch stores and the Company Control Panel. It holds a plan, a `paid_through`
  date and an optional trial. Without it, a plan granting "N stores" has nothing to
  count against.
- **A plan grants** a store-count cap, a per-store terminal ceiling, and a feature
  set. Four tiers are seeded and every value is editable: `starter` (1 store /
  2 tills), `retail` (1/8), `multi-store` (10/25), `enterprise` (50/99). Operators
  can also **create their own plans** — the seeded four are a starting point, not a
  closed catalogue.
- **A plan's price always carries its recurrence.** `billing_period` is one of
  `monthly` | `annual` | `once-off`, and the UI never shows a bare number — a figure
  without its period is not a price. `once-off` means a perpetual licence rather than
  a subscription. **The control plane does not charge anyone**: the price list exists
  so a quote and an invoice raised elsewhere agree. Billing/payment recording is L3
  and unbuilt.
- **A Head Office belongs to exactly one company**, which is why creating one asks
  for the merchant. The flow creates the merchant inline when the client is new, so
  onboarding does not require visiting two screens.
- **`paid_through` is the date the subscription is paid up to.** It is the single
  input that drives licence state: before it a company is `active`, after it the
  account is `past_due` for the grace window, then `suspended` and new sales stop on
  its stores. It also caps how far ahead `maxOfflineUntil` may be set, so it bounds
  how long a disconnected till keeps trading. Labelled "Paid up to" in the UI.
- **The fleet is self-describing.** Both applications identify themselves on their
  public `/health` — a store answers `app: "vula"`, a Head Office answers
  `service: "vula-head-office"` — and the control plane probes that before
  registering a row. A store pointed at a Head Office (or vice versa) is refused as
  `wrong_app_kind`, because the two are different products and a mismatch can never
  authenticate. Only a _definitive_ mismatch is refused: an unreachable URL is
  allowed, since a registry row is normally created before its container is
  deployed.
- **Deletion is guarded, deliberately.** A company can only be deleted when it owns
  no stores and no Head Office. The schema cascades a panel and nulls store
  assignments, so an unguarded delete would silently strip a merchant's Head Office
  and its branches' entitlement — the refusal names the blockers and points at
  suspension, which stops trade without losing history. A Head Office row can be
  removed on its own (that deletes the registration, never the deployment).
- **Billing state is derived, never stored**: `active` → `past_due` (inside the
  grace window after `paid_through`) → `suspended` (beyond grace). A manual company
  `suspension` is a separate operator override. Nothing runs on a schedule.
- **Caps fail loudly.** Creating a store beyond the cap or pushing more terminals
  than the plan allows returns **402** with an upgrade message. An unassigned store
  is not cap-policed, so a store predating companies keeps working.
- **The Company Control Panel is a managed application in the vendor's fleet.** One
  per merchant (e.g. `urban-threads-ho.vula-app.co.za`), it is a _separate_ app with
  its own database and its own `ho_users` logins. The control plane **provisions,
  monitors and licences** it, and the customer reaches it directly at its own URL.
- **The privacy boundary is absolute, and asserted by tests.** The control plane may
  know whether an application is functioning; it may never learn how much money it is
  making. Panel endpoints expose only URL, health, last seen, version, config state,
  licence state and branch count. Business data (sales, revenue, customers, profit,
  transaction contents, cash-ups) never passes through this app, and the boundary is
  enforced at the API rather than in the React tree. The tempting shortcut to avoid
  is SSO from the control plane into a panel: the control plane links out, it never
  embeds.

## 2b. Feature enforcement (L4, 2026-09-11)

Before L4 a plan's feature set was informational — nothing anywhere read it. L4 makes
it a contract shared by all three applications. The licence remains the source of
truth at the store: it carries `features[]`, `billingState`, `paidThrough` and
`maxOfflineUntil`, and each application derives its own gate from those claims.

### The curated feature vocabulary (six keys, locked with the owner)

A plan may grant only these keys; the control plane refuses anything else at plan
write time (400, naming the unknown key) so a typo cannot flow silently into licences.
Served machine-readably at `GET /api/plans/features` (see `src/services/features.ts`
— the canonical list lives there).

| Key                 | Label              | Enforced by                         |
| ------------------- | ------------------ | ----------------------------------- |
| `customer_credit`   | Customer credit    | store                               |
| `advanced_reports`  | Advanced reports   | store                               |
| `multi_store`       | Multi-store        | control plane · Head Office · store |
| `stock_transfers`   | Stock transfers    | Head Office                         |
| `ecommerce_bridges` | E-commerce bridges | store                               |
| `ai_assistant`      | AI assistant       | store                               |

### Who enforces what

- **The store (za-pos register)** gates its own API server-side — `requireFeature(key)`
  middleware returns **402** when the licence's feature list lacks the key, and the
  checkout path (including offline replay via sync push) refuses **new sales** while
  suspended. Server-side is deliberate: being online must not be a bypass. Reads,
  returns, voids and cash-ups are never blocked — suspension stops trading, it never
  destroys data or traps history. Offline trade is bounded by the licence's
  `maxOfflineUntil` clamp. The register surfaces **warn / grace / suspended** states
  in its UI from the same licence (see the register-state vocabulary below).
- **The control plane** gates capability grants of its own:
  - multi-store client onboarding and single→multi upgrades require `multi_store`
    → **402 `{ error, code: 'feature_not_in_plan' }`** (the plan that will be in
    force when the topology lands is the one checked — an upgrade may carry its own
    plan switch);
  - a **suspended** company buys no new capacity: creating a store for it, or
    raising a store's terminal count, returns **402
    `{ error, code: 'subscription_suspended' }`**. Config and licence pushes are
    never blocked — that is how a store learns it has been unsuspended.
- **The Head Office panel** verifies the company licence and gates `multi_store` on
  it (L5, pending).

### Enforcement propagation

An entitlement change (plan, paid-through, trial, suspension) re-pushes signed
licences to all of the company's stores and Head Office immediately (same path L3
uses on payment), so a manual suspension reaches the registers in seconds rather
than at the next health sweep. Delivery failures are reported in the API response
(`licencePush.errors`) and never fail the edit — the registry row is already
correct, and the next sweep retries.

### Register states (shared vocabulary)

Derived by the CP from the billing state and surfaced on stores and companies
(`registerState` + `tradingBlocked`); the register derives the same from its
licence. The two sides must keep the windows in step (CP: `REGISTER_WARN_DAYS = 7`,
grace from env `LICENCE_GRACE_DAYS`).

| State        | Meaning                                                    | Register behaviour            |
| ------------ | ---------------------------------------------------------- | ----------------------------- |
| `ok`         | Paid up, more than 7 days to run                           | trading normally              |
| `warn`       | Paid up, subscription ends within 7 days                   | trading, renewal banner       |
| `grace`      | Past paid-through, inside the grace window                 | trading, grace banner         |
| `suspended`  | Grace over, or operator suspension                         | **new sales refused**         |
| `trial`      | Inside the trial window                                    | trading, trial banner         |
| `unlicensed` | No company/plan behind the licence (informational licence) | trading, no entitlement gates |

**For the tenant workstream (za-pos) to implement against this contract:**
`requireFeature` middleware (402) on the gated routes, the suspended gate on the
checkout + sync-replay paths, a `subscription` block (register state, features,
sales/trading status) in `/api/runtime-config`, and the register banners/feature
hiding. No internal-API (`/api/internal/*`) shapes change in L4 — the licence
already carries everything the store needs.

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
internal-API **v0.2.0 since 2026-09-03, when `vertical` joined the configure
request and the status response**. `scripts/dev-store-stub.ts` in this repo
remains a dev stand-in for CP development when no store is running.

Base: `{base_url}/api/internal` (the registry keeps `base_url` with any
trailing slash stripped). All endpoints require header
`X-Control-Plane-Token: <control_plane_token>` and answer `401 { error }`
when it is missing or wrong. The store should 404 (not 401) these routes when
`CONTROL_PLANE_TOKEN` is unset on the container, so unconfigured stores don't
advertise the surface.

| Endpoint                         | CP client fn    | Request                                                                                                                                                                           | Response (2xx)                                                                                                                               |
| -------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/internal/configure`   | `pushTerminals` | `{ terminalCount: N, vertical: "general"\|"clothing"\|"spares"\|"hardware"\|"pharmacy"\|"restaurant", terminals: [{ till: 1, name: "Till 1" }, …, { till: N, name: "Till N" }] }` | `{ ok: true, applied: { terminalCount: N, terminals: [...] } }` — full body is stored as the config snapshot                                 |
| `GET /api/internal/status`       | `ping`          | —                                                                                                                                                                                 | any JSON describing the store, e.g. `{ ok, storeName, vatRegNo, vertical, version, terminalCount, terminals }`                               |
| `POST /api/internal/admin/reset` | `resetAdmin`    | —                                                                                                                                                                                 | `{ ok: true, tempPassword: "<one-time>" }` — the **store generates** the temp password; the CP only proxies it (shown once, never persisted) |

Every CP push includes `vertical` (CP-owned). The store validates it (400
listing the allowed values when unknown), writes it to `settings.vertical`
and seeds the type's starter category pack (idempotent); an absent `vertical`
leaves the store's current type untouched (backward compatible with older
CP builds).

Error handling: non-2xx → CP throws `StoreClientError` (502) with the store's
`error` message when present; network failure/timeout (5 s) also 502. Health
and push _outcomes_ are recorded on the registry row regardless.

## 5. Registry schema (source of truth: `src/config/registryDb.ts`, mirrored in `schema.sql`)

`stores` — one row per fleet member:

| Column                      | Type / constraint                              | Notes                                                                                                                          |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                        | INTEGER PK AUTOINCREMENT                       |                                                                                                                                |
| `slug`                      | TEXT NOT NULL UNIQUE                           | Validated `^[a-z0-9][a-z0-9-]*$` ≤ 40; immutable                                                                               |
| `name`                      | TEXT NOT NULL                                  | Display name                                                                                                                   |
| `vat_reg_no`                | TEXT NULL                                      | Shown on the dashboard; informational in v1                                                                                    |
| `vertical`                  | TEXT NOT NULL DEFAULT 'general'                | Store type; enum enforced at the API layer (no CHECK — SQLite can't add one via the auto-migration). Pushed on every configure |
| `terminal_count`            | INTEGER NOT NULL DEFAULT 1 CHECK 1–99          | Pushed as Till 1..N                                                                                                            |
| `base_url`                  | TEXT NOT NULL CHECK http(s)%                   | Trailing slash stripped at write                                                                                               |
| `control_plane_token`       | TEXT NOT NULL                                  | Never serialized by the API                                                                                                    |
| `status`                    | TEXT DEFAULT 'active' CHECK active/paused      | Paused blocks push + reset-admin                                                                                               |
| `last_config_status`        | TEXT DEFAULT 'pending' CHECK pending/ok/failed | Last push outcome                                                                                                              |
| `last_config_at`            | TEXT NULL                                      | UTC `datetime('now')`                                                                                                          |
| `last_config_snapshot_json` | TEXT NULL                                      | Store's configure response (kept only on success)                                                                              |
| `last_health_at`            | TEXT NULL                                      | UTC                                                                                                                            |
| `last_health_status`        | TEXT DEFAULT 'unknown' CHECK up/down/unknown   | up/down recorded on each manual check                                                                                          |
| `created_at` / `updated_at` | TEXT NOT NULL DEFAULT (datetime('now'))        | UTC                                                                                                                            |

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
