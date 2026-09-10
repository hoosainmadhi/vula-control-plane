# Vula Control Plane

Office panel for the Vula fleet: one store = one Vula Coolify deployment
(own SQLite DB). This app keeps the store registry, pushes terminal
configuration (`Till 1..N`) to each store's internal API, checks store health
and can reset a store's admin password. House control-plane pattern (see
`~/apps/common-files/CONTROL-PLANE-SPEC.md`; reference implementation
`~/apps/optimed-control-plane`).

**Scope:** the fleet registry, terminal provisioning, and **subscription
licensing**. Concretely:

- **Stores** — register a deployment, push `Till 1..N`, health-check it, reset its
  admin password, and tear it down (pause-first).
- **Companies** — the merchant account, and the unit of billing. It owns its branch
  stores *and* its Head Office, and holds the plan and the paid-up-to date.
- **Plans** — a store-count cap, a per-store terminal ceiling, a feature set, and a
  price with its recurrence (`monthly` / `annual` / `once-off`). Four tiers are
  seeded and every value is editable; operators can add their own.
- **Head Offices** — one per merchant. The control plane deploys, monitors and
  licences it and never reads inside it. See the privacy boundary in `CONTEXT.md` §2a.
- **Licences** — the control plane signs them (ES256/P-256) and stores or panels
  verify with the public key. Entitlement is real, and works offline.

Billing *recording* (invoices/payments) is not built — `paid_through` is set by hand
today. The store side of the internal API (`/api/internal/*`, guarded by a per-store
`CONTROL_PLANE_TOKEN`) follows the contract in `CONTEXT.md` §4 and ships in za-pos;
`scripts/dev-store-stub.ts` remains a dev stand-in.

## Naming

`:3240` is the **Control Plane** (yours, one instance, all clients). `:3260` is the
merchant's **Head Office** (one per merchant). Avoid "SaaS CP" / "Multistore CP" —
two names ending in CP is what makes them confusable.

## Stack

Node 22 + Express 4 + better-sqlite3 (registry DB `data/control-plane.db`,
WAL) · TypeScript strict ESM · React 19 + Vite 8 + Tailwind v4 (CSS-first) ·
jest + ts-jest + supertest. Local ports **3240 (API) / 3241 (frontend dev)**
— block 3240–3249 in the house port registry.

## Quick start

```bash
cp .env.sample .env          # office admin defaults: admin@za-pos.local / temp123
npm install && (cd frontend && npm install)
npm run dev                  # API :3240 + SPA :3241 (http://localhost:3241/login)
```

Try it end to end against the dev store stub:

```bash
npm run stub                 # tenant internal API stand-in on :3299
# in another shell:
npm run dev:api
bash scripts/smoke-test.sh   # login → create store vs stub → push → health → …
```

## Commands

| Command                              | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| `npm run dev` / `dev:api` / `dev:ui` | Concurrent dev / API only / UI only                        |
| `npm test`                           | 38 jest+supertest tests (in-memory registry, mocked fetch) |
| `npm run typecheck`                  | backend tsc --noEmit                                       |
| `npm run build`                      | backend tsc + frontend production build                    |
| `npm start`                          | run `dist/server.js` (production)                          |
| `npm run stub`                       | dev store stub on :3299                                    |
| `npm run smoke`                      | curl boot smoke (needs API + stub running)                 |

## Environment variables

| Variable                   | Default                   | Notes                                                |
| -------------------------- | ------------------------- | ---------------------------------------------------- |
| `PORT`                     | 3240                      | Local dev; Coolify injects its own in production     |
| `CP_DB_PATH`               | `./data/control-plane.db` | Fallback chain `CP_DB_PATH` > `DB_PATH`              |
| `OFFICE_ADMIN_EMAIL`       | `admin@za-pos.local`      | Production refuses to boot without it                |
| `OFFICE_ADMIN_PASSWORD`    | `temp123`                 | Dev default; production refuses placeholders         |
| `JWT_SECRET`               | dev default               | ≥ 32 chars in production (`openssl rand -base64 64`) |
| `JWT_TTL_HOURS`            | 168                       | Office session length                                |
| `STORE_REQUEST_TIMEOUT_MS` | 5000                      | Per-call timeout against stores                      |
| `LOG_LEVEL`                | info                      | debug/info/warn/error                                |

## API (see `AGENTS.md` for the full table)

`POST /api/auth/login` (office, rate-limited) · `GET|POST /api/stores`
(create with an optional `controlPlaneToken` matching the store's env — blank
generates one — then attempts a first push) · `GET|PUT /api/stores/:id`
(detail incl. terminal preview; PUT never auto-pushes) · `PATCH
/api/stores/:id/pause|resume` · `POST /api/stores/:id/push|health|reset-admin`
(reset-admin returns a one-time temp password the store generated; it is
never stored). Errors are always `{ error }`. The per-store
`control_plane_token` never leaves the server.

## Testing

Backend: jest + ts-jest ESM + supertest against `:memory:` SQLite; store
calls mocked via `jest.spyOn(globalThis, 'fetch')`. Tests live in
`src/__tests__/`.

## Deploying

Deploy the control plane itself on Coolify: build pack **Dockerfile**, set
`CP_DB_PATH=/data/control-plane.db` with a persistent volume at `/data`, and
the office/JWT env vars. Deploying a **store** (with its
`CONTROL_PLANE_TOKEN`) and onboarding it here is a manual runbook — see
[`prompts/deploy-coolify-control-plane.md`](prompts/deploy-coolify-control-plane.md).

## Layout

See `AGENTS.md` — root backend + nested `frontend/`; the registry DDL lives in
`src/config/registryDb.ts` (mirrored in `schema.sql`); the tenant internal-API
client is `src/services/storeClient.ts`; the wire contract is CONTEXT.md §4.

## Related repos

- `~/apps/za-pos` — the per-store POS product (tenant side of the contract)
- `~/apps/optimed-control-plane` — reference control-plane implementation
- `~/apps/port-management-app` — house port registry (3240–3249)
