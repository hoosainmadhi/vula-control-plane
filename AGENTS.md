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
npm test             # jest+supertest (in-memory registry, mocked fetch)
npm run typecheck    # backend tsc --noEmit
npm run build        # backend tsc + frontend production build
npm start            # run compiled dist/server.js (production)
npm run smoke        # boot smoke vs the dev store stub (API must be running)
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
│   │                      # devices.ts (fleet devices §25),
│   │                      # versions.ts (build distribution §32),
│   │                      # deployments.ts (job history §33, read-only)
│   ├── services/          # subscriptions (billing state + entitlements),
│   │                      # pricing (THE recurring calculator),
│   │                      # terminalLicences (purchase + allocations + caps),
│   │                      # billing (invoices/licences), licenceSigner,
│   │                      # storeClient, features, coolify, storeProvisioning,
│   │                      # clientOrchestrator, healthSweep,
│   │                      # fleetView (derived health/config state + devices)
│   ├── utils/             # logger, asyncHandler, validate, errors (HttpError),
│   │                      # rateLimiter
│   └── __tests__/         # env-setup.ts, helpers.ts + suites (*.test.ts)
├── scripts/
│   ├── dev-store-stub.ts  # stand-in tenant internal API until za-pos ships it
│   └── smoke-test.sh      # curl boot smoke against :3240 + stub :3299
├── frontend/              # React 19 + Vite + Tailwind v4 (own package)
│   └── src/
│       ├── api.ts         # fetch wrapper + token (localStorage 'zapos_cp_token')
│       ├── lib/money.ts   # cents → ZAR, price labels (one formatter, all screens)
│       ├── components/    # Layout, Modal, StatusBadge, Spinner, ErrorBox, cards
│       ├── pages/         # Clients (+wizard), ClientDetail, StoreDetail, Plans,
│       │                  # Billing, Companies (advanced), Panels (advanced),
│       │                  # Devices (§25), Versions (§32), Deployments (§33),
│       │                  # Errors (§30 feed)
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
- Money: none in this app (no prices stored here).

## Naming — two planes, two products

| Port | Name                   | Audience                                    |
| ---- | ---------------------- | ------------------------------------------- |
| 3240 | **Vula Control Plane** | The SaaS vendor. One instance, all clients. |
| 3260 | **Head Office**        | The merchant. One instance per merchant.    |

"Control plane" is the fleet-management layer and only the vendor app is one, so
do **not** write "SaaS CP" / "Multistore CP" — two names ending in CP keep the
ambiguity alive. See `CONTEXT.md` §2a.

## API surface (`/api` prefix, `{ error }` on failure)

| Method & path                                | Access                          | Purpose                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/auth/login`                           | public (rate-limited 20/15 min) | office session → `{ token, user }`                                                                                                                                                            |
| GET `/clients`, POST `/clients`              | office                          | client-first onboarding: wizard creates the company, its **subscription** (licensed terminals) and the deployment job                                                                          |
| GET `/clients/:id`                            | office                          | client detail + `subscription` block (plan, licensed/allocated, recurring amount, setup fee + status, per-store allocations)                                                                  |
| PUT `/clients/:id`                            | office                          | profile, plan, `licensedTerminalCount`, `allocations[]`, `setupFeeStatus`; re-pushes licences when the entitlement changes                                                                    |
| POST `/clients/:id/upgrade-to-multistore`     | office                          | §7 upgrade: deploys Head Office + a branch, keeps existing store data, and extends the licensed total                                                                                          |
| GET `/clients/jobs/:id`                       | office                          | deployment jobs (and their steps) for a client                                                                                                                                                 |
| POST `/clients/jobs/:id/retry`                | office                          | resume a failed deployment job without duplicating resources                                                                                                                                   |
| GET `/stores`                                | office                          | fleet list — company, plan, billing state, licensed vs configured terminals; never returns the token                                                                                            |
| POST `/stores`                               | office                          | create store + **allocate its licensed terminals** + first push and first licence; refuses a duplicate URL, a Head Office URL, and a client with no licensed terminals; a generated token is returned **once** |
| GET `/stores/:id`                            | office                          | detail: terminal preview Till 1..N + config snapshot + licensed allowance                                                                                                                      |
| PUT `/stores/:id`                            | office                          | name/vatRegNo-free/terminalCount/baseUrl/companyId/terminalNames (slug immutable; **no auto-push**); refuses configuring above the licence                                                       |
| PATCH `/stores/:id/pause` · `/resume`        | office                          | paused stores 409 push/reset-admin/licence                                                                                                                                                     |
| DELETE `/stores/:id`                         | office                          | **pause-first teardown**: 409 `store_active` while active; removes the registry row only, never the deployment                                                                                |
| POST `/stores/:id/push`                      | office                          | push `{terminalCount, terminals: Till 1..N}`; 402 if over the plan's till ceiling or the store's licence                                                                                       |
| POST `/stores/:id/health`                    | office                          | ping `GET /api/internal/status`, record up/down, refresh the licence                                                                                                                          |
| POST `/stores/:id/licence`                   | office                          | re-issue and deliver the signed licence (carries the store's `maxTerminals`)                                                                                                                  |
| POST `/stores/:id/reset-admin`               | office                          | store resets its admin pw; temp password shown once, never stored                                                                                                                             |
| GET `/stores/licence/key`                    | office                          | the public verification key stores install (never the private key)                                                                                                                            |
| GET/POST `/plans`, PUT `/plans/:id`          | office                          | plan catalogue: store cap, per-store terminal ceiling, features, `pricingMode` + `terminalPriceCents` + `customAmountCents` (a custom plan's agreed flat charge per period; 0 = per-invoice) + `setupFeeCents` + `billingPeriod`; code immutable; per_terminal needs a rate > 0       |
| GET `/plans/features`                        | office                          | the curated feature vocabulary (6 keys) plans may grant — validated on plan write; the store/head-office gates mirror it (L4)                                                                  |
| GET/POST `/companies`, GET/PUT/DELETE `/:id` | office                          | merchant accounts — the unit of billing and owner of the subscription; DELETE is 409 `company_in_use` while it owns stores or a Head Office; PUT accepts `licensedTerminalCount` + `setupFeeStatus` |
| GET/POST `/panels`, GET/PUT/DELETE `/:id`    | office                          | one Head Office per merchant; POST/DELETE are the registration only                                                                                                                           |
| GET `/panels/licence/key`                    | office                          | as `/stores/licence/key`                                                                                                                                                                      |
| POST `/panels/:id/health`                    | office                          | ping the panel's own `/api/internal/status`, record health + version                                                                                                                          |
| POST `/panels/:id/licence`                   | office                          | re-issue and deliver the company licence to a panel                                                                                                                                           |
| GET/POST `/billing/invoices`                 | office                          | invoices with their pricing evidence (`terminalCount` × `terminalPriceCents`, `setupFeeCents`); an amountless invoice for a custom-priced client is 400 `custom_pricing_requires_amount`       |
| POST `/billing/invoices/:id/pay` · `/cancel` | office                          | settlement (advances `paid_through`, marks the onboarding charge paid, re-pushes licences) / cancel                                                                                            |
| POST `/billing/renew-check`                  | office                          | renewal sweep: recurring-only invoices, explicit settlement, custom-priced clients skipped                                                                                                    |
| GET `/errors`                                | office                          | grouped failure feed (§30): fingerprint, message, sources, occurrences, stores/head-offices hit, first/last seen                                                                              |
| GET `/errors/:fingerprint`                   | office                          | one fault with every occurrence behind it (entity, source, times, version, environment); 404 on an unknown fingerprint                                                                        |
| GET `/devices`                               | office                          | every configured till of every store (claimed or not) plus one entry per Head Office (§25); derived from roster + last telemetry, read-only                                                   |
| GET `/versions`                              | office                          | fleet build distribution (§32): version → stores/panels + environments + members, schema spread, most-deployed per environment; no minimum-supported policy (see tidbits)                       |
| GET `/deployments`                           | office                          | every orchestrated deployment across the fleet, newest first (§33, read-only) with a one-query step tally                                                                                     |
| GET `/deployments/:id`                       | office                          | one job with its steps — status, attempts, warnings, error; 404 on an unknown job                                                                                                             |
| GET `/health`                                | public                          | liveness (Coolify healthcheck)                                                                                                                                                                |

## Testing conventions

- jest + ts-jest + supertest against `:memory:` SQLite. `src/__tests__/
env-setup.ts` sets `CP_DB_PATH=':memory:'` + office env; `beforeEach`
  calls `resetRegistryDb()`; login helper in `helpers.ts`.
- Store calls are mocked via `jest.spyOn(globalThis, 'fetch')` (jest.mocked
  only casts types — it does not create mocks) returning canned `Response`s
  or network errors; `mockRestore()` per test.
- Add a regression test with every bug fix.

## Branch strategy & house notes

- `main` (production) · `dev` (integration) · `feat/*`; hotfixes from `main`.
  Commit style `type(scope): description` (`feat(platform)`, `feat(ui)`,
  `fix(platform)`, `docs`, `chore`).
- Deploy: Coolify build pack "Dockerfile", `PORT` injected by Coolify,
  `CP_DB_PATH=/data/control-plane.db` (persistent volume), `OFFICE_ADMIN_*`,
  `JWT_SECRET` (≥32 chars). Full playbook in `prompts/`.
- Seeded/dev credentials are demo-only; change before going live.
