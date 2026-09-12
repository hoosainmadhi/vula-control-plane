# Progress

Dated log of the build.

## 2026-09-12 — dev stub implements licence delivery; L4 verified end to end on a live stack

- The dev store stub (`scripts/dev-store-stub.ts`) had **no
  `POST /api/internal/licence`** — it predates L1, so every licence push to a
  stub-backed store 404'd and `licence_push_status` stayed `failed`. Added the
  route in stub style: token-guarded, tracks the monotonic sequence (409 on a
  stale one, mirroring the tenant), logs the claims' plan + billing state. No
  signature verification — the stub holds no key; the real store verifies
  against `LEASE_PUBLIC_KEY`.
- With that in place the whole L4 flow was verified against a throwaway
  instance (`CP_DB_PATH=/tmp/... PORT=3242` + stub on :3299, live CP on :3240
  untouched): vocabulary endpoint, unknown-key 400, suspended-company 402s,
  suspension → `licence v2 accepted … billing state suspended` at the stub →
  store row `registerState=suspended / tradingBlocked=true`, till increase
  refused, multi-store wizard refused on Starter, resume → licence v3 active →
  `ok`. Panel delivery failures reported, never fatal.
- Stub note for demos: supply the same 64-hex token to both
  (`CONTROL_PLANE_TOKEN=<hex>` on the stub, `controlPlaneToken` on store
  create) or pushes 401.

## 2026-09-11 — L4 enforcement, control-plane authority side (plans stop being informational)

- **Curated feature vocabulary (`src/services/features.ts`)**: the six locked
  keys (`customer_credit`, `advanced_reports`, `multi_store`,
  `stock_transfers`, `ecommerce_bridges`, `ai_assistant`) now live as
  `PLAN_FEATURES` with labels and `enforcedBy` (store / head-office /
  control-plane). `validateFeatureKeys()` refuses unknown keys at plan
  create/edit (400 names the bad key and the allowed list) and normalises to
  vocabulary order so licences carry a deterministic feature list. Served at
  `GET /api/plans/features`.
- **CP-side `requireFeature(plan, key)`** (subscriptions.ts) — takes the plan
  that will be in force when the capability lands (an upgrade may carry its
  own plan switch). Gates: `POST /api/clients` with `deploymentType:
multi_store` and `POST /api/clients/:id/upgrade-to-multistore` need
  `multi_store` → `402 { error, code: 'feature_not_in_plan' }`, refused
  before anything is created.
- **Suspended = no new capacity**: store creation for a suspended company and
  terminal-count increases on its stores return
  `402 { error, code: 'subscription_suspended' }`. Same-count pushes and
  unrelated edits stay allowed — config/licence delivery is how a store
  learns it has been unsuspended. Grace (`past_due`) and trial keep trading.
- **Propagation**: `PUT /api/companies/:id` detects an entitlement change
  (planId / paidThrough / trialEndsAt / status) and immediately runs
  `pushLicencesForCompany` (the L3 path) — a manual suspension reaches the
  registers in seconds, not at the next sweep. Response carries
  `licencePush: { storesUpdated, panelsUpdated, errors }` (null when nothing
  entitlement-bearing changed); delivery failures are reported, never fatal.
- **Register states**: `registerEnforcementFor()` maps billing state to
  `registerState` (`ok | warn | grace | suspended | trial | unlicensed`, warn
  = paid-through ends within `REGISTER_WARN_DAYS = 7`, mirroring za-pos
  `licence.ts`) + `tradingBlocked`. Surfaced on `StoreOut`/`CompanyOut`, the
  fleet card gained a **Register** column, companies gained a "Sales blocked"
  pill.
- **Naming lesson**: the first draft called the flag `salesBlocked` — the §40
  privacy-boundary test failed it immediately (forbidden key pattern
  `/sales/i`). Renamed to **`tradingBlocked`**, which is also the better
  domain word (suspension stops trading; reads/returns/cash-ups stay open).
- Existing `clients.test.ts` onboarding/upgrade tests now pass an explicit
  multi-store `planId` — correct, since multi-store topology is a plan
  feature and a no-plan company must not get it for free.
- CONTEXT.md §2b "Feature enforcement (L4)" authored: vocabulary table,
  who-enforces-what, propagation, register-state vocabulary, and the tenant
  TODO (requireFeature middleware, checkout/sync gate, runtime-config
  subscription block, banners). **No `/api/internal/*` shapes changed** — the
  licence already carries everything; nothing for the tenant contract to
  break.
- Tests: **120 green across 11 suites** (+15 `enforcement.test.ts`);
  typecheck clean; frontend build green.

## 2026-09-11 — restaurant store type (tenant P4 mirror)

- `restaurant` added to the CP vertical vocabulary, mirroring the tenant
  (`~/apps/za-pos` shipped P4 the same day — menu starter pack,
  starter-pack-only like hardware/pharmacy): `StoreVertical` union +
  `STORE_VERTICALS` in `src/config/registryDb.ts`, mirrored union in
  `frontend/src/types.ts`, `VERTICAL_COLORS` pill (`bg-rose-100
text-rose-700`) in `StatusBadge.tsx`, `StoresPage` chip label
  "Restaurant" + form option "Restaurant & quick service", and the two
  hard-coded POS-profile dropdowns (`ClientsPage` wizard +
  `ClientDetailPage` edit modal) gained "Restaurant & Quick Service".
  `scripts/dev-store-stub.ts` allow-list updated; the "rejects unknown
  verticals" test regex now includes `restaurant` (still samples
  `bakery` as the unknown value). CONTEXT vocabulary + configure-payload
  rows updated; task_plan interplay note and tidbits struck.
- Workstream note (owner): all work now happens on `dev`; order is
  P4 → L4 (CP enforcement) → F1 (CP ops hardening) → backlog.

## 2026-09-11 — Consolidated Plan: Client-Centric Workflow, Durable Orchestration & Operations Hardening (Phases 0–5)

- **Client-Centric Control Plane Architecture (`src/routes/clients.ts`, `services/clientOrchestrator.ts`)**:
  1. Refactored Control Plane primary navigation around canonical **Client / Company** entities (`ClientsPage.tsx` at `/`).
  2. Built **New Client Wizard** (`+ New Client`):
     - Step 1: Client Information (Name, Slug, Billing Email, Plan, POS Profile).
     - Step 2: Deployment Topology selection (Single Store vs Multi-Store).
     - Step 3: Technical Setup (Single store FQDN/Tills or Head Office + Branch store roster).
     - Step 4: Review & Automated Orchestration.
  3. Built **Client Detail Portal** (`ClientDetailPage.tsx` at `/clients/:id`):
     - Comprehensive tabs for Overview, Stores Fleet, Head Office Panel, and Deployments.
     - Live deployment stepper with granular step outcomes and one-click Retry.
     - Single-to-Multi Upgrade workflow (§7): deploys Head Office and branches without touching existing store databases.
- **Durable Deployment Jobs & Steps Engine (`deployment_jobs`, `deployment_job_steps`)**:
  1. Persistent job ledger: `deployment_jobs` and `deployment_job_steps` with status tracking (`pending`, `running`, `complete`, `failed`).
  2. Idempotent step runner: checks existing resources, skips already completed steps, resumes failed steps without duplicate container creation.
  3. Automated multi-store wiring: auto-deploys HO, branches, configures terminals, provisions admins, wires HO URL/token into branch stores, and broadcasts asymmetric trade licences.
- **Operations Hardening & Privacy Cleanups**:
  1. Removed `vat_reg_no` from Developer Control Plane store creation/edit forms and DTOs (§21).
  2. Configuration versioning: added `desired_config_version` and `applied_config_version` tracking (§22).
  3. Background health sweep service (`services/healthSweep.ts`): pings active stores/panels, records latency in milliseconds, and exposes `POST /api/stores/health-sweep` (§23).
  4. Audit logging table (`audit_logs`) and API (`GET /api/stores/audit-logs`) tracking privileged admin actions (§27).
- Tests: 104 green across 10 suites (+4 new client orchestration tests); backend and frontend builds clean.

## 2026-09-11 — L3 Billing & Invoicing shipped (automated subscriptions & licence renewals)

- **Subscription Invoicing & Payments Engine (`services/billing.ts`)**:
  1. `invoices` table: tracks invoice number (`INV-YYYYMMDD-XXXX`), company id, amount, due date, paid date, status (`pending`, `paid`, `overdue`, `cancelled`).
  2. `payments` table: records completed fee settlements with payment method (`manual`, `stripe`, `bank_transfer`, `credit_card`, `paypal`), transaction ID, and timestamp.
  3. `billing_settings` table: per-company auto-renewal preferences and invoice notification settings.
  4. Monotonic renewal date calculation: `calculateRenewalDate()` computes exact renewal dates (+1 month for monthly, +1 year for annual, 2099-12-31 for once-off). Extends from existing future `paid_through` if active, or from today if past due.
  5. Automated fleet licence push: upon payment settlement or auto-renewal, signed asymmetric licences are instantly re-minted with monotonic sequence and pushed to every branch store (`pushLicence`) and Company Head Office panel (`pushLicenceToPanel`).
  6. Automated background renewal sweep: `runAutomatedRenewals()` scans all active merchant companies with priced plans. Subscriptions within the 3-day expiry threshold automatically generate invoices, settle payments, advance `paid_through`, and broadcast renewed licences.
- **Office Billing API (`src/routes/billing.ts`)**:
  - `GET /api/billing/invoices`, `GET /api/billing/invoices/:id`, `POST /api/billing/invoices`
  - `POST /api/billing/invoices/:id/pay` (record payment, advance `paid_through`, push licences)
  - `POST /api/billing/invoices/:id/cancel`
  - `GET /api/billing/payments`, `GET/PUT /api/billing/settings/:companyId`
  - `POST /api/billing/renew-check` (trigger automated renewal cycle)
- **Executive Billing Dashboard (`frontend/src/pages/BillingPage.tsx`)**:
  - Live billing KPIs (Total Billed, Collected Revenue, Outstanding Receivables).
  - Status filters, invoice generator modal, payment capture modal, and manual trigger for the automated renewal sweep.
  - Recent payment audit ledger.
- Tests: 100 green across 9 suites (+5 new comprehensive billing tests); backend typecheck and frontend production build clean.

## 2026-09-11 — automated Coolify container provisioning (F2 core shipped)

- Integrated Coolify v1 REST API client (`services/coolify.ts`) into the Control Plane,
  porting the proven pattern from `optimed-control-plane`.
- Added background provisioning service (`services/storeProvisioning.ts`): calls Coolify v1 API,
  creates applications targeting `hoosainmadhi/za-pos`, injects environment variables
  (`PORT=3000`, `DB_PATH=/data/za-pos.db`, `LEASE_PUBLIC_KEY`, `APP_URL`, `JWT_SECRET`,
  `CONTROL_PLANE_TOKEN`), attaches Docker persistent volumes, triggers build & deploy, polls
  `/health` until up, bootstraps store admin via `/api/internal/admin/init`, and pushes initial
  terminals + trade licence.
- Database schema: added `deploy_status`, `coolify_uuid`, `volume_name`, `admin_email` columns
  to `stores` table with auto-migrations in `src/config/registryDb.ts`.
- UI: Added "Auto-provision container on Coolify" checkbox and admin email input to `StoresPage.tsx`
  create modal, live deployment status badges (`Provisioning on Coolify...` with animated spinner,
  `Auto-deployed`, `Deploy failed`), and automatic 4-second live polling while provisioning.
- Tests: 95 green across 8 suites; typecheck and frontend build clean.

## 2026-09-10 — the fleet is self-describing: wrong-kind registrations refused

- Owner reported two failing rows:
  - `HM Spares Head Office` (panel) showing **Down** — its URL was
    `https://localhost:3250`, i.e. `https://` (TLS) against a plain-HTTP
    deployment, **and** 3250 is a _store_, not a Head Office.
  - `HM Spares CT` (store) failing push — the duplicate of `urban-threads-cpt` on
    3252 with a control-plane-generated token.
- **Both apps already identify themselves on their PUBLIC `/health`**: a store
  answers `app: "vula"`, a Head Office answers `service: "vula-head-office"`. So
  `probeAppKind()` now reads that before registering anything, and:
  - a **store** row pointed at a Head Office is refused (`409 wrong_app_kind`),
  - a **Head Office** row pointed at a store is refused — the mistake that was made.
  - Only a _definitive_ mismatch is refused: an unreachable URL (or one that answers
    without identifying) is allowed, because the registry row is normally created
    before the container is deployed. That keeps create-then-deploy working.
- **Stopped prefilling `https://`** in the Head Office form — that prefill is how a
  local `http://localhost:3250` became a TLS URL. The field is now empty with an
  example placeholder.
- Cleaned up the two non-functional rows (both registry-only; deployments and data
  untouched, backup at `/tmp/control-plane.db.before-cleanup`). The fleet is now 8
  stores + 1 Head Office, all healthy.
- Tests: **95 control plane (8 suites)**, +4 covering the identity guards and that
  an unreachable deployment still registers.

## 2026-09-10 — store teardown added; duplicate-URL guard; one-time token reveal

- Owner reported `Push failed: Invalid control plane token` against "HM Spares". Two
  rows share that name, which is the confusion:
  - `hm-spares` (id 9, :3250) — tokens match, push **succeeds** (verified live).
  - `hm-spares-ct` (id 12, :3252) — the test row created earlier: it duplicates the
    `urban-threads-cpt` deployment and carries a control-plane-generated token the
    store never had, so it can never authenticate.
- **Store teardown added** (`DELETE /api/stores/:id`), the F1 item, with the
  pause-first policy: an active store is refused with `409 store_active` and told to
  pause first, so a live till cannot vanish from the fleet in one click. Removal
  deletes the registry row only — the deployment and its data are untouched — and
  the URL becomes available for re-registration. UI gains a two-step `Remove`
  action beside Pause/Resume.
- **One deployment, one registry row** is now enforced for stores and panels: a
  second row on an already-registered URL is refused with `409 base_url_in_use`,
  naming the existing store. (The check runs after input validation, so a malformed
  token still returns 400 rather than being masked.) This would have caught
  `hm-spares-ct` at creation.
- **A generated control-plane token is revealed once**, on create, with instructions
  to install it as `CONTROL_PLANE_TOKEN`. Previously it was generated and discarded,
  leaving the operator no way to make the push work. List and detail still never
  return it.
- **Action errors now surface the real reason.** A fallback swallowed any non-ApiError
  into a useless "Action failed"; the underlying message is now always shown.
- Tests: **91 control plane (8 suites)**, +4 for teardown and +1 for the URL guard.

## 2026-09-10 — registry rebuild bug fixed, live data repaired, regression guard added

- Owner reported `no such table: main.plans_old` when creating a company. **My bug**,
  introduced with the `once-off` period migration, and it had corrupted live data.
- Cause: the rebuild renamed `plans` → `plans_old` **with foreign keys enabled**.
  SQLite then (a) rewrote `companies.plan_id` to reference `"plans_old"`, so dropping
  the temp table left writes failing against a non-existent table, and (b) fired
  `ON DELETE SET NULL` on the drop, **wiping Urban Threads' plan assignment**.
- Amplified by five duplicate `tsx watch server.ts` processes re-running the
  migration on every file save. Reduced to a single server.
- Fixed with SQLite's documented procedure: `foreign_keys = OFF` and
  `legacy_alter_table = ON` set outside the transaction, and create-new → copy →
  drop-old → rename order. The migration now also **heals** a database already
  damaged by the faulty version and is idempotent.
- Live registry backed up, healed, plan assignment restored, licences re-pushed to
  the three branches and the panel. Verified: company create/edit works, all four
  apps report `plan=multi-store`, no `plans_old` references remain.
- Added `src/__tests__/migration.test.ts` (+7) which would have caught it: it boots
  the migration against a pre-`once-off` database with real data and asserts the FK
  is intact, the assignment survives, and a damaged database is repaired.
- Tests: **86 control plane (8 suites)**; za-pos suite untouched at 277.

## 2026-09-10 — paid-through explained, and guarded deletion added

- Owner asked two things:
  1. **"What is New company → Paid through?"** It is the date a subscription is paid
     up to, and it is the single input behind licence state: active before it, past
     due for the grace window after it, then suspended with new sales refused. It
     also caps `maxOfflineUntil`, so it bounds how long a disconnected till may keep
     trading. Relabelled **"Paid up to"** with an inline explanation, since "paid
     through" is accounting shorthand.
  2. **"Unable to delete a company — intentional?"** No: **no delete route existed at
     all**, for companies or panels. But a blind delete would have been wrong anyway —
     the schema cascades `panels` and nulls `stores.company_id`, so it would silently
     delete a merchant's Head Office and strip its branches' plan and licence.
     Added `DELETE /api/companies/:id`, refused with **409 `company_in_use`** while
     the company owns stores or a Head Office, naming exactly what blocks it and
     pointing at suspension as the history-preserving alternative. Added
     `DELETE /api/panels/:id` so the guard is satisfiable (removes the registration
     only, never the deployment). Both use inline two-step confirmation rather than
     a native dialog, which some browsers suppress.
- Live check on the real merchant: _"Urban Threads Retail Group still owns 3 stores
  and 1 Head Office. Reassign or remove those first… To stop trading without losing
  history, suspend it instead."_
- Tests: **79 control plane (7 suites)**, +5 covering delete guards and that
  detaching a store leaves it intact and unassigned rather than cascading it away.

## 2026-09-10 — pricing made explicit, custom plans, and one-step client onboarding

- Owner raised three things:
  1. **"New Head Office → Merchant → dropdown, why?"** A Head Office must belong to
     exactly one company, so the form needs to know which. But it was a dead end for a
     brand-new client — you had to leave and create the company first. The modal now
     offers **"+ New merchant"** inline (name, slug, plan) and creates the company
     before the Head Office, so onboarding a client is one screen. When no merchants
     exist yet it opens straight into that mode rather than showing an empty dropdown.
  2. **"Plans price — per month or once off? Be explicit."** It was genuinely
     ambiguous: the table showed a bare number. `billing_period` now supports
     `monthly` | `annual` | **`once-off`** (added with a `plans` table rebuild, since
     SQLite cannot widen a CHECK in place), the Plans page has a "Billed how?"
     selector, and every price display is suffixed "per month" / "per year" /
     "once-off". A test asserts an invalid period is refused. Documented that the
     control plane does not charge anyone — the price list exists so a quote and an
     invoice raised elsewhere agree (billing/payment recording is L3, unbuilt).
  3. **"Can we not create our own Plans?"** The API allowed it but the UI did not.
     There is now a **New plan** flow (code, name, store cap, till ceiling, features,
     price + period), so the seeded four are a starting point rather than a closed
     list.
- Tests: **74 control plane (7 suites)**; typecheck and build clean.

## 2026-09-10 — naming settled; Companies, Plans and Head Office creation added

- **Naming (owner asked, two planes were being confused):** the vendor app at `:3240`
  is the **Vula Control Plane**; the merchant app at `:3260` is **Head Office**.
  Deliberately asymmetric, because "control plane" means the fleet-management layer
  and only the vendor app is one — two names both ending in "CP" preserve the
  ambiguity. Recorded in `CONTEXT.md` §2a.
- **Two real gaps the owner hit, both closed:**
  - **No way to set or upgrade a company's plan.** There was no UI at all for
    companies or plans, only API routes. Added a **Companies** page (create a
    merchant, set/upgrade its plan, set paid-through or a trial, manual suspend;
    shows stores used vs the cap, head-office count, and a billing-attention tile)
    and a **Plans** page (view and edit each tier's store cap, per-store till
    ceiling, feature set and price).
  - **No way to create a Head Office.** The panels page listed and managed them but
    had no create flow. Added **New Head Office** — pick the merchant, name, slug
    and URL; the control plane issues the token and delivers the company licence.
- **Stores can be assigned to a merchant** from the store modal (on create and
  edit), so a new branch joins a company immediately and the plan's cap applies.
- **Navigation** (the app had none) is now **Stores · Head Offices · Companies ·
  Plans**, with the environment always visible.
- Verified live end to end: created PharmaCrest on Starter → first store accepted →
  second store **refused** with `store_cap_reached` and an upgrade message →
  upgraded the company to Multi-Store → second store then accepted. Test rows were
  removed afterwards so the fleet stays honest.
- Tests still green: **74 control plane (7 suites)**, **277 za-pos (28 suites)**.

## 2026-09-10 — companies, plans and the Company Control Panel become fleet members

- Owner asked why the control plane at `:3240` showed nothing about the merchant's
  multi-store panel. Answer: no company entity existed, and the panel app was
  referenced nowhere in this repo (one incidental "L5 Head Office" line). Fixed.
- **New registry tables:** `plans` (four SA-retail tiers seeded — Starter 1 store /
  2 tills, Retail 1/8, Multi-Store 10/25, Enterprise 50/99 — every value editable),
  `companies` (the merchant: the unit of billing, owning both branches and panel),
  `panels` (one Company Control Panel per merchant), and `stores.company_id`.
  Auto-migrated on the existing 8-row registry.
- **`src/services/subscriptions.ts`:** billing state is DERIVED from `paid_through`
  plus the grace window (active → past_due → suspended), so nothing needs a cron; a
  manual company suspension is a separate override. Cap checks (`canAddStore`,
  `canUseTerminals`) run at the point of action.
- **Caps fail loudly, never silently:** over-cap store creation and terminal pushes
  return **402** with an upgrade message and a machine-readable code
  (`store_cap_reached`, `terminal_cap_exceeded`). Unassigned stores are not policed.
- **Licence claims are finally populated.** L1 left `companyId`/`planCode`/
  `features` inert; `issueLicence` now receives the resolved entitlement, so branch
  licences carry the real company, plan, feature set and paid-through date.
- **Routes:** `/api/plans`, `/api/companies` (CRUD), `/api/panels` (register, edit,
  health, push licence). Store list/detail now expose company, plan and billing
  state; a store can be reassigned with `PUT /stores/:id { companyId }`.
- **Panel side (`za-pos/head-office`):** a new token-guarded `/api/internal/status`
  (version, environment, branch count, licence state) and `/api/internal/licence`,
  plus a `panel_licence` table and ES256 verification with the control plane's
  public key. The panel is verified as `app: company-control-panel`.
- **UI:** real navigation (it had none) — Stores · Panels — with the environment
  always visible; a new Panels page (reachable/unreachable/licence-attention tiles,
  per-panel health/version/licence, Diagnostics and Push Licence); store cards gain
  a **Company** column and surface entitlement notes (over cap, overdue, unassigned).
- **Boundary asserted, not commented:** a test walks the JSON of `/api/stores`,
  `/api/panels`, `/api/companies` and `/api/plans` and fails if any field name looks
  like trading data, and another asserts the control-plane token never leaves the
  server. §40 requires the boundary at the API, so that is where it is tested.
- **Drift fixed:** `schema.sql` now mirrors the code DDL (it was missing `vertical`,
  the four `licence_*` columns and all three new tables); stale "5 stores" references
  corrected to 8; **F3a struck** — it planned a control-plane dashboard with product
  count, orders/revenue, open tills and low-stock, which the SPOG spec forbids here.
- Tests: **74 green (7 suites)**, up from 52 (+22 in `companies.test.ts`); the panel
  suite is 20. `tsc --noEmit` and the frontend build clean.

## 2026-09-10 — licence signing: the control plane becomes the authority (L1)

- Owner approved a subscription/licensing plan; **L1 (asymmetric licence
  foundation)** shipped. Motivation: the store used to sign its own lease with
  its own `JWT_SECRET`, so a tenant could grant itself a subscription.
- `src/services/licenceSigner.ts`: ES256/P-256 keypair from `LEASE_PRIVATE_KEY`
  (or `LEASE_KEY_FILE`), `keyId` for rotation, monotonic per-store `sequence`,
  and a real `maxOfflineUntil = min(now + LICENCE_OFFLINE_DAYS, paidThrough +
LICENCE_GRACE_DAYS)` clamp. Production **refuses to start** without a private
  key rather than issue unverifiable licences; dev generates an ephemeral pair
  with a loud warning.
- `scripts/generate-licence-key.ts` prints the pair for installation. There is no
  way to smuggle the private key into a store: stores get only the public key.
- Delivery: `POST /api/internal/licence` on the store (new `storeClient.pushLicence`),
  sent on store creation, on every health check, and on demand via
  `POST /api/stores/:id/licence`. `GET /api/stores/licence/key` publishes the
  verification key for operators. New registry columns `licence_sequence`,
  `licence_issued_at`, `licence_push_status`, `licence_pushed_at` (auto-migrated).
- Tests: `src/__tests__/licence-signer.test.ts` (+10) — verifies what we signed,
  rejects tampered payloads and signatures and foreign keys, refuses malformed
  tokens, pins the 64-byte IEEE-P1363 signature the browser needs, and pins the
  grace clamp. Suite now **52 green (6 suites)**; `tsc --noEmit` and the frontend
  build clean.
- Next: L2 companies & plans, L3 billing, L4 feature enforcement, L5 Head Office
  entitlements.

## 2026-09-10 — fleet view redesigned: cards, full terminal roster, fleet summary

- Owner feedback: the stores list looked "too squashed", and Everyday
  Retail's **25 terminals showed only 12** (`MAX_CHIPS = 12` silently
  rendered 12 chips plus a `+13` badge — the rest were unreachable).
- Replaced the 7-column table with **one full-width card per store** (owner
  follow-up: single-company cards should span the row rather than sit three
  per line). Each card is laid out horizontally — identity (name, slug,
  status and store-type chips), then Domain / Health / Config / VAT as
  labelled columns, then actions — with the terminal roster on its own
  full-width strip beneath. Page width raised from `max-w-6xl` to
  `max-w-[1600px]` to give the roster room.
- **Terminal roster is now unbounded**: every till renders as a fixed-size
  numbered tile in a wrapping row, so 25 tills show 25 tiles across the
  card. Green = last config push succeeded, grey = never pushed. The `+N`
  overflow badge is gone.
- Actions are labelled (`Edit`, `Push`, `Check`, `Admin`, `Pause`) rather
  than five unlabelled icon buttons, so a card is scannable at a glance.
- Added a **fleet summary strip** (Stores, Active, Paused, Healthy,
  Unreachable, Terminals) plus **search** (name/slug/domain) and a
  status filter — a real at-a-glance fleet view.
- Added the missing favicon link (`/vula-mark.svg`); the CP mark itself
  was already a vector path, not a font glyph.
- Tests: 42 green (5 suites); `tsc --noEmit` and the frontend build clean.

## 2026-09-06 — fleet phase set planned (F1–F3, no code)

- Owner asked to start the control plane and all stores. Fleet verified
  from the registry DB (2026-09-06; the fleet has since grown to 8): 5 stores —
  brake-bolt-spares (spares, 3 tills),
  builders-hardware (hardware, 3), everyday-retail (general, 25),
  medisave-pharmacy (pharmacy, 5), urban-threads (clothing, 2) — all
  `active`, health `up`, config `ok`. No registration gaps.
- Decisions (owner): plan the whole fleet roadmap phased and implement
  later — **F1** CP ops hardening (health sweep, last-error
  persistence, store_audit, store delete/teardown, custom terminal
  names, fleet header strip) → **F2** Coolify auto-provisioning
  (env-gated client, provision/redeploy actions; needs the domain
  wildcard live) → **F3** central office over the fleet (F3a fleet
  summary, F3b catalogue push, F3c IBT — the tenant side needs
  internal-API v0.3.0 in ~/apps/za-pos). Phase set recorded in
  task_plan.md; tidbits items promoted into it with pointers.
- za-pos repo got a cross-reference ("Fleet track" section in its
  task_plan.md + progress/findings/tidbits notes) the same day; its
  baseline is 135 tests green (goods receiving shipped).
- Working tree still carries an uncommitted frontend/CONTEXT batch —
  settle before F1 starts.

## 2026-09-04 — pharmacy store type

- `pharmacy` added to the CP vertical vocabulary, mirroring the tenant
  (`~/apps/za-pos` shipped the same value in `src/services/vertical.ts`
  same day): `StoreVertical` union + `STORE_VERTICALS` in
  `src/config/registryDb.ts`, mirrored `StoreVertical` in
  `frontend/src/types.ts`, VERTICAL_COLORS pill (`bg-emerald-100
text-emerald-700`) in StatusBadge, and StoresPage chip label "Pharmacy" +
  form option "Pharmacy & wellness" (pushed verbatim in the configure
  payload; the tenant seeds its schedule-grouped starter pack).
  `scripts/dev-store-stub.ts` allow-list updated; the "rejects an unknown
  vertical" tests now sample `bakery` (they had used `pharmacy` as their
  unknown value before it existed). Suite 42/42 green (was 41), typecheck +
  build clean. CONTEXT vocab + configure-payload rows updated.

## 2026-09-03 — CP v1 built and verified

- Scaffolded `~/apps/za-pos-control-plane` (git init `main`): root backend
  npm project (Express 4 + better-sqlite3 + TS strict ESM) + nested
  `frontend/` (React 19 + Vite 8 + Tailwind v4 CSS-first), jest+ts-jest with
  `.js`-stripping mapper, prettier, .env.sample, Dockerfile.
- Registry DB `src/config/registryDb.ts`: `stores` table per spec
  (+`last_health_status`), WAL, lazy singleton, `resetRegistryDb()` test hook.
- Office auth: `POST /api/auth/login` (bcrypt compare vs
  OFFICE_ADMIN_PASSWORD, JWT kind `office`, 20/15 min rate limit), office
  guard middleware; production boot fails fast without admin creds.
- `src/services/storeClient.ts`: pushTerminals (`{terminalCount, terminals
Till 1..N}` to `POST /api/internal/configure`), ping (`GET
/api/internal/status`), resetAdmin (`POST /api/internal/admin/reset` →
  `{tempPassword}`); 5 s `AbortSignal.timeout`, typed 502 `StoreClientError`;
  registry record helpers on the db module.
- Routes `/api/stores` (office): list, create (+first push, failure never
  fails creation), detail (terminal preview Till 1..N + snapshot), PUT (no
  auto-push, slug immutable), pause/resume, push, health, reset-admin
  (temp password proxied once, never stored). Token never leaves the server.
- 39 jest+supertest tests green across login / auth-guard / rate-limit /
  stores / storeClient suites (in-memory registry, `jest.spyOn` global fetch
  with canned stores; failure + timeout paths covered).
- Frontend: login page, store fleet table with terminal chips (Till 1..N),
  config/health/status badges, create+edit modal, row actions (Edit, Push
  now, Health, Admin password reveal-once modal, Pause/Resume), notice
  banner; production build green.
- Packaging: schema.sql, AGENTS/CONTEXT/README, planning files,
  Dockerfile (node:22-alpine 2-stage, VOLUME /data), `.dockerignore`,
  `scripts/dev-store-stub.ts` (tenant internal-API stand-in),
  `scripts/smoke-test.sh`, `prompts/deploy-coolify-control-plane.md`.
- Ports 3240/3241 registered in PORT-REGISTRY.md, PortPilot config and
  Dashy conf (committed in port-management-app).
- Verification: `npm test` 38/38, `npm run typecheck` clean, `npm run build`
  green, boot smoke PASSED end to end (login → create vs stub → first push →
  health up → reset-admin → edit 4 + explicit push → dead-store failure
  paths → pause 409s push, resume works).
- Commits on `main` per house `type(scope):` style.

## Deferred (see tidbits.md)

Tenant internal API implementation (za-pos side), audit table, DELETE store,
health sweep, Coolify auto-provisioning, live store insight, central
catalogue, IBT, GitHub push of this repo.

## 2026-09-03 (late) — Rebrand to Vula (branding-only pass)

- Product renamed **ZaPOS → Vula** ("vula" = open). Both repos: za-pos had
  already been rebranded (commit 008cb15); this repo now matches — UI
  strings, docs, comments, /health app name `vula-control-plane`.
- Domain decision: owner is registering **vula-app.co.za**; docs/runbooks
  standardize on stores at `https://<slug>.vula-app.co.za` (wildcard
  `*.vula-app.co.za`) and the panel at `https://cp.vula-app.co.za`
  (CONTEXT §3 + prompts runbook).
- Internal identifiers intentionally untouched (branding-only): repo/folder
  names `za-pos*`, package names, `zapos_cp_token`, env defaults
  (`admin@za-pos.local`), DB paths. Registry/PortPilot/Dashy labels now say
  Vula; za-pos demo credentials moved to `@vula-app.co.za`.

## 2026-09-03 (late) — Store type (vertical) moved to the control plane

- Cross-repo change (CP + za-pos tenant) making the **store type** a
  registry-owned field pushed to every store. Field name `vertical`
  everywhere (tenant vocabulary, `general | clothing | spares |
supermarket`); UI labels it "Store type"; default `general` (matches the
  tenant's `settings.vertical` default).
- CP `stores` table gains `vertical TEXT NOT NULL DEFAULT 'general'`
  (`STORES_DDL` + `schema.sql` mirror + `ensureColumns` auto-migration for
  existing DBs). No CHECK — SQLite can't add one via ALTER; the enum is
  enforced at the API layer (new `StoreVertical` union + `STORE_VERTICALS`
  in registryDb.ts, `optionalVertical` in routes/stores.ts).
- Wire: `StoreOut` + POST/PUT `/api/stores` accept `vertical`; configure
  push body is now `{ terminalCount, vertical, terminals }`
  (`services/storeClient.ts`), so the first push and every "Push now"
  deliver the type.
- Frontend: fleet table gains a **Type** column (VERTICAL_COLORS pills via
  StatusBadge), create/edit modal gains a **Store type** select; edit
  notice now says changes apply on the next push.
- Tenant (`~/apps/za-pos`): `/api/internal/configure` accepts `vertical`,
  validates it (400 + allowed list), writes `settings.vertical` and seeds
  the starter pack idempotently — mirroring the settings PUT; absent
  `vertical` leaves a locally chosen type untouched (older CP builds).
  `/api/internal/status` now reports `vertical`; internal API + /health
  version literal bumped 0.1.0 → 0.2.0.
- Dev stub now mirrors the tenant (STUB_VERTICAL env, configure stores
  vertical, status reports it).
- CONTEXT.md updated on both sides (§2 glossary, §4 contract table incl.
  v0.2.0 note, §5 schema row here; §14/§16 in za-pos). Task plan Phase 5
  appended.
- Verification: CP `npm test` 42/42 (was 39; +default/explicit vertical,
  +unknown-vertical 400s, +PUT vertical; login moved to beforeAll because
  the 20/15-min login rate limit is per app instance and 21 per-test logins
  tripped it), `npm run typecheck` clean, frontend build green; za-pos
  internal + verticals suites green (24 tests).

## 2026-09-03 (evening) — Store types: supermarket merged into general, hardware added

- Domain change driven by the owner: `supermarket` ("Supermarket & spaza")
  folded into `general` (now "General retail, convenience & spaza") —
  the two shared an identical 7-category starter pack and differed only by
  the weighed-scale product toggle, which `general` now carries
  (ProductsPage weighed gate keyed on `general`). `zero_rated` +
  `scale_ready` moved onto general's capabilities (declarative).
- New 4th type `hardware` ("Hardware & building supplies") with its own
  7-category pack (Timber & Boards, Building Materials, Paint & Finishes,
  Electrical, Plumbing, Hand & Power Tools, Fasteners & Fixings); no new
  product fields (fractional/cut-length sales deferred, like the scale
  driver). Pack names kept unique across verticals so a vertical switch
  can't steal another pack's categories (applyStarterCategories upserts by
  unique name).
- Mirrored across: za-pos vertical.ts + Settings picker + CONTEXT §16 +
  README; CP registryDb STORE_VERTICALS, frontend types/labels/colors,
  stub, CONTEXT §2/§4; both test suites updated (98/98 tenant, 42/42 CP),
  za-pos + CP frontend builds green. Decision recorded: merge target kept
  the `general` value; `supermarket` retired; CP rows of that type are
  deleted/migrated (the live supermarket demo store was replaced by a
  builders-hardware store, see below).
- Fleet: greenway-supermarket instance (:3248) retired with its registry
  row; a fresh hardware store "Builders Hardware" (slug `builders-hardware`)
  now runs on :3248 with its own DB/token; all four local store instances
  restarted onto the rebuilt tenant bundle. Fleet = general (everyday-retail
  :3245), clothing (urban-threads :3246), spares (brake-bolt-spares :3247),
  hardware (builders-hardware :3248).
