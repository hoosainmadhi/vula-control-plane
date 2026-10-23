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

## Phase: WhatsApp add-on on Plans, Quotes and New Client (2026-10-20) — complete, uncommitted

- [x] **Plans** — `ADDON_ORDER` includes `whatsapp_cloud`, so the plan editor prices it.
- [x] **New Client** — bundle picker (250/500/750/1000) when WhatsApp is ticked; the chosen
      bundle is sent, priced in the preview, recorded on the subscription and carried by
      the licence.
- [x] **Quote** — selecting WhatsApp opens the Prices block with the bundle selector
      (250/500/750/1000, no bare "List" row), defaulting to the entry bundle; the send
      panel explains the bundle is set on the quote.
- [x] **Bundles** — the four published tiers are 250/R50, 500/R100, 750/R150 and **1000/R200**; the server's price→allowance map and every picker read the same list.
- [x] **Tests** — frontend 34/34 (bundle price → allowance), backend 473/473, build clean.

## Phase: the published price list reaches Plans, Quotes and New Client (2026-10-20) — complete, uncommitted

Owner asked whether Plans/Quotes/Clients could fulfil the marketing model. The quote
desk and public list already matched; the onboarding surfaces did not. All fixed:

- [x] **Plan data** — one-time `user_version = 2` migration: `vula-standard` becomes
      `per_store` R199/R49 (it was per-terminal R49 with no store line); every plan's Head
      Office add-on moves 9900 → 19900. Existing agreed subscriptions do not move.
- [x] **New Client preview** — shared `SubscriptionQuotePreview`, used by the client
      detail and the wizard; per-store stores + extra tills + add-ons + setup are itemised.
- [x] **New Client defaults/caps** — the default plan fits the default estate; caps are
      shown; Deploy is blocked with the server's own refusal text.
- [x] **No orphan clients** — validate the estate and caps before creating the company;
      the commercial writes are one transaction.
- [x] **Head Office** — refused on a single-store deployment by the server and the wizard.
- [x] **Quote conversion** — creates branches from the quote's split and a Head Office
      when bought; starts the deployment job; checks caps/slugs first.
- [x] **Docs/schema** — `schema.sql`, `CONTEXT.md`, `AGENTS.md`; marketing hydration now
      moves the visible rate banner and add-on cards, not only the builder total.
- [x] **Tests** — CP 473/473 (36 suites), frontend 31/31, typecheck and builds clean.

## Phase: the add-on model adds up (2026-10-10) — complete, uncommitted

The owner's add-on pricing (six keys sold at R99/R49 per month, priced per plan and
bought per client) was already modelled; this pass closed the places where the numbers,
the documents and the signed claim did not agree with it. The tenant half of the gate
audit (`layby` on its own key) was verified already done in `za-pos`.

- [x] **The subscription editor's quote includes the add-ons**
      (`frontend/src/pages/ClientDetailPage.tsx` + `lib/money.ts`). The preview showed
      terminals alone, so the owner's screenshot of a client with four ticks read
      "Recurring (30 × R 1,00) R 30,00" while saving billed R 426. It now itemises the
      terminals, each ticked add-on and the total, at the price agreed with the client
      where one is on record (grandfathering) and the plan's price otherwise — the same
      order the server's `quoteForSubscription` uses. `addonLinesFor` is unit-tested, and
      a custom plan states that its ticks sit inside the agreed flat amount.
- [x] **A custom-priced invoice names its add-ons as included, not as priced lines**
      (`services/billing.ts` `invoiceLineItems` + both renderers). A `custom` recurring
      charge is one negotiated figure, so pricing the snapshotted add-ons on the document
      stated a per-month charge the client was not paying and left the residual line to
      absorb the difference. They now read "Included in the agreed amount" with no figure
      (`InvoiceLineItem.included`) and the agreed amount prints whole; per-terminal
      invoices still price each add-on and sum to the total. Both directions are pinned.
- [x] **A suspended licence omits the metered add-ons**
      (`SUSPENSION_STRIPPED_FEATURES` in `services/features.ts`, applied at the single
      delivery boundary in `services/licenceDelivery.ts`). `ai_assistant` and
      `invoice_import` are sold per month, so they stop while the account is suspended —
      the register's own gate is the second half of the same rule. The operational
      add-ons (Head Office, credit, lay-by, e-commerce) stay: suspension stops new sales,
      not a merchant's access to data it owns. `enforcement.test.ts` decodes the pushed
      licence and checks both states.
- [x] **Docs and mirror**: `schema.sql` gains the three columns the DDL already had
      (`company_subscriptions.features_json`/`addon_prices_json`, `invoices.addons_json`);
      `features.ts`'s "six keys" comment corrected to eight; CONTEXT §2b (vocabulary
      table, the suspension rule), §2a (the seeded catalogue still read as the retired
      four tiers at R500) and §5 (the add-on model, `company_subscriptions`, `invoices`).
- Verification: control plane typecheck + `npm run build` clean, backend **405/405 across
  33 suites**, frontend **28/28**; the tenant `za-pos` store+Head Office suites
  **682/682** and its vitest **52/52** (unchanged tree, re-run as the cross-app gate).
  Not committed.

## Phase: launch hardening — the 10 October review (2026-10-10 → 10-11) — complete, uncommitted

The owner's second external pre-launch review (`review-10October2026.md`, conditional
NO-GO for a paid launch) was verified claim by claim against this repo, then the approved
scope was built: both P0s plus the code-level P1s, each with a regression test. Nothing
committed (the za-pos side of the pass is recorded in that repo's planning files).

- [x] **P0 · redirect policy.** `redirect: 'error'` on every privileged outbound fetch:
      `storeClient.ts` request() (all store/panel calls carry the token),
      `storeProvisioning.ts` bootstrapStoreAdmin (token + temp admin password),
      `coolify.ts` request() + probe (bearer API token), `mailer.ts` Resend call,
      credentialless probes for consistency. undici reports the refused redirect only in
      `err.cause.message` ("unexpected redirect") — every classifier checks the cause
      chain, and probeCoolify names the policy instead of the transport failure.
      `redirectPolicy.test.ts` runs real HTTP servers (origin 301/302/307/308, target
      records arrivals) and proves the credential never reaches the target, for the store
      ping, the admin bootstrap and the Coolify probe, with a happy-path control.
- [x] **P0 · `scripts/vula-backup.sh`.** Now verifies every copy (read-only
      `PRAGMA integrity_check` + schema sanity, so no `-wal/-shm` strays), archives each
      store's `images/` beside its database, enforces a 7-copy retention floor (age prune
      only above the floor; demo-golden exemption kept), warns loudly without
      `BACKUP_RSYNC_TARGET`, and aborts the whole run on the first unverifiable database.
      `VULA_DATA_ROOT`/`BACKUP_DEST` overridable (the root name matches `coolify.ts`).
      Runtime-verified on a scratch fleet: 16/16, including corrupt-source and
      flipped-page aborts, demo skip, tar extraction and prune behaviour.
- [x] **P1 · `/health` is database-aware.** The registry `SELECT 1` runs on every probe
      and answers 503 `database: 'unhealthy'` when it cannot — the static ok could hold a
      dead registry open as healthy in Coolify. `health.test.ts` covers both paths.
- [x] **P1 · production requires `MANAGED_ENDPOINT_SUFFIXES`.** Boot refuses an
      empty/whitespace allowlist in production (an empty list silently disabled the
      managed-endpoint policy). `productionBoot.test.ts` proves it with a real child
      boot of `src/config/env.ts`; `.env.sample` updated.
- [x] **P1 · settlement double-pay pinned.** `settlement.test.ts`: the same renewal
      invoice settled twice → second is 409, `paid_through` moved exactly once, one
      payment row, one `invoice_settled` audit entry, one licence push.
- [x] **P1 · office session TTL.** `JWT_TTL_HOURS` default 168h → 24h (env override
      kept); `.env.sample` updated.
- Verification: typecheck clean; backend jest **401/401 across 33 suites** (was 387/30);
  frontend 24/24; `npm run build` exit 0; prettier clean on touched files. Not committed.

## Next Step

Owner: set the production office identity and SMTP in the prod control plane's
Settings, then onboard the first real client (cutover §8). The repository is
committed and promoted (`dev` → `staging` → `main`, all three at the same commit,
2026-10-12); the CP's own two deployments have **not** been redeployed since, so
they still run the previous `main` — say the word and they follow.

## Current Phase

**Deployment, the demo fleet and the storage tree — live (2026-10-07).** Both
control planes are deployed and healthy: staging
(`staging-cp.vula-app.co.za`, the rehearsal walked end-to-end) and production
(`vula-cp-mzsza-2026.vula-app.co.za`, clean registry — the owner's real
identity + SMTP in Settings and the first real client are what remain, §8).
The demo fleet is nine stores over six clients — Urban Threads (Head Office +
three branches), Everyday Retail, Kloof Auto Spares, **Demo Diner** (renamed:
myDiner is a real restaurant's name), **Demo Hardware** and **Demo Pharmacy** —
every one on the agreed bind tree, licences active, settled to 2099, reset
nightly from goldens. The marketing site is live at vula-app.co.za.

Rolling with the deployment:

- **The data tree is bind-backed volumes** (Coolify 4.3.23's API refuses binds
  and has no command-exec endpoint):
  `/data/apps/vula-app/control-plane/<env>/` ·
  `clients/<client>/head-office/` · `clients/<client>/stores/<store>/` — each
  leaf is the deployment's `/data`, and the volume's `_data` and the tree path
  are the same inode. Thirteen deployments migrated with a verified
  copy-then-swap (`scripts/vula-bind-storage.sh`, installed on the host too).
- **Backups mirror the tree** into `/backups/vula-app` at 02:10 — the demo
  clients are excluded by the owner's decision (their goldens protect them) —
  and the demo reset runs at 02:17 from `/backups/vula-app/demo-golden`.
- **Watch paths stop the fleet rebuilding for non-code pushes**: stores and
  Head Offices ignore `marketing/**`, docs, prompts, plans, plus
  `head-office/**` (stores) and `frontend/**` (HOs); the website watches
  `marketing/**` alone. `scripts/**` stays watched — the production build
  compiles it into both images.
- **The deployment queue can wedge** (Horizon's job timeout is 11 hours): a
  push that queues nothing, or deployments stuck `queued`, means restart the
  coolify container and re-trigger — stuck jobs are marked failed, never
  resumed. Findings, 2026-10-07.
- **The Head Office's branch Base URL is a link** into the store, and the two
  new demo verticals ship through the same onboarding path real clients will.

Previous — **Pass 4 of the production review — operations (2026-09-25, complete).** Owner:
_"go ahead with next task"_. `markOverdueInvoices` gives the `overdue` status its
first writer; a daily billing tick (`BILLING_TICK_INTERVAL_MINUTES`, 0 disables)
marks lapsed invoices and runs the renewal sweep, never settling anything; the
two scheduled jobs share one implementation of the guards
(`startScheduledTask`, with the health sweep delegating and its tests untouched);
and the wizard's nested `stores[]`/`headOffice` plus the upgrade route's
`headOffice` are validated through the same helpers as the registry routes —
closing a hole where a nested `baseUrl` bypassed the Pass 2 trust boundary, and
a non-array `stores` produced a 500. Tests CP **343 green (26 suites)**.
**Frontend test coverage (§27) is started:** `frontend/jest.config.cjs` (Jest +
jsdom, two added dev deps) with three suites and 22 tests over the money
formatter, the `api` wrapper and the store form; `npm run test:all` runs
backend + frontend (365 tests). Page-level behaviour tests remain (tidbits).
**The approved-domain allowlist** (`MANAGED_ENDPOINT_SUFFIXES`, production only)
is implemented after the owner confirmed the domain — `vula-app.co.za`, with the
panel at `vula-cp-mzsza-2026.vula-app.co.za` (review §8 closes completely, and
`prompts/production-cutover.md` records the locked decisions). **`main` is
promoted to the same commit** (`origin/main` = `d19016f`, fast-forward) —
production now deploys the reviewed code. **The optimed Coolify probe is
adopted** (`npm run probe`, `scripts/coolify-probe.ts`) — the one piece of its
integration this repo lacked; the unused lifecycle exports (stop/start/delete)
stay unwired pending the product question in tidbits. **Still open from
the review:** the `registryDb.ts` split (§26 — deferred to the next schema
change).

Previous — **Pass 2 of the production review — the trust boundary (2026-09-25,
complete).**
Owner: _"push / move on to phase 2"_. One managed-endpoint policy
(`requireBaseUrl` + `assertManagedEndpoint`) now backs store create, store edit,
Head Office create and Head Office edit — the two edit routes previously changed
a base URL with no probe, so a row could be repointed and the next licence push
would send that store's token to the new host. Production refuses plaintext,
private/loopback/link-local/CGNAT/metadata addresses (literal and resolved) and
unreachable hosts; development keeps allowing loopback and unreachable rows, as
the fleet requires. The login limiter is proxy-aware
(`CP_TRUST_PROXY_HOPS`, default 0), enforced per address _and_ per account, and
no longer extended by the requests it refuses. The dev-credentials hint is
DEV-only and `npm run build` fails if it survives minification. Tests CP **328
green (25 suites)**; typecheck and both builds clean; verified in production
mode against a copy of the live registry (all seven refusals). Doctrine:
CONTEXT §3a. **Remaining from the review:** Pass 4 (overdue tick, nested wizard
validation, frontend tests, registryDb split); the unowned `companies.ts` hunk;
and tidbits' limiter-storage and DNS-rebind items.

Previous — **Pass 3 of the production review — client lifecycle (2026-09-25,
complete).**
Owner: _"lets go ahead with pass 3"_. Company delete now blocks on invoice
history (financial records are retained; suspension is the off-ramp, and a
successful delete is audited `company_deleted`); `updateCompany` switched from
COALESCE to presence-flag semantics so an explicit `null` clears `paid_through` /
`trial_ends_at` / `plan_id` (the old helper could set but never un-set); the
client and company PUTs apply the whole edit in one transaction (a refused
allocation no longer leaves a renamed client behind an error), with the licence
push outside it; and Head Office registrations tear down pause-first like stores
(`DELETE /panels/:id` → 409 `panel_active`, Pause/Resume on both panel surfaces).
One self-inflicted bug found and fixed: `db.transaction(fn)` returns a function —
the two new transactions were never invoked, so the routes silently did nothing
until the five-test wall came down (findings, 2026-09-25 pass 3). Tests CP **310
green (24 suites)**; typecheck and both builds clean; verified against a copy of
the live registry. Pass 2 (URL/SSRF, proxy-aware limiter, login dev-hint gate)
remains queued.

Previous — **Pass 1 of the production review — settlement → entitlement
(2026-09-25).**
Owner: _"see attached and advise"_ on `review-23Sep2026.md`, verified claim by
claim, then _"continue with Phase 1"_ (fleet is dev-only, so strictness is safe).
Shipped: `purpose` persisted on invoices and returned by GET; settlement
extends `paid_through` only for `initial`/`renewal`; the recorded amount must
equal the invoice total; the financial writes are one transaction with the licence
push outside; an expired trial and a never-paid client derive **suspended** (the
old `active` fallback is gone — 8 of 11 dev clients now read suspended, honestly);
the sweep re-delivers licences on failed push or past half the offline window;
production boot refuses `BILLING_SIMULATE_RENEWAL_SETTLEMENT=true`. Verified on a
copy of the live registry: onboarding settlement leaves a client suspended, an
initial settlement activates one and delivers its licence. Tests CP **302 green (24 suites)**. Doctrine: CONTEXT §2b, §5e. **Remaining from the review:** Pass 2
(URL validation/SSRF, proxy-aware limiter, login dev-hint), Pass 3 (company-delete
financial blocker, COALESCE null-clearing, atomic client edits, panel teardown),
Pass 4 (overdue tick, nested validation, frontend tests, registryDb split), plus
the unowned `companies.ts` change and the prettier decision.

Previous — **The health sweep runs on a timer (2026-09-17).** Owner: _"ok go ahead"_ on the
recommendation list. The tree is committed (three commits: the licence-counter
repair, the client roster row + store ordering, the session docs), and the first
piece of the "make the panel tell the truth" item is done: `server.ts` now starts
`services/sweepScheduler.ts`, which runs `healthSweep` every
`HEALTH_SWEEP_INTERVAL_MINUTES` (default 10, `0` = manual only). The measurement
that justified it: the registry claimed **64 of 64 stores up** while a real sweep of
the same fleet found **15 up, 49 down** — every green light on the fleet page was a
record of deploy time, not of the fleet. A tick is skipped rather than queued while a
sweep is in flight, and the first sweep is one interval after boot. Tests CP **280
green (22 suites)**. Doctrine: CONTEXT §3.

**Still outstanding from the recommendation list:** item 2 (record the agreed price
for the ten clients whose terms are unset, and bill the onboarding charge for the
eight that have never carried it) is an operator task — it changes what live clients
are billed, so it needs the owner's figures; item 3's remaining half is the 51 red
licence badges (42 unreachable hostnames, 9 credentials); item 4 (secrets at rest,
auth hardening) is the gate before the CP is internet-facing; item 5 is F2
auto-provisioning, blocked on DNS; item 6 is integration tests for the money and
entitlement paths. The prettier reformat is deliberately untouched while another
session is editing this tree.

**Two owner reports fixed (2026-09-16, eleventh pass).** Owner: _"CP : Clients -> 1
Client per line"_ + _"Client Details-> Multiple Stores-> Push License : Store POST
/api/internal/licence failed: Licence sequence 6 is older than the stored 10 retry"_.

- **The licence counter is a mirror of what the deployment holds, and now asks it.**
  `panels.id=1` (`urban-threads-ho`, the _Multi-Store_ client's Head Office) held 6
  while the deployment held 10, so every push was refused and every retry moved the
  number one step. `services/licenceDelivery.ts` is now the single place a licence is
  signed and delivered (used by all six issuing paths, not just the two buttons); it
  reads the sequence the deployment reports before allocating and raises the counter
  to at least that value — never lowering it, best-effort when the deployment cannot
  be reached. The correction is audited (`licence_sequence_reconciled`, actor
  `control-plane`) and returned to the SPA as `reconciled: {from,to,reported}`.
  Verified on the live fleet: panel 1 `6 → 11` and store 4 `5 → 7`, both now `ok`.
- **Clients: one client per line** as a wide roster row (identity · four labelled
  columns · actions), with the store chips on their own full-width row.
- **Scope, stated:** this repairs the 2 rows actually refused on sequence. The other
  51 failed licence rows are unreachable production URLs (42) or wrong credentials
  (9) — different problems, in tidbits.md.

Tests CP **273 green (21 suites)**; backend typecheck, frontend `tsc -b` and the
production build clean. Doctrine: CONTEXT §4.

Previous — **Phase 3 complete — pro-rata, grandfathering and print CSS (2026-09-16).**
Owner: _"pro-rata+gf then print css"_.

- **Grandfathering**: the agreed price terms live on the subscription and are
  stamped only when the office onboards, moves or explicitly re-prices a client, so
  **editing a plan re-prices nobody**; caps and features still track the plan.
  `POST /clients/:id/reprice` is how a rise reaches an existing client (audited),
  and the client page says which state each client is in.
- **Pro-rata**: terminals bought mid-period are charged at the agreed rate for the
  days left in the paid period (monthly = 30 days, annual = 365), once per period
  (`invoices.pro_rata_period`), never credited on a reduction, never applied to a
  negotiated flat deal. The client page shows the figure and the window; the office
  raises it (`purpose: 'pro_rata'`).
- **Print CSS**: the invoice prints as a document, not as the SPA.
- Two bugs fell out and were fixed: the renewal sweep aborted on one client's data
  (now isolated per client, like the health sweep per store) and read the plan
  rather than the client's agreement; and every invoice line now comes from one
  model, so a hand-priced or pro-rata charge itemises instead of showing a bare
  total.

Tests CP **260 green (20 suites)**; typecheck, frontend `tsc -b` and the production
build clean. Doctrine: CONTEXT §5e. **Phase 3 is now closed** — the deferred
commercial items (reduction credits, per-client overrides, bulk re-price, the
payment gateway) are in tidbits.md.

Previous — **Phase 3 (partial) — invoice numbering and VAT on inclusive prices
(2026-09-16, complete).** Owner: _"fix invoice numbering"_ + _"prices inc VAT"_ —
the two items that stood between this panel and an invoice usable with a real
client:

- **Numbers** are a monotonic per-year sequence, `VULA-2026-000001`, from an
  `invoice_sequences` counter incremented in the statement that reads it. The old
  `INV-<date>-<4 random digits>` could collide within a second (surfacing as a raw
  UNIQUE error) and reconciled to nothing; a year seeds from the highest number
  already issued, so a restored backup cannot re-issue one.
- **VAT**: prices are quoted **inclusive**, so the invoice states the total and
  breaks the tax out of it (`subtotal + vat = total`, integer cents, never a cent
  out). `vat_reg_no` + `vat_rate` are Settings fields; the rate and the split are
  stored **per invoice**, so a rate change never restates a document already
  issued; pre-split invoices keep their NULLs; with a registration the document is
  headed **Tax invoice**.

Tests CP **242 green (19 suites)**; typecheck, frontend `tsc -b` and the
production build clean. Doctrine: CONTEXT §5e ("VAT and invoice numbering").
What is left of Phase 3: print CSS.

Previous — **Phase 2d — the invoice's line order and one name for the once-off
(2026-09-16, complete).** Owner: _"alway have the Vula onboarding and deployment
first line item when applicable in invoice."_ The charge now leads the lines on
the PDF, the emailed invoice, the Billing detail view and the Raise-an-Invoice
preview; the label is one constant per side of the build
(`SETUP_FEE_LINE_LABEL` / `SETUP_FEE_LABEL`), so the client reads the same words
the office does; and the invoice subject moved out of the amounts table, where it
looked like an uncharged line and displaced the first real item. Test: the email
rows are asserted to put the once-off before the recurring line. Tests CP **234
green (19 suites)**, typecheck, frontend build clean. Doctrine: CONTEXT §5e.

Previous — **Phase 2c — capturing the once-off, and what is _not_ chargeable
(2026-09-16, complete).** Owner: _"when creating an invoice: check if once-off has
been payed. if not it invoice it"_ + _"Allow to bill for support as well"_.

- **The once-off is captured automatically.** It used to ride only on an `initial`
  invoice — so a client invoiced once before the charge existed kept an unbilled
  R10 000 forever, which is how nine of eleven live clients got there. Now
  `initial`, `renewal` (sweep included) and hand-priced invoices all carry it while
  it is unbilled, itemised as its own line; `includeOnboarding: false` is the
  one-invoice opt-out; the sweep counts what it captured (`onboardingCharged`); and
  the create modal shows the line, with the opt-out, before the invoice goes out.
- **Support is not chargeable — it is in the rate.** The owner's answer to the
  second half was a pricing decision, not a feature request: support is included
  per licensed terminal. Recorded as a locked commercial rule in CONTEXT §5e, the
  glossary, AGENTS.md and tidbits, so "bill for support" does not get invented
  later.

Status: **complete** — tests CP **233 green (19 suites)**, typecheck, frontend
`tsc -b` and the production build clean. Phase 3's remainder (invoice numbering,
the stored VAT split) is unchanged; see tidbits.md.

Previous — **Phase 2b — the invoice as a document, and a home for once-off charges
(2026-09-16, complete).** Owner follow-ups on the Phase 2 mailer, all about the
invoice itself:

1. **The email footer said "Sent by the Vula control plane."** "Control plane" is
   internal vendor vocabulary that a merchant should never read on an invoice.
   Every mail now signs off with the office's own name.
2. **A PDF invoice attached to the email.** `services/invoicePdf.ts` (pdfkit, A4,
   the tenant's document conventions) renders it; the mailer attaches it and
   `GET /api/billing/invoices/:id/pdf` serves the same document, so the download
   and the attachment cannot diverge. Three layout defects found by reading the
   rendered text — a money column narrower than the amount (which split
   `R 14 500,00` mid-figure), two guessed vertical offsets, and a footer pinned to
   the foot of the page — are fixed and the money-column fit is asserted in tests.
3. **Somewhere to bill a once-off charge.** Invoices carry a **`description`**; a
   hand-priced invoice must state one (400 `invoice_description_required`); the
   Billing modal asks for it; and the client page can bill the plan's onboarding
   charge on its own (`purpose: 'onboarding'`, 409 `setup_fee_not_due` when there
   is none due) rather than re-billing the client's current period via `initial`.
   Nine live clients owe R10 000 onboarding that had no path to being raised.

Status: **complete** — tests CP **228 green (19 suites)**, backend typecheck,
frontend `tsc -b` and the production build clean. Doctrine: CONTEXT §5e. What is
left of Phase 3: invoice numbering and the stored VAT split (see tidbits.md).

Previous — **Control-plane settings & the real mailer — Phase 2 of the SPOG/demo plan
(2026-09-16, complete).** Owner: _"continue with phase 2"_ (the phased plan set
with the Head Office branch-picker work; Phase 1 = CP → panel store roster and the
picker, closed 2026-09-16; Phase 3 = invoice numbering, stored VAT split, PDF,
print CSS). A **settings singleton for the control plane's own identity**, a
**Settings page**, and a **real SMTP mailer** — because the existing
`POST /api/billing/invoices/:id/email` is a stub that audits an email, returns
`ok: true` and `sentAt`, and **sends nothing**: a fabricated success on the
billing surface, the same shape of defect as the auto-renewal that used to record
a payment nobody made.

Also carried in this phase, from the same day's owner reports:

- **The store credential has no repair path** — **fixed.** A store added without
  pasting its deployment's `CONTROL_PLANE_TOKEN` gets a generated one, every push
  answers `Invalid control plane token`, and nothing could reconcile the two:
  `PUT /api/stores/:id` did not accept a token, the edit modal had no field for
  it, and the client page's "Add Store to Fleet" neither accepted nor revealed
  one (the reveal-once modal existed only on the unlinked `/stores` fleet page).
  Now: `PUT` accepts `controlPlaneToken` (blank refused, audited without the
  value, never returned), the edit modal carries the field, and the client page's
  add form has both the input and the token modal. **Verified against the live
  store at `:3278`**: create → `Invalid control plane token`, replace the
  credential → push ok, health up.
- **"Unable to edit a store" was a vocabulary problem, not a missing feature.**
  Driving the real UI proved editing works on all three surfaces — the button is
  called **Configure** (pencil), not "Edit", and `PUT /api/stores/:id` returns
  200 with the modal's values. The one thing the modal could not change was the
  push credential, which is the gap the first bullet closes.

Status: **complete** — `office_settings` singleton + `services/officeSettings.ts`

- `services/mailer.ts` (nodemailer, transport per send) + `routes/settings.ts`
  (`GET/PUT /api/settings`, `POST /api/settings/test-email`) + the Settings page and
  nav entry; the invoice email route now really sends (400 `smtp_not_configured` /
  502 `mailer_failed` / 200 with `emailed_at`+`emailed_to` and an audit row that
  matches the outcome); `invoice_due_days` replaces the hard-coded 14-day term.
  Tests **218 green (18 suites)**; backend typecheck, frontend `tsc -b` and the
  production build clean. Doctrine: CONTEXT §5e. Phase 3 (invoice numbering, VAT
  split, PDF/print CSS) is the next slice; see tidbits.md.

Previous — **Subscription model redesign — licensed terminals × rate + once-off onboarding
(2026-09-13, complete).** The owner brief
(`~/Downloads/vula-pos-subscription-redesign-agent-prompt*.md`) sets the commercial
model: recurring = **licensed terminals × price per terminal**, plus a **once-off
onboarding** charge on the first invoice; a plan may be `per_terminal` or `custom`.
Shipped in this repo and in za-pos (both sides of the terminal-allowance gate):

- **Plan / subscription / billing are now three concepts.** The plan is the
  catalogue (caps, features, `pricing_mode`, `terminal_price_cents`,
  `setup_fee_cents`, `billing_period`); the subscription is what the client bought
  (`company_subscriptions.licensed_terminal_count` + `setup_fee_status`);
  `store_terminal_licences` says where those licences sit; billing is
  `licensed × rate` (+ onboarding once).
- **Only licensed terminals are billable** — never configured tills, claimed
  devices, open tills or heartbeats. `services/pricing.ts` is the one calculator.
- **`custom` never auto-calculates**: an amountless invoice for a custom-priced
  client is refused, and the renewal sweep skips it.
- **The licence carries the allowance** (`maxTerminals`, additive, per store); the
  register refuses new device claims beyond it (za-pos). Existing flat-priced plans
  became `custom` rather than being re-interpreted as rates — see findings.md.
- Tests: CP **159 green (13 suites)**, za-pos **325 green (32 suites)**; typecheck
  and both production builds clean; migration rehearsed against a copy of the live
  registry. **No commit** (house rule).

Previous — **L4 Enforcement — control-plane authority side (2026-09-11).** Plans no longer
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
- [x] **Head Office has its own client tab, between Overview and Stores**
      (2026-09-13, owner-directed): the tab carries the full panel card
      (URL, status, last check, version, licence sequence/push) with
      **Diagnostics, Push Licence, Edit (name/URL) and Remove (registration
      only, confirm-then-delete)** actions; Single-Store clients see the
      upgrade entry point there. Head Offices removed from the nav (the
      /head-offices fleet page stays reachable by URL for panel registration,
      like /stores and /companies). Tabs: Overview · Head Office · Stores ·
      Deployments.
      **Deferred (spec "Next"/"Later"):** sync dashboard/inspector, backups —
      errors, devices, versions and deployments shipped 2026-09-14 below.
      The spec's grouped nav (§39) is the obvious follow-up now that four
      surfaces exist.
- [x] **SPOG — Deployments page** (2026-09-14, §33, read-only): `GET
/api/deployments` exposes the orchestration history fleet-wide (until now
      only per client) with a one-query step tally, and
      `GET /api/deployments/:id` adds the steps (status, attempts, warnings,
      error). A job records no image version, environment or operator — those
      spec columns are omitted rather than guessed. No rollout controls: §33
      warns against them without permissions and auditing the CP does not have.
      Page + nav + status filter + step modal. Doctrine: CONTEXT §5d. Tests: CP
      **195 green (17 suites)**.
- [x] **SPOG — Versions page** (2026-09-14, §32): `GET /api/versions` aggregates
      the build each registered member runs (stores' `app_version`/
      `schema_version`, panels' `app_version`) into a distribution with its
      member list, a schema-version spread and the most-deployed build per
      environment. "Never reported" is its own row, so the distribution accounts
      for the whole fleet. **No "minimum supported" version** — nothing defines
      one, and inventing it would invent a support commitment (tidbits.md).
      Page + nav + build filter. Doctrine: CONTEXT §5c. Tests: CP **188 green**.
- [x] **SPOG — Devices page** (2026-09-14, §25): every configured till of every
      store (claimed or not) plus one entry per Head Office, from `GET
/api/devices`. Derived, not stored: per-till `claimed`/`deviceId`/
      `sessionOpen`/`lastSeenAt` come from `last_telemetry_json` and the roster
      decides which tills exist. A bound till reads **Claimed**, not Online —
      `lastSeenAt` is a reserved null until the tenant ships device heartbeats —
      and Last seen falls back to the store heartbeat. Read-only: no per-device
      command API exists, so the spec's device actions are not shipped as dead
      buttons. `services/fleetView.ts` now owns the derived state that the store
      list, store detail and Devices page share. Page + nav + type filter +
      status filter. Doctrine: CONTEXT §5b. Tests: CP **181 green (15 suites)**.
- [x] **SPOG — Errors page** (2026-09-14, §30 observability): the panel was
      blind by construction — a store's row keeps only the _latest_ failure, so
      "how often, since when, how many stores" was unanswerable, and the
      2026-09-14 health-probe incident showed a bare "Offline" with no reason.
      New `error_events` feed (one row per fingerprint × source × entity,
      incremented on repeat), recorded from the four real failure paths —
      store health, config push, licence push (**whose reason used to be
      discarded**, now kept) and deploy. `GET /api/errors` (grouped, newest
      first) + `GET /api/errors/:fingerprint` (a group with every occurrence);
      new **Errors** nav entry and page with source filters and a detail modal.
      History survives recovery; only the CP's own technical summaries are
      stored (§40). Doctrine: CONTEXT §5a. Tests: CP **173 green (14 suites)**.
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
- [x] **Phase 2 — office settings + the real mailer** (2026-09-16): the
      `office_settings` singleton, `GET/PUT /api/settings` +
      `POST /api/settings/test-email`, a Settings page and nav entry, and
      `services/mailer.ts` replacing the invoice-email stub that reported a
      success it never performed. Shipped with the store-credential repair path
      (§5e, and the Current Phase entry above). Tests **218 green (18 suites)**.
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
- [x] **F2 Coolify auto-provisioning** (this repo) — **shipped and live**: the
      env-gated client, provision-on-create, `/data` storage, the deploy/health
      calls and the mocked-API tests all landed across September; since
      2026-10-01 the whole fleet, both control planes and the two new demo
      stores have been provisioned through it. The bind target is now emitted
      in the result (`vulaHostPath`) with the host step named in the warning,
      because the API cannot create the bind itself (findings, 2026-10-07).
      Original scope, kept as the record:
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
      **Superseded by the 2026-09-13 redesign** (licensed quantity + allocations + per-terminal pricing + once-off onboarding): per-store pricing is
      expressed as allocations, and subscription snapshots remain deferred
      (tidbits.md).
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
      CP-vs-HO token isolation suites. _Partially covered:_ the new
      orchestration suite covers fail-truthfully, UUID persistence +
      retry-without-duplicates, two-way wiring, and warnings-not-fake-success.

## Phase set (2026-10-10): the add-on model, complete

Owner: _"split the keys"_, then _"but all of these are chargable"_ — the plans sell features per
month, nothing chargeable is bundled, and what a client buys is snapshotted at the price agreed.

- [x] **A1 The three-layer entitlement model.** `plans.features_json` (included),
      `plans.feature_prices_json` (what this plan sells an add-on for),
      `company_subscriptions.features_json` + `addon_prices_json` (what the client bought, at the
      price agreed then). `effectiveFeatures(plan, subscription)` is the one derivation, and it is
      what every licence carries.
- [x] **A2 Eight keys, six chargeable.** `layby` and `invoice_import` split out of their parents and
      granted by migration to every client that already had the parent (verified against a snapshot:
      all eleven clients' entitlement sets unchanged). A chargeable feature may not be bundled by a
      plan — refused by name at both plan write paths.
- [x] **A3 Billing follows the client, not the plan.** One invoice line per add-on, prices
      snapshotted, editing a plan re-prices nobody, `requireSellableFeature` gates multi-store on
      buying the Head Office add-on.
- [x] **A4 The office sells them in both UIs.** Plans page: an **Add-ons** price block (only what the
      plan does not include) and an _Included_ statement. Clients wizard and the subscription editor:
      the add-on ticks, with the plan's prices, forced Head Office for multi-store.
- [x] **A5 Two defects found by using it (2026-10-10, warehouse demo).**
      `invoices.addons_json` had a DDL line and no column migration — every existing registry failed
      its next invoice; fixed with the migration and three tests against a pre-add-on shape. And
      `kind` travelled on the roster but not on branch activation, so the panel filed a warehouse as a
      shop; both payloads carry it now, with the panel leaving an absent kind alone.
      CP 376 tests, panel 97, store 656.

## Phase set (planned 2026-10-13): the quote desk — the CP sends the site's quotes as documents

Owner: _"should we use the CP to send quotes? We dont have a that feature. lets plan"_ — the
sending half already exists; what the office does not have is the desk around it.

**What already exists, verified live 2026-10-13.** The marketing `#pricing` builder posts its
quote to `POST /api/public/quote-request` (deployed: CORS preflight from `vula-app.co.za`
answers 204, `/health` ok). The route mails the office (`QUOTE_TO`) and the visitor, Reply-To
the visitor, through SMTP-or-Resend (`routes/public.ts`, `services/quoteMail.ts`, 9 tests).
What is missing: **nothing persists** (no `quotes` table — the schema's only "quote" is the
pricing arithmetic — and no office screen); the visitor receives a copy of their _request_, not
a quotation; and the route trusts the page's figures (`money()` only shape-checks).

**Vocabulary.** A _quote_ (this feature) is a document sent to a prospect.
`SubscriptionQuote` / `quoteForSubscription` (`services/pricing.ts`) is the arithmetic of what
an existing client pays — a different concept; CONTEXT gains §5f with the distinction when P1
lands.

- [ ] **P0 Prove production sending.** The transport is the office's SMTP mailbox (owner,
      2026-10-13: no Resend — the mailbox is already configured), so nothing here waits on an
      env key; what remains is a live request from the site with `example.com` as the visitor
      address, confirming the office copy, the visitor copy, and that Reply goes to the
      visitor. Nothing below can be verified end-to-end without it.
- [ ] **P1 The record.** `quotes` + `quote_sequences` tables (registryDb.ts, mirrored in
      schema.sql; new tables, no data migration). `nextQuoteNumber()` copies
      `nextInvoiceNumber`'s rules exactly (increment in the reading statement, self-heal from
      the highest number already written) with the format `VULA-Q-<year>-<6 digits>`. The public
      route records **first, emails second**, in a transaction: a transport failure keeps the
      lead (today it is lost) and the page's 502 → mailto fallback is unchanged; honeypot and
      validation failures still record nothing. **Server-priced, with a drift flag**: the route
      prices the configuration itself (`services/quotePricing.ts` — the list plan's per-till
      rate, `DEFAULT_FEATURE_PRICES`, and the R5 000 assisted / R1 500 self setup pair, whose
      assisted figure currently has no home server-side and needs one: settings or a constant)
      and stores what the visitor saw beside what the catalogue says. The office email names a
      difference; the visitor's copy keeps their builder's numbers. Office API `GET /api/quotes` + `/:id` and a read-only Quotes page beside Billing in the CP frontend; the lead email
      carries the number and a deep link. Tests: numbering (monotonic, never reused, self-heal),
      record-on-request, honeypot records nothing, transport failure keeps the row, pricing +
      drift, list/detail; `publicQuotes.test.ts` updated for the new behaviour.
      _P1 progress (2026-10-13): the backend is in — `quotes` + `quote_sequences` and
      `nextQuoteNumber` in the registry, `services/quotePricing.ts` (the list price and the
      assisted/self setup pair as constants there; P4 moves them to a served endpoint), the
      public route recording first and emailing second (desk copy with the number and any
      drift, visitor copy as before), and `routes/quotes.ts` (office-only list/detail). The
      builder now posts its add-on keys and setup choice alongside the figures — **deploy the
      page before the CP**, since the new endpoint requires them (the old endpoint ignores the
      extra fields, so that order is safe). The read-only Quotes page landed the same day
      (`frontend/src/pages/QuotesPage.tsx`: status filter, drift and email-failed chips, a
      detail modal with both figure sets; labels come from `/plans/features`, never a local
      copy) — **P1 is complete, P2 (PDF + send) next**._
- [x] **P2 The document.** `services/quotePdf.ts` on the `invoicePdf.ts` pattern (A4, 48pt
      margins; the money column and wrap rules asserted the same way): vendor identity from
      office settings, "Quotation" + number, date and valid-until, prospect block, lines, the
      tax broken out of the inclusive prices at the snapshotted rate, setup once-off, monthly
      total, note, footer — and the explicit line that it is **not a tax invoice**.
      `GET /api/quotes/:id/pdf` (office; what the office downloads is what the prospect
      receives) and `POST /api/quotes/:id/send`: config/validity/note editable while sending,
      prices snapshotted, `valid_until` from a new office setting `quote_valid_days` (30), the
      prospect receives the PDF with `hello@` as Reply-To, status → `quoted`, audit row; the
      mailer's honest-outcomes table applies. The request email stays as it is — the quotation
      is a separate message.
      _P2 progress (2026-10-13): landed — the office setting, `services/quotePdf.ts`, the PDF
      and send routes, the page's Download/Send actions and the inline send panel (stores,
      tills, set-up, add-ons from the vocabulary). Deviations from the plan above, recorded
      rather than quietly dropped: the invoice footer is **not** printed on a quotation
      (payment instructions belong to an invoice — nobody owes anything yet; a validity line
      stands in its place); the per-send `validDays` override exists in the API but the UI
      leaves validity to the setting; and editing the prospect's note was not built — it
      lands with P3's accept/decline pass._
- [x] **P3 The pipeline.** Accept/decline recorded by the office; `expired` derived from
      `valid_until` (never stored, no cron — the subscription-state rule). **Create client from
      this quote** pre-fills the existing onboarding (`POST /companies`, `recordAgreedPricing`,
      setup fee) and stores `company_id` back on the quote. Audit every action.
      _P3 progress (2026-10-13): landed — `accept`/`decline` (audited; a settled quote refuses a
      second verdict with 409), `expired` derived in `quoteOut` and surfaced as an Expired
      filter/chip, and `create-client`: a quote-driven creation reusing the onboarding machinery
      (`createCompany`, `setLicensedTerminalCount`, the pricing setters) but with the **quote's
      own figures** rather than `recordAgreedPricing`'s plan prices — the quotation is the
      promise, and a plan edited since must not re-price it (P4 closes the loop). The office's
      panel pre-fills name/slug/plan/tills from the record and can correct them; a visitor with
      no business name must be given one. `company_id` links the two, and the desk links to the
      client page. **Also landed 2026-10-13, from the owner testing the desk: the office can
      draft a quote itself** — `POST /api/quotes` records a `source: 'office'` draft (same
      catalogue pricing, no request email; a new column, defaulted to 'website' with the usual
      column migration for existing registries) so a phone-in prospect flows through the
      identical pipeline. **Then the owner's first real test found the desk pricing tills
      wrong** — the forms asked for a total while the product prices per till (3 stores × 1
      till quoted as 1 till): the create/send/edit forms now ask Stores × Tills per store (the
      marketing builder's own model) and a quote with fewer tills than stores is refused;
      `PUT /api/quotes/:id` edits a live quote (re-priced, audited, the visitor's snapshot
      untouched) and `DELETE /api/quotes/:id` removes any quote that never became a client
      (audited; numbers retired). Still open from P2's note: the per-send validity override in
      the UI (the note edit landed with the edit panel)._
- [ ] **P4 (optional, decide after P2) One price source.** `GET /api/public/pricing` from the
      CP; the site's script hydrates its figures from it with the static `data-cents` kept as
      the no-JS default. Then the P1 drift flag becomes a canary, not a routine.

**Open decisions (owner).** (1) A negotiated adjustment line on a quote — v1, or defer? The
plan defaults to defer (list prices; the office's reply carries any concession). (2)
Prospect-data retention for quotes that never become clients — deferred; say if a purge action
is wanted. (3) A signed public "accept" link (the store's receipt-link pattern) — deferred;
acceptance is recorded by the office.

**Out of scope.** Auto-provisioning on acceptance (the orchestrator exists; onboarding a live
client stays an owner action). Merchant-side quoting — the store and panel already send their
own; the vendor plane must not carry merchant content.

**Acceptance.** After P3: a visitor builds a quote on the live site → a numbered, server-priced
record appears in the CP → the office sends a PDF quotation the prospect receives and can reply
to → acceptance is recorded → the client is created from the quote at the agreed prices and the
quote links to it. Suites green and typecheck clean; landed and committed on the owner's word
(2026-10-13/14) and deployed to both control planes.

## Phase set (planned 2026-10-14): the per-store price

Owner: _"R199 / store / month — First till + hosting included; Additional till R99/month;
Standard hosting and backups included; Software updates included; Standard support included"_,
then _"Head Office hosting + software R199/m"_ and _"setup/add ons unchanged"_. Asked whether
the warehouse — which exists in the local fleet as Central DC — carries its own line:
_"the warehouse holds stock and IBT happens from the WH. we should not complicate things. Also
should not be charging separately."_ Then, watching the page: _"the addons must be charge per
store, no? so if three stores - laybuy must be charged per store"_ — so the add-ons are
per-store too, Head Office alone excepted.

The model, settled: **R199/m per trading store (first till included), R49/m per additional
till, R199/m Head Office and R49/m e-commerce once per business, the remaining four capabilities
(credit accounts, lay-by, the assistant, the invoice importer) once per trading store, warehouses
not charged, set-up R1 500 self / R5 000 assisted** — all VAT-inclusive, and the list is for **new business only**:
existing clients keep their agreed prices (§5 grandfathering; their `addon_prices_json` covers
the Head Office change too). Read structurally it is today's list plus a flat R100 per
deployment — `199 + 99 × (tills − 1) = 99 × tills + 100` — and it finally prices what a store
costs to run: a container, a volume, a backup job. A warehouse rides along unpriced and
unregistered, which matches its role: stock, not trade.

**All five landed 2026-10-14** (S1–S5 below). Landed together with them, from the same owner
message: `addonQuantity(key, stores)` in `services/pricing.ts` — a per-store add-on multiplies
by the client's trading stores (`max(1, stores)`, so a bought add-on never becomes free), Head
Office stays ×1; the subscription quote carries `unitCents`/`quantity` per add-on, the invoice
snapshot keeps them (older rows still read), and the editor, the desk and the page all state
the multiplication. Verified end-to-end on the local fleet: the marketing page's default
configuration (3 stores × 2 tills + Head Office + credit + e-commerce) reads **R1 387,00/m** on
the page, and `POST /api/quotes` for the same configuration records exactly the same figure —
one source, three surfaces. CP 455/455, frontend build clean.

- [x] **S1 The plan carries the mode.** `plans` gained `pricing_mode: 'per_store'` with
      `store_price_cents` (19900 — first till included) while `terminal_price_cents` became the
      ADDITIONAL-till rate (settled at 4900 the same day); the catalogue's eight seeded tiers moved to it (the
      `per_store` CHECK needed the same guarded table rebuild the stores table uses), the
      Plans editor reads both figures (its at-ceiling total is store price +
      (ceiling − 1) × till price, per store), and `resolvePlanPricing` refuses a per-store plan
      with a zero store rate the way it refuses a zero per-terminal one.
      `calculateRecurringAmount` (one arithmetic; `calculateRecurringSubscriptionAmount` is its
      plan-shaped reader) is
      `stores × store_price + max(0, licensed − stores) × terminal_price`, where **stores
      counts `kind = 'store'` rows only** — a warehouse is not a billed unit. The subscription
      snapshots the agreed store rate beside the till rate (`store_rate_cents`, additive), so
      grandfathering holds on the new mode too. Mid-period increases pro-rate the formula's own
      delta, so adding a store with its first till moves the bill by `199 − 99 = R100` (the same
      invariant seen from below); `ProRataCharge` gained `extraStores` for the wording.
      `DEFAULT_FEATURE_PRICES.multi_store` (Head Office) moved 9900 → **19900**; the other
      add-ons stay R49/R99 per store; the additional-till rate settled at 4900 the same day.
- [x] **S2 The document says it.** The invoice's recurring lines are now `Stores · Vula
Network · 3 × R 199,00` and, when there are any, `Additional tills · 3 × R 49,00` — and a
      per-store add-on reads `Lay-by · Per month · 3 × R 49,00`. `store_count`/`store_price_cents`
      are snapshotted onto the invoice beside the terminal pair (additive columns, the house
      migration); `terminal_count` keeps meaning the licensed TOTAL on every invoice, so the
      additional count is the difference and pro-rata baselines still read from one column
      (`paidStoresFor` is `paidTerminalsFor`'s counterpart).
- [x] **S3 The desk quotes it.** `services/quotePricing.ts` prices the list: `3 stores (first
till included · (2 tills per store)) · 3 × R 199,00` plus `3 additional tills · 3 ×
R 49,00` when there are any, and each add-on at its own quantity — Head Office ×1,
      everything else × the stores (`Lay-by · 3 × R 49,00`). The real-split feature feeds both
      naturally (`(1 + 2 + 0 extra across 3 stores)`), and the rate/quantity/split snapshots and
      the drift flag are unchanged.
- [x] **S4 The page shows it.** The section reads "One rate per store", the banner states R199
      per store with the first till included plus R49 per extra till, Head Office's card is
      R199/month for the business while the other five cards say "/ store", and both the markup's
      no-JS default and the builder's arithmetic were recomputed: 3 stores × 2 tills + Head
      Office + credit + e-commerce = `3×199 + 3×49 + 199 + 3×49 + 3×49` = **R1 237,00/m**, set-up
      R5 000. The builder's `data-per` attribute is what makes an add-on per store or per
      company.
- [x] **S5 One price source — the old P4, now earned.** `GET /api/public/pricing` serves the
      desk's own list (store rate, additional-till rate, each add-on with its `perStore` flag,
      the setup pair), and the page hydrates from it on load — verified live: the page's request
      to `control-plane.localhost:3240/api/public/pricing` lands and the figures it renders are
      the ones the desk records. A failed fetch changes nothing: the markup's published figures
      stand (`data-store-cents` / `data-till-cents`).

**E-commerce is per company (owner, 2026-10-14).** _"ecommerce should be for the whole
business and not per store"_ — one storefront connection serves the business, not each branch, so
`PER_COMPANY_FEATURE_KEYS` (`multi_store`, `ecommerce_bridges`) now names the two per-company
add-ons explicitly, `addonQuantity` applies it for the desk and the invoice, and the page shows
e-commerce as per-company. The page's default configuration reads R1 139,00/m.

**The onboarding pair (owner, 2026-10-14).** The once-off setup has two prices — self and
assisted — and both now live in **Office Settings** (`setup_fee_self_cents` 150 000 /
`setup_fee_assisted_cents` 500 000), read by the desk's quotes, the onboarding form, the
subscription editor and the marketing page (which hydrates the pair alongside the rates). A
plan's own field is the per-tier override of the SELF price, and a plan created without one
starts from the office figure. The self price settled at **R1 500** (the catalogue's eight tiers
were aligned to it) and assisted at **R5 000**; the page's cards, the builder and the desk all
follow Settings, so neither figure needs a deploy to change.

**Quotes may price off the list (owner, 2026-10-14).** A prospect who enquired before the
list moved per store is honoured on the terms he was quoted: a quote now carries its own
`pricing_basis` (`store` — the published list — or `till`, the older terms) and optional unit-rate
overrides for the store rate, the till rate, each add-on and the once-off, with every departing
line recording the list figure it departed from (`listCents`). The desk's create/edit panels have
a Prices block for them. Landing with it: **the quote → client conversion now reads the quote's
own terms** — it had never been updated for the per-store model and wrote a till rate with a
STORE RATE OF ZERO, so a client created from a per-store quote would have been billed stores at
nothing; that is fixed and pinned by a test asserting the client's monthly equals the quote's.

**Warehouse correction (owner, 2026-10-14).** _"will the warehouse also be fixed - ie no POS"_ —
the earlier "no warehouse enforcement work" ruling is superseded in one respect and stands in
another: a warehouse is still not charged (S1's `kind = 'store'` billing rule is unchanged),
but it must not have a register at all. **Landed:** the store makes the control plane's `kind`
its own identity — a `settings.kind` column (baseline DDL + column migration, default
`'store'`), persisted by `POST /api/internal/configure`. That field was validated and then
thrown away, which is exactly why a warehouse behaved as "a store with zero tills" — read by
the register as legacy mode, and sold from. It is now reported by `/internal/status`, echoed
in the configure `applied` block, and published to the register through `runtime-config`.
Three refusals follow it: **`checkout()` refuses every new sale at a warehouse** (403
`warehouse`; placed after the idempotency lookup beside the subscription gate, so a sale
recorded before the kind was pushed still replays, and covering all four new-sale funnels —
the POS route, offline sync replay, customer-order collection, quotation conversion); **a
configure that would arm a warehouse with tills is refused** (the mirror of the zero-till
rule, validated against the recorded kind when the push omits it); and **the UI stops offering
the register** — the `register`-tagged nav item is filtered for all three surfaces, Home's
Sell tile and the three `/pos` action cards are replaced by a notice, Dashboard's "New sale"
link hides, and `/pos` redirects home. Regression tests pin each rule. Verified on the local
fleet (Central DC: status `kind`, runtime-config, a refused sale, and in the browser — /pos
redirects, no Sell tile, the notice shown); store suite 706/706, typecheck and both frontend
builds clean.

**Acceptance.** A new quote prices at R199/store (first till in), R49 per extra till, R199 Head
Office and every other add-on once per store, with the warehouse unmentioned; a client
onboarded on the per-store plan invoices as `3 × R199 + 3 × R49 + HO + 3 × each add-on`; an
existing client's bill does not move; the page and the desk state the same figures — and since
S5 they are the same figures, served once; and a warehouse deployment has no register anywhere
— menu, tiles, route or API.

## Phase: M4 shared-image release controller (2026-10-22) — repository-side complete, no deployment

Owner: make the Control Plane authoritative for shared-image provisioning,
version tracking, locking/dedup, schema-safe rollback and release waves. Develop
and test locally; do not deploy the CP or migrate tenants.

- [x] `image_releases` catalog: kind, immutable tag + `sha256` digest, version,
  channel, schema range, active flag; duplicate kind/tag/digest refused.
- [x] Tenant image state on `stores`/`panels`: digest, tag, channel, desired,
  last and previous release, last release time; panel schema version.
- [x] Coolify `dockerimage` provisioning from the digest, per-tenant volume,
  existing control token, runtime-only env, `health_check_host=127.0.0.1`.
- [x] Onboarding uses the latest active stable release when present. Production
  refuses a Dockerfile build; non-production fallback requires the explicit
  `ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true` opt-in.
- [x] Per-tenant deployment locks with expiry and no-op dedup for
  already-current/already-deploying tenants; stale running deployments are
  reconciled against Coolify before a retry.
- [x] Schema compatibility gate before Coolify; rollback target checked against
  the current schema and refused when incompatible.
- [x] Release batches/waves with `dryRun`, sequential execution, paused-tenant
  skips, `stopOnFailure` and per-item audit.
- [x] Release API: catalog, fleet state, apply, rollback, channel, history,
  batches/rollout.
- [x] Reliability review: Coolify deployment status + app state + version/
  revision health proof, stop-first SQLite protection, `/data`/identity
  preflight, app allowlist, trigger/app persistence, in-flight reconciliation,
  `release_state`/phase tracking.
- [x] Tests: `releases.test.ts` 29/29; main `dev` full backend **506/506**;
  isolated branch **520/520** (39 suites); typecheck and production build clean
  on both.
- [x] Isolated M4 branch `m4/shared-image-release` (implementation `14c9133`;
  M4.1 docs `1092f69`, `9c9a654`, `dcb1311`) prepared from clean HEAD;
  unrelated working-tree changes preserved on `dev`. Branch suite 520/520
  (39 suites), typecheck and build clean.
- [x] Read-only Coolify 4.4.7 contract check: application status, `/data`
  storage, deployment records/status and deployment-by-UUID confirmed; stop is
  an async queued job (exited state, containers removed). No live image app or
  stop exercised.
- [x] Stage A preparation: CP-driven single-Store plan, exact URLs/TLS
  arrangement, `/data/control-plane.db` volume contract, exact ownership
  manifest and stop-first recovery documented. `docs/m4.1-live-integration-plan.md`
  and `docs/m4.1-staging-ownership.json`.
- [x] Token consumer audit: exact exposed value in Vula and OptiMed
  `.env`; both deployed CPs expose `COOLIFY_API_TOKEN` env keys (values masked);
  no local process/container/cron/systemd consumer found. Four per-application
  credentials and an independent rotation/rollback plan are in
  `docs/m4.1-token-rotation-plan.md`.
- [x] Cross-application credential dependency removed: `release-apps.sh` reads
  only this application's environment or its own repository-root `.env`; missing
  credentials fail closed, with no OptiMed fallback.
- [x] Staging boundary guard: exact project/server/destination, staging
  name/domain, post-create read-back and mandatory allowlist on existing-app
  retry/redeploy paths. First Store creation is intentionally allowed before its
  UUID is added to the existing-app allowlist. Tests in
  `src/__tests__/stagingBoundary.test.ts`; branch suite 520/520.
- [x] Branch secret scan over `origin/dev..HEAD`: no private key, GitHub token,
  JWT, Coolify assignment or exposed token value. No `.github` workflow and no
  auto-deploy app references the branch. Branch pushed at `9ae7fc5`.
- [x] Stage A approval gates: Root Team residual accepted for the disposable
  staging test; `coolify-vula-m4-staging-cp` created and verified; exact branch
  commit pushed; isolated project created.
- [x] Independent legacy rotation: four per-app tokens created; OptiMed, Vula
  production and existing Vula staging CPs updated/restarted and verified; old
  token id 2 revoked and confirmed 401; new tokens all 200; OptiMed health
  unchanged.
- [x] M4.1 Stage A live execution: `vula-cp-m4-staging` deployed from
  `9ae7fc5` with independent DB/volume and valid TLS; Store A release registered
  and one Store provisioned through the CP. Verified exact arm64 digest, storage,
  DB identity, health and deployment records.
- [x] Stage A exact-name gate resolved by approved naming amendment 1: the
  existing Store `za-pos-m4-staging-client-m4-store-a`
  (`hme58ok1x4jvqi3cvdeapqzq`) is accepted after read-only UUID/project/domain/
  digest/storage/registry verification. Only that UUID is allowlisted; only the
  staging CP was restarted.
- [x] Stage A final acceptance: CP and Store health 200, exact arm64 digest,
  `/data` volume and DB, single container, release tracking healthy, project
  ownership exactly CP + Store, existing Vula/OptiMed health unchanged.
- [x] Onboarding API defect fixed in repository: nested input, step metadata,
  `createStore`/`createPanel` and inserts now preserve `deploymentName`.
  Regression tests in `clients.test.ts` and `onboardingNaming.test.ts`; full
  suite 520/520, typecheck/build clean. Not yet deployed.
- [ ] M4.1 Stage B: Release B prepared as OCI
  `sha256:72a9aeb8...`, version `v2026.10.23-86ed3e1-m4b`, arm64, private staging
  tag planned. Not published or deployed; approval packet in
  `docs/m4.1-release-b-approval.md`.
- [ ] M4.1 Stage B execution blocked at publication: GHCR rejected the exact
  OCI push with HTTP 403 because the available token lacks `write:packages`;
  the temporary workflow route was rejected for missing `workflow` scope. No
  tag/manifest published; CP remains on `9ae7fc5`; Store A remains on A;
  no backup/upgrade/rollback/wave test started.
- [ ] Existing Dockerfile→dockerimage blue/green migration (separate approval).
- [ ] Image signature/attestation verification (supply-chain follow-up).
- [ ] Panel schema reporting from live telemetry (currently only set by this
  controller).
- [ ] Background release worker/queue + resume endpoint for large waves.
- [ ] Release-manager role/approval boundary.
