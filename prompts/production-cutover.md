# Production cutover — control plane, stores, Head Offices

The sequence for going live on a real domain, across three workloads in two repos.
The per-app details live in `prompts/deploy-coolify-control-plane.md` (this repo)
and `~/apps/za-pos/prompts/deploy-production-vula-app.md` (tenant) — this file is
the order, the decisions, and the checks that are easy to forget.

Written 2026-09-25, after the production review's four passes. Where the examples
say `vula-app.co.za`, substitute the registered domain.

---

## 0. Decisions to lock before touching Coolify

| # | Decision | Why it blocks |
| - | -------- | ------------- |
| D1 | **Hostname scheme.** Wildcard `*.<domain>` for stores (`<slug>.<domain>`), `<company-slug>-ho.<domain>` for Head Offices, and an **obscure** hostname for the panel (e.g. `admin.<domain>` — the tenant runbook argues the panel should not be discoverable). | DNS, `APP_URL`, `base_url` and every store row are built from it. Changing it later means re-registering every store. |
| D2 | **Start from an empty registry** (recommended) or deliberately import selected real clients. | The dev registry holds demo clients, dozens of `localhost` rows and demo invoices. In production the managed-endpoint policy refuses `http://` and private addresses, so a lifted `localhost` row cannot even be re-saved. |
| D3 | **Backups.** Neither app schedules one: stores have manual-only backup endpoints, Head Offices have none, and the control plane's registry has none. Decide the mechanism (host cron taking a volume snapshot, or `POST /api/backups?scope=db` per store on a schedule) and a retention. | "Persistent volume" is not a backup. This is the one gap that loses money silently. |
| D4 | **Secrets at rest.** Store/panel control-plane tokens and the SMTP password sit in plaintext in both SQLite databases; the panel is a single admin with a 7-day JWT and no roles. Accept for launch, or schedule the encryption/RBAC work first? | Whoever reads a database file holds every store credential. Tolerable for a first deploy with one operator; not for a support hire. |
| D5 | **Which login branches.** The panel deploys from `main`; this repo's session work is on `dev` (see §2). | A deploy from `main` today ships the pre-review CP. |

## 1. Close the tenant's fail-open traps before a store trades

All four are in `~/apps/za-pos`, all small, all verified by reading the code:

1. **`LEASE_PUBLIC_KEY` is not a boot gate.** Blank or malformed leaves the store
   in *unlicensed dev mode*: licences are accepted but **not verified**, and every
   feature gate is permissive (`src/services/licence.ts`). The key is only
   challenged on the first verification attempt. Either make it a boot gate, or
   confirm after deploy that the store reports the licence **active**.
2. **`APP_URL` is unguarded.** Forgetting it produces receipt links pointing at
   `http://localhost:3230` (`services/receiptPdf.ts`). Set it per store.
3. **The Head Office `HO_DB_PATH` guard accepts `DB_PATH`** — and the config then
   never reads `DB_PATH`, so a deployment setting only `DB_PATH` passes the boot
   gate and writes its database into the container layer, where a rebuild eats it.
   The image sets `HO_DB_PATH`, which masks this; set it explicitly anyway.
4. **`SEED_DEMO_DATA` must be unset or `false`.** Set to `true` in production it
   seeds a known executive login (`executive@urban-threads.co.za`) and demo data.

Also set `TRUST_PROXY=1` on stores and Head Offices (hop count, not a boolean) —
without it the login limiter keys on the proxy's address rather than the client's.

## 2. Promote to `main` (production deploys from `main`)

Coolify tracks a branch and auto-deploys it, so **merging is deploying** once the
resources exist. Do this deliberately, per repo:

- **This repo:** the session's work (licence-sequence repair, settlement
  correctness, the strict billing state machine, the managed-endpoint policy, the
  proxy-aware limiter, the daily billing tick, nested payload validation, the
  frontend suite) is on `dev`. `main` is roughly two weeks behind.
- **Tenant repo:** same check — confirm what `main` is missing before pointing a
  production resource at it.

Gate for both: the suites green (`npm run test:all` here) plus a review of the
`dev..main` diff. Do not deploy an unreviewed merge to a fleet that will hold real
customer databases.

## 3. DNS and TLS

1. Wildcard `*.<domain>` → the Coolify host. That single record covers every
   store, every merchant Head Office and the panel's own hostname.
2. Per Coolify resource: **Automatic SSL** (Let's Encrypt).
3. **The certificate must be live before the first store row is created.** From
   the review's Pass 2, production refuses a store URL that is plaintext, private,
   or does not answer — the app-kind probe has to succeed at registration.

## 4. Secrets inventory

Generate once, store in a password manager, paste into Coolify (never into git):

| Secret | Scope | How |
| ------ | ----- | --- |
| `OFFICE_ADMIN_PASSWORD` | control plane | strong, unique; the placeholder fails the boot gate |
| `JWT_SECRET` | control plane | `openssl rand -base64 64` |
| `LEASE_PRIVATE_KEY` / `LEASE_KEY_ID` | control plane | `npx tsx scripts/generate-licence-key.ts`; boot fails without it |
| `CONTROL_PLANE_TOKEN` | per store, per Head Office | `openssl rand -hex 32` — same value in the deployment env and the registry row |
| `JWT_SECRET` (store) / `HO_JWT_SECRET` (panel) | tenant | ≥32 chars, not a placeholder, or boot fails |
| SMTP account | control plane | set in **Settings** after first boot, then **Send test email** |

The control plane publishes the verification key at `GET /api/stores/licence/key`
(and `/api/panels/licence/key`); every store and Head Office needs it as
`LEASE_PUBLIC_KEY` + `LEASE_KEY_ID=k1`.

## 5. Deploy order

1. **Control plane** — it holds the signing key and the registry.
2. **Settings** — office identity (the name on invoices), payment terms, SMTP, and
   the VAT registration/rate if invoicing tax.
3. **One store** (Part A of the CP runbook) → register it (Part B).
4. **Verify** (§6) before onboarding a second store.
5. **Head Office**, if the client is multi-store — then wire the branch topology
   (the panel otherwise reports a healthy branch as *Offline*; that is the most
   confusing failure in this system).

## 6. Verification

Per store, in the panel: **Health** → `Up`; **Configured** with the right
`Till 1..N`; the licence column **active** (not "unlicensed"); `GET
/api/internal/status` on the store reports the expected `maxTerminals` and a
licence `sequence` ≥ 1. Per Head Office: **Diagnostics** green and the branch
roster matching the client's stores.

On the control plane itself: `/health` answers; **Errors** is empty; **Deployments**
shows the job and its steps; and the first scheduled health sweep (10 minutes after
boot) leaves the fleet's health and versions fresh rather than deploy-time.

## 7. Go-live sequence for the first real client (easy to miss)

The billing state machine is strict since 2026-09-25: **a client that has never
paid derives `suspended`, and a suspended client cannot trade.** Onboarding alone
does not make a client active. The sequence that does:

1. Onboard the client (wizard: company + subscription + deployment).
2. Raise the initial invoice — the once-off onboarding charge rides on whichever
   invoice is raised next.
3. **Record the payment** once the EFT lands. That is what writes `paid_through`
   and moves the client to `active`; the panel does not charge anyone, it records
   what happened.
4. Confirm the register reads **active** and the licence has been re-pushed.

The daily billing tick (`BILLING_TICK_INTERVAL_MINUTES`, default 1440) marks lapsed
invoices `overdue` and raises renewals. It never records a settlement, by design —
so a client whose payment has arrived but was never recorded stays suspended and
stops trading.

## 8. Day-2

- **Upgrades:** migrations run on every database open and some rebuild tables.
  Expect a short gap, not zero downtime, and snapshot the database before a schema
  change. Rollback is the previous image plus its matching database.
- **Support access:** a store admin login is issued from the store row
  (**Admin password** — one-time temp password, shown once, never stored).
- **Pausing:** a store can be paused for maintenance (push and admin reset are
  refused while paused); a Head Office tears down pause-first too.
- **Volumes are keyed by name** in Coolify: renaming the layout path applies to new
  deployments only, and orphans existing data.

## 9. Accepted at launch (recorded, not forgotten)

Secrets at rest and panel RBAC (D4); the login limiter's counters are per-process
(a restart clears them); DNS resolution and the later fetch are independent, so a
fast-rebinding record is not caught, and there is no production domain allowlist
yet — `tidbits.md` in this repo carries all four with the reasoning.
