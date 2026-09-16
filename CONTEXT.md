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
- **Plan · subscription · billing are three different things** (2026-09-13). The
  **plan** is the catalogue entry: what a client *may* buy (store cap, per-store
  terminal ceiling, features, rate per licensed terminal, once-off onboarding).
  The **subscription** is what this client *did* buy — one row per company in
  `company_subscriptions` (`licensed_terminal_count` + `setup_fee_status`) plus a
  `store_terminal_licences` row per store saying where those licences sit.
  **Billing** is the arithmetic: `licensed terminals × rate`, plus the once-off
  onboarding charge on the first invoice. Only the first is editable as a
  catalogue; the others are per-customer facts. **Every price is quoted including
  VAT** (owner, 2026-09-16): the invoice states the total and the tax inside it,
  never a rate the office then has to add tax to. **The rate covers support** — the
  owner decided the same day that support is included per terminal, so there is no
  support line, tier or charge type. See §5e before changing either.
- **A plan grants** a store-count cap, a per-store terminal ceiling, a feature set,
  and its pricing. Four tiers are seeded and every value is editable: `starter`
  (1 store / 2 terminals), `business` (1/10), `multi-store` (20/10), `enterprise`
  (custom pricing). All three per-terminal tiers are R500 per licensed terminal per
  month plus R10,000 once-off onboarding. Operators can also **create their own
  plans** — the seeded four are a starting point, not a closed catalogue.
- **Four terminal quantities, and only one of them is billable.** **Licensed** is
  the commercial quantity (bought from the vendor, drives the fee). **Configured**
  is the terminal slots the POS is told to run (`stores.terminal_count`). **Claimed**
  is the actual device/browser binding at the register. **Open** is a trading session
  running right now. Claimed devices, open tills, heartbeats and configured counts
  never change what a client pays; a store may not be *configured* above what it is
  *licensed* for, so the POS slots and the signed licence cannot drift apart.
- **A plan's price always carries its recurrence.** `billing_period` is one of
  `monthly` | `annual` | `once-off`, and the UI never shows a bare number — a figure
  without its period is not a price. `pricing_mode` is `per_terminal` (recurring
  rate × licensed terminals) or `custom` (a negotiated deal). A custom plan may
  carry an **agreed amount** (`custom_amount_cents`, billed flat per period — the
  office states it once and renewals follow from it), or 0, which means "negotiated
  per client": an amountless invoice is then refused and the renewal sweep skips
  that client rather than inventing a figure. Either way nothing is ever derived
  from a terminal count on a custom plan. `once-off` means a perpetual licence
  rather than a subscription.
- **Money is integer cents everywhere** — storage, wire and arithmetic. Rands exist
  only inside form inputs and labels.
- **The licensed quantity gates capacity.** Creating a store allocates its terminals
  out of what the client bought (defaulting to the requested configured count), and
  a client with **zero** licensed terminals cannot take a store until the purchased
  quantity is stated. Over-allocating is refused with **402
  `terminal_allocation_exceeded`**; exceeding the plan's per-store ceiling is
  **402 `terminal_cap_exceeded`**.
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
- **Caps fail loudly.** Creating a store beyond the plan's store cap (**402
  `store_cap_reached`**), configuring more terminals than the plan or the store's
  licence allows (**402 `terminal_cap_exceeded` / `terminal_allocation_exceeded`**),
  or invoicing a custom-priced client without an agreed amount (**400
  `custom_pricing_requires_amount`**) are all refused with a message that names the
  next step. An unassigned store is not cap-policed, so a store predating companies
  keeps working.
- **Invoices carry their own pricing evidence.** `terminal_count` ×
  `terminal_price_cents` (a rate snapshot, so editing a plan cannot rewrite an
  issued invoice) is the recurring line, and `setup_fee_cents` marks the once-off
  onboarding charge — which rides the client's **first** invoice only and never a
  renewal. Settlement is explicit: the sweep creates renewal invoices and never
  records a payment itself (`BILLING_SIMULATE_RENEWAL_SETTLEMENT=true` restores the
  old demo behaviour for disposable environments).
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
truth at the store: it carries `features[]`, `billingState`, `paidThrough`,
`maxTerminals` and `maxOfflineUntil`, and each application derives its own gate from
those claims.

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

### The licensed terminal allowance (2026-09-13)

The subscription's purchased quantity reaches the register through the licence, per
store:

| Claim                 | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `maxTerminalsPerStore` | The PLAN's ceiling for any one store (unchanged; informational at the register)          |
| `maxTerminals`         | **This store's allowance** — its allocation on the client's subscription. Additive claim |

The store refuses a **new device claim** once it holds `maxTerminals` bindings
(402 `terminal_limit_reached`), and refuses a `configure` that would create more
terminal slots than the licence covers. The count is of CLAIMED terminals against
the signed licence — never of devices that happen to be online — and a device
*moving* between tills keeps its claim. **Existing claims are never revoked** when a
subscription shrinks: reducing a quantity must not strand a till mid-shift. A
deployment with no licence (or a licence whose `billingState` is `unlicensed`) has
no allowance and stays uncapped. A licence issued before the claim exists falls back
to `maxTerminalsPerStore`, which can never be lower than what the store already runs.
`/api/runtime-config` publishes `subscription.maxTerminals` so the register can show
"N of M licensed"; the gate itself is server-side.

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
  it (L5). It has no tills, so the terminal allowance does not apply to it.

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

**Tenant side — shipped 2026-09-12** (za-pos `CONTEXT.md` §14a): `requireFeature`
middleware (402) gates the debtors/lay-bys routes, credit fields on customers,
the range report, woo/shopify bridges, AI routes and Head Office calls into the
branch; the suspended gate lives inside `checkout()` (after the idempotency
lookup, so replays of recorded sales apply) covering POS checkout, offline sync
replay, order collection and quotation conversion; `/api/runtime-config` carries
the `subscription` block and the register shows warn/grace/suspended banners and
hides gated UI. Unlicensed stores (no `LEASE_PUBLIC_KEY`) allow every feature.
No internal-API (`/api/internal/*`) shapes changed in L4 — the licence already
carries everything the store needs.

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
| `POST /api/internal/configure`   | `pushTerminals` | `{ terminalCount: N, vertical: "general"\|"clothing"\|"spares"\|"hardware"\|"pharmacy"\|"restaurant"\|"custom", terminals: [{ till: 1, name: "Till 1" }, …, { till: N, name: "Till N" }] }` | `{ ok: true, applied: { terminalCount: N, terminals: [...] } }` — full body is stored as the config snapshot                                 |
| `GET /api/internal/status`       | `ping`          | —                                                                                                                                                                                 | any JSON describing the store, e.g. `{ ok, storeName, vertical, version, terminalCount, terminals }` — **no `vatRegNo` since 2026-09-12**: merchant tax data never leaves the merchant plane (§40) |

`POST /api/internal/configure` also accepts an optional `headOffice` block:
`{ enabled: true, url: "<ho-base-url>", token: "<per-branch HEAD_OFFICE_TOKEN>" }`.
The token is the **branch's dedicated Head Office credential** — generated by
the CP during topology wiring and registered in the merchant Head Office under
the same value. It is never the vendor `CONTROL_PLANE_TOKEN` (the two trust
domains stay separate; see za-pos §14/§14a). The store-side
`/api/internal/head-office/*` routes additionally accept the vendor token ONLY
when the operator sets `ALLOW_CONTROL_PLANE_TOKEN_FALLBACK=true` — a
migration-only opt-in, default off since 2026-09-12.
| `POST /api/internal/admin/reset` | `resetAdmin`    | —                                                                                                                                                                                 | `{ ok: true, tempPassword: "<one-time>" }` — the **store generates** the temp password; the CP only proxies it (shown once, never persisted) |
| `POST /api/internal/licence`     | `pushLicence`   | `{ token: "<signed licence>" }`                                                                                                                                                  | `{ ok: true }` on a verified, newer-sequence licence; **409** on a stale sequence. Claims as issued by `services/licenceSigner.ts`: `licenceId, keyId, sequence, companyId, companyName, storeSlug, storeName, planCode, planName, features[], maxStores, maxTerminalsPerStore, maxTerminals?, paidThrough, billingState, issuedAt, maxOfflineUntil`. `maxTerminals` is the store's own allowance (2026-09-13) and is **absent on a Head Office licence** — the claim is additive, so a verifier that does not know it keeps working |
| `GET /api/internal/telemetry`    | `fetchTelemetry` | —                                                                                                                                                                                | **v0.4.0 (2026-09-12)**: `{ ok, app: 'vula', version, environment, schemaVersion, generatedAt, sync: { lastSyncAt, pendingEvents, failedEvents }, terminals: [{ till, name, claimed, deviceId, sessionOpen, lastSeenAt }] }` — technical metadata only (§40). `pendingEvents`/`failedEvents`/`lastSeenAt` are `null` until the tenant ships device heartbeats; the fields are reserved so the shape will not change. Stub mirrors it |

Every CP push includes `vertical` (CP-owned). The store validates it (400
listing the allowed values when unknown), writes it to `settings.vertical`
and seeds the type's starter category pack (idempotent); an absent `vertical`
leaves the store's current type untouched (backward compatible with older
CP builds).

Since 2026-09-13 the store also refuses a `configure` whose `terminalCount`
exceeds the licence's `maxTerminals` (**402 `terminal_limit_reached`**) — defence
in depth behind the claim gate, so terminal slots and the licence cannot drift.
Configured count ≤ licensed count is enforced at BOTH ends; the CP refuses the
push first (§2a).

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
| `head_office_token`         | TEXT NULL                                      | Per-branch credential the merchant's Head Office uses to call this store; set by topology wiring (2026-09-12). Distinct from `control_plane_token` by design |
| `vertical`                  | TEXT NOT NULL DEFAULT 'general'                | Store type; enum enforced at the API layer (no CHECK — SQLite can't add one via the auto-migration). Pushed on every configure |
| `terminal_count`            | INTEGER NOT NULL DEFAULT 1 CHECK 1–99          | **Configured** terminal slots, pushed as Till 1..N. Bounded by the store's licence allowance; never a billing input |
| `base_url`                  | TEXT NOT NULL CHECK http(s)%                   | Trailing slash stripped at write                                                                                               |
| `control_plane_token`       | TEXT NOT NULL                                  | Never serialized by the API. Supplied at create, or **replaced** by `PUT /api/stores/:id` (2026-09-16) to reconcile a deployment that holds its own value — the repair for "Invalid control plane token". Refused if blank (it cannot be cleared), audited without the value |
| `status`                    | TEXT DEFAULT 'active' CHECK active/paused      | Paused blocks push + reset-admin                                                                                               |
| `last_config_status`        | TEXT DEFAULT 'pending' CHECK pending/ok/failed | Last push outcome                                                                                                              |
| `last_config_at`            | TEXT NULL                                      | UTC `datetime('now')`                                                                                                          |
| `last_config_snapshot_json` | TEXT NULL                                      | Store's configure response (kept only on success)                                                                              |
| `last_health_at`            | TEXT NULL                                      | UTC                                                                                                                            |
| `last_health_status`        | TEXT DEFAULT 'unknown' CHECK up/down/unknown   | up/down recorded on each manual check                                                                                          |
| `created_at` / `updated_at` | TEXT NOT NULL DEFAULT (datetime('now'))        | UTC                                                                                                                            |

`plans` — the catalogue (source of truth for the DDL is `src/config/registryDb.ts`):
`code` (unique, immutable), `name`, `max_stores`, `max_terminals_per_store`,
`features_json`, `pricing_mode` (`per_terminal` | `custom`), `terminal_price_cents`,
`setup_fee_cents`, `billing_period`, `is_active`, `sort_order`, timestamps. All
money is integer cents with a `>= 0` CHECK; a `per_terminal` plan must carry a rate
above zero (refused at the API).

`company_subscriptions` — one row per client: `company_id` (UNIQUE),
`licensed_terminal_count` (>= 0), `setup_fee_status`
(`not_invoiced` | `invoiced` | `paid` | `waived`).

`store_terminal_licences` — where the purchased licences sit: `company_id`,
`store_id` (UNIQUE), `licensed_terminal_count` (>= 0). Invariants enforced in
`services/terminalLicences.ts`: the sum of a client's allocations never exceeds its
subscription's licensed count, and no allocation exceeds the plan's per-store
ceiling.

`invoices` — `amount_cents` plus its evidence: `terminal_count`,
`terminal_price_cents` (rate snapshot), `setup_fee_cents`, and a `description`
(what the charge is for). `subtotal_cents` / `vat_cents` / `vat_rate` are the tax
split of `amount_cents`, which is VAT-inclusive; NULL on invoices raised before
the split existed (their documents were issued without it). `payments` records a settlement (status `completed`)
with a method and reference. `emailed_at` / `emailed_to` are written **only after
the mail server accepts the message**, so the stamp means "sent", never
"attempted".

`office_settings` — **the control plane's own** singleton (`CHECK (id = 1)`,
seeded on first boot): office name/email/phone/address, `invoice_due_days`,
`invoice_footer`, the vendor's own `vat_reg_no` + `vat_rate`, and the SMTP block (`smtp_host`, `smtp_port`, `smtp_user`,
`smtp_pass`, `smtp_from`). Three different things in this codebase are called
settings and they must not be confused: `office_settings` is the vendor's own
(one row, global), `billing_settings` is per client (`company_id`), and the
tenant's `settings` table is per store and not on this plane at all. Nothing a
merchant owns belongs in `office_settings` (§40).

Conventions: snake_case columns, CHECK-constrained enums, ISO-ish UTC
timestamps, JSON text for snapshots. The audit table, the users table and the
DELETE routes shipped after v1 (see `tidbits.md` for what is still open).

## 5a. Error feed (observability, §30)

A store row keeps only the **latest** failure (`last_health_error`,
`last_config_error`), which cannot answer the questions the Errors page exists
for: how often, since when, and how many stores. `error_events` keeps that
history.

| Column        | Notes                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `fingerprint` | SHA-1 (16 hex chars) of the normalised message — the grouping key                                  |
| `source`      | `health` \| `config` \| `licence` \| `deploy`                                                      |
| `entity_type` | `store` \| `panel` — an error belongs to one fleet member                                          |
| `entity_id`   | that member's id                                                                                   |
| `message`     | the control plane's own technical summary, truncated to 500 chars                                   |
| `app_version` | the member's version when it failed, when known                                                     |
| `occurrences` | increments when the same fault recurs                                                               |
| `first_seen` / `last_seen` | UTC; `last_seen` is the row's freshness                                             |

Rules that matter:

- **The group key is `(fingerprint, source, entity_type, entity_id)`.** A unique
  index makes the recorder an upsert, so the table grows with the number of
  distinct problems, not with the number of probes. `entity_type`/`entity_id`
  rather than nullable `store_id`/`panel_id` because SQLite treats NULLs as
  distinct in a unique index — a nullable column would silently write one row
  per occurrence.
- **The fingerprint strips volatile detail** (ids, timestamps, urls, numbers)
  before hashing, so `timed out after 5000ms` and `timed out after 100ms` group
  while two genuinely different faults do not.
- **Recovery never deletes rows.** The feed is a timeline; a store coming back
  up leaves its past failures visible with their original `last_seen`.
- **The reason is now kept where it used to be discarded.** A failed licence
  push recorded only a `failed` enum; it now records its message too.
- **Privacy (§40):** the only thing stored is the control plane's own summary —
  the same strings already held in the store's error columns. Merchant payloads
  and raw response bodies are never persisted or shown, and the feed is
  office-authenticated.
- **Recording never masks a failure.** `recordErrorEvent` swallows and logs its
  own errors, so a problem writing the feed cannot replace the real failure the
  caller is reporting.

Endpoints: `GET /api/errors` returns the grouped feed (newest first, ties broken
by occurrence count then fingerprint) and `GET /api/errors/:fingerprint` returns
one group with every occurrence behind it.

## 5b. Devices (SPOG §25)

`GET /api/devices` is a **derived** view, not a table: there is no devices
registry, and none is needed. Each store contributes one entry per **configured
till** (from `terminalRoster`, so custom names and the roster order survive),
and each Head Office contributes one `office` entry. Per-till state —
`claimed`, `deviceId`, `sessionOpen`, `lastSeenAt` — is read out of the store's
`last_telemetry_json`; the roster decides which tills exist, telemetry decides
what state they are in. A till with no telemetry entry is `unclaimed`.

Derivation lives in `services/fleetView.ts` — the same module the store list and
store detail use for `healthState` / `configState` / the telemetry summary, so
the SPOG cannot drift on how a state is computed.

Honest limits, deliberately surfaced rather than papered over:

- **A bound till reads `claimed`, not `online`.** `lastSeenAt` is a reserved
  null in the v0.4.0 telemetry contract until the tenant ships device
  heartbeats, so "claimed but not reporting" is its own status rather than a
  guess between online and offline.
- **`lastSeenAt` falls back to the store's heartbeat** (`last_heartbeat_at`) for
  display; the table's footer says so.
- **`version` is the store's build**, since every till in a store runs the same
  one and the contract carries no per-device version.
- **A Head Office has no environment** (the `panels` table has no such column)
  and no till state, so those fields are null/false by construction.
- **Read-only.** The spec's device actions (rename, rotate token, revoke, force
  logout, run diagnostics) are not implemented because the tenant exposes no
  per-device command API — §39 forbids shipping the controls as dead buttons.

### Presentation: client → store → device (2026-09-14)

The spec's §25 is a flat device table; on the real fleet that was 70 rows in
which one store (**Everyday Retail, 25 tills**) accounted for 38% of the page and
every row repeated its store's name. The owner asked for store-first grouping and
then for the client above it, so the page groups **client → store → till**.

- **Client is a section band, not another collapse level.** Two nested disclosure
  levels for 65 tills would mean two clicks to reach any device. Each band shows
  the client name and `N stores · M tills`.
- **Stores no client owns get an explicit `Unassigned — no client` section**,
  marked in amber and sorted last. In this fleet that is **5 stores and 37 of 65
  tills** — the largest section. Hiding it would misrepresent the fleet; folding
  it into a client would invent ownership.
- **The store header** carries a health dot, the store name, a short vertical
  chip, the environment **only when it is not `development`**, and a right-aligned
  `N tills · M claimed · heartbeat …`. The client name sits on the band, not on
  every store, so it is stated once.
- **The vertical chip stays even when the name encodes it.** "Builders Hardware"
  and "Brake & Bolt Spares" do describe their own vertical, but `Cape Town` and
  `cpt-wf` are **general**-profile stores belonging to *Kloof Auto Spares* and
  *AHK Spares* — without the chip nothing on screen says a spares merchant is
  running general tills, which is a real configuration mismatch worth seeing.
- **Stores with more than 5 tills start collapsed** (`DEFAULT_EXPAND_MAX_TILLS`),
  with Expand all / Collapse all. The threshold exists so a 25-till store cannot
  bury the other fifteen; it is a presentation default, not a rule about stores.
- **A Head Office gets its own section**, not a store group: it is a fleet member
  with no tills and no parent store, so nesting it under one would be a lie.
- Search matches a store's own fields, so searching `Everyday Retail` brings all
  its tills with it; status/type filters drop groups that no longer match.

## 5c. Versions (SPOG §32)

`GET /api/versions` aggregates the build each registered member currently runs,
from `stores.app_version` / `schema_version` and `panels.app_version` — the
figures telemetry already wrote. There is **no version history**: each member
has one current build, overwritten on every telemetry read, so the page answers
"what is out there now", never "what did this store run last week".

- **Unreported is a bucket, not a gap.** A registered member that has never
  answered telemetry has `app_version` NULL; it appears as its own row
  ("Never reported") so the distribution still accounts for the whole fleet.
- **Most deployed per environment** is the build the most members run in that
  environment, ties broken alphabetically so the figure is stable rather than
  arbitrary. It is a derived fact, not a policy.
- **No "minimum supported" version.** The spec asks for one; nothing in the
  control plane defines a minimum build, and adding one would create a support
  commitment nobody agreed to. Omitted deliberately (tidbits.md) rather than
  defaulted to `0.0.0` or the oldest seen.
- **A Head Office records no environment** (`panels` has no such column), so its
  members show "—" in the environment column rather than a guessed value.
- Environment counts on a row sum to its store count; panel counts sit outside
  them and are shown separately.

## 5d. Deployments (SPOG §33, read-only)

`GET /api/deployments` is the fleet-wide view of `deployment_jobs` — until now
the orchestration history was only reachable per client
(`GET /api/clients/:id/jobs`). Newest first, with a step tally computed in one
grouped query (`deploymentStepCounts`) rather than per job.

`GET /api/deployments/:id` adds the steps.

- **`stepCounts` and `steps` are deliberately different keys.** The list returns
  `stepCounts` (totals); the detail returns `steps` (the rows). One key cannot
  carry both meanings without lying about one of them.
- **What a job does not record, the page does not show.** There is no image
  version/tag on a job, no `environment` column, and no operator — jobs carry
  `type`, `status`, `error`, `started_at`, `completed_at` only. So the spec's
  Version, Environment and Operator columns are omitted rather than guessed at
  (an operator could only be inferred from `audit_logs.actor`, which is not
  joined here). The page footer says so.
- **Target comes from the steps**, which carry `resource_type` + `resource_id`
  (a store, a Head Office, wiring, a licence…) and, for some, `metadata_json`.
- **Warnings are real and worth showing:** a step can be `complete` while having
  recorded best-effort failures in `warnings_json` (e.g. a branch token that
  could not be verified). The detail surfaces them next to the step.
- **Read-only, and no rollout controls.** §33's canary/pause/rollback are
  explicitly "later" and the spec itself warns against them without permissions
  and auditing — which the control plane does not have (it is a single office
  JWT; see the RBAC item in tidbits.md).

## 5e. The office's own settings and the mailer (2026-09-16)

`GET /api/settings` and `PUT /api/settings` (office-gated). Patch semantics:
absent = unchanged, empty string = cleared, and `smtpPass` is returned as the
mask `••••••••` and treated as "unchanged" when submitted back — so a form
round-trip cannot blank a working credential. Clearing `smtp_host` clears the
user, password and from-address with it: a credential must not outlive the
server it belongs to. Every change is audited (`settings_updated`) with the
**masked** view, so the audit trail never becomes a second copy of the password.

`POST /api/settings/test-email` sends a proof message. When the form and the
mailer disagree, the mailer wins: the test uses the **stored** settings, not what
is typed (save first). With no host configured it answers `smtp_not_configured`
rather than complaining about the recipient — the missing mail server is the
more useful thing to say.

**The mailer is real, and that is the point.**
`POST /api/billing/invoices/:id/email` used to audit an email, answer `ok: true`
with a `sentAt`, and send nothing — a fabricated success on the billing surface.
It now goes through `services/mailer.ts` and its outcomes are the honest ones:

| Situation                   | Outcome                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| No SMTP host configured     | **400** `smtp_not_configured`, nothing stamped, audit result `failed`        |
| Relay refuses / unreachable | **502** `mailer_failed` with the relay's reason, nothing stamped, `failed`   |
| Relay accepts               | **200**, `emailed_at`/`emailed_to` stamped, audit `ok`                       |

Recipient precedence: an address named on the request → the client's
`billing_settings.invoice_email` → `companies.billing_email`. The per-client
`email_invoice` / `auto_renew` flags stay API-only and gate nothing yet: there is
no automatic send, so the operator's action is the only path and it always asks.

`invoice_due_days` is the payment term for **newly raised** invoices
(`createInvoiceForCompany`); invoices already issued keep the due date they were
created with.

### The invoice as a document (2026-09-16)

`services/invoicePdf.ts` renders the invoice with pdfkit (A4, 48pt margins — the
same engine and conventions as the tenant's documents) and serves **both** the
email attachment and `GET /api/billing/invoices/:id/pdf`, so what the operator
downloads and what the client receives cannot drift. The document carries the
vendor's identity, the client's name, the description, the charge lines, the
amount due and the footer from Settings. It carries no store data and no till
count beyond the licensed quantity on the recurring line.

Two layout rules are load-bearing, and both were bugs first:

- **The money column must fit the figure.** A 57pt column was narrower than
  `R 14 500,00` (59.9pt at 11pt bold), so pdfkit drew the amount as
  `R 14 500,0` / `0`. It is 110pt now, drawn with `lineBreak: false`, and
  `moneyColumnFits()` (pdfkit's own metrics) is asserted in
  `invoicePdf.test.ts` so a width change cannot reintroduce it.
- **Anything that can wrap must be measured.** A wrapped description advanced a
  fixed 16pt and the total rule cut through its second line; a long client name
  ran into the row beneath it. Both offsets come from `heightOfString()` now, and
  the footer flows after the charge block instead of being pinned to the foot of
  the page (which left half an A4 blank on a one-line invoice).

### What an invoice snapshots (2026-09-16)

An invoice is a document, so everything that describes the deal at the moment it
was raised is **copied onto it** — never read back through today's catalogue:

| On the invoice          | Because                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `terminal_count` × `terminal_price_cents` | The rate at issue; a plan's price change must not restate an issued invoice |
| `setup_fee_cents`       | The once-off as charged, not as the plan prices it now      |
| `plan_code` / `plan_name` | The plan the client was on when it was raised             |
| `subtotal_cents` / `vat_cents` / `vat_rate` | The tax inside the total, at the rate then in force |
| `description`           | What the charge was for, in the words used at the time      |

The plan name is shown in the PDF's metadata block and on the subscription line
(`Vula Network · 7 × R 500,00`), and in the client's emailed invoice; the Billing
detail view reads it off the invoice rather than the client's current plan. A
client with no plan shows nothing there — the invoice says what it knows.

### VAT and invoice numbering (2026-09-16)

**Every price this office quotes is VAT-inclusive** (owner decision). The plan's
per-terminal rate, the onboarding charge and any hand-priced amount are all the
figure the client pays; the tax is broken *out* of it, never added on top. That
makes the arithmetic one-directional and exact:

```
subtotal = round(total × 100 / (100 + rate))   // VAT-exclusive
vat      = total − subtotal                    // the portion inside the total
```

(`utils/money.ts` `exclusiveCents` / `vatPortionCents` — integer cents, and the
two always add back to the total, so no invoice is ever a cent out.) The rate and
the vendor's own registration are office settings: the invoice is headed **Tax
invoice** and carries the number when `vat_reg_no` is set, and a plain invoice
when it is not. Both are stored **on the invoice as raised** — changing a rate
never restates a document that has already gone out.

Invoices raised before the split existed keep NULLs and print the total alone.
Back-filling them would state tax figures that were never on the document.

**Invoice numbers are a monotonic per-year sequence**: `VULA-2026-000001`. They
used to be `INV-<date>-<4 random digits>`, which was neither sequential (no gap or
duplicate is visible from the number) nor collision-safe — two invoices raised in
the same second could draw the same digits, and the UNIQUE index surfaced the
loser as a raw database error. The counter is an `invoice_sequences` row
incremented in the statement that reads it, and a year's counter starts from the
highest number already written for that year, so a restored backup or an imported
fleet cannot re-issue a number.

### The price a client agreed — grandfathering (2026-09-16)

A **plan** is a catalogue entry; what a client pays is their own record. When a
client is onboarded (the wizard, or `POST /companies`), when the office moves them
to another plan, or when the office explicitly re-prices them, the plan's terms are
copied onto the subscription:

| `company_subscriptions` | Meaning                                              |
| ----------------------- | ---------------------------------------------------- |
| `pricing_mode`          | `per_terminal` or `custom`, as agreed                |
| `rate_cents`            | The agreed per-terminal rate                         |
| `custom_amount_cents`   | The agreed flat charge, for a negotiated deal         |
| `setup_fee_cents`       | The agreed once-off onboarding charge                |
| `billing_period`        | `monthly` / `annual` / `once-off`                     |
| `priced_at`             | When the office recorded it (NULL = never recorded)  |

`quoteForSubscription` reads the **agreement first** and falls back to the plan
only when `priced_at` is NULL, reporting `pricingSource: 'agreed' | 'plan'` so the
UI can say which. **Editing a plan therefore re-prices nobody** — that is the whole
point: eleven clients on four tiers would otherwise all move on one save.
`POST /api/clients/:id/reprice` is how a rise is actually applied (one client,
audited as `subscription_priced`); the client page shows "Priced from the plan —
no agreed price recorded yet" for a legacy row and offers that button.

Caps, terminal ceilings and features keep tracking the **plan** live: they are
entitlements, not prices. Moving a client onto an archived plan is still refused.

### Mid-period increases (pro-rata, 2026-09-16)

When a client buys terminals *after* the period they have paid for, the extra
terminals are charged for the days left in that period — not for the whole next
period, and not free:

```
extra     = licensed now − terminals on the last SETTLED invoice
amount    = round(extra × agreed rate × daysRemaining / periodDays)
periodDays: monthly = 30, annual = 365          (a stated convention, not a law)
daysRemaining = paid_through − today
```

- **Only increases.** A reduction is not credited; it applies from the next period.
- **Only `per_terminal` deals.** A negotiated flat amount has no per-terminal figure
  to multiply, so a quantity change is priced by the office, as with any hand-priced
  invoice.
- **Only against a paid period.** `paidTerminalCount` comes from the most recent
  **settled** invoice — with nothing settled there is no unbilled time to charge for,
  and a lapsed period has nothing left either.
- **One charge per paid period.** The invoice stamps `pro_rata_period` with the
  period it covered, so the same increase cannot be billed twice; voiding it frees
  the period again, exactly as voiding releases the once-off onboarding charge.
- **The office raises it, the amount is shown first.** The client page shows the
  figure and the window ("2 extra terminals · 15 of 30 days · 2026-09-15 to
  2026-09-30"), and `POST /api/billing/invoices {purpose: 'pro_rata'}` raises it —
  409 `nothing_to_pro_rate`, or 409 `pro_rata_already_billed` naming the invoice
  that already has it. Nothing is invoiced without that act, and the office can
  always see what it owes.

The line is deliberately **not** `count × rate`: it is time-based, so it carries no
`terminal_count`/`terminal_price_cents`, and the description spells out the
arithmetic. Every invoice line — structured or not — comes from one model
(`invoiceLineItems` in `services/billing.ts`), so the PDF and the email cannot
disagree, and a hand-priced or pro-rata charge appears as a real line with its
amount instead of a bare total.

### Settling and voiding (2026-09-16)

**The action is "Record payment", never "Pay".** The control plane does not charge
anyone: a settlement happens outside it (EFT, bank transfer, cash) and the office
records it — a payment row with the method and reference, `paid_through` advanced,
signed licences re-pushed. "Pay" implied money movement this app never performs,
which is the same class of mislabelling as the invoice-email stub that reported a
send it never made.

**Only the methods that actually happen are offered**: Manual EFT / Bank Deposit,
and Direct Debit / Bank Transfer. Stripe, PayPal and card-terminal options were
removed from the UI because no gateway is integrated — choosing one recorded a
charge no system had made. The API enum still accepts those values, because the
method describes how money arrived rather than asking the CP to move it; when a
gateway lands it is a **new action** ("Charge card"), not a relabelling of this one.

**An issued invoice is voided, not cancelled** — "Cancel" sat beside "Record
payment" and read as "cancel the payment". The stored status stays `cancelled`
(the DDL CHECK cannot be altered in place, and the wire value is unchanged); the
Screens read it as *Voided*. A void keeps the invoice on the record and simply
stops it being payable, releases the once-off onboarding charge if this was the
last invoice carrying it (the response says `setupFeeReleased: true`, and the UI
says so out loud), and is attributed in the audit trail as `invoice_voided`.

### Charging once off (2026-09-16)

**Support is not a separate charge — it is included in the per-terminal rate**
(owner decision, 2026-09-16). There is deliberately no support line, no support
plan column and no support charge type: `licensed terminals × rate` is the whole
recurring model, and support comes with it. Do not add one without the owner
saying so — asked directly, the answer was *"we charging per terminal which
includes support"*.

**The once-off charge is captured automatically.** Whichever invoice is raised
next for a client that has never been billed its onboarding charge carries it —
`initial`, `renewal` (including the automated sweep), or a hand-priced invoice.
The office does not have to remember a second step; nine live clients had each
been left with an unbilled R10 000 by exactly that.

| What is raised                                     | What the invoice carries                                          |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Subscription, `purpose: 'initial'`                 | recurring + the unbilled once-off (itemised separately)           |
| Subscription, `purpose: 'renewal'`                 | recurring + the unbilled once-off — the sweep counts these in `onboardingCharged` |
| Hand-priced (`amountCents` + `description`)         | the agreed amount + the unbilled once-off                         |
| `purpose: 'onboarding'`                            | the once-off **alone** — for a client already invoiced for a period (409 `setup_fee_not_due` when there is none due) |
| Any of the above with `includeOnboarding: false`    | the invoice's own charge only; the once-off waits for the next one |

The guard against double-billing is `setupFeeDueCents`, which is zero the moment
the charge sits on a standing invoice, is paid, or is waived. So there is no
"bill it twice" case to reason about — and `includeOnboarding: false` is the
operator saying "not on this one", which leaves the charge owed and available to
the next invoice.

**The once-off leads the invoice lines whenever it applies** (owner, 2026-09-16).
It is the first thing the client is asked to pay for, on the PDF, in the emailed
invoice, in the Billing detail view and in the Raise-an-Invoice preview alike —
subscription lines follow it. The invoice's *subject* (the `description`) stays
with the title rather than sitting in the amounts column, where a line with no
amount reads as an uncharged item.

**It is called "Vula onboarding and deployment"** wherever it is itemised
(`SETUP_FEE_LINE_LABEL` in `services/billing.ts`, mirrored in the SPA's
`lib/storeVocab.ts` as `SETUP_FEE_LABEL` — the two cannot share a module across
the build). The plan-level field keeps the name *once-off onboarding* on the plan
form and the subscription's status vocabulary; the invoice line is what the client
reads, and it says what the money bought.

**A hand-priced invoice must carry a `description`** (400
`invoice_description_required`). It is how a once-off charge says what it is for,
and it is what stops a client receiving a bare "Amount due: R2 500,00" — the
description shows on the invoice list, the detail, the PDF and the email. When
the control plane computes the amount itself it derives the description instead
(`Subscription — Vula Network (monthly) + Vula onboarding and deployment`).

**Cancelling the last invoice that carries the onboarding charge frees it**
(2026-09-16): the subscription goes back to `not_invoiced` and the response says
`setupFeeReleased: true`. Without that, the charge was stranded — no standing
invoice carried it, and the client was recorded as though it had been billed, so
it could never be raised again. Cancelling an already-cancelled invoice is
idempotent and still performs that release, which is also how a registry that hit
the hole before it was fixed is repaired.

Surfaces name where the charge sits as `setupFeeRef` (the invoice number) rather
than anything containing "invoice": the §40 privacy test walks field *names* on
the client and company endpoints and cannot tell a vendor document number from a
merchant's billing data — the same reason `tradingBlocked` is not `salesBlocked`.

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
auto-provisioning. Tracked in `tidbits.md` and the za-pos `task_plan.md`.

Corrected 2026-09-16: this section used to list "audit trail, DELETE store,
automated health sweep" as out of scope, though all three shipped
(2026-09-11/12 — `audit_logs` §38, pause-first teardown §21, `healthSweep`).
Flagged in `findings.md` on 2026-09-14 and fixed here, since a stale scope list
is worse than no list.
