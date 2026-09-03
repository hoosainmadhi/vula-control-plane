# Progress

Dated log of the build.

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
