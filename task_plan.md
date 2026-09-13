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

**L4 Enforcement — control-plane authority side (2026-09-11).** Plans no longer
gate nothing. Shipped in this repo:

- **Curated feature vocabulary** (`src/services/features.ts`) — the six locked
  keys with labels + `enforcedBy`; plans may grant only these (400 names an
  unknown key); served at `GET /api/plans/features`.
- **CP-side gates (402)** — `requireFeature(plan, key)` in subscriptions.ts;
  `multi_store` required for multi-store onboarding and single→multi upgrades
  (`feature_not_in_plan`); a **suspended** company buys no new capacity —
  store creation and till increases refused (`subscription_suspended`), while
  config/licence pushes stay open so a store can learn it is unsuspended.
- **Enforcement propagation** — company PUT (plan / paid-through / trial /
  status change) immediately re-pushes signed licences to all branch stores +
  Head Office; delivery failures reported in `licencePush`, never fatal.
- **Register states surfaced** — `registerState`
  (`ok|warn|grace|suspended|trial|unlicensed`) + `tradingBlocked` on stores
  and companies; Register column on the fleet card, "Sales blocked" pill on
  companies.
- Tests: 120 across 11 suites (+15 `enforcement.test.ts`).
- **Contract authored in CONTEXT.md §2b** — the store side is the za-pos
  workstream (below). Previous phase — restaurant vertical mirror (2026-09-11).

**Current phase — production-readiness fixes (2026-09-12, owner: "fix first
before continuing").** The review's P0 set plus the cheap P1/P2 items shipped
the same day (see progress.md): truthful deployment steps with persisted
Coolify UUIDs, a real Head Office deployment path, the hard-coded admin
password gone, `billing_settings` rebuilt per-company, two-way topology
wiring with per-branch `HEAD_OFFICE_TOKEN`s, Retail → Business, plan-code
immutability + active-plan filtering, settlement-gated auto-renewal, and
`vat_reg_no` dropped from the CP surface. **Next step:** F1 CP ops hardening.

Previous Phase — **Subscription licensing & multi-tenant fleet (2026-09-10).** CP v1 (stores CRUD +
terminal provisioning) shipped 2026-09-03; the licensing/commercial layer landed
2026-09-10.

- **L1 asymmetric licence signing** — ES256/P-256 keypair, `POST /api/internal/licence`
  delivery, published verification key.
- **Companies & plans (L2)** — merchant accounts, 4 editable tiers, derived billing state,
  402 cap refusals with upgrade messaging.
- **Head Offices as fleet members** — `panels` table with registration, health, version,
  and company licence verification.
- **Fleet hygiene** — store teardown (pause-first), one-deployment-one-row, self-describing app kinds
  (`wrong_app_kind`), one-time token reveal.

**Planned, not started:** the store side of L4, L5, the SPOG UI set below; and the
older fleet phase set F1–F3 (2026-09-06), with F3a struck and F3b/F3c reassigned.

## Phase set (planned 2026-09-10): licensing & the SPOG

Decisions locked with the owner: asymmetric CP-signed licences · warn → grace →
block new sales, keep all data · manual invoices first (gateway later) · tiered plan
(max stores + per-store till ceiling + features), 4 seeded editable tiers · over a
cap, block and offer an upgrade · curated feature gating (6 keys).

- [x] **L1 Asymmetric licence foundation** (2026-09-10)
- [x] **L2 Companies & plans** (2026-09-10) — incl. caps and the panel entity
- [x] **L3 Billing & Invoicing** (2026-09-11) — subscription invoices & payment ledger;
      marking paid advances `paid_through` and automatically re-pushes signed licences
      to all branch stores and Head Office panels; automated renewal checks (`/api/billing/renew-check`);
      and dedicated Office Billing & Invoicing UI (`/billing`).
- [x] **L4 Enforcement — control-plane authority side** (2026-09-11) — curated feature
      vocabulary + validation, CP-side 402 gates (`feature_not_in_plan`,
      `subscription_suspended`), licence propagation on entitlement change, register
      states surfaced; contract in CONTEXT §2b. Store side below.
- [x] **L4 Enforcement — store side (za-pos, 2026-09-12)** — `requireFeature(key)`
      middleware (402 `feature_not_in_plan`) on debtors/lay-bys, customer credit
      fields, the range report, woo/shopify bridges, AI routes and Head Office
      calls into the branch (`multi_store`); suspended gate inside `checkout()`
      (402 `subscription_suspended`) covering POS, offline sync replay, order
      collection and quotation conversion; `subscription` block in
      `/api/runtime-config`; register warn/grace/suspended banners + feature
      hiding. Contract: CONTEXT §2b; store doctrine: za-pos `CONTEXT.md` §14a.
- [x] **L5 Head Office entitlements** (2026-09-12, za-pos side) — the panel's
      `requireFeature('multi_store')` middleware gates catalogue writes/branch
      pushes, stock transfers, cross-branch lookup and branch management with
      `402 feature_not_in_plan`; reads stay open; unlicensed dev panels stay
      permissive. Completes the L1–L5 chain.
- [x] **SPOG — store telemetry** (2026-09-12) — `GET /api/internal/telemetry`
      (internal API v0.4.0, contract §4): app/schema version, heartbeat,
      per-till claim state and sync liveness; `lastSeenAt`/queue counts are
      nullable until the tenant ships device heartbeats. CP persists
      `app_version`/`schema_version`/`last_heartbeat_at`/`last_telemetry_json`
      via the health route and the sweep; stub mirrors it.
- [x] **SPOG — Stores screen** (2026-09-12, per the UI-revision spec §45/§47):
      Store Type → POS profile (+ Custom); Environment field; Version and
      versioned Config state columns; derived technical Health vocabulary
      (healthy/warning/offline/unknown) split from the administrative state;
      Licence column mapped from register states; terminal claimed/open
      summary + sync line on the roster strip; actions renamed to Diagnostics /
      Configure / Push Config / Support / More (Pause/Resume/Remove inside
      More); audited Support session modal (reason + optional temp password);
      Diagnostics modal; summary cards reordered technical-first with a second
      row; filters extended (Healthy/Warning/Offline/Paused/Config issue/Sync
      issue); search extended to store ID.
- [x] **Support session workflow** (2026-09-13): Start (reason, audited) →
      active-session view (health/version/schema/config/licence/sync/latency
      summary + reveal-once temp password) → End (audited). The session stays
      open while the developer works instead of vanishing behind a toast.
- [x] **Head Office is a card on the client Overview** (2026-09-13,
      owner-directed — no separate tab): full panel detail (URL, status, last
      check, version, licence sequence/push) + Diagnostics and Push Licence
      actions in its own overview card; Single-Store clients see the upgrade
      entry point there. Head Offices removed from the nav (the /head-offices
      fleet page stays reachable by URL for panel registration, like /stores
      and /companies). Tabs: Overview · Stores · Deployments.
      **Deferred (spec "Next"/"Later"):** Devices page,
      sync dashboard/inspector, errors, backups, versions/deployments.
- [x] **SPOG navigation & drill-down** (2026-09-12/13, owner-directed): the
      owner removed the Stores nav link the same day — **stores are reached
      through the client**: every client card lists its stores as chips
      linking straight into `/stores/:id` (colour-coded by health), the
      client's Stores tab renders the shared cards, and the store detail page
      breadcrumbs back to the client. The `/stores` fleet page remains
      reachable by URL for cross-client ops but is deliberately unlinked.
      Head Offices · Plans · Billing stay in the nav; the store card
      is one shared component (`StoreCard` + `useStoreActions` + shared
      modals) used by the fleet page AND the client's Stores tab — the stale
      duplicate table on the client page is gone; new **/stores/:id** store
      detail page (SPOG §24 Overview + per-store audit trail via
      `GET /api/stores/:id/audit`) reached from both surfaces, with the fleet
      card's Client name linking back to the client; naming sweep: the
      merchant account is **"Client"** everywhere in the UI (PanelsPage's
      46 "Merchant" strings included), Company accounts demoted to an
      advanced page linked from Clients, "Stores" kept as the domain term.
- [x] **Plans: deactivate in the UI** (2026-09-12 — Deactivate/Re-activate
      action + Active/Archived pills; code field read-only in edit mode) and
      the **audit trail** (shipped 2026-09-11, §38).

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

| #   | Decision                                                                                                                                         | Rationale                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| D11 | Store type field is `vertical` everywhere (UI label "Store type"), values `general` · `clothing` · `spares` · `supermarket`, default `general`   | Mirrors za-pos `settings.vertical` 1:1 so the push maps directly; tenant docs always called it "store type (vertical)" |
| D12 | Every configure push carries `vertical`; tenant applies it + seeds the pack idempotently; an absent `vertical` leaves the store's type untouched | Same trust model as terminal replacement; older CP builds stay compatible (tenant-side leniency)                       |

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
before F1 starts. Fleet verified from the registry (2026-09-10: 8 stores,
health up, config ok.

- [x] **F1 CP ops hardening** (this repo — complete 2026-09-12; the sweep,
      audit table and teardown had already shipped with the consolidated-plan
      and licensing work, see progress 2026-09-11 / 2026-09-10)
  - Automated health sweep — shipped 2026-09-11 (`services/healthSweep.ts`,
    `POST /api/stores/health-sweep`, latency recorded).
  - Persist last errors — **shipped 2026-09-12**:
    `last_config_error`/`last_health_error` recorded by every outcome site
    (push, health, sweep, provisioning), cleared on recovery; shown under the
    Health/Config badges on the fleet card so a red state explains itself.
  - Audit table — shipped 2026-09-11 (`audit_logs`, §27).
  - Store delete/teardown — shipped 2026-09-10 (pause-first, §21).
  - Custom terminal names per till — **shipped 2026-09-12**:
    `terminal_names_json` on the registry row, `terminalRoster()` feeds every
    configure push (topology wiring included, so re-pushes never clobber
    names), edit modal gains per-till inputs, roster tiles show custom names.
  - Fleet header strip — shipped 2026-09-10 (SummaryTiles + search + filter).
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
  - ~~F3a fleet summary~~ **STRUCK 2026-09-10** — it planned a control-plane
    dashboard carrying product count, today's orders/revenue, open tills and
    low-stock count. The Developer Control Plane spec (§1, §8, §40) forbids
    business metrics on this surface: the CP may know whether an app is
    functioning, never how much money it is making. That dashboard is delivered
    by the merchant's own Company Control Panel (`za-pos/head-office`) instead.
  - F3b catalogue push: a central catalogue in the CP, pushed to chosen
    stores via an internal upsert (SKU as the key) — same trust model
    as the verticals push.
  - F3c inter-store transfers (IBT): the CP orchestrates source
    decrement + destination increment over the internal API; both ends
    write audited stock_movements (reuse `kind 'adjustment'` with
    `IBT-…` reasons, or add kinds — decide at build; the CHECK rebuild
    pattern exists).
- Interplay: ~~tenant P4 (restaurant vertical) adds `restaurant` to this
  repo's vertical vocabulary when it lands~~ **done 2026-09-11** —
  `restaurant` mirrored across the vocabulary, UI, stub and tests
  (pharmacy precedent); tenant P2/P3 (returns) run on the za-pos track
  independently.

## Phase set (planned 2026-09-12): production-safe Multi-Store provisioning + subscription foundation

Source: external production-readiness review
(`~/Downloads/vula-subscription-and-platform-deep-dive-report.md`); every
claim code-verified the same day — see the findings.md entry at the top.
Proposed to sequence **ahead of F1** (orchestration truthfulness blocks
trusting any automated deployment), but F1-vs-this order is the owner's
call. za-pos-side items (HO Dockerfile, demo-seed guard, token fallback)
run as the tenant workstream in parallel.

- [x] **P0 Orchestration truthfulness** (2026-09-12) — required Coolify
      operations fail the step; best-effort ops (admin bootstrap, first
      config/licence push) complete with recorded `warnings_json`; the
      orchestrator persists `coolify_uuid`/`volume_name` immediately and skips
      creation when the UUID exists (retry never duplicates). A generic
      `deployments` table is deferred — the store/panel columns cover it for now.
- [x] **P0 Real Head Office deployment** (2026-09-12) — `head-office/Dockerfile`
      in za-pos + `createHeadOfficeDeployment()` in `services/coolify.ts`
      (`dockerfile_location: head-office/Dockerfile`); `head_office_deploy`
      uses it. Image build verified locally.
- [x] **P0 Security** (2026-09-12) — `AdminPassword@123` replaced with the
      storeProvisioning CSPRNG generator (password used once, never persisted
      or shown; the operator issues a login via the existing reveal-once
      reset); za-pos HO demo seeding gated by `SEED_DEMO_DATA`
      (default off in production), plus a new CP-driven
      `POST /api/internal/admin/init` on the panel.
- [x] **P0 billing_settings schema fix** (2026-09-12) — rebuilt with
      `company_id` as the natural key; the unused `auto_renew_subscription_id`
      dropped; migration test added.
- [x] **P0 wire_topology both directions** (2026-09-12) — per-branch
      `HEAD_OFFICE_TOKEN` generated and stored (`stores.head_office_token`),
      pushed via configure, and registered in the panel via
      `POST /api/internal/branches`; wiring failures fail the step.
- [x] **P1 (partial) Subscription foundation** (2026-09-12) — seeded plan
      `Retail` → `Business` (code migrated once, immutable via API
      thereafter); inactive plans refused at onboarding/company assignment;
      auto-renewal no longer records a synthetic payment — the sweep only
      creates the invoice, settlement is explicit
      (`BILLING_SIMULATE_RENEWAL_SETTLEMENT=true` restores demo behaviour).
      **Still deferred:** per-store pricing (`plan_prices`), subscription
      snapshots, annual discount mechanics.
- [x] **P2 (partial) Privacy boundary** (2026-09-12) — `vat_reg_no` dropped
      from the CP stores DDL/DTOs/forms (with a DROP COLUMN migration) and
      from za-pos `/api/internal/control/status`; the CP-token fallback on
      Head Office routes is now env-gated
      (`ALLOW_CONTROL_PLANE_TOKEN_FALLBACK`, default OFF). **Still deferred:**
      renaming the legacy `branch_stores.control_plane_token` column in za-pos
      (additive `head_office_token` shipped first).
- [ ] **Integration tests** (per the review's §38): single-store onboarding,
      multi-store onboarding, retry-without-duplicates, single→multi upgrade
      preserving the original store, expire→grace→suspend→resume, and
      CP-vs-HO token isolation suites. *Partially covered:* the new
      orchestration suite covers fail-truthfully, UUID persistence +
      retry-without-duplicates, two-way wiring, and warnings-not-fake-success.
