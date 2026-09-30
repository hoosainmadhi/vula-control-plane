# AGENTS.md — working instructions for AI agents in this repo

## Agent instructions

- Respond in English only. Do not commit, merge or push unless instructed.
- Read the planning files before starting work: `task_plan.md`,
  `findings.md`, `progress.md`, `CONTEXT.md` (in that order), then run
  `git status`.
- This project uses planning-with-files conventions: after each phase,
  update `task_plan.md` statuses; append to `progress.md` throughout;
  write findings into `findings.md`; keep small deferred items in
  `tidbits.md`.
- `CONTEXT.md` is the authoritative domain reference — including the
  **Internal API contract**, which the za-pos tenant workstream implements
  to match. Never change the wire contract without updating CONTEXT.md and
  flagging it for the tenant side.
- Never invent business rules: if the docs and the code disagree, flag it in
  `findings.md` before coding around it.
- No `console.log` in server code paths — use `logger` from
  `src/utils/logger.ts` (level-gated).

## What this is

Office control plane for the Vula fleet (house pattern per
`~/apps/common-files/CONTROL-PLANE-SPEC.md`, reference impl
`~/apps/optimed-control-plane`). One store = one za-pos Coolify container
with its own SQLite DB; this app keeps the store registry (incl. terminal
count) and pushes terminal configuration to each store's internal API.

## Commands

```bash
npm run dev          # concurrently: API on :3240 (tsx watch) + Vite on :3241
npm run dev:api      # API only
npm run dev:ui       # frontend only
npm run stub         # dev store stub (tenant internal API) on :3299
npm test             # backend: jest+supertest (in-memory registry, mocked fetch)
npm run test:ui      # frontend: jsdom + Testing Library (frontend/jest.config.cjs)
npm run test:all     # both suites — the full gate
npm run typecheck    # backend tsc --noEmit
npm run build        # backend tsc + frontend production build
npm start            # run compiled dist/server.js (production)
npm run smoke        # boot smoke vs the dev store stub (API must be running)
npm run probe        # verify Coolify API connectivity and token (needs COOLIFY_*)
npm run format       # prettier
```

Ports registered in the house registry: **3240 API / 3241 frontend dev**
(block 3240–3249; store stub dev port 3299 is unregistered — local only).

## Layout

```
za-pos-control-plane/
├── server.ts              # entry: env gate, registry open, listen
├── schema.sql             # mirror of the stores DDL in src/config/registryDb.ts
├── src/
│   ├── config/
│   │   ├── env.ts         # typed env (PORT, CP_DB_PATH, OFFICE_ADMIN_*, JWT_*)
│   │   └── registryDb.ts  # DDL (stores, plans, companies, subscriptions,
│   │                      # licences, invoices, panels, jobs, audit,
│   │                      # error_events), lazy
│   │                      # singleton (WAL), CRUD + migrations
│   ├── app.ts             # createApp(): headers, /health, /api, SPA, errors
│   ├── middleware/
│   │   ├── auth.ts        # signOfficeToken, verify, requireOffice (kind 'office')
│   │   └── error.ts       # notFound + one { error, code? } handler (err.status)
│   ├── routes/            # auth.ts (login), clients.ts (client-first wizard +
│   │                      # subscription), stores.ts, companies.ts (+ plans),
│   │                      # panels.ts, billing.ts, errors.ts (failure feed §30),
│   │                      # settings.ts (the office's own settings + SMTP),
│   │                      # devices.ts (fleet devices §25),
│   │                      # versions.ts (build distribution §32),
│   │                      # deployments.ts (job history §33, read-only)
│   ├── services/          # subscriptions (billing state + entitlements),
│   │                      # pricing (THE recurring calculator),
│   │                      # terminalLicences (purchase + allocations + caps),
│   │                      # billing (invoices/licences), licenceSigner,
│   │                      # licenceDelivery (THE issue-and-deliver path: asks the
│   │                      #   deployment for its sequence before allocating),
│   │                      # officeSettings (the singleton),
│   │                      # mailer (nodemailer; invoice + test sends),
│   │                      # invoicePdf (pdfkit; the invoice document),
│   │                      # storeClient, features, coolify, storeProvisioning,
│   │                      # clientOrchestrator, healthSweep,
│   │                      # sweepScheduler (runs healthSweep on a timer),
│   │                      # fleetView (derived health/config state + devices)
│   ├── utils/             # logger, asyncHandler, validate, errors (HttpError),
│   │                      # money (cents → ZAR, for server-rendered mail),
│   │                      # rateLimiter
│   └── __tests__/         # env-setup.ts, helpers.ts + suites (*.test.ts)
├── scripts/
│   ├── dev-store-stub.ts  # stand-in tenant internal API until za-pos ships it
│   ├── reseed-fleet.ts    # rebuild the demo registry from the live deployments
│   ├── coolify-probe.ts   # verify Coolify API connectivity + token before first use
│   └── smoke-test.sh      # curl boot smoke against :3240 + stub :3299
├── frontend/              # React 19 + Vite + Tailwind v4 (own package)
│   └── src/
│       ├── api.ts         # fetch wrapper + token (localStorage 'zapos_cp_token')
│       ├── lib/money.ts   # cents → ZAR, price labels (one formatter, all screens)
│       ├── components/    # Layout, Modal, StatusBadge, Spinner, ErrorBox, cards
│       ├── pages/         # Clients (+wizard), ClientDetail, StoreDetail, Plans,
│       │                  # Billing, Companies (advanced), Panels (advanced),
│       │                  # Devices (§25), Versions (§32), Deployments (§33),
│       │                  # Errors (§30 feed), Settings (office identity + SMTP)
│       └── types.ts       # camelCase mirrors of the API types
└── prompts/
    └── deploy-coolify-control-plane.md  # runbook: deploy stores + this CP
```

## Code style

- TypeScript strict; ESM (`"type": "module"`); relative imports carry
  `.js` suffixes. No unused locals/params.
- Express 4; route handlers wrapped in `asyncHandler`; typed errors via
  `HttpError` (utils/errors.ts) / `ValidationError` (utils/validate.ts) /
  `StoreClientError` (status 502); one global `{ error }` error handler.
- Hand-rolled validation in `src/utils/validate.ts` (no zod/joi).
- DB access: `getRegistryDb()` prepared statements only, parameterised with
  `?`. Multi-step writes go through `db.transaction(...)`. Schema changes:
  edit the DDL in `src/config/registryDb.ts`, mirror in `schema.sql`, and add
  any needed column to the ensureColumns migrations. SQLite can't ALTER CHECK
  constraints — changing an enum requires the optimed rebuild choreography
  (see findings.md).
- DB columns snake_case; API wire types camelCase (StoreOut etc. defined in
  src/routes/stores.ts, mirrored 1:1 in frontend/src/types.ts).
- Frontend: fetch via `api.*` only; Tailwind utilities; `@theme` brand colors
  in index.css (no tailwind.config).
- VAT lives in `src/utils/money.ts` (`vatPortionCents` / `exclusiveCents`) and is
  always computed from an inclusive amount; the SPA never recomputes it.
- Money: integer cents in the registry and on the wire, ZAR labels in the SPA
  (`frontend/src/lib/money.ts`) and in server-rendered mail
  (`src/utils/money.ts` — the two cannot share a module across the build).
  No floating-point arithmetic on amounts.

## Naming — two planes, two products

| Port | Name                   | Audience                                    |
| ---- | ---------------------- | ------------------------------------------- |
| 3240 | **Vula Control Plane** | The SaaS vendor. One instance, all clients. |
| 3260 | **Head Office**        | The merchant. One instance per merchant.    |

"Control plane" is the fleet-management layer and only the vendor app is one, so
do **not** write "SaaS CP" / "Multistore CP" — two names ending in CP keep the
ambiguity alive. See `CONTEXT.md` §2a. The same rule applies to what clients
*read*: the phrase must never appear in a mail or document a merchant receives
(the invoice footer is the office's own name).

## Commercial rules locked with the owner

- **`licensed terminals × rate` is the whole recurring model, and the rate
  includes support** (2026-09-16). No support line, no support tier, no support
  charge type. Do not add one without the owner saying so.
- The **once-off onboarding charge is captured automatically** on the next invoice
  raised for a client that has never been billed it — across `initial`, `renewal`
  and hand-priced invoices. `includeOnboarding: false` is the one-invoice opt-out.
- **A hand-priced invoice must say what it is for** (`description`).
- **The office *records* payments; it never charges anyone.** Only manual EFT and
  bank transfer are offered until a gateway exists; "Pay" is not a word for this
  action, and an issued invoice is **voided**, not cancelled (the stored status
  stays `cancelled`).
- **Every price is quoted VAT-inclusive** (2026-09-16). The invoice breaks the tax
  *out* of the total (`subtotal + vat = total`, integer cents); nothing is added on
  top. The rate and Vula's own `vat_reg_no` are office settings, stored per
  invoice as raised, and an invoice raised before the split keeps its NULLs.
- **Invoice numbers are a monotonic per-year sequence** (`VULA-2026-000001`) from
  the `invoice_sequences` counter — never a date plus random digits.
- **A plan is a catalogue; what a client pays is their own record** (2026-09-16).
  The agreed terms live on `company_subscriptions` and are stamped only when the
  office onboards, moves or explicitly re-prices a client — **editing a plan
  re-prices nobody**. Caps/features still come from the plan.
- **Mid-period increases are pro-rated** at the agreed rate for the days left in
  the paid period (monthly = 30 days, annual = 365 — a stated convention), charged
  once per period (`invoices.pro_rata_period`), never credited on a reduction, and
  never applied to a negotiated flat deal.
- Never invent an amount: a `custom`-priced client is invoiced only with an agreed
  figure the office supplied.

## API surface (`/api` prefix, `{ error }` on failure)

| Method & path                                | Access                          | Purpose                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/auth/login`                           | public (rate-limited 20/15 min) | office session → `{ token, user }`                                                                                                                                                            |
| GET `/clients`, POST `/clients`              | office                          | client-first onboarding: wizard creates the company, its **subscription** (licensed terminals) and the deployment job; nested `stores[]`/`headOffice` entries are validated through the same helpers the single-store routes use (slug, terminal counts, `baseUrl` shape and address policy, admin email), with the app-kind probe run for any URL the operator supplies                                                                          |
| GET `/clients/:id`                            | office                          | client detail + `subscription` block (plan, licensed/allocated, recurring amount, setup fee + status, per-store allocations, `pricingSource`/`pricedAt`, and `midPeriodCharge` when terminals were bought mid-period) |
| POST `/clients/:id/reprice`                   | office                          | applies the plan's current price to that client (`subscription_priced`); the only way a price rise reaches an existing client                                                                 |
| PUT `/clients/:id`                            | office                          | profile, plan, `licensedTerminalCount`, `allocations[]`, `setupFeeStatus`; re-pushes licences when the entitlement changes                                                                    |
| POST `/clients/:id/upgrade-to-multistore`     | office                          | §7 upgrade: deploys Head Office + a branch, keeps existing store data, and extends the licensed total                                                                                          |
| GET `/clients/jobs/:id`                       | office                          | deployment jobs (and their steps) for a client                                                                                                                                                 |
| POST `/clients/jobs/:id/retry`                | office                          | resume a failed deployment job without duplicating resources                                                                                                                                   |
| GET `/stores`                                | office                          | fleet list — company, plan, billing state, licensed vs configured terminals; never returns the token                                                                                            |
| POST `/stores`                               | office                          | create store + **allocate its licensed terminals** + first push and first licence; refuses a duplicate URL, a Head Office URL, and a client with no licensed terminals; the URL goes through the managed-endpoint policy (CONTEXT §3a) — app-kind probe in every environment, plus https/private/metadata/unreachable refusals in production; a generated token is returned **once** |
| GET `/stores/:id`                            | office                          | detail: terminal preview Till 1..N + config snapshot + licensed allowance                                                                                                                      |
| PUT `/stores/:id`                            | office                          | name/vertical/terminalCount/baseUrl/companyId/terminalNames (slug immutable; **no auto-push**); refuses configuring above the licence; **a changed `baseUrl` is re-probed** through the managed-endpoint policy before the row moves, so an existing store's token cannot be repointed at an unvalidated host; **`controlPlaneToken`** replaces the push credential when a deployment holds its own (the "Invalid control plane token" repair), blank is refused, never echoed back |
| PATCH `/stores/:id/pause` · `/resume`        | office                          | paused stores 409 push/reset-admin/licence                                                                                                                                                     |
| DELETE `/stores/:id`                         | office                          | **pause-first teardown**: 409 `store_active` while active; removes the registry row only, never the deployment                                                                                |
| POST `/stores/:id/push`                      | office                          | push `{terminalCount, terminals: Till 1..N}`; 402 if over the plan's till ceiling or the store's licence                                                                                       |
| POST `/stores/:id/health`                    | office                          | ping `GET /api/internal/status`, record up/down, refresh the licence                                                                                                                          |
| POST `/stores/:id/licence`                   | office                          | re-issue and deliver the signed licence (carries the store's `maxTerminals`); **asks the deployment for the sequence it holds first** and raises our counter to match, so a registry rebuilt or restored out of a backup cannot issue a stale licence. Returns `reconciled: {from,to,reported}` when it had to catch up |
| POST `/stores/:id/reset-admin`               | office                          | store resets its admin pw; temp password shown once, never stored                                                                                                                             |
| GET `/stores/licence/key`                    | office                          | the public verification key stores install (never the private key)                                                                                                                            |
| GET/POST `/plans`, PUT `/plans/:id`          | office                          | plan catalogue: store cap, per-store terminal ceiling, features, `pricingMode` + `terminalPriceCents` + `customAmountCents` (a custom plan's agreed flat charge per period; 0 = per-invoice) + `setupFeeCents` + `billingPeriod`; code immutable; per_terminal needs a rate > 0       |
| GET `/plans/features`                        | office                          | the curated feature vocabulary (6 keys) plans may grant — validated on plan write; the store/head-office gates mirror it (L4)                                                                  |
| GET/POST `/companies`, GET/PUT/DELETE `/:id` | office                          | merchant accounts — the unit of billing and owner of the subscription; DELETE is 409 `company_in_use` while it owns stores, a Head Office **or any invoice** (financial history is retained — suspend instead; a successful delete is audited `company_deleted`); PUT accepts `licensedTerminalCount` + `setupFeeStatus`, applies the whole edit in one transaction, and treats an explicit `null` as clearing (`paidThrough`/`trialEndsAt`) |
| GET/POST `/panels`, GET/PUT/DELETE `/:id`    | office                          | one Head Office per merchant; POST/DELETE are the registration only — DELETE is 409 `panel_active` while active (**pause-first teardown**, like stores); PUT accepts `status` (`active`/`paused`, anything else 400) and re-probes a changed `baseUrl` through the managed-endpoint policy (CONTEXT §3a)                                                                                                                           |
| GET `/panels/licence/key`                    | office                          | as `/stores/licence/key`                                                                                                                                                                      |
| POST `/panels/:id/health`                    | office                          | ping the panel's own `/api/internal/status`, record health + version                                                                                                                          |
| POST `/panels/:id/licence`                   | office                          | re-issue and deliver the company licence to a panel (reconciles the sequence as above; a Head Office reports it as `licence.sequence`)                                                        |
| GET/POST `/billing/invoices`                 | office                          | invoices with their pricing evidence (`terminalCount` × `terminalPriceCents`, `setupFeeCents`), their tax split (`subtotalCents` + `vatCents` + `vatRate`; the total is VAT-inclusive), a `description` of what is charged and the `planCode`/`planName` snapshot of the plan at issue; numbers are a monotonic `VULA-<year>-<6 digits>` sequence; `purpose: initial\|renewal\|manual\|onboarding\|pro_rata` — **persisted on the invoice and returned by GET**; settlement extends the paid period only for `initial`/`renewal` (`pro_rata` raises the mid-period increase, 409 `nothing_to_pro_rate` / `pro_rata_already_billed`); **an unbilled once-off onboarding charge rides on whichever invoice is raised next** unless `includeOnboarding: false`; a hand-priced invoice without a description is 400 `invoice_description_required`; `onboarding` bills the once-off alone (409 `setup_fee_not_due` when none is due); an amountless invoice for a custom-priced client is 400 `custom_pricing_requires_amount` |
| POST `/billing/invoices/:id/pay` · `/cancel` | office                          | **record a settlement** (the UI's *Record payment* — purpose-gated: only `initial`/`renewal` advance `paid_through`, an `onboarding`/`manual`/`pro_rata` settlement pays for itself alone; the recorded amount must equal the invoice total or 400 `payment_amount_mismatch`; one transaction, audited `invoice_settled`, re-pushes licences) / **void** (stored `cancelled`, releases the once-off if it was the last invoice carrying it, audited `invoice_voided`) |
| GET `/billing/invoices/:id/pdf`              | office                          | the invoice as a downloadable A4 PDF — the same document the email attaches                                                                                                                   |
| POST `/billing/renew-check`                  | office                          | renewal sweep (also run daily by the scheduled billing tick, which marks lapsed invoices `overdue` first): recurring-only invoices, explicit settlement, custom-priced clients skipped                                                                                                    |
| GET `/errors`                                | office                          | grouped failure feed (§30): fingerprint, message, sources, occurrences, stores/head-offices hit, first/last seen                                                                              |
| GET `/errors/:fingerprint`                   | office                          | one fault with every occurrence behind it (entity, source, times, version, environment); 404 on an unknown fingerprint                                                                        |
| GET `/devices`                               | office                          | every configured till of every store (claimed or not) plus one entry per Head Office (§25); derived from roster + last telemetry, read-only                                                   |
| GET `/versions`                              | office                          | fleet build distribution (§32): version → stores/panels + environments + members, schema spread, most-deployed per environment; no minimum-supported policy (see tidbits)                       |
| GET `/deployments`                           | office                          | every orchestrated deployment across the fleet, newest first (§33, read-only) with a one-query step tally                                                                                     |
| GET `/deployments/:id`                       | office                          | one job with its steps — status, attempts, warnings, error; 404 on an unknown job                                                                                                             |
| POST `/billing/invoices/:id/email`           | office                          | **really sends** the invoice over the configured SMTP; 400 `smtp_not_configured` when the host is missing, 502 `mailer_failed` with the relay's reason; stamps `emailedAt`/`emailedTo` and audits (ok/failed) only on a relay that accepted it |
| GET/PUT `/settings`                          | office                          | the office's **own** settings singleton: identity, `invoiceDueDays`, `invoiceFooter`, the SMTP block; `smtpPass` masked on read and mask = unchanged on write; audited (`settings_updated`) |
| POST `/settings/test-email`                  | office                          | send a proof message (`to` optional → office email); 400 `smtp_not_configured` / 502 `mailer_failed`                                                                                          |
| GET `/health`                                | public                          | liveness (Coolify healthcheck)                                                                                                                                                                |

## Testing conventions

- **Two suites, explicitly.** `npm test` is the backend (jest + ts-jest +
  supertest, `src/__tests__/**/*.test.ts`); `npm run test:ui` is the frontend
  (`frontend/jest.config.cjs`, jsdom, `frontend/src/**/*.test.tsx?`); `npm run
  test:all` runs both. Three constraints worth knowing before adding a frontend
  test, all discovered the hard way: React is pinned to the app's copies in the
  config (the root install has its own, and two copies fail every render with
  "Invalid hook call"); jsdom has **no `fetch` and no `Response`**, so a network
  test assigns a mock and uses a minimal response stand-in; and a *page* under
  test cannot use `import.meta.env` (LoginPage does) unless it stops being
  compiled as CommonJS. Test files are excluded from `frontend/tsconfig.app.json`
  so the production build never needs Jest's types.
- jest + ts-jest + supertest against `:memory:` SQLite. `src/__tests__/
env-setup.ts` sets `CP_DB_PATH=':memory:'` + office env; `beforeEach`
  calls `resetRegistryDb()`; login helper in `helpers.ts`.
- Store calls are mocked via `jest.spyOn(globalThis, 'fetch')` (jest.mocked
  only casts types — it does not create mocks) returning canned `Response`s
  or network errors; `mockRestore()` per test.
- Add a regression test with every bug fix.

## Branch strategy & house notes

- `main` (production) · `staging` (release candidate — the Coolify staging
  resources track it; `prompts/production-cutover.md` §7 is the rehearsal) ·
  `dev` (integration) · `feat/*`; hotfixes from `main`. Promote `dev → staging`
  for the dress rehearsal, `staging → main` once it validates. Commit style
  `type(scope): description` (`feat(platform)`, `feat(ui)`, `fix(platform)`,
  `docs`, `chore`).
- Deploy: Coolify build pack "Dockerfile", `PORT` injected by Coolify,
  `CP_DB_PATH=/data/control-plane.db` (persistent volume), `OFFICE_ADMIN_*`,
  `JWT_SECRET` (≥32 chars), `HEALTH_SWEEP_INTERVAL_MINUTES` (default 10; 0 =
  manual sweeps only), `CP_TRUST_PROXY_HOPS` (proxy hops in front of the app;
  0 trusts none, which is the safe default when directly exposed),
  `BILLING_TICK_INTERVAL_MINUTES` (default 1440 = daily; 0 = manual renewals
  only), `MANAGED_ENDPOINT_SUFFIXES=.vula-app.co.za` (the approved deployment
  domain for store/panel URLs in production). Full playbook in `prompts/`.
- Seeded/dev credentials are demo-only; change before going live.
