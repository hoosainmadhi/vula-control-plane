# Progress

Dated log of the build.

## 2026-09-06 — fleet phase set planned (F1–F3, no code)

- Owner asked to start the control plane and all stores. Fleet verified
  from the registry DB: 5 stores — brake-bolt-spares (spares, 3 tills),
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
