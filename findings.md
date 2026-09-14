# Findings

## 2026-09-14 — what the deferred SPOG set can actually be built on

- **Most of the deferred nav has no data behind it.** Checked each surface
  against the schema before planning. Buildable now: **Errors** (latest-only
  per store, hence the new `error_events` table), **Devices** (per-till
  `deviceId`/`claimed`/`sessionOpen`/`lastSeenAt` are already in
  `stores.last_telemetry_json` — `telemetrySummary` reduces them to counts, so
  it needs *exposing*, not collecting), **Versions** (`app_version` /
  `schema_version` / `last_heartbeat_at` from telemetry, `panels.app_version`),
  and a **read-only Deployments** page (`deployment_jobs`/`_steps` are durable
  but exposed only per-client). Blocked: **Sync dashboard/inspector**
  (`pendingEvents`/`failedEvents`/`lastSyncAt` are reserved nulls until the
  tenant ships device heartbeats, and there is no sync-event store to inspect),
  **Printers** (no printer agent exists), **Backups** (needs a tenant internal
  endpoint; za-pos has only an admin-only `/api/backups`). Spec §39 forbids
  empty placeholder pages, so the blocked ones were left unbuilt rather than
  stubbed.
- **The licence-push failure reason was being thrown away.** `recordLicencePush`
  wrote a `failed` enum and nothing else; the message existed only in the HTTP
  response and a log line, so a red licence badge had no explanation anywhere in
  the database. Same for `setStoreDeployStatus(…, 'failed')`. Both now record
  the reason into the feed.
- **`MAX(message)` is not the latest message.** SQLite has no "last value"
  aggregate, so the grouped feed joins each group to the row `ORDER BY last_seen
  DESC, id DESC LIMIT 1`. Getting this wrong would have shown the *first*
  occurrence's text, which is exactly the stale reading the page is meant to
  avoid.
- **A nullable column cannot be part of the grouping key.** `stores` and `panels`
  have independent id sequences, and SQLite treats NULLs as distinct in a unique
  index — so `(fingerprint, source, store_id, panel_id)` with one of them NULL
  would never conflict and every occurrence would insert a new row. Hence
  `entity_type` + `entity_id`, both NOT NULL.
- **Number normalisation needs no word boundary on the right.** `\b\d+\b` does
  not match `5000` in `5000ms` (no boundary between the digit and the unit), so
  the first fingerprint test failed: identical timeouts hashed differently.
- **The spec's Errors page asks for more than the CP can know.** Fingerprint,
  frequency, first/last seen and store count are real after this slice; **stack
  trace and correlation ids are not** — a store's failure reaches the CP as a
  502 summary string, and nothing propagates a trace. The page shows what exists
  and does not fake the rest.
- **Privacy holds by construction.** The feed stores only strings the CP already
  produced and already persisted in `stores.last_health_error` /
  `last_config_error`; no tenant payload or raw response body enters it. The
  failure text a store returns *is* a `{ error }` validation message (§40 line
  already documented for the store surface).
- **Stale doc, noticed not fixed:** `CONTEXT.md` §7 still lists "audit trail,
  DELETE store, automated health sweep" as out of scope, though all three shipped
  (2026-09-11/12). Left alone rather than widening this slice — flagged here per
  the repo rule about doc/code disagreement.

## 2026-09-13 — the pricing redesign: what the code said vs what the brief assumed

- **The working tree already contained a half-finished pricing implementation that
  contradicted the brief.** 9 modified files (registryDb, billing service/route,
  companies, stores, clientOrchestrator, PlansPage, BillingPage, types) added
  `pricing_model: flat|per_terminal`, billed `plan.price_cents × SUM(stores.
  terminal_count)` — i.e. **configured** tills, which the brief's §12 explicitly
  forbids — kept the bundled `included_terminals`/`extra_terminal_price_cents`
  fields the brief removes (§5), and left the frontend not typechecking (`Plan`
  declared two fields the API never sent while using four it did). Verified before
  touching anything, saved as a patch, reverted, rebuilt to the brief.
- **The live registry had already been booted with that WIP build** — its `plans`
  table carried `included_terminals`, `extra_terminal_price_cents` and
  `onboarding_fee_cents`, and `invoices` carried `terminal_amount_cents`. So the
  migration could not assume "the pre-pricing shape": it detects columns
  dynamically. Rehearsed against a copy: clean, idempotent, no FK violations.
- **A flat client price is not a per-terminal rate, and mapping it would have
  silently re-priced live customers.** The live fleet's plans carried flat prices
  (Starter R1,500, Business R3,000, Multi-Store R5,000, a custom "per-till" R499).
  Copying those into `terminal_price_cents` would have billed Urban Threads
  R5,000 × its 9 licensed terminals. Decision: a plan that carried a price becomes
  `custom` (no auto-calculation, invoices raised with an agreed amount), and only
  genuinely unpriced seeded tiers pick up the recommended R500/R10,000 defaults.
  The visible consequence — those plans no longer auto-invoice until the office sets
  a rate — is recorded in progress.md for the owner.
- **Billing needed a purchased quantity that did not exist.** Before this change the
  only quantity in the registry was `stores.terminal_count` (configured slots), so
  "bill the licensed quantity" had nothing to read. Hence
  `company_subscriptions.licensed_terminal_count` + `store_terminal_licences`
  (per-store allocations), backfilled from what stores already ran so a live fleet
  keeps working and every existing licence still permits its tills.
- **Zero licensed terminals is a real state, and it must be a gate, not a default.**
  A client whose purchased quantity was never stated cannot take a store
  (`402 terminal_allocation_exceeded` with "no licensed terminals yet") — otherwise
  the CP would be inventing commercial terms. The client-first wizard always states
  the quantity, so normal onboarding never meets the gate; the advanced Companies
  form now asks for it.
- **The privacy-boundary test constrains field NAMES.** Its forbidden pattern
  (`/revenue|sales|profit|margin|payment|invoice|cost|transaction|…/`) is walked over
  `/api/plans` and `/api/companies` too, so `terminalPriceCents`,
  `recurringAmountCents`, `setupFeeCents` and `licensedTerminalCount` were chosen to
  clear it. (Earlier lesson, still true: a field merely *named* `salesBlocked` fails
  it.)
- **The tenant enforced no terminal cap at all.** `claimDevice` validated only that
  the till existed and was unique; `configure` accepted any 1–99. The licence
  carried `maxTerminalsPerStore` since 2026-09-10 but nothing read it. Now the store
  gates NEW claims on the licence's `maxTerminals` — claimed terminals against the
  signed entitlement, never devices online — keeps a device's *move* working, and
  never revokes existing claims when a subscription shrinks (a reduction must not
  strand a till mid-shift).
- **`createPayment` wrote status `processing` and never advanced it**, while the
  invoice it belonged to was marked `paid` — an incoherent pair (§27's warning about
  fabricated settlement). A payment row is only written on a confirmed settlement,
  so it now records `completed`.

## 2026-09-12 — external production-readiness review received and code-verified

A deep-dive review of both repos landed (full text:
`~/Downloads/vula-subscription-and-platform-deep-dive-report.md`). Per house
rule, **every claim was verified against the code before being recorded** —
none is taken on trust. All check out. Grouped by repo.

**za-pos-control-plane (this repo):**

- **`head_office_deploy` deploys a store image, not a Head Office.**
  `src/services/clientOrchestrator.ts:156` (panel path) calls
  `createStoreDeployment()` from `services/coolify.ts` — the same call the
  store path makes at :195. za-pos has no `head-office/Dockerfile`; the root
  Dockerfile CMD is `node dist/server.js` (the store POS). An orchestrated
  "Head Office deployment" currently cannot boot the HO app.
- **Failed prerequisites still mark steps complete.** In the same file, the
  Coolify failure is caught → `logger.warn` (:161-163, :200-202); admin
  bootstrap (:210-212), terminal push (:218-220), topology wiring (:250-252)
  and licence pushes (:280-282, :307-309) are "notice"-level; the step is
  then unconditionally marked `complete`. A job can go green with no
  container, no admin, no config and no licence.
- **Coolify UUIDs are never persisted by the orchestrator.** The result of
  `createStoreDeployment()` is discarded — no `coolify_uuid`/`volume_name`
  write anywhere in clientOrchestrator.ts. `storeProvisioning.ts` persists
  them, but the wizard path does not, so a retry can create a duplicate
  Coolify application.
- **`wire_topology` is one-directional.** It pushes
  `headOffice.{enabled,url,token}` into branch stores (:230-254) but never
  registers the branches in the Head Office's own `branch_stores` — the HO
  side of the topology is still hand-entered.
- **Hard-coded store admin password** `AdminPassword@123` at
  clientOrchestrator.ts:209. `storeProvisioning.ts` already has a generator;
  the orchestrator doesn't use it.
- **`billing_settings` is a singleton wearing multi-tenant clothes.** DDL is
  `id INTEGER PRIMARY KEY CHECK (id = 1)` beside a separate `company_id`
  (registryDb.ts:128-137) while `upsertBillingSettings` inserts without
  `id`. Company #1 works; company #2's insert violates the CHECK — a real
  bug, not a style issue.
- **Automated renewal fabricates settlement.** `runAutomatedRenewals`
  (billing.ts:332-333) records `method: 'manual'` with
  `transactionId: auto-<ts>` and marks the invoice paid — no real payment
  confirmation anywhere in the path.
- **Plans are flat-priced and a tier is named `Retail`.** Single
  `plans.price_cents` (registryDb.ts:199), seed tier `Retail` (:269). The
  recommended Multi-Store pricing (base incl. HO + first 2 stores, then a
  recurring per-additional-store charge) cannot be expressed yet.
- **Docs vs code disagreement (flagged per house rule):** progress.md's
  2026-09-11 entry claims `vat_reg_no` was "removed from store creation/edit
  forms and DTOs (§21)". It was not: the column (registryDb.ts:70), the
  `StoreOut` field (routes/stores.ts:141) and the StoresPage form fields are
  all still present, and `git log -S vatRegNo -- src/routes/stores.ts` shows
  the route unchanged since the initial commit. **Decision needed:** remove
  it from the CP surface (the review recommends it; §40 leans that way) or
  correct the progress note.

**za-pos (tenant + Head Office):**

- **No Head Office production image.** `head-office/Dockerfile` does not
  exist; the root Dockerfile builds and starts only the store app.
- **Credential separation still has the migration fallback** —
  `src/routes/internal.ts:64`: without `HEAD_OFFICE_TOKEN`,
  `CONTROL_PLANE_TOKEN` is accepted on HO routes; the HO branch schema still
  names the credential `control_plane_token`.
- **HO seeds a demo executive + demo data with no env guard** —
  `head-office/src/db.ts:137-147` creates `executive@urban-threads.co.za` /
  `Admin@12345` whenever the users table is empty.
- **`/api/internal/control/status` returns `vatRegNo`** (internal.ts:87) —
  merchant tax data reaching the vendor plane.

**Recommendations to confirm with the owner before implementation** (the
review's §34 priority list): orchestration truthfulness + a real HO
deployment first, then the subscription/commercial model (Retail → Business;
base + per-additional-store pricing; subscription snapshots so plan edits
never silently rewrite a signed deal), then the privacy boundary. Target
catalogue: Starter / Business / Multi-Store / Enterprise, with Multi-Store
priced as base incl. HO + first 2 stores plus a recurring per-additional-
store charge.

## 2026-09-11 — L4 enforcement notes

- **The §40 privacy-boundary test guards field NAMES, not just values.** Naming
  a new wire field `salesBlocked` failed `assertNoBusinessData` because the
  forbidden pattern includes `/sales/i` — the test cannot know the flag is
  entitlement state rather than trading data, and it shouldn't try. Renamed to
  `tradingBlocked`, which is also more accurate domain language: a suspension
  stops _trading_ (new sales), while reads, returns, voids and cash-ups stay
  open. Lesson: on this surface, avoid business-flavoured substrings in field
  names even when the meaning is innocent.
- **A company with no plan derives `active`, not `unlicensed`.** L2's
  `deriveBillingState` treats a missing `paid_through` as active (Starter-cap
  fallback), so a no-plan company is `ok` at the register with an empty
  feature list — it keeps trading. `unlicensed` is reserved for a _store with
  no company at all_ (the `UNASSIGNED` entitlement). The gate implication:
  `requireFeature` on a null plan refuses everything, which is exactly what
  closed the "upgrade to multi-store for free" hole the old clients tests
  were exercising.
- **Feature lists are stored in vocabulary order, not submission order.**
  `validateFeatureKeys` normalises, so licences are byte-deterministic across
  UI submissions and plan edits — a licence re-push never diffs just because
  checkboxes arrived in a different order.
- **The upgrade-to-multistore gate must check the _effective_ plan.** The
  route accepts `planId`, and `orchestrateUpgradeToMultiStore` applies that
  plan switch before deploying — so a Starter company upgrading WITH a
  multi-store planId must be allowed (the gate would otherwise read the
  current Starter plan and wrongly refuse).

## 2026-09-10 — a table rebuild corrupted the registry (my bug, and what it taught)

**Symptom reported by the owner:** creating or editing a company failed with
`no such table: main.plans_old`.

**Root cause.** The migration that widened `plans.billing_period` to allow
`'once-off'` rebuilt the table as:

```sql
ALTER TABLE plans RENAME TO plans_old;   -- ← wrong: foreign keys ON
CREATE TABLE IF NOT EXISTS plans (...);  -- new DDL
INSERT INTO plans SELECT ... FROM plans_old;
DROP TABLE plans_old;                    -- ← fires ON DELETE SET NULL
```

Two SQLite behaviours make that sequence destructive:

1. **`ALTER TABLE ... RENAME TO` rewrites references in OTHER tables.** Since
   SQLite 3.25 the default is `legacy_alter_table = OFF`, so renaming `plans` to
   `plans_old` silently rewrote `companies.plan_id REFERENCES plans(id)` into
   `REFERENCES "plans_old"(id)`. Dropping the temporary table then left `companies`
   pointing at a table that did not exist — which is precisely why _writes_ failed
   with "no such table: main.plans_old" while reads looked fine.
2. **`DROP TABLE` fires foreign-key actions.** With `foreign_keys = ON`, dropping
   `plans_old` triggered the (rewritten) `ON DELETE SET NULL` and **wiped every
   company's plan assignment** — Urban Threads silently lost its Multi-Store plan.

**Amplifier.** Five duplicate `tsx watch server.ts` processes were running for the
control plane. `tsx watch` restarts on every file save, so each save re-ran the
migration concurrently, and the corruption kept being re-applied. Only one of them
could hold `:3240`; the rest were failed or racing boot attempts. Worth remembering
when restarting services from tool calls.

**The correct SQLite rebuild procedure**, now implemented as `rebuildTable()` in
`src/config/registryDb.ts`:

```sql
PRAGMA foreign_keys = OFF;      -- OUTSIDE the transaction; pragma is a no-op inside
PRAGMA legacy_alter_table = ON; -- stops RENAME rewriting other tables' FK clauses
BEGIN;
  CREATE TABLE t_rebuild (...);  -- create-new FIRST
  INSERT INTO t_rebuild (cols) SELECT cols FROM t;
  DROP TABLE t;
  ALTER TABLE t_rebuild RENAME TO t;
COMMIT;
PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
```

**Repair.** The migration now also _heals_ damage: any table whose stored DDL still
references `plans_old` is rebuilt against the real `plans`, an interrupted rebuild
is recovered, and the whole step is idempotent. The live registry was backed up to
`/tmp/control-plane.db.before-repair` before being healed; the wiped plan
assignment was restored and licences re-pushed to the three branches and the panel.

**Guard.** `src/__tests__/migration.test.ts` builds a database with the _old_
schema plus real data and asserts, on boot: the CHECK widened, no temporary table
left behind, `companies` still references `plans` (never `plans_old`), the plan
assignment survived rather than being nulled, existing rows kept their values, a
second boot changes nothing, and an already-damaged database is repaired. That test
would have caught this before it reached a live registry.

Dated, verified findings that shaped the build.

## 2026-09-03 — za-pos tenant internal API does NOT exist yet

Grep across `~/apps/za-pos` for `internal`, `CONTROL_PLANE`, `configure`,
`terminal_count` finds nothing but till-session domain code. za-pos
CONTEXT.md §14 (lines 295–311) documents only the _intent_: CP owns the
terminal count per store and pushes generated terminal config (Till 1..N) to
`POST /api/internal/configure` guarded by a per-store `CONTROL_PLANE_TOKEN`;
admin password reset over the same channel. **Consequence:** this CP authors
the wire contract (CONTEXT.md "Internal API contract") and verification uses
`scripts/dev-store-stub.ts` until the tenant routes land. The tenant
workstream (za-pos: `terminals` table + internal routes + `CONTROL_PLANE_TOKEN`
env) implements to match.

## 2026-09-03 — Ports 3240/3241 allocated

PORT-REGISTRY block 3240–3249 was free (3200 OptiMED CP, 3220 Beauty CP,
3230 za-pos, row 16 next). Frontend dev port 3241 proxies `/api` → 3240.

## 2026-09-03 — House control-plane pattern verified against optimed

optimed-control-plane is the reference (19 commits, tests, eslint,
auto-migrations); beauty-control-plane is an incomplete single-commit copy
(no tests/jest/eslint). Adopted optimed conventions: jest `moduleNameMapper`
strips `.js`; lazy `getRegistryDb()` singleton with `resetRegistryDb()` for
tests; env `requireEnv` production fail-fast; asyncHandler + `{ error }`
error shape; bcrypt-hash-at-boot compare; DDL with CHECK-constrained enums.
Deliberate deviations per spec: office auth naming, `/api/stores`, no audit
table, no Coolify client.

## 2026-09-03 — Jest: `jest.mocked(fetch)` does not create a mock

`jest.mocked` is a type-level cast only; calling `.mockImplementation` on it
throws `TypeError: ... is not a function`. Real spies require
`jest.spyOn(globalThis, 'fetch')` (restored in `afterEach`). Noted for all
future suites that mock global fetch.

## 2026-09-03 — Node DOMException is not `instanceof Error`-reliable in jest

Timeout/abort handling in the store client originally gated the error-name
check behind `err instanceof Error`; a DOMException abort rejection fell
through to the "unreachable" branch. Fix: read `(err as {name?}).name`
without the instanceof gate, then fall back to `err.message`.

## 2026-09-03 — Slug regex allows trailing dashes (spec regex is literal)

Spec regex `^[a-z0-9][a-z0-9-]*$` accepts `trailing-dash-`. Tests were
initially stricter than the approved contract; aligned to the spec (leading
dash, uppercase, spaces and >40 chars remain invalid).

## 2026-09-03 — Timestamps stored as UTC (`datetime('now')`)

SQLite `datetime('now')` writes UTC ("YYYY-MM-DD HH:MM:SS"); the SPA parses
with an appended `Z` and renders local time. House-consistent with optimed.

## 2026-09-03 — Token agreement: create accepts an optional controlPlaneToken

The first boot smoke exposed an ops gap: stores are deployed with
`CONTROL_PLANE_TOKEN` already set (runbook Part A), but the create route only
generated its own token — the two could never agree, so the first push always
401'd. Resolved: `POST /api/stores` accepts an optional `controlPlaneToken`
(64 lowercase hex, must match the store's env; blank → generated). The
runbook, CONTEXT glossary and the New-store modal now carry the token through.
Generation remains the default, so the original spec behaviour is unchanged
when the field is omitted.

## 2026-09-03 — bash gotcha in smoke-test.sh

`BODY=$(req …)` runs the function in a subshell, so a `status` variable set
inside `req` never reached the caller. Rewritten with a `resp` helper that
emits `<body>\n<http-code>` and the caller splits it in the parent shell.

## 2026-09-03 — ESM: `__dirname` does not exist under tsx

`src/app.ts` used `__dirname` to locate `frontend/dist`. ts-jest's CJS
transform shims it (tests passed), but `tsx watch` runs true ESM and crashed
at boot. Fixed with `fileURLToPath(import.meta.url)`. Lesson: boot the server
(`npm run dev:api`) after ESM-sensitive edits — unit tests alone don't prove
the runtime entry works.

## 2026-09-03 — SQLite can't ALTER CHECK constraints

`last_health_status` was added to the DDL from day one, so no table rebuild
is needed (optimed had to rebuild `practices` for a CHECK change). If a
future column needs a CHECK change, mirror optimed's rebuild choreography.

## 2026-09-06 — fleet planning session (F1–F3 planned, no code)

- **Fleet state verified from the registry** (`data/control-plane.db`,
  read-only; 5 stores at the time, 8 now), all `active` / health `up` / config `ok` —
  brake-bolt-spares (spares, 3 tills), builders-hardware (hardware, 3),
  everyday-retail (general, 25), medisave-pharmacy (pharmacy, 5),
  urban-threads (clothing, 2). No gaps to register.
- **Owner decisions:** full fleet roadmap phased — F1 CP ops hardening,
  F2 Coolify auto-provisioning, F3 central office over the fleet —
  planned into the planning files now, implemented later (same pattern
  as the tenant's P1–P7 set).
- **F2 prerequisite:** vula-app.co.za is not registered yet (see
  tidbits) — the wildcard DNS must exist before auto-provisioning can
  go live; the phase is env-gated so the panel works without it.
- **F3 pulls tenant work:** internal-API v0.3.0 in ~/apps/za-pos (fleet
  summary, catalogue upsert, IBT stock in/out). The tenant repo carries
  a cross-reference in its task_plan.md so the workstream isn't lost.
- **Uncommitted tree:** frontend components + CONTEXT.md batch in this
  repo — settle before F1 starts.
