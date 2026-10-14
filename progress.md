# Progress

## 2026-10-11 — launch hardening: both review P0s and the code-level P1s, all verified

`review-10October2026.md` (conditional NO-GO for paid launch) verified claim by claim,
then built under the owner's approved scope. P0s first: `redirect: 'error'` on every
privileged outbound fetch with cause-chain-aware errors and a real-server regression
suite (`redirectPolicy.test.ts`, 8 tests); `vula-backup.sh` hardened to the store app's
standard (per-copy integrity + schema verification, images archived, 7-copy floor,
off-host warning, env-overridable roots) and runtime-verified on a scratch fleet — 16/16
checks including corrupt-source and flipped-page aborts. P1s: `/health` queries the
registry DB (503 when it cannot; `health.test.ts`), production boots refuse an empty
`MANAGED_ENDPOINT_SUFFIXES` (`productionBoot.test.ts` boots the real env gate in a child
process), the settlement double-pay case is pinned in `settlement.test.ts`, and the
office session TTL default is 24h. `.env.sample` updated for both the allowlist and the
TTL.

**Verification (all executed):** `npm run typecheck` clean; backend jest **401/401
across 33 suites** (14 new tests: 8 redirect, 2 health, 3 production boot, 1 settlement
double-pay); frontend 24/24; `npm run build` exit 0; prettier clean on touched files.
Nothing committed — owner tests first, per house rule. Deferred with reasons in this
repo's `tidbits.md` and the za-pos one: MFA, Redis rate limiting, DNS pinning, mandatory
off-host enforcement, restore rehearsal.

## 2026-10-03 — production is live: vula-cp-prod deployed, healthy, clean, logins verified

Owner: _"secrets done"_ — the production licence keypair, JWT secret and admin
password saved to the password manager and passed file-to-file (`~/Notes/
vula-prod-*.txt`), with the office email confirmed as hello@vula-app.co.za.

- **`vula-cp-prod` deployed end to end through the Coolify API** (uuid
  `yx3ntdoau1qhula5i3mr7wpz`, project vula-control-plane, environment
  production): built from `main` on
  `https://vula-cp-mzsza-2026.vula-app.co.za`, 18 env vars (production
  NODE_ENV, the **production** lease keypair, `MANAGED_ENDPOINT_SUFFIXES`,
  `CP_TRUST_PROXY_HOPS=1`, `COOLIFY_PROJECT_UUID` → vula-tenants, the tenant
  repo pinned to vula-app.git), named volume `vula-cp-prod-data` at /data.
- **Verified live:** `/health` ok over TLS, login ok, **registry clean per
  D2** (0 clients, 0 stores), office name at the seeded default pending the
  owner's real identity in Settings.
- **The rehearsal's dividend:** every failure mode this deploy could have hit
  had already been hit and fixed in staging — the 4.3.23 payload changes, the
  repo default, the GitHub App grant, the env-var masking — so production
  deployed first time, healthy, with zero surprises.
- The nightly backup picks up the production volume automatically
  (`-vula-cp-prod-` matches the cp bucket). Restore drill passed the day
  before on the staging backup.
- **Remaining for the first real client (owner, the flow they've done
  twice):** Settings with the real legal identity + production SMTP + test
  email; check the 8-plan catalogue; first store Part A/B; first client
  through §8. Parked: pause-as-kill-switch.

## 2026-10-02 (night) — names are provisioned, the till warns before checkout, and the licence hole got its teeth

Owner reports from driving the rehearsal stores: _"single store should not
have the menu item Head Office"_ (done — tenant `51fd5a9`), _"Paused
Rehearsal Two North -> but can still access POS and ring up sale"_,
_"why is Store name 'Vula Store' for all stores?"_, _"I think we need a
popup"_ for the suspension refusal, and the rehearsal's biggest catch: a sale
rang up on a **suspended** client's store.

- **The licence enforcement hole (tenant `e4b94ff`):** the CP signs
  `billingState` into every licence, but the tenant's acceptance path
  flattened it — a null paid-period mapped to _active_ ("no billing
  configured" — a pre-redesign assumption), and the paid path never consulted
  manual suspension. Fixed: the signed state is the authority for suspension;
  the date math refines active↔past_due only. The stores rebuild into
  enforcement — client 2's tills now **hard-block** sales until the money
  sequence, with the popup below on screen.
- **The suspension popup (tenant `3917ff7`):** the checkout refusal text is
  now one constant (`SUSPENDED_SALES_MESSAGE`) shared by the checkout 402 and
  the till's modal — the register warns before the first ring-up, dismissible
  for the shift, reappearing until the account is settled. Exposed via
  runtime-config (`subscription.suspendedMessage`) so the two cannot drift.
- **Store names are provisioned (CP `1a2fcfb` + tenant `3917ff7`):** the
  configure payload carries the registry `name` (a wire-contract change —
  CONTEXT.md updated on both sides, payload assertions pinned in both test
  suites); the tenant applies it to its own `store_name`. Dev's names had
  come from seed scripts; production now gets them from provisioning. The
  three rehearsal stores were re-pushed and report their real names — North
  was resumed, pushed and **re-paused**, preserving the owner's pause test.
- Fleet state after the rebuilds: all four tenant containers and the CP
  healthy; client 1's store trading with its name; client 2 suspended with
  the popup live.

## 2026-10-02 (evening) — the outlet's login goes out by email, and the store row finally keeps its admin address

Owner: _"go ahead - no forced change in PW"_ — the credentials email is a
feature, and the tenant confirmed the temp password works until changed (no
forced first-login reset), which makes the delivery the credential itself.

- **The row dropped the address.** The wizard sends `adminEmail` per store, the
  create route read it, threaded it into provisioning metadata — and never
  wrote the `admin_email` column. Every bootstrap and every credential email
  was being refused at the `if` that guards on that column. Fixed at both
  creation sites (route + orchestrator) via `createStore`'s new `adminEmail`
  field; the frontend's multi-store branch now defaults each branch's address
  from the client's billing email, matching the single-store and Head Office
  paths (the rehearsal's stores got none because it didn't).
- **Delivery is best-effort everywhere a bootstrap or reset happens**: the
  orchestrator's store and Head Office steps, the background provisioning
  runner, and the Admin-password route. SMTP unconfigured or the relay
  refusing degrades to a step warning or a response field — never a failure —
  and the operator re-issues via the reveal-once action. `mailer.ts` gains
  `sendAdminCredentialsEmail` (the outlet-facing login, signed off with the
  office's name) and `trySendAdminCredentialsEmail` (the swallow-to-outcome
  wrapper). The reset route reports `emailedTo` / `emailError`; the modal
  shows which happened. The password passes through to the message body only —
  still never stored (new `credentialEmail.test.ts`, 3 tests).
- **§10's backup script now discovers volumes by name** — since 4.3.23 refuses
  API bind mounts, API-created databases live under
  `/var/lib/docker/volumes/<app-uuid>-<name>/_data`; the storage names carry
  the slug, so the globs stay readable. The host-tree loop remains for
  deployments given manual UI bind mounts.
- Owner's data-loss worry answered from the session's own evidence: the
  staging CP was redeployed four times today and its registry survived every
  one — named volumes persist across redeploys; only deleting and re-creating
  an application yields a fresh volume (and the old one stays on the host).
  Tests: backend **355 green (28 suites)**, frontend **22 green**, typecheck
  and the production build clean. Commit `33326b5`.

## 2026-10-02 (later) — the full §7 rehearsal sequence ran green end to end

Owner: _"github grant done"_. Job 1 resumed at `head_office_deploy` and, after
two more truthfully-failed retries, completed all seven steps.

- **The grant worked; the retry proved no-duplicate resumption.** The Head
  Office and store 1 applications were not re-created; only the failed/pending
  steps ran. Containers built (`vula-ho-rehearsal-retail-ho`,
  `za-pos-rehearsal-retail-1/2`, all `running:healthy` in ~12 minutes).
- **The entitlement gate fired mid-rehearsal, correctly.** Store 2's deploy was
  refused 402: the wizard had onboarded the client licensed for **2** terminals,
  and store 1 had taken both. Raised the subscription to 4 (`PUT /clients/1`),
  retried, store 2 deployed. The 402 message named the remedy exactly as
  designed.
- **`wire_topology` failed while the containers built — truthfully.** The step
  refused to fake success against unreachable stores; once the containers were
  healthy the retry wired both branches. Initial config pushes are best-effort
  warnings (the sweep/manual push recovers), wiring is a required step.
- **§8 walked as designed, on two invoices.** The wizard had raised the
  once-off itself (`VULA-2026-000001`, purpose `onboarding`, R2 000) — so the
  `initial` invoice correctly carried only the subscription (R600). Both
  settled: the onboarding payment `periodAdvanced=False` (it never moves the
  period), the initial payment `True` — **client `active`, paid through
  2026-11-02**, licences re-pushed on settlement.
- **§6 verification green:** both stores `lastHealthStatus: up`,
  `registerState: ok`, `tradingBlocked: false`, 2 tills each, config pushed
  (Till 1..2), licences accepted (sequence 6). Note for tidbits: completed
  steps retain the previous attempt's `error` text after a successful retry —
  stale display data to clean (clear `error` when a step completes).

## 2026-10-02 — the rehearsal earned its keep: two payload fixes, one permissions gate

Owner: _"ran the wizard. nothing happening on coolify"_ — the first §7 rehearsal
onboarding, which failed truthfully at `head_office_deploy` and surfaced three
real defects in one run.

- **Rehearsal step 1 closed.** Settings persisted (office identity, 14-day
  terms, VAT 15%, Zoho SMTP working — my first flat read of GET /settings was a
  false negative: the block nests under a `settings` key). Registry verified
  clean per D2: 0 stores, 0 clients, 8 plans.
- **4.3.23 bit twice more.** The wizard's `head_office_deploy` failed on the
  same validation class I hit creating the CP resource: `dockerfile_location`
  must be a **path** (`/Dockerfile`, `/head-office/Dockerfile`) — the bare
  filename forms `deployFromSpec` still sent are refused. Fixed, and Coolify's
  422s now carry their failing field names in the step error instead of a bare
  "Validation failed." (commit `25b15d7`).
- **The repo default named a repo that does not exist.** The tenant's GitHub
  repo is `hoosainmadhi/vula-app` (local clone ~/apps/za-pos); the CP's
  `ZA_POS_REPO_URL` default pointed at `hoosainmadhi/za-pos.git`, so every
  create died with "Repository not found or not accessible by the GitHub App."
  Fixed the default, pinned `COOLIFY_ZA_POS_REPO_URL` on the staging resource,
  and the orchestration suite now records create bodies and asserts both the
  repo and the `/`-prefixed dockerfile paths (commit `39e91df`).
- **Still gating: the GitHub App's repo grant.** A throwaway create straight
  from `vula-app.git` fails identically, so the inherited app
  (`digicure-githubapp` — optimed's, borrowed with the rest of its `COOLIFY_*`
  config) holds `vula-control-plane` but not the tenant repo. Owner grants it
  in GitHub, then job 1 retries — the wizard's resume path keeps the
  company/subscription rows and re-runs the failed step.
- Tenant `main` verified current (5c27eca, all branches aligned) with the §1
  fail-open gates present; `head-office/Dockerfile` and the root `Dockerfile`
  both exist for the two provisioning paths. Tests **352 green (27 suites)**;
  typecheck clean.

## 2026-10-01 (later) — the staging control plane is live

Owner: _"look at .env in ~/apps/optimed-control-plane"_ — the Coolify
credentials, which opened the whole staging build.

- **Stood up entirely through the API.** The five `COOLIFY_*` settings were
  merged from optimed's `.env` into this repo's (file-to-file, no secret
  printed); `npm run probe` connected (Coolify **4.3.23**). Following the house
  project split, `vula-control-plane` and `vula-tenants` projects were created,
  and the staging CP application `vula-cp-staging` built from the `staging`
  branch with the §4/§7 env block — production `NODE_ENV`, its own staging
  JWT/admin/lease secrets (generated to a chmod-600 /tmp file for the password
  manager, never printed), `MANAGED_ENDPOINT_SUFFIXES`, `CP_TRUST_PROXY_HOPS=1`,
  and `COOLIFY_PROJECT_UUID` pointed at `vula-tenants` so wizard onboarding
  provisions stores into the tenants project. First deploy:
  **`https://staging-cp.vula-app.co.za/health` answers ok over real TLS** —
  rehearsal step 1 done, and D2's clean registry holds (fresh volume).
- **Coolify 4.3.23 refuses API-created bind mounts, and the client now says
  so.** `deployFromSpec`'s `host_path` storage POST — the per-client host tree
  §10's backup script assumes — is refused 422 on this API version. The fix
  tries the host path first and falls back to a named docker volume (the only
  API-accepted persistent form), pinned by a new orchestration test.
  Consequence: API-created databases live under
  `/var/lib/docker/volumes/<name>/_data`, not `/data/apps/vula-app/...` — §10
  amended. Also new since 4.3.10: `dockerfile_location` wants `/Dockerfile`.
- **Merging the credentials into `.env` broke two upgrade tests — the suite
  was inheriting the operator's environment.** `config/env.ts` runs dotenv at
  import, after jest's `setupFiles`, so with real `COOLIFY_*` keys present the
  provisioning paths flipped to live calls against mocks that answer no uuid.
  `env-setup.ts` now pins the five to empty strings (dotenv never overrides an
  existing var), leaving `configureCoolify` in charge where Coolify is under
  test. The suite is hermetic against the operator's `.env` again.
- Both fixes committed (`3d80647` fallback, `05f457f` hermetic env), pushed to
  `dev` and fast-forwarded to `staging`; the CP redeployed with them. Tests
  **351 green (27 suites)**; typecheck clean.

## 2026-10-01 — cutover prep: the promotion was already on the remote, and the gate holds with the unowned hunk

Owner: _"ok so continue"_ then _"carry on"_ — proceeding with the repo-side half
of the cutover order (everything after it is Coolify/host work).

- **All three branches already carry everything.** `origin/main`,
  `origin/staging` and `origin/dev` are all at `132ccc3` — the two docs commits
  rode onto `main` and `staging` outside this session (an earlier check in the
  same conversation had `main` two docs commits behind; the remote moved between
  that check and the fetch). Nothing was pushed here: the only local action was
  `fetch origin staging:staging`, which fast-forwarded the stale local
  `staging` branch (it sat at `1aadb92`, one behind its own remote). §2 of the
  cutover plan is therefore done — production deploys `132ccc3`, the reviewed
  code with the current runbook.
- **The gate holds on the working tree, hunk included.** `tsc --noEmit` clean
  and the backend suite **350 green (27 suites)** with the uncommitted
  `companies.ts` hunk in place — it breaks nothing observable. It remains
  unreviewed, untested and uncommitted (plan PUT → auto-push licences to active
  companies on that plan); the commit-or-drop decision is still open, and until
  it is made it cannot reach a deployment — which it can't, being uncommitted.
- **The probe has no credentials here.** `.env` carries no `COOLIFY_*` keys, so
  `npm run probe` cannot run from this machine yet — it wants
  `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_PROJECT_UUID`,
  `COOLIFY_SERVER_UUID`, `COOLIFY_GITHUB_APP_UUID`. Running it before anything
  depends on provisioning is the point of it: a wrong API URL should surface as
  a probe failure, not as a failed store deployment mid-onboarding.
- Next is the host court: `*.vula-app.co.za` wildcard DNS live before any
  registration, secrets per §4 (a **separate licence keypair for staging** —
  the rehearsal must not share the production trust root), the three staging
  resources, and the §7 rehearsal in order.

## 2026-09-30 — the optimed comparison, and a Coolify probe

Owner: _"go ahead"_ on the CP `dev → main` promotion (done — `origin/main` at
`d19016f`, fast-forward, 11 commits / 57 files) and _"look at
~/apps/optimed-control-plane to see coolify integration"_.

- **Comparison:** optimed's client wraps the whole lifecycle (stop/start/
  restart, domain read/update, delete, probe, manual-onboarding instructions);
  this repo's does creation and deploy for two application types from one repo,
  with the lease public key injected and a per-client volume layout. Each has a
  half the other lacks; the lifecycle half is recorded in tidbits as a product
  decision (does pausing a store stop its container?), not cleanup.
- **Adopted:** `probeCoolify` + `scripts/coolify-probe.ts` + `npm run probe` —
  verifies the Coolify API URL, token and UUIDs against the real instance
  before anything depends on provisioning. Four tests (missing config, plain-
  text version, HTTP refusal, network failure).
- Two harness lessons from the probe tests: the "missing configuration" case
  deleted the COOLIFY_* variables for the whole process, so the tests after it
  ran with no config (fixtures that mutate process.env must restore), and
  `scripts/coolify-probe.ts` called the repo logger's `error` with two
  arguments where it takes one.

## 2026-09-25 — Pass 4 (continued): the frontend suite exists

## 2026-09-25 — Pass 4 (continued): the frontend suite exists

Owner: _"go ahead with next task"_. The review's §27 — frontend coverage was
effectively zero.

- **Harness:** `frontend/jest.config.cjs` on jsdom, through the repo's existing
  Jest rather than a second toolchain (two new dev dependencies:
  `jest-environment-jsdom`, `@testing-library/react`). `npm test` stays the
  backend suite; `npm run test:ui` is the frontend; `npm run test:all` is both
  (365 tests). Test files are excluded from `frontend/tsconfig.app.json` so the
  production build never needs Jest's types.
- **Three suites, 22 tests:** the money formatter (`rand`'s em-dash for a missing
  amount, `toCents` never returning a float, and the price label that says
  _incl. VAT_); the `api` wrapper (bearer header from the token store, body
  serialisation, `ApiError` carrying the server's own message); and
  `StoreFormModal` (edit prefill, the credential field that starts empty and
  never echoes a stored token, the payload it emits — untouched fields included —
  and the disabled-while-saving guard).
- Two things the harness had to solve, both recorded in AGENTS.md: React is
  pinned to the app's copies (the root install has its own, and two copies fail
  every render with "Invalid hook call"), and jsdom provides no `fetch`/`Response`,
  so a network test assigns a mock and a minimal stand-in rather than spying.
- Deliberately deferred (tidbits): page-level behaviour tests — the
  invoice-create modal's purpose rules, the Record-payment outcome copy, the
  destructive confirmations — because a page test also needs `import.meta.env`
  handled, and those pages are monolithic.

## 2026-09-25 — Pass 4: the daily billing tick, and nested onboarding payloads

## 2026-09-25 — Pass 4: the daily billing tick, and nested onboarding payloads

Owner: _"go ahead with next task"_. The review's §19 and §22.

- **`overdue` finally gets written.** `markOverdueInvoices` flips `pending`
  invoices whose due date has passed — the status had been in the schema, the UI
  and the sweep's unpaid filter since v1 with nothing setting it.
- **A daily billing tick** (`BILLING_TICK_INTERVAL_MINUTES`, default 1440, 0
  disables) marks overdue invoices and runs the renewal sweep, so "automatic
  renewal" is a mechanism rather than a line of copy. It never settles anything —
  only an explicit settlement moves `paid_through`, pinned by a test.
- **One scheduler implementation.** `startScheduledTask` owns the
  skip-don't-queue and nothing-at-boot guards; the health sweep delegates to it
  and its six existing tests passed untouched.
- **Nested onboarding payloads are validated, not cast.** The wizard's `stores[]`
  and `headOffice`, and the upgrade route's `headOffice`, now go through the same
  helpers as the single-store routes: slug, terminal counts, base URL shape and
  address policy, admin email. The wizard's nested `baseUrl` had bypassed the
  Pass 2 trust boundary entirely, and a non-array `stores` was a 500. Onboarding
  keeps one deliberate exception — `allowUnreachable`, because rows are raised
  before containers exist — and probes only operator-supplied URLs.

Tests CP **343 green (26 suites)** — 15 new (tick and payload validation);
typecheck, frontend build and the dist check clean.

Remaining from the review: **frontend test coverage** (§27, needs tooling) and the
`registryDb.ts` split (§26, deferred to the next schema change).

## 2026-09-25 — Pass 2 of the production review: the trust boundary

## 2026-09-25 — Pass 2 of the production review: the trust boundary

Owner: _"push / move on to phase 2"_. The review's §8, §9, §12 and §13 — the
outbound-call and login surfaces.

- **One managed-endpoint policy, everywhere.** `requireBaseUrl` (shape) plus
  `assertManagedEndpoint` (DNS resolution + identity) now back store create,
  store edit, Head Office create and Head Office edit. The two edit routes had
  no probe at all, so a row could be repointed at an attacker's host and the
  next licence push would carry the store's token there — that is the hole
  this closes.
- **Production address policy:** `https` required, and private / loopback /
  link-local / CGNAT / metadata addresses refused as literals _and_ as
  resolution results; metadata hostnames and internal suffixes refused. An
  unreachable URL is refused in production too (the token leaves on the first
  push) but still allowed in development, where the fleet is loopback and rows
  precede containers.
- **Proxy-aware login limiter:** `CP_TRUST_PROXY_HOPS` (default 0 — ignore
  `X-Forwarded-For` entirely), enforced per address _and_ per account, with a
  refused request no longer extending the window, and expired buckets swept.
- **Dev credentials hint** behind `import.meta.env.DEV`, and `npm run build`
  now fails if it survives minification (`scripts/check-dist.mjs`).
- **The approved-domain allowlist is implemented** (`MANAGED_ENDPOINT_SUFFIXES`,
  production only): with `.vula-app.co.za` set, `https://attacker.example` is
  refused outright even if it identifies as Vula. The owner confirmed the domain,
  which is what this needed.
- Residual, recorded in tidbits: the limiter is per-process (a restart clears
  it, two replicas do not share it), and DNS resolution and the later fetch are
  independent (a fast rebind is not caught without pinning the resolved IP).

Tests CP **328 green (25 suites)** — 18 of them new in
`managedEndpoint.test.ts`; backend typecheck, frontend `tsc -b`, the
production build and the new dist check all clean. Verified on a copy of the
live registry booted with `NODE_ENV=production`: all seven refusals fire with
the specific rule named. Live registry untouched.

## 2026-09-25 — Pass 3 of the production review: client lifecycle

Owner: _"lets go ahead with pass 3"_. Four items, each verified against the
review's claim before being fixed:

- **Company delete blocks on financial history** — `companyBlockers` now counts
  invoices; 409 `company_in_use` names the retention rule when it is the money
  that blocks; a successful delete (a row that never transacted) is audited
  `company_deleted`.
- **`updateCompany` presence-flag semantics** — absent = unchanged, explicit
  null = clears; the old COALESCE could never clear `plan_id`, `paid_through`
  or `trial_ends_at`.
- **Atomic client/company edits** — the whole PUT in one transaction, the
  licence push outside it; a refused allocation no longer leaves a half-applied
  edit behind an error message.
- **Pause-first panel teardown** — `DELETE /panels/:id` 409 `panel_active`
  while active; `PUT` validates `status`; Pause/Resume beside Remove on the
  Head Office tab and the Panels page.

Caught and fixed mid-pass: `db.transaction(fn)` returns a wrapper — the two new
transactions were assigned and never invoked, so the routes silently did
nothing until five tests failed at once (findings, pass 3 entry). The house
pattern was already in `billing.ts`.

Tests CP **310 green (24 suites)**; backend typecheck, frontend `tsc -b` and
the production build clean. Verified on a copy of the live registry: an atomic
edit rolls the name back on a refused allocation; `paidThrough: null` clears and
derives `suspended` with the activation note; panel delete is 409 → pause →
delete; a company with 2 invoices is blocked with `blockers.invoices: 2`. Live
registry untouched. Pass 2 (URL/SSRF, proxy-aware limiter, login dev-hint gate)
remains queued.

## 2026-09-25 — Pass 1 of the production review: settlement → entitlement

Owner: _"see attached and advise"_ on `review-23Sep2026.md`, then _"continue with
Phase 1"_ after "we are only on dev at the moment so testing". Every P0 claim in
the review was verified against the code first; all checked out.

- **Settlement is purpose-gated.** Only `initial`/`renewal` advance
  `paid_through`; `onboarding`, `manual` and `pro_rata` settle their own debt.
  `purpose` is now a persisted column (backfilled where derivable, `initial`
  otherwise) and returned by GET — previously it vanished after creation even
  though AGENTS.md documented it.
- **Amount honesty:** the recorded amount must equal the invoice total
  (`payment_amount_mismatch` otherwise); zero/negative refused. An omitted amount
  still means the full invoice.
- **Transactional settlement:** payment + invoice + setup-fee state + paid period
  in one `db.transaction`, audited `invoice_settled`; the licence push stays
  outside, failures recorded for the sweep.
- **Strict state machine:** `deriveBillingState` order is now manual suspension →
  paid period (active/grace/suspended) → trial (running) → suspended. An expired
  trial and a never-paid client derive **suspended**; the old `active` fallback
  is gone. On a copy of the live registry this flips 8 of 11 clients to
  `suspended` — the honest answer, and safe because the fleet is dev-only.
- **Licence recovery in the sweep:** re-delivers when the last push failed or the
  licence is past half its offline window; never pushes to a store that did not
  answer; panels recovered the same way. Makes CONTEXT's "the next sweep retries"
  true for the first time.
- **Production gate:** boot refuses `BILLING_SIMULATE_RENEWAL_SETTLEMENT=true`
  when `NODE_ENV=production` (verified: exit 1 with a FATAL line).
- **Custom-client renewals** are now explicit: the create modal asks whether a
  hand-priced charge bills the period (default: no). This was the flow that would
  have silently broken had the gate shipped without it.

Tests CP **302 green (24 suites)** — new `settlement.test.ts` (17) and
`healthSweep.test.ts` (5), plus fixture updates whose companies are now paying
clients by default. Backend typecheck, frontend `tsc -b` and the production build
clean. Verified on a copy of the live registry: settling Urban Threads'
onboarding invoice leaves `paid_through` NULL and the client suspended; settling
Brake & Bolt's initial invoice advances to 2026-10-28, activates the client and
delivers 1 licence with 0 errors. The live registry itself was untouched.

Doctrine: CONTEXT §2b (register states) and §5e (settling).

## 2026-09-17 — the health sweep runs on a timer

## 2026-09-17 — the health sweep runs on a timer

Owner: _"ok go ahead"_ after the recommendation list — the first item (land the tree)
is committed, and this is the first piece of item three: making the panel stop
answering "is the fleet okay" from an old probe.

- **The measurement that justified it:** the live registry said **64 of 64 stores
  `up`** — statuses recorded when each was deployed. A real sweep of that same fleet
  immediately afterwards found **15 up and 49 down**. The panel was not reporting the
  fleet, it was reporting history. Every store in the registry showed a green light
  while two thirds of them are unreachable.
- **`services/sweepScheduler.ts`** runs `healthSweep` every
  `HEALTH_SWEEP_INTERVAL_MINUTES` (default 10, `0` = manual only), started from
  `server.ts` next to `listen`. The manual `POST /api/stores/health-sweep` stays.
- **Two guards, both tested:** a tick is _skipped, not queued_, while a sweep is
  still in flight (verified by removing the guard — the test then shows three
  overlapping sweeps); and the first sweep is one interval after boot rather than at
  boot, so a restart loop cannot hammer the fleet. A sweep that throws logs and the
  next tick is the retry.
- **Measured cost:** a full sweep of the real fleet (64 stores + 6 panels, most
  unreachable) completes in well under a minute, so a ten-minute interval is
  comfortable.
- Verified by booting against a copy of the live registry: the log line appears, the
  sweep completes with `19 up, 51 down across 64 stores & 6 panels` (15 stores + 4
  panels up), latency is recorded for the reachable ones, and the **live registry was
  untouched** — it still reads 64/64 `up`, which is precisely the lie this fixes.
- Tests CP **280 green (22 suites)**. Doctrine: CONTEXT §3.

## 2026-09-17 — a client's stores, in name order

Owner: _"CP - clients - put stores in alphabetical order."_

- **Sorted at the source, not in the card.** The chips under each client (and the
  client's Stores tab) come from two places in `routes/clients.ts` that both filtered
  `listStores()`, which answers `created_at DESC, id DESC` — so the newest branch
  appeared wherever it happened to land. One helper, `storesForCompany()`, now filters
  and sorts by name, so the card and the detail cannot drift apart; the locale is
  pinned (`'en'`) so the order does not depend on the server's environment.
- **Name, not slug:** the operator reads the branch they see on screen. Mixed-case
  names sort the way a person expects (AHK's `ALRODE`, `Atteridgeville`, `BLOEMFONTEIN`
  on real data), with the unique slug breaking exact ties.
- **Left alone deliberately:** the `/stores` fleet page keeps newest-first, which is
  right for a running log of what was added — the owner asked about Clients.
- Test (`clients.test.ts`) seeds three stores out of order and asserts both the card
  and the client detail; it was confirmed to fail without the sort before being kept.
  Tests CP **274 green (21 suites)**; backend typecheck and frontend `tsc -b` clean.
- **Verified on real fleet data**, not just fixtures: a copy of the live registry
  served by a scratch instance on `:3289` lists all five multi-store clients
  alphabetically, including AHK Spares' 41 branches and mixed-case names.

## 2026-09-16 (eleventh pass) — "Push Licence" that could not catch up, and one client per line

Owner, from a live session: _"1. CP : Clients -> 1 Client per line / 2. Client
Details-> Multiple Stores-> Push License : Store POST /api/internal/licence
failed: Licence sequence 6 is older than the stored 10 — retry"_.

**The licence failure was a counter that could never catch up.** Boss `panels.id=1`
(`urban-threads-ho`, the Head Office of the client shown as _Multi-Store_) held
**6**; the deployment behind it held **10**. The tenant refuses any licence below
the sequence it holds (correctly — it blocks a stale replay), the CP never compared
the two, and each retry incremented by one _before_ pushing, so the operator needed
five blind clicks.

- Verified against the live deployment, not reasoned about: `GET
/api/internal/status` on `:3260` returned `licence.sequence: 10`, matching the
  refusal exactly. The registry was rebuilt on 2026-09-14 by `reseed-fleet.ts`'s
  documented recipe (move the DB aside, rebuild, reseed), which restarts every
  counter at 0 while the deployments keep theirs — the same signature as the
  "sequence 2 older than the stored 3" cluster that `error_events` has carried for
  stores 2, 3, 4 and 9 since that day.
- **`services/licenceDelivery.ts` is now the one place a licence is signed and
  delivered.** Before allocating, it reads the sequence the deployment reports
  (`subscription.sequence` on a store, `licence.sequence` on a Head Office — fields
  the CP was already fetching on every health check and discarding) and raises the
  counter to at least that value. It only ever raises, and it is best-effort: an
  unreachable or older deployment behaves exactly as it did before, refusal
  included.
- **All six issuing paths now use it**, not just the two buttons: the stores route,
  the panels route, the payment/plan-change re-push (`pushLicencesForCompany`), the
  orchestrator's `issue_licences` step and provisioning. Recording a payment on that
  same client would otherwise have kept failing after the button was fixed.
- **The repair is announced**: audit `licence_sequence_reconciled` (actor
  `control-plane`, before/after/reason — the trail's first non-operator actor) and
  `reconciled: { from, to, reported }` on both licence routes, which the SPA renders
  as "the deployment already held v10, so the control plane caught up".
- **Stub parity closed while here**: it rejected an equal sequence (`<=`) where the
  tenant accepts it (`<`), and reported no licence on `/status` so nothing local
  could exercise the reconcile. Both fixed (`STUB_LICENCE_SEQUENCE` seeds it).
- **Fleet reality, stated plainly:** this repairs the **2** rows actually refused on
  sequence (store 4 `urban-threads-cpt`, panel 1). The other **51** failed licence
  rows are different problems — 42 unreachable production hostnames and 9 wrong
  token/missing public key on the local mockups — and are recorded in tidbits
  rather than folded into this fix.

**Clients: one client per line, as a wide roster row.**

- The `lg:grid-cols-2` card grid became a single column of full-width rows in the
  shape the store cards already use: identity (name linked to the client page, slug,
  topology badge) · the four facts as labelled columns · the actions. The store chips
  keep their own full-width row beneath, because a client with 41 branches (AHK
  Spares) would otherwise be a column of chips. No information was dropped.

Tests CP **272 green (21 suites)** — 13 of them new in `licenceSequence.test.ts`,
which reproduces the live failure against a tenant mock that enforces the real
refusal rule and pins both the repair and the cases where the number must not move.
Backend typecheck, frontend `tsc -b` and the production build clean. Doctrine:
CONTEXT §4.

## 2026-09-16 (tenth pass) — grandfathering, pro-rata, and print CSS

Owner: _"pro-rata+gf then print css"_ — the two commercial rules from the
what's-next list, then the last Phase 3 item.

**Grandfathering — a plan is a catalogue, not a live price.**

- The agreed terms now live on the subscription (`pricing_mode`, `rate_cents`,
  `custom_amount_cents`, `setup_fee_cents`, `billing_period`, `priced_at`) and are
  stamped at exactly three moments: onboarding, moving a client to another plan,
  and an explicit re-price. `quoteForSubscription` reads the agreement first and
  falls back to the plan only when none is recorded, reporting
  `pricingSource: 'agreed' | 'plan'`.
- **Editing a plan re-prices nobody.** Caps, terminal ceilings and features still
  track the plan — they are entitlements, not prices.
- `POST /api/clients/:id/reprice` applies the plan's current price to one client
  (audited `subscription_priced`), which is how a rise actually lands. The client
  page says "Priced from the plan — no agreed price recorded yet" for a legacy row
  and offers that button; all eleven live clients are in that state.
- The renewal sweep now reads the **effective** price instead of the plan, so a
  client with no agreed figure is skipped rather than invoiced from a plan they
  never agreed to. That fix was forced by this change, not bolted on.

**Pro-rata — terminals bought mid-period.**

- `proRataForIncrease` (in `services/pricing.ts`, the recurring calculator) charges
  `extra × agreed rate × daysRemaining / periodDays`, monthly = 30 days and
  annual = 365 by a stated convention. Only increases, only `per_terminal` deals,
  only against a period that has actually been paid for (`paidTerminalsFor` reads
  the last settled invoice).
- One charge **per paid period**: the invoice stamps `pro_rata_period`, so the same
  increase cannot be billed twice; voiding it frees the period again, mirroring the
  onboarding rule. 409 `nothing_to_pro_rate` / 409 `pro_rata_already_billed`.
- The client page shows the figure and the window ("2 extra terminals · 15 of 30
  days · 2026-09-15 to 2026-09-30") with a **Bill the difference** action. A
  reduction is never credited — it applies from the next period.

**One line model for every invoice.** `invoiceLineItems` now builds the lines for
the PDF and the email from a single place, and anything the structured lines do not
explain becomes its own line labelled with the description. That is what makes a
hand-priced, custom-priced or pro-rata charge appear as a real line with its amount
instead of a bare total — a gap that had been there since the first invoice.

**Two bugs this surfaced, both fixed:** the renewal sweep aborted entirely on one
client's bad data (`createInvoiceForCompany` was not isolated per client — the same
isolation the health sweep gives each store), and its "custom pricing" guard read
the plan rather than the client's agreement.

**Print CSS** (the last Phase 3 item): the invoice modal prints as a document —
`@media print` keeps the `.print-invoice` subtree, drops the nav, filters, table
and buttons, and neutralises the modal's grey overlay. Print was previously the
whole SPA.

Tests: `pricing.test.ts` (13) covers the calculator's arithmetic and every
"nothing to charge" case, the client surface, the re-price action and the
grandfathering rule; total CP **260 green (20 suites)**, typecheck, frontend
`tsc -b` and the production build clean. Verified live: the client page shows the
pricing-source note and the action, and the invoice modal carries the print hooks.

## 2026-09-16 (ninth pass) — "Record payment", and voiding instead of cancelling

Owner: _"Record Payment"_ + _"remove the Stripe Paypal Card Terminal"_ + _"I agree
with Void instead of Cancel"_ — the three naming decisions from the discussion
that followed the last pass.

- **`Pay` → `Record Payment`** on the invoice row and the modal's submit button.
  The app never charges anyone; it records a settlement that already happened and
  then advances `paid_through` and re-pushes licences. "Pay" promised an action the
  system does not perform — the same mislabelling as the invoice-email stub that
  used to report a send it never made. The modal heading keeps the side effect
  visible (_Record Payment & Renew Licence_), and the row button carries a tooltip
  saying the control plane does not charge anyone.
- **Stripe, PayPal and card-terminal methods removed** from the payment form. No
  gateway is integrated, so choosing one wrote a `method: 'stripe'` row for a
  payment no system had made — a manual EFT that looks like a card charge. Manual
  EFT / Bank Deposit and Direct Debit / Bank Transfer remain. The API enum still
  accepts the gateway values (a method describes how money arrived, and a script
  recording a real card settlement is stating a fact) — when a gateway lands it is
  a **new action**, not a relabelled one. The reference-field placeholder no longer
  suggests a Stripe charge id.
- **`Cancel` → `Void`** on the row, in the confirm text, in the status pill and in
  the status filter. "Cancel" sat next to "Record Payment" and read as "cancel the
  payment". The stored status stays `cancelled` (the DDL CHECK cannot be altered in
  place and the wire value is unchanged) — the SPA maps it to _Voided_ for display.
- **Voiding is now attributed**, like push/pause/licence/settings: an
  `invoice_voided` audit row records the status change and whether the once-off was
  released. And the UI now _says_ when a void released the onboarding charge,
  instead of leaving the operator to discover it on the next invoice.

Tests: the void keeps the invoice on the record with status `cancelled`, reports
`setupFeeReleased`, and writes the audit row; both offered methods record a
`completed` payment; an unknown method is still refused. CP **247 green (19
suites)**, typecheck, frontend `tsc -b` and the production build clean. Verified
live: the row reads **Record Payment** / **Void**, the filters read **Voided**, and
the modal offers only the two methods.

## 2026-09-16 (eighth pass) — the plan on the invoice

Owner: _"we should [show] the plan in the invoice."_

- **The plan is now on the document, as a snapshot.** `invoices.plan_code` /
  `plan_name` are written when the invoice is raised and never read back from the
  catalogue: renaming a plan must not restate what an issued invoice says. That
  was already untrue in one place — the Billing detail view looked up the
  _client's current_ plan and printed it on old invoices — so the UI now reads the
  invoice's own record.
- **Where it shows**: the PDF's metadata block (`PLAN  Vula Network`), the
  subscription line's detail (`Vula Network · 7 × R 500,00`), the emailed invoice's
  licensed-terminals row, and the Billing detail view (falling back to "No plan
  recorded on this invoice" for a client that has none — the invoice says what it
  knows rather than inventing a tier).
- **The subscription line now states its own total** (R3 500,00) beside the
  arithmetic, matching the once-off line — previously it showed only
  "7 × R 500,00" and left the reader to multiply. The amount column header says
  **AMOUNT (INCL. VAT)**, since that is what the figures are.
- Tests: the plan is captured on recurring, onboarding-only and hand-priced
  invoices; a plan renamed after issue leaves the old invoice reading as issued
  while the next invoice picks up the new name; a client with no plan reports
  `null` rather than a guessed tier.

Tests: CP **245 green (19 suites)**; typecheck, frontend `tsc -b` and the
production build clean. Rendered and read back on a scratch registry: PDF
geometry clean (no out-of-margin text, no rule crossing text).

## 2026-09-16 (seventh pass) — invoice numbering and VAT on inclusive prices

Owner: _"fix invoice numbering"_ + _"prices inc VAT"_. Both were on the
what's-next list, and together they are the last two things standing between this
panel and an invoice that can go to a real client.

- **Numbers are now a monotonic per-year sequence: `VULA-2026-000001`.** They were
  `INV-<date>-<4 random digits>`, which was neither sequential — no gap or
  duplicate is readable from the number — nor collision-safe: two invoices raised
  in the same second could draw the same digits and the UNIQUE index turned the
  loser into a raw database error. The counter is an `invoice_sequences` row,
  incremented in the statement that reads it, and a year's counter starts from the
  highest number already written for that year, so a restored backup cannot
  re-issue a number. Existing `INV-…` rows are left exactly as they are: they are
  issued documents.
- **Prices are quoted VAT-inclusive, and the invoice breaks the tax out.** The
  split is `subtotal = round(total × 100 / (100 + rate))`, `vat = total −
subtotal` — integer cents that always add back to the total, so no invoice is a
  cent out. `vat_reg_no` and `vat_rate` are Settings fields; with a registration
  the document is headed **Tax invoice** and carries the number, and both the rate
  and the split are stored **per invoice**, so changing a rate never restates an
  invoice already issued.
- **Sequencing and tax landed together on purpose**: an invoice number that can
  skip or collide and a tax total that cannot be reconciled are the same class of
  problem — the document looks official and is not quite right.
- Invoices raised before the split keep NULLs and print the total alone. Back-
  filling them would state tax figures that were never on the document, which is
  the opposite of what the split is for.
- UI: Settings gained the two VAT fields (with the inclusive-pricing rule spelled
  out), the invoice detail states **Total (incl. VAT)** with the subtotal and VAT
  beneath it, the line column reads "Amount (incl. VAT)", and the plan catalogue's
  per-terminal label now says _incl. VAT_ — otherwise the office reads a rate as
  ex-VAT and the tax line is a surprise.
- Tests added: the sequence is monotonic, unique, same-width, continues past an
  existing number for the year and survives three raises in one second; the split
  sums back to the total for amounts that do not divide cleanly (1, 7, 99, 1234,
  49999, 1234567, R115 000,01); a rate change leaves issued invoices alone;
  impossible rates are refused; and a pre-split invoice reports NULLs.

Tests: CP **242 green (19 suites)**; backend typecheck, frontend `tsc -b` and the
production build clean. Rendered and read against a scratch registry: a
R13 500,00 inclusive invoice splits to R11 739,13 + R1 760,87 at 15%, headed "Tax
invoice", with the once-off still leading the lines.

## 2026-09-16 (sixth pass) — the once-off leads the invoice, under one name

Owner: _"alway have the Vula onboarding and deployment first line item when
applicable in invoice."_

- **It is now the first line item, everywhere the charge is itemised**: the PDF,
  the emailed invoice, the Billing detail view and the Raise-an-Invoice preview.
  Subscription lines follow it, and the preview's total still adds both.
- **One name, one place.** The label is `SETUP_FEE_LINE_LABEL` in
  `services/billing.ts` ("Vula onboarding and deployment" — the wording the
  Billing detail view already used, and what the owner calls it), mirrored as
  `SETUP_FEE_LABEL` in the SPA's `lib/storeVocab.ts` with a comment explaining
  that the two cannot share a module across the build. The client page's
  subscription summary and the subscription editor now use the same words; the
  plan's field and the status vocabulary keep "once-off onboarding", and CONTEXT
  §5e says which is which.
- **The invoice subject moved out of the amounts column.** The `description` was
  drawn as the first row of the lines table — with no amount beside it, which
  reads as an uncharged item and pushed the real first line item to second place.
  It now sits with the "Subscription invoice" title, and the table holds only
  charged lines, led by the once-off.
- **A stale helper corrected while in there:** the subscription editor still said
  "the onboarding charge rides the client's first invoice only — never a renewal",
  which the fourth pass made untrue. A claim in the UI that a later change
  invalidated is worse than no claim.
- Test added: the email's rows are asserted to put
  `Vula onboarding and deployment` before `Licensed terminals` — the order is
  readable as text there, and the PDF draws the same sequence from the same
  constant. Verified live too: invoice INV-20260916-1553 renders
  "Vula onboarding and deployment R10 000,00" above "2 licensed terminals".

Tests: CP **234 green (19 suites)**; typecheck, frontend `tsc -b` and the
production build clean. Nothing raised, nothing committed.

## 2026-09-16 (fifth pass) — the create-invoice modal said three things at once

Owner: _"i dont see the once off when creating an invoice"_ and _"this is
confusing: What is this for? (optional) -> Left blank, the invoice describes the
subscription it bills."_

Both were the same fault: the modal explained the invoice in prose, in the wrong
places, and the once-off was a footnote in small grey type.

- **The modal now shows the invoice, not a description of it.** A "What this
  invoice will carry" panel lists the subscription line (`Subscription — Vula
Spares Network (7 × R 500,00) R3 500,00`), the once-off owed
  (`Once-off onboarding · Never billed for this client — added to this invoice ·
R10 000,00`) and **the total** — so the arithmetic is not left to the reader.
  The once-off line carries the tick that waves it off, and its own explanation
  ("Left off this invoice; it stays owed and the next invoice picks it up").
- **The contradictory field label is gone.** "What is this for? (optional)" became
  required the moment an amount was typed, and its helper explained an internal
  rule ("the invoice describes the subscription it bills"). Now: the amount field
  says _"— leave empty to bill the subscription"_, the description field appears
  **only when an amount is typed**, and it asks _"What is this amount for?"_ with
  one line saying where it is read (client, PDF, email). With no amount, the modal
  states the sentence the invoice will carry instead.
- **Before a client is chosen the panel has a placeholder** — "Choose a client to
  see the subscription, any once-off charge still owed, and the invoice total" —
  because with nothing selected there was previously nothing to see at all, which
  is precisely what "I don't see the once off" looked like.
- Also: "Company" → "Client" (the UI's vocabulary everywhere else), and the submit
  button is "Raise Invoice" (the heading said "Raise an Invoice" while the button
  said "Generate Invoice").

Verified live on Kloof Auto Spares: empty amount → subscription R3 500 + once-off
R10 000 = **R13 500**; typing R2 500 → "Your charge R2 500,00" + once-off =
**R12 500**, with the description field appearing and required. Nothing was
created (fleet still 12 invoices). Tests **233 green (19 suites)**, typecheck,
frontend `tsc -b` and the build clean.

## 2026-09-16 (fourth pass) — the once-off is captured automatically; support is not a charge

Owner: _"when creating an invoice: check if once-off has been payed. if not it
invoice it"_ and _"Allow to bill for support as well"_.

- **The once-off now rides on whichever invoice is raised next.** It used to be
  charged only on an `initial` invoice, so a client whose first invoice went out
  before the charge existed kept it unbilled forever unless someone remembered the
  separate "Bill onboarding" step. Now `initial`, `renewal` (the sweep included)
  and hand-priced invoices all carry it while it is unbilled, itemised as its own
  line, and the sweep counts them (`onboardingCharged`) so automatic captures are
  visible rather than silent. `includeOnboarding: false` waves it off for one
  invoice; the charge stays owed and the next invoice picks it up.
  - Double-billing is structurally impossible: `setupFeeDueCents` is zero as soon
    as the charge sits on a standing invoice, and my earlier fix releases it if
    that invoice is cancelled. Four tests cover the ways in.
  - The Billing modal shows the line and lets the operator untick it; when the
    charge is already billed, it says which document carries it
    (`setupFeeRef`) instead of adding it twice.
- **Support is deliberately not billed.** Asked how support should be charged, the
  owner answered: _"ignore support charges. we charging per terminal which includes
  support"_. So no support line, tier or charge type — and it is written into
  CONTEXT §5e, the glossary, AGENTS.md ("Commercial rules locked with the owner")
  and tidbits, because "add a support fee" is an obvious-looking feature for a
  future session to invent.
- **A field name had to change for §40.** Naming the carrying document
  `setupFeeInvoiceNumber` failed the privacy-boundary test, which walks field
  _names_ on the client and company endpoints and cannot tell a vendor document
  number from a merchant's billing data. Renamed `setupFeeRef` — the same lesson
  as `salesBlocked` → `tradingBlocked` in 2026-09-11.

Tests: CP **233 green (19 suites)**; backend typecheck, frontend `tsc -b` and the
production build clean. Six existing billing tests were given an explicit
`includeOnboarding: false`, each with a comment saying why that invoice is not the
moment to capture the charge. Not committed (house rule).

## 2026-09-16 (third pass) — the invoice as a document, and somewhere to bill a once-off

Owner follow-ups on the mailer, all about the invoice itself:

1. _"in Email: Sent by the Vula control plane"_ — "control plane" is internal
   vendor vocabulary a merchant should never read on an invoice. Every mail now
   signs off with the office's own name (`Sent by {office name}`), the test email
   included, and a test asserts the phrase never appears in an invoice email.
2. _"can we not have pdf invoice attached to email"_ — **yes.** `services/invoicePdf.ts`
   renders an A4 invoice with pdfkit (the tenant's engine and conventions), the
   mailer attaches it, and `GET /api/billing/invoices/:id/pdf` serves the same
   document, so the download and the attachment cannot diverge. The Billing
   invoice modal gained "Download PDF" (fetched with the session token, then
   handed to the browser as a blob).
3. _"What about charging once off payment? need somewhere to bill it"_ — this was
   the real gap. Invoices carried an amount and nothing saying what it was for,
   so a once-off charge (installation, training, a migration) had nowhere to
   live, and the plan's onboarding fee was **visible but unbillable** for an
   existing client. Now: `invoices.description`, a hand-priced invoice must state
   one (400 `invoice_description_required`), the Billing "Raise an Invoice" modal
   asks for it, and the client page has a **"Bill R… onboarding"** button that
   raises the once-off charge alone (`purpose: 'onboarding'`) — not `initial`,
   which would re-bill the client's current period.
   **Nine of the eleven live clients owe R10 000 onboarding that had no path to
   being raised** (AHK Spares and Street Gym are already marked paid). Nothing was
   billed for them — that is the owner's call.

**Layout defects the PDF had, found by reading it rather than assuming** — each
is now fixed and pinned by a test:

- The amount was drawn as `R 14 500,0` / `0`: a 57pt money column is narrower
  than the string at 11pt bold (59.9pt). The column is 110pt and `lineBreak:
false`; `moneyColumnFits()` asserts the fit with pdfkit's own metrics.
- A wrapped description advanced a fixed 16pt, so the total rule could cut
  through its second line; a long client name ran into the row beneath it. Both
  offsets are measured now.
- The footer was pinned to the foot of the page, leaving **48% of an A4 blank**
  on a one-line invoice. It flows after the charge block.
- The money column ran 5pt past the right margin (inherited from the tenant's
  geometry, whose content edge is 552pt). The content box is a clean 48pt/547pt.

**A stranded onboarding charge, found by watching the owner use the new UI.** A
few minutes after the reset, two invoices appeared for myDiner (an `initial` one,
cancelled, and a hand-priced "Installation" one) — the owner exercising the new
billing form. The cancelled one had carried the R10 000 onboarding charge, and
the subscription still read `invoiced` with nothing due: the charge could never be
raised again, because a cancelled invoice had marked it billed. Fixed in the same
pass — cancelling the last standing invoice that carries the charge releases it
(`setupFeeReleased: true`, back to `not_invoiced`) — with two tests, and the live
row repaired through the API (myDiner is billable again).

Tests: CP **230 green (19 suites)** (was 218/18), backend typecheck, frontend
`tsc -b` and the production build clean. Doctrine: CONTEXT §5e (+ the geometry
and once-off rules). Not committed (house rule).

**One mistake worth recording.** A throwaway script meant for a scratch registry
set `CP_DB_PATH` in its own first line — too late, because ESM hoists imports, so
it opened the **live** registry: it created a demo company, its invoice and
overwrote the office's identity settings. Repaired the same hour (company deleted
through the API, which cascaded its invoice; settings restored from the values
captured in a PDF rendered two minutes earlier and re-verified; SMTP credentials
untouched) and the scratch scripts now refuse to run unless `CP_DB_PATH` is under
`/tmp`. See findings.md.

## 2026-09-16 (later) — Phase 2: the office's own settings, and a mailer that sends

Owner: _"continue with phase 2"_ — the CP settings singleton + Settings page +
real SMTP mailer. Also carried in this pass, from two owner reports on the same
screen: the store credential had no repair path, and "unable to edit a store".

- **The invoice email was a fabricated success.** `POST /api/billing/invoices/:id/email`
  audited an email, returned `ok: true` and a `sentAt`, and **sent nothing** — the
  same shape of defect as the auto-renewal that used to record a payment nobody
  made. It now goes through `services/mailer.ts` (nodemailer, transport built per
  send from the stored settings): 400 `smtp_not_configured` when no host is set,
  502 `mailer_failed` with the relay's reason when it refuses, and only on
  acceptance are `emailed_at`/`emailed_to` stamped and the audit written `ok`. A
  failed send is audited `failed`, so the trail never claims an email.
- **`office_settings`** — a true singleton (`CHECK (id = 1)`, seeded on first
  boot) holding the vendor's own identity, `invoice_due_days`, `invoice_footer`
  and the SMTP block. Named apart from `billing_settings` (per client) on purpose:
  three different things in this codebase are called settings, and only one of
  them is the office's. `invoice_due_days` replaced the hard-coded 14-day term in
  `createInvoiceForCompany`.
- **`GET/PUT /api/settings` + `POST /api/settings/test-email` + a Settings page**
  (new nav entry). The SMTP password is never returned; the mask
  (`••••••••`) submitted back means "unchanged", so a form round-trip cannot
  blank a working credential. Clearing the host clears the user, password and
  from-address with it. Audited with the masked view.
- **Test-email ordering matters.** The first cut asked for a recipient before
  noticing there was no mail server at all, which sends the operator to fix the
  wrong field; the missing host is now reported first (caught live in the browser,
  not by a test).
- **The store credential is repairable (the `ahk-spares-ct` report).** A store
  added without pasting its deployment's `CONTROL_PLANE_TOKEN` gets a generated
  one, every push answers "Invalid control plane token", and until today the only
  way out was to delete the registry row and create it again — losing its history,
  licence allocation and job records. `PUT /api/stores/:id` now accepts
  `controlPlaneToken` (blank refused; audited as `store_credential_set` without
  the value; never echoed back), the edit modal gained the field, and the client
  page's "Add Store to Fleet" gained both the token input and the reveal-once
  modal it was swallowing.
- **Verified against the live store at `:3278`** (the one from the report):
  create without the token → `Invalid control plane token`; paste the
  deployment's token via the edit path → **push ok**, health **up**
  ("AHK Spares Cpt"), audit row written without the value. Probe store removed
  afterwards; fleet back to 64.
- Tests: CP **218 green (18 suites)** (was 198/17), backend typecheck, frontend
  `tsc -b` and the production build all clean. Doctrine: CONTEXT §5e + the
  `invoices`/`office_settings` rows in §5.

## 2026-09-16 — store Remove looked inert because its refusal was rendered off-screen

Owner report: _"client : Client Details -> remove -> Confirm remove : store is not
removed."_ Not a broken handler — the pause-first guard was working exactly as
designed and saying so, into the wrong place.

- **Diagnosis.** `DELETE /api/stores/:id` refuses an `active` store with **409
  `store_active`** ("Pause it first, then remove it"). Every seeded store is
  active, so every Remove was refused. The refusal _was_ reported:
  `useStoreActions.removeStore` catches it and calls `notify('error', …)`. But the
  notice rendered **in document flow at the foot of the page** — below all 44
  store cards on the AHK client — so the click read as a no-op. `removeStore` also
  calls `onDone?.()` on failure, collapsing Confirm/Cancel back to a plain Remove,
  which removed the last on-screen evidence that anything had happened at all.
- **Fix — `NoticeBanner` (`frontend/src/components/storeUi.tsx`).** The action
  outcome is now a **fixed, viewport-anchored toast** (`role="status"`,
  `aria-live="polite"`), so it cannot be scrolled away from. Adopted by the three
  surfaces that share the store-action hook — `ClientDetailPage`, `StoresPage`
  (advanced/unlinked), `StoreDetailPage` — replacing three copies of the same
  inline block. `CompaniesPage`/`PanelsPage` still carry their own simpler
  string-only notice (no `kind`), left alone as they are advanced surfaces.
- **Verified end-to-end** against the running CP with a throwaway _unassigned_
  store (so no client's allocations were touched): create → DELETE while active →
  **409 `store_active`** → Pause → DELETE → **200**, probe row gone, fleet back to
  64 stores. Backend **198 green (17 suites)**; backend typecheck, frontend
  `tsc -b` and the production build all clean.
- **Registry hygiene (demo data, not code).** AHK Spares' licensed quantity set
  back **130 → 123**, matching its 41 branches × 3 tills (123 configured, 123
  allocated), clearing the over-allocation note and restoring R61,500/mo. The
  three stale `reseed-fleet` AHK rows (`ahk-spares-jhb/dbn/ct`) are all gone from
  the registry.
- **Not covered by a test.** The refusal itself is covered
  (`stores.test.ts` asserts 409 + "pause it first"); the _presentation_ fix is not,
  because this repo has no frontend test runner (no `test` script in
  `frontend/package.json`). Recorded in tidbits.md.

## 2026-09-14 — production deployment plan documented (shared with za-pos)

Owner will register `vula-app.co.za`; the readiness answer is written down rather
than coded. The runbook lives in the tenant repo —
`za-pos/prompts/deploy-production-vula-app.md` — because it covers the shared
host, and this playbook now links to it.

CP-side findings it records, all tracked in `tidbits.md`:

- **The image contradicts itself on ports**: `EXPOSE 3240` + healthcheck on
  `localhost:3240`, while Coolify injects `PORT=3000` for the proxy.
- **The licence key is checked lazily**, not at boot, so a keyless production CP
  starts healthy and dies on the first licence issue.
- **Provisioning injects neither `BACKUP_DIR` nor `HEAD_OFFICE_TOKEN`** — the
  first loses store backups into the container layer, the second is the
  two-sided-credential gap that has made the fleet look Offline twice by hand.
- **The host tree needs uid-1000 ownership** before first start, because the
  volumes are bind mounts and the container runs as `node`.

Also corrected here: this playbook opened by claiming the CP does not provision
Coolify, which `services/coolify.ts` has done since the recent work; and its
store env block omitted `BACKUP_DIR` and the licence public key.

Dated log of the build.

## 2026-09-14 — production blockers closed (this repo's four)

Paired with the same day's work in `za-pos`; both repos reached "no blockers
left" together.

- **The image builds.** Its frontend asked for node types without declaring
  `@types/node`; the root install hoisted them locally so only Coolify's clean
  build failed. Verified by building the image.
- **The licence key is checked at boot**, not on first use — a CP that starts
  healthy and dies when it issues its first licence is the worse failure.
- **The port story is coherent**: default, `EXPOSE` and healthcheck all 3000,
  matching the `PORT` Coolify injects for its proxy.
- **Provisioning writes the agreed tree** and injects the two things it was
  leaving out: `BACKUP_DIR`, and the branch↔panel credential (both directions in
  `services/topology.ts`, shared by the wizard and `POST /api/stores`).
- **This image gets the entrypoint too**, so it can write a root-owned `/data`
  — and no longer runs as root while doing it.

The provisioning path has still only been exercised against its stub: verifying
it against a real Coolify target is on the go-live checklist, not here.

## 2026-09-14 — Devices page: client sections above the stores (owner follow-up)

Owner: _"we should group by client name / company name no?"_ — yes, and the
registry shows why that needs care rather than being a straight nesting.

**The fleet is majority-unowned.** Of 16 stores and 65 tills, only 11 stores /
28 tills belong to a client:

| Client                     | Stores | Tills  |
| -------------------------- | ------ | ------ |
| _(no client)_              | 5      | **37** |
| Urban Threads Retail Group | 3      | 9      |
| Kloof Auto Spares          | 3      | 8      |
| Cresta Grocers             | 2      | 5      |
| AHK Spares                 | 2      | 4      |
| myDiner                    | 1      | 2      |

So client becomes a **section band** (not a second collapse level — two nested
disclosures would mean two clicks to reach any till), and the five unowned stores
get an explicitly marked **`Unassigned — no client`** section, amber and sorted
last. That section is the largest on the page (37 tills), which is the honest
picture: most of this fleet is not attributed to anyone. Hiding those stores
would misstate the fleet; filing them under a client would invent ownership.

- The client name moved off the store header onto the band, so it is stated once
  instead of on every store row.
- **A data bug fell out of the exercise:** company _HM Spares_ owns a Head Office
  panel but **zero stores**, while the `hm-spares` store (spares, 1 till) sits
  unassigned. That store belongs to that company — one `companyId` on the store
  edit fixes both halves. The other four unassigned demo stores
  (`everyday-retail`, `brake-bolt-spares`, `builders-hardware`,
  `medisave-pharmacy`) have no company to join; they are demo fixtures created
  without one.
- Verified against a copy of the live registry: bands read AHK Spares 2/4,
  Cresta Grocers 2/5, Kloof Auto Spares 3/8, myDiner 1/2, Urban Threads Retail
  Group 3/9, Unassigned 5/37, plus the Head offices section — 16 store groups
  across six bands, exactly matching the registry. Tests **195 green**,
  typecheck and build clean. Doctrine: CONTEXT §5b.

## 2026-09-14 — Devices page: store-first layout (owner-directed)

The owner looked at the shipped page against the real fleet and asked for
"store first, then the device". The reason was visible in the data: **70 rows for
16 stores**, of which **Everyday Retail alone was 25** (38% of the page, its name
repeated on every row), and five stores with no client rendered a dead
`— · Development` line.

Rewritten as a **grouped, collapsible** list (owner picked this over store cards
and master/detail):

- A **store header** per store — health dot, name, short vertical chip, client
  only when set, environment only when it is not `development` — with
  `N tills · M claimed · heartbeat …` right-aligned.
- **More than 5 tills starts collapsed** (`DEFAULT_EXPAND_MAX_TILLS`) so the
  25-till store cannot bury the other fifteen; Expand all / Collapse all
  alongside.
- **Head offices move to their own section** — a fleet member with no tills has
  no parent store to nest under.
- Search matches store fields, so searching a store brings its tills; status and
  type filters drop emptied groups.
- The Config column now uses the shared `CONFIG_STATE_LABELS` (`✓ Current`,
  `⚠ Pending`) instead of raw enum values, matching the store surfaces.

Two design points worth keeping: the **vertical chip stays even when a store's
name encodes it**, because `Cape Town`/`cpt-wf` are general-profile stores owned
by spares merchants — the mismatch is the signal; and the **client name is what
disambiguates** the several stores named after towns.

Verified against a **copy of the live registry** (never the running one): 16
stores · 65 tills · 5 head offices = 70 devices, Everyday Retail collapsed by
default, expanding it takes the page from 61 to 87 rows, and the status tiles
still reconcile (61 unclaimed + 4 claimed + 3 offline + 2 unknown = 70). No
backend change; tests **195 green (17 suites)**, typecheck and build clean.
Doctrine: CONTEXT §5b.

## 2026-09-14 — SPOG §33: the Deployments page (fourth deferred surface)

- **Fleet-wide for the first time.** `deployment_jobs`/`_steps` were durable from
  the start but only ever exposed per client; `GET /api/deployments` lists every
  job newest first with a step tally computed in **one grouped query**
  (`deploymentStepCounts`) rather than a step query per job, and
  `GET /api/deployments/:id` returns the steps.
- **`stepCounts` vs `steps`.** The list returns tallies, the detail returns rows.
  Sharing one key would have made it mean two things, so they are named apart.
- **What a job doesn't record is not shown.** There is no image version, no
  `environment`, and no operator on a job — so the spec's Version / Environment /
  Operator columns are omitted rather than inferred (the footer says so). Target
  does exist, from the steps' `resource_type` + `resource_id`.
- **Warnings are surfaced.** A step can be `complete` while carrying best-effort
  failures in `warnings_json`; the detail shows them beside the step. Verified
  live: a real client wizard run produced a 4-step job where
  `store_deploy_urban-threads` completed with 2 warnings and `issue_licences`
  with 1 — exactly the kind of half-success that a bare status pill hides.
- **No rollout controls.** §33's canary/pause/rollback are "later" and the spec
  warns against them without permissions and auditing; the CP has a single office
  JWT and no RBAC (tidbits.md).
- Tests: `src/__tests__/deployments.test.ts` (7) → CP **195 green (17 suites)**,
  typecheck + production build clean. Page verified live against a wizard-created
  client. Doctrine: CONTEXT §5d.

## 2026-09-14 — SPOG §32: the Versions page (third deferred surface)

- **`GET /api/versions`** aggregates what telemetry already wrote: each store's
  `app_version` / `schema_version`, each panel's `app_version`. Output is the
  distribution (version → stores, panels, per-environment counts, freshest
  heartbeat, and its members), the schema-version spread, the most-deployed build
  per environment, and fleet totals. Derivation in `services/fleetView.ts`.
- **Unreported is a bucket.** A member registered but never probed has a NULL
  version; it gets its own "Never reported" row so the distribution still
  accounts for the whole fleet rather than quietly dropping members.
- **No "minimum supported" version.** The spec asks for one and nothing defines
  it. Adding it would create a support commitment nobody agreed to, so it is
  deliberately omitted (and the page footer says why) rather than defaulted to
  `0.0.0` or the oldest build seen — the same "never invent business rules" line
  the tenant repo works to.
- **There is no version history** — each member has one current build,
  overwritten on every telemetry read. The page says so rather than implying a
  timeline.
- Page: summary tiles (members reporting, distinct builds, most-deployed
  production/staging), the distribution table, schema spread, and a build filter
  that lists the members on a build (row click sets it).
- Tests: `src/__tests__/versions.test.ts` (7) → CP **188 green (16 suites)**,
  typecheck + production build clean. Doctrine: CONTEXT §5c.

## 2026-09-14 — SPOG §25: the Devices page (second deferred surface)

Device data was already being collected and then thrown away: per-till
`claimed`/`deviceId`/`sessionOpen`/`lastSeenAt` sit in
`stores.last_telemetry_json`, but `telemetrySummary` reduces them to four counts.
So this slice **exposes** rather than collects.

- **`services/fleetView.ts`** (new, shared): the derived read model moved out of
  `routes/stores.ts` — `parseTelemetry`, `telemetrySummary`, `configStateFor`,
  `healthStateFor` — plus the new device derivation. One module now owns how a
  state is computed, so the store list, store detail and Devices page cannot
  drift. `stores.ts` imports them instead of defining them.
- **Devices are derived, not stored.** Each store contributes one entry per
  **configured till** (from `terminalRoster`, so custom names and roster order
  survive) and each Head Office one `office` entry. The roster decides which
  tills exist; telemetry decides their state. A till with no telemetry entry is
  `unclaimed`.
- **Honest statuses.** A bound till reads `claimed` — not `online` — because
  `lastSeenAt` is a reserved null until the tenant ships device heartbeats;
  `online` requires a fresh heartbeat, `offline` means the store is down or the
  heartbeat is stale. Last seen falls back to the store heartbeat and the footer
  says so. `version` is the store's build (no per-device version exists).
- **Two real bugs caught by the tests**: tills were sorting alphabetically by
  name (so a renamed "Bakery" landed before "Front counter") — the view now
  carries the roster position and sorts on it; and `POST /stores` silently
  ignores `terminalNames` (it is an update field), which the first test fixture
  had wrongly assumed.
- `GET /api/devices` (office-gated, `routes/devices.ts`) + a **Devices** nav
  entry and page: status/type tiles, search, type and status filters, and the
  §25 columns. Read-only — the tenant exposes no per-device command API, so the
  spec's rename/rotate/revoke actions are deliberately absent rather than dead.
- Tests: `src/__tests__/devices.test.ts` (8) → CP **181 green (15 suites)**,
  typecheck + production build clean. Doctrine: CONTEXT §5b.

## 2026-09-14 — SPOG §30: the Errors page (first of the deferred surfaces)

Owner picked the deferred SPOG set; this lands its first slice after committing
the subscription redesign.

**Why this one first.** A store row keeps only the _latest_ failure
(`last_health_error`, `last_config_error`), and the 2026-09-14 health-probe
incident made the cost concrete: the panel showed a bare "Offline" badge with no
reason, undiagnosable from the UI by construction. Grouping, frequency and
"since when" are the questions the page exists for, and none of them are
answerable from a single latest-error column.

- **`error_events`** (registryDb + `schema.sql`): one row per
  `fingerprint × source × entity`, with `occurrences`, `first_seen`,
  `last_seen`, `app_version`, `environment`. A unique index on that key makes
  the recorder an upsert, so the table grows with distinct problems, not with
  probes. `entity_type`/`entity_id` rather than nullable `store_id`/`panel_id`
  — SQLite treats NULLs as distinct in a unique index, which would have written
  one row per occurrence and silently defeated the grouping.
- **Fingerprint** = SHA-1 of the message with volatile detail stripped (ids,
  timestamps, urls, numbers), so `timed out after 5000ms` groups with
  `timed out after 100ms` while different faults stay apart. The trailing `\b`
  had to go: a quantity carries a unit (`5000ms`), and a word boundary does not
  match inside it.
- **Recorded from the four real failure paths** — store health down, config push
  failed, licence push failed, deploy failed — plus panel health and panel
  licence push. `recordLicencePush`/`recordPanelLicencePush` and
  `setStoreDeployStatus`/`setPanelDeployStatus` gained the failure reason they
  previously dropped, and the call sites now pass it.
- **Recovery never deletes history**: the feed is a timeline and freshness is
  `last_seen`. **Recording never masks a failure**: `recordErrorEvent` logs and
  swallows its own errors.
- **Routes** `GET /api/errors` and `GET /api/errors/:fingerprint` (office-gated,
  grouped newest first, ties broken by occurrences then fingerprint);
  `src/routes/errors.ts`, mounted in the API router.
- **UI**: new **Errors** nav entry and `ErrorsPage` — summary tiles, source
  filters, the grouped table (message, fingerprints, sources, stores, occurrences,
  relative last-seen) and a detail modal naming the store or Head Office behind
  each occurrence and listing version/environment. Store and panel names ride
  along on load so an occurrence names the thing it came from.
- Tests: `src/__tests__/errors.test.ts` (13) → CP **173 green (14 suites)**,
  typecheck + production build clean. Verified live against a scratch registry:
  two health probes grouped to `occurrences: 2`, the create-time config and
  licence failures recorded separately, unauthenticated `/api/errors` → 401,
  and the page rendered with real rows and a working detail modal.

**Not built, and why** (spec §39 forbids empty placeholders): Sync
dashboard/inspector need device heartbeats and a sync-event store the tenant
does not ship yet (`pendingEvents`/`failedEvents`/`lastSeenAt` are reserved
nulls); Printers needs a printer agent that does not exist; Backups needs a
tenant internal endpoint (za-pos has only admin-only `/api/backups`). Devices,
Versions and a read-only Deployments page are buildable and are the queued next
slices (tidbits.md).

## 2026-09-13 (redesign, later) — a custom plan can carry an agreed amount; plan-row switch

Owner feedback on the shipped Plans screen, two changes:

- **Plan rows now carry an on/off switch** instead of a Deactivate button: the
  archive/re-activate action is the switch itself (label and tooltip removed at the
  owner's request; the accessible name survives). Edit stays a pencil icon.
- **`custom` plans may hold a monthly charge.** Owner: _"so that the custom plans
  hold a monthly charge"_. New additive column `plans.custom_amount_cents` (integer
  cents, per `billing_period`) with `migratePlanCustomAmount` in the ensure-columns
  block and the column added to `PLAN_COLUMNS`/the plan-restructure source select.
  Semantics: a stated agreed amount bills **flat** each period (no terminal
  arithmetic, no terminal line on the invoice) and the renewal sweep renews it; an
  amount of **0 keeps the old strict behaviour** — an amountless invoice is refused
  with `custom_pricing_requires_amount` and the sweep skips that client, so the
  control plane still never invents a figure for a negotiated deal. Both figures
  (rate and agreed amount) are stored whichever mode is active, so toggling the mode
  never loses a value; only the mode's own figure is ever read or billed.
  UI: the Pricing section shows **Agreed amount (R)** when the model is Custom, the
  quote box states it (or "no agreed amount yet · invoices will need an amount typed
  each time"), and the plan list shows "R 7 500,00 / month · Agreed amount, billed
  flat". CONTEXT §2a, AGENTS' plan row, schema.sql and tidbits updated.
- Tests: CP **160 green (13 suites)** (+1: a custom plan's agreed amount bills and
  renews; without one it still refuses and is skipped); typecheck + production build
  clean. No commit (house rule).

## 2026-09-13 (redesign) — subscription model: licensed terminals × rate + once-off onboarding

Owner brief (`~/Downloads/vula-pos-subscription-redesign-agent-prompt*.md`),
planned with the owner first: the commercial model is now **licensed terminals ×
price per terminal, plus a once-off onboarding fee** — and a plan may instead be
`custom` (negotiated), which the control plane never prices on the client's behalf.

**The working tree already held a half-finished, divergent pricing implementation**
(9 modified files, 404 insertions, frontend not typechecking: it billed _configured_
tills — expressly forbidden by the brief — kept the bundled `included_terminals`
model the brief removes, and referenced fields that existed nowhere). It was saved
to `/tmp/cp-per-term-pricing-wip.patch` and reverted, then rebuilt to the brief.

- **Schema** (`src/config/registryDb.ts`, `schema.sql`): `plans` rebuilt to
  `pricing_mode` (`per_terminal` | `custom`) + `terminal_price_cents` +
  `setup_fee_cents`; new `company_subscriptions` (licensed quantity +
  `setup_fee_status`) and `store_terminal_licences` (per-store allocations);
  `invoices` carry their own evidence (`terminal_count`, a rate snapshot
  `terminal_price_cents`, `setup_fee_cents`). The flat-model columns are gone.
  Migrations are dynamic (any intermediate dev shape), FK-safe
  (`rebuildTable` + an explicit source-select for the renames) and idempotent —
  rehearsed against a copy of the live registry: 6 subscriptions, 11 allocations,
  no FK violations, second boot changes nothing.
- **A flat price is NOT a per-terminal rate.** Every existing priced plan (live:
  Starter R1,500, Business R3,000, Multi-Store R5,000, "per-till" R499) became
  `custom` rather than being copied into the rate field, which would have
  multiplied live clients' bills by their till count. Unpriced seeded tiers
  (`starter`/`business`/`multi-store`) picked up the recommended R500/terminal +
  R10,000 setup. **Consequence for the live fleet:** those plans no longer
  auto-invoice; the office sets a per-terminal rate in the Plans UI to restore
  renewal, or raises custom invoices with an agreed amount.
- **Domain services**: `services/pricing.ts` holds THE canonical calculator
  (`licensed terminals × rate`; `null` for custom — never a guess);
  `services/terminalLicences.ts` owns the purchase and its allocation rules
  (sum of allocations ≤ licensed count, allocation ≤ plan ceiling, configured tills
  ≤ allowance); `subscriptions.ts` entitlements gained the licensed quantity and a
  per-store allowance; `billing.ts` bills the licensed quantity, puts the onboarding
  charge on the first invoice only, refuses an amountless invoice for a
  custom-priced client, and the renewal sweep skips custom (with a
  `customPricingSkipped` count in its summary). Payments now record `completed`
  rather than `processing` (§27's confirmed-settlement flow).
- **Licence**: an additive `maxTerminals` claim carries **this store's** allowance
  beside `maxTerminalsPerStore` (the plan ceiling); omitted on Head Office licences.
  Every issue site passes it, and the store's licence is the register's cap.
- **APIs**: `PlanOut`/`CompanyOut`/`StoreOut` carry the new fields (a
  `subscription` block on companies and on `GET /api/clients/:id`); plan writes
  validate integer cents and require a rate above zero for `per_terminal`;
  `PUT /api/clients/:id` edits the purchased quantity, the allocations and the
  onboarding status; store create/PUT/push refuse allocating or configuring beyond
  the licence — including the honest gate that a client with **zero** licensed
  terminals cannot take a store until the quantity is stated. `HttpError` gained an
  optional machine-readable `code`, surfaced by the error handler.
- **Tenant (za-pos)**: `maxTerminals` mirrored in the claims interface (store +
  panel); `claimDevice` refuses a NEW claim beyond the allowance (402
  `terminal_limit_reached`) while a device _moving_ keeps its claim and existing
  claims are never revoked; `configure` refuses a count above the allowance;
  `/api/runtime-config` publishes `subscription.maxTerminals`; the register's types
  carry it. **325 tenant tests green (32 suites)**; typecheck + build clean.
- **UI**: Plans page rebuilt to PLAN / CAPACITY / PRICING / FEATURES with per-terminal
  pricing and the list showing "R500.00 / terminal / month · Setup R10,000.00 once-off"
  or "Custom pricing"; the client wizard takes **licensed terminals per store** and
  quotes the recurring + onboarding figures live (§33/§34); the client page gained a
  subscription card and a licence-allocation editor ("Total allocated 9 / 9"); the
  invoice view itemises "N licensed terminals @ R500"; store cards show
  `N licensed` beside configured/claimed/open; the advanced Companies page sets the
  purchased quantity. One shared `lib/money.ts` formatter replaced the copies.
- **Tests**: CP **159 green across 13 suites** (+27: `subscription.test.ts` ×10, new
  billing cases, plan validation, the licence claim, migration reshape/backfill).
  Verified the §36 list end to end, including "claiming/unclaiming devices does not
  change the subscription amount" and "Enterprise custom pricing never
  auto-calculates".
- **No commit** (house rule). Deferred and documented in `tidbits.md`: pro-rata
  upgrades, per-invoice VAT, subscription snapshots/grandfathering, a payment
  gateway, the per-branch onboarding fee (§14), and the register's "N of M licensed"
  display line.

## 2026-09-13 (later still) — panel 404s diagnosed: missing CONTROL_PLANE_TOKEN; token reveal added

- Owner hit `urban-threads-ho is down: … status failed: Not found` on
  Diagnostics and Push Licence. Diagnosis against the live panel (:3260):
  `/health` answers `vula-head-office` (right app, healthy), but
  `/api/internal/*` 404s **even with the correct registry token** — the
  panel's process had NO `CONTROL_PLANE_TOKEN` env, and an unconfigured
  panel hides its whole vendor surface behind 404 (by design, not a bug).
  Proven by a throwaway instance on :3263 with the token set → 200.
- Fixed locally: `CONTROL_PLANE_TOKEN=<registry token>` written to
  `za-pos/.env` (loaded via dotenv on restart) — **the panel process needs a
  restart to pick it up**. hm-spares-ho (:3262) needs its OWN token (same
  repo .env applies to whichever panel loads it — per-instance env for
  multi-panel dev). kloof-auto-spares-ho (production) needs the env added in
  Coolify; new deployments get it automatically via
  `createHeadOfficeDeployment()`.
- Product gap closed: panel tokens were NEVER revealable (unlike store
  tokens at create) — the operator couldn't configure the panel env without
  DB access. New `GET /api/panels/:id/token` (office-guarded, audited
  `reveal_panel_token`) + a **Reveal Token** button on the client Head
  Office tab.
- Tests: **132 green (12 suites)** (+token reveal test); typecheck + build
  clean.

## 2026-09-13 (later) — Support session cycle + Head Office tab as the panel surface

- **Support workflow made visible**: the modal no longer closes after
  starting — it switches to an active-session view (health, version, schema,
  config state, licence, sync, latency, tills; technical only) with the
  reveal-once temp-password action inside, a 30-minute window, and an
  explicit **End session** button. `POST /api/stores/:id/support/end`
  audits the close, so the trail shows start AND end per session.
- **Head Office tab restored between Overview and Stores** (owner clarified
  after the card experiment): the tab carries the full panel card — URL,
  status, last check, app version, licence sequence + push status — with the
  complete action set: **Diagnostics** (health + licence refresh), **Push
  Licence**, **Edit** (name/URL via PUT /api/panels/:id), and **Remove**
  (registration only, two-step confirm; deployment and data untouched).
  Single-Store clients get the upgrade entry point in the tab's empty state.
  `GET /api/clients/:id` headOffice includes the licence fields. Nav is down
  to **Clients · Plans · Billing**; /head-offices, /stores and /companies
  remain as unlinked advanced pages.
- **Card polish (owner feedback)**: store-card actions (Diagnostics …
  Pause/Resume/Remove) sit on their own full-width row with the More menu
  expanded inline (no dropdown), terminals strip separate — the columns
  spread out on the client page.
- Tests: **131 green (12 suites)**; typecheck + build clean.

## 2026-09-13 — stores accessed through the client (nav link removed)

Owner: "I don't want the stores link. The stores should be accessed through
the Client card."

- **Stores removed from the nav** — Clients · Head Offices · Plans · Billing.
  The `/stores` fleet page still exists for cross-client ops but is
  deliberately unlinked.
- **Client cards now list their stores as chips** linking straight into
  `/stores/:id`, colour-coded by derived health (rose = offline, amber =
  warning, slate = healthy/unknown). Backend: `GET /api/clients` items carry
  light store rows (`storeToOut`-derived, so the health vocabulary has a
  single source of truth).
- The client detail page's Stores tab (shared cards) and the store detail
  page's breadcrumb back to the client complete the workflow:
  Client card → chip → store detail; or Manage Client → Stores tab.
- Tests: **131 green** (+client-list store-rows assertion); typecheck +
  build clean.

## 2026-09-12 (away-session 2) — SPOG navigation & drill-down

Owner feedback: the Stores view had no link in the nav, stores should be
reached through the client workflow, and the naming needed a pass.

- **Navigation**: Clients · Stores · Head Offices · Plans · Billing now all
  linked (Stores + Head Offices were orphan routes only reachable by URL);
  CompaniesPage stays as an advanced page, linked from the Clients header.
- **One shared store card**: the card, action handlers and modals were
  extracted from the (1,497-line) StoresPage into `StoreCard` +
  `useStoreActions` + `storeModals`/`storeUi`/`storeVocab` modules. The
  client detail page's Stores tab — previously a stale, simpler duplicate
  table — now renders the same cards backed by the same actions; the backend
  embeds full `storeToOut` rows in `GET /api/clients/:id` so both surfaces
  share one data shape.
- **Store detail page `/stores/:id`**: SPOG §24 Overview (administrative
  state, licence, technical health, version, sync, configuration with
  expected/applied versions, devices roster) + a per-store audit trail
  (`GET /api/stores/:id/audit`, target-filtered). Reached by clicking a store
  name on the fleet page or the client page; the card's Client column links
  back to the client. Configure/Diagnostics/Support/Push/More all work there.
- **Naming**: the merchant account is **"Client"** in every user-facing
  string (PanelsPage's 46 "Merchant" labels included); "Company accounts"
  survives only as the advanced page; API/type field names and the CONTEXT
  glossary are unchanged.
- Tests: **131 green (12 suites)** (+per-store audit test; client-detail
  embed assertions); typecheck + frontend build clean.

## 2026-09-12 (away-session) — L5 closed and the SPOG Stores screen shipped

Owner away; instruction: continue the list and complete the SPOG. Three
workstreams landed across both repos.

- **L5 Head Office entitlements** (za-pos): the panel now gates its
  multi-store business operations on the company licence — new
  `requireFeature(key)` middleware returns `402 feature_not_in_plan` on
  catalogue writes + branch pushes, stock-transfer create/dispatch/receive/
  cancel, cross-branch stock lookup and branch register/edit/delete. Reads
  stay open (suspension never hides merchant data) and unlicensed dev panels
  stay permissive. The licence a panel stores already carries the feature
  claims, so no wire change was needed.
- **Store telemetry (internal API v0.4.0)**: za-pos exposes
  `GET /api/internal/telemetry` — app version, schema version (SQLite
  `user_version`, now stamped = 1), environment, heartbeat, per-till
  claim/session state and last successful device sync. Technical only (§40);
  device `lastSeenAt` and queue counts are nullable until device heartbeats
  exist, so the contract will not change when they land. The CP fetches it on
  every health check and in the automated sweep, persisting
  `app_version` / `schema_version` / `last_heartbeat_at` /
  `last_telemetry_json`; `StoreOut` derives a telemetry summary (sync +
  configured/claimed/open/online). The dev stub mirrors the shape.
- **SPOG Stores screen** (per `~/Downloads/vula-control-plane-agent-ui-revision.md`
  §45/§47): POS profile (+ `custom`, which seeds no starter pack, mirrored in
  za-pos `vertical.ts` and the Settings picker); Environment field (defaults
  to the CP's own environment); Version + versioned Config-state columns
  (Current/Pending/Failed with expected/applied versions); derived technical
  Health (Healthy/Warning/Offline/Unknown — entitlement trouble or config
  drift raises Warning) shown separately from the administrative state; a
  Licence column (Active/Trial/Expiring/Grace/Suspended/Unlicensed); terminal
  summary (configured · claimed · open) and last-sync on the roster strip;
  actions renamed Diagnostics / Configure / Push Config / Support / More with
  Pause/Resume/Remove inside More; a Diagnostics modal (technical rows only)
  and an audited Support-session modal (reason, 30 min, optional one-time
  temp password); summary cards reordered technical-first plus a second row
  (Active/Paused/Sync issues/Licence warnings); filters
  Healthy/Warning/Offline/Paused/Config issue/Sync issue; search by
  name/slug/domain/store ID.
- Tests: CP **130 green (12 suites)**; za-pos **315 green (32 suites)**
  (+L5 gate suite, +telemetry test). Typecheck + production builds clean on
  both.

## 2026-09-12 (later) — F1 CP ops hardening complete

The phase is now fully closed. Three items were still open after the
production-readiness pass; all shipped:

- **Last errors persist**: `last_config_error` / `last_health_error` columns
  (DDL + ensureColumns + schema.sql). Every outcome site records the reason —
  the push route, health route, the automated sweep and store provisioning —
  and recovery clears it. The fleet card shows the message under the Health
  and Config badges (truncated with a full-text title), so a red state
  explains itself across refreshes.
- **Custom till names**: `terminal_names_json` on the stores row;
  `terminalRoster()` resolves names (blank slot → "Till N") and feeds EVERY
  configure push — including `wire_topology`, which previously regenerated
  "Till N" and would have clobbered custom names. The edit modal gains
  per-till inputs (prefilled via `StoreOut.terminalNames`), the roster tiles
  show custom names, and `PUT /stores/:id { terminalNames: null }` reverts.
- **Plans deactivate toggle**: Deactivate/Re-activate row action with
  Active/Archived pills; the plan-code field is read-only in edit mode since
  codes are immutable now.

Tests: **130 green across 12 suites** (+1 till-name lifecycle, +error
persistence assertions); typecheck and production build clean.

## 2026-09-12 (night) — production-readiness P0 set shipped ("fix first before continuing")

Owner made the sequencing call: the review's fixes come before F1. Shipped in
one pass across both repos; **no commits made** (house rule: commit only when
instructed).

- **Orchestration truthfulness** (`clientOrchestrator.ts`): required
  operations (Coolify application create) fail the step and job; best-effort
  operations (admin bootstrap, first config/licence push) complete the step
  with recorded `warnings_json` (new column; amber "complete · warnings" in
  the stepper UI). The orchestrator now persists `coolify_uuid`/`volume_name`
  immediately after creation and skips creation when the UUID already exists —
  a retry re-triggers deploy instead of duplicating the application.
- **Real Head Office deployment**: `createHeadOfficeDeployment()` in
  `services/coolify.ts` (name `vula-ho-<slug>`, `dockerfile_location:
head-office/Dockerfile`, env `HO_DB_PATH`/`HO_JWT_SECRET` + lease keys); the
  new `head-office/Dockerfile` in za-pos builds and starts the actual HO app
  (build verified locally with docker). `panels` gained
  `deploy_status`/`coolify_uuid`/`volume_name`.
- **Credentials**: `AdminPassword@123` is gone — the orchestrator uses the
  storeProvisioning CSPRNG generator and discards the password (operator
  issues a login via the reveal-once reset, house D4 posture). The panel got
  `POST /api/internal/admin/init` (one-time, 409 once a user exists) so the CP
  can bootstrap HO admins. za-pos demo seeding (executive account + Urban
  Threads categories) is now gated by `SEED_DEMO_DATA` — default off in
  production, on in dev/test.
- **Topology both ways**: `stores.head_office_token` (new column) holds a
  per-branch credential generated at wiring time; `wire_topology` pushes it to
  the branch via the configure payload AND registers the branch in the panel's
  roster via the new `POST /api/internal/branches` (upsert by slug, panel-token
  guarded). The old behaviour (pushing the panel's vendor CP token to branches)
  is gone. za-pos `branch_stores` gained `head_office_token` and its store
  client prefers it when calling branches.
- **billing_settings rebuilt per-company** (`company_id` is now the natural
  key; the unused `auto_renew_subscription_id` dropped) — the second company's
  settings save no longer violates `CHECK (id = 1)`.
- **Auto-renewal is settlement-gated**: the sweep creates the renewal invoice
  but never records a payment by itself; `paid_through` moves only on an
  explicit settlement (office-recorded payment now, provider webhook later).
  `BILLING_SIMULATE_RENEWAL_SETTLEMENT=true` restores the demo behaviour.
- **Plans**: seeded `Retail` → `Business` (one-time code migration),
  `plan.code` immutable via the API (400 otherwise), inactive plans refused at
  onboarding/company assignment and filtered from the wizard dropdown.
- **Privacy**: `vat_reg_no` dropped from the CP stores DDL, DTOs, forms, tests,
  stub and smoke script (DROP COLUMN migration for live DBs) and `vatRegNo`
  removed from za-pos `/api/internal/control/status`; the store's Head Office
  routes accept the vendor CP token only with
  `ALLOW_CONTROL_PLANE_TOKEN_FALLBACK=true` (migration-only, default OFF).
- **Tests**: CP **129 green across 12 suites** (+8 new: orchestration
  truthfulness ×4, billing_settings/Retail migrations ×2, plan immutability +
  inactive-plan ×2); za-pos **311 green across 31 suites** (+12: vendor
  branches ×5, admin-init/no-demo-seed ×5, CP-token-fallback gating ×2).
  Both repos typecheck clean and both production builds pass.
- **Deferred to the next milestone** (deliberately): `plan_prices` per-store
  pricing, subscription snapshots, the legacy
  `branch_stores.control_plane_token` column rename in za-pos, and the §38
  full lifecycle suites.

## 2026-09-12 (evening) — external production-readiness review received, code-verified and captured

- Owner shared a deep-dive review of both repos (full text:
  `~/Downloads/vula-subscription-and-platform-deep-dive-report.md`). Per
  house rule every claim was verified against the code before recording —
  **all of them check out**, including the headline: `head_office_deploy`
  calls `createStoreDeployment()` (clientOrchestrator.ts:156) and za-pos has
  no `head-office/Dockerfile` (root CMD `node dist/server.js` = store app
  only), so orchestrated "HO deployment" cannot boot the HO app today.
- Also confirmed in this repo: steps marked complete despite swallowed
  failures; `createStoreDeployment` results discarded (no coolify_uuid
  persistence in the orchestrator path); one-directional `wire_topology`
  (branches never registered in the HO); `AdminPassword@123`
  (clientOrchestrator.ts:209); `billing_settings` `CHECK (id = 1)` singleton
  vs per-company inserts (the second company's save will throw); renewal's
  synthetic `manual` payment (billing.ts:332); flat `price_cents` plans with
  a seeded tier named `Retail`.
- **Docs vs code disagreement flagged (findings.md):** progress claimed
  `vat_reg_no` was removed from CP forms/DTOs on 2026-09-11 — it is still in
  the DDL, `StoreOut` and the StoresPage forms; the route has never changed
  since the initial commit. Decision needed: remove the field or fix the note.
- Captured: verified findings → findings.md; proposed phase set
  "production-safe Multi-Store provisioning + subscription foundation" →
  task_plan.md (P0/P1/P2 + integration tests; sequencing vs F1 is the
  owner's call — noted in Current Phase); smaller commercial/ops items →
  tidbits.md. **No implementation started** — awaiting the owner's go-ahead
  and sequencing decision.

## 2026-09-12 (later) — L4 store side shipped in za-pos; L4 complete on both sides

- The za-pos workstream implemented the store half of the §2b contract the same
  day: `requireFeature` middleware (402 `feature_not_in_plan`) on debtors,
  lay-bys, customer credit fields, the range report, woo/shopify bridges, AI
  routes and Head Office calls into the branch (`multi_store`); the suspended
  gate inside `checkout()` (402 `subscription_suspended`, after the idempotency
  lookup so replays apply) covering POS, offline sync replay, order collection
  and quotation conversion; the `subscription` block in `/api/runtime-config`;
  and the register warn/grace/suspended banner + feature hiding.
- za-pos tests: 299 green across 29 suites (+13 enforcement); doctrine in its
  `CONTEXT.md` §14a. Both repos pushed on `dev`. **Next: F1 CP ops hardening.**

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

## 2026-09-14 — demo registry rebuilt: 10 clients, 9 stores, nothing unassigned

Owner: "remove all plans and stores and reseed with new data, use same Company
names, no 'Unassigned — no client'." The registry had accumulated 16 store rows
for 9 real deployments — 7 pointed at nothing (3 Kloof on production domains, 2
Cresta, 2 AHK whose URL was `https://ahk-dbn-gw.localhost:3254`, https on a local
port) — and 5 of the 9 live stores had no client at all.

**New tool: `scripts/reseed-fleet.ts`** (also `--dry-run`). It reads each store's
env file (`PORT`, `CONTROL_PLANE_TOKEN`) and its own database (`store_name`,
`vertical`, till count from `terminals`) and recreates the registry through the
control plane's API — so nothing is invented, and the panel and the store cannot
disagree. It refuses a non-empty registry unless `--force`, and it validates that
every store's tills fit its client's plan ceiling _before_ writing anything (that
check caught the real ceilings: the freshly seeded tiers cap at 2 / 10 / 10 / 99).

Adopting the env's existing token is the point: a minted one would 401 every push
and show the whole fleet Offline while each store API was healthy — the failure
mode the fleet already hit once on 2026-09-14. Every store reported `config=ok`,
which is the proof the tokens match.

Result: **10 clients · 9 stores · 5 Head Offices · 0 unassigned**. Kloof Auto
Spares, Cresta Grocers and AHK Spares keep their names (chosen by the owner) and
hold a Head Office panel each, but own no store. Plans reseeded to the four
defaults (the three Vula Market tiers are gone) and invoices/payments cleared.
Store databases themselves were left untouched.

Store base URLs are now `http://<slug>.localhost:<port>`; a health sweep over
them returns 9 stores up, 1 Head Office up, and the 4 panels that have no local
deployment down (expected: hm-spares-ho's :3262 is not started, and the three
production panels point at domains that are not live).

Two consequences worth the owner's attention:

- **Starter caps at 2 tills**, so the 3-till demo stores (Brake & Bolt Spares,
  Builders Hardware) cannot buy the entry tier and sit on Business.
- **Everyday Retail's 25 tills exceed every priced tier**, so it had to go on
  Enterprise — which is `custom`-priced, meaning no rate and no automatic
  invoice. Raise a priced tier's ceiling, or lower that store's tills, to show it
  on a normal plan.

The old registry is preserved at `~/vula-store-data/backups/pre-reseed/`
(`.db` + `-wal`; SQLite needs both).

## 2026-09-14 — the plan catalogue, and every Head Office on a local URL

Owner supplied the real catalogue and two constraints: the eight tiers are
**Vula Start (1 store, 1 till) · Vula Grow (1, 3) · Vula Branch (3, 2) · Vula
Network (5, 3) · Vula Market (1, 10) · Vula Market Plus (10, 15) · Vula Market
Enterprise (50, 20) · Vula Spares Network (50, 5)**, priced at the house default
(R500/terminal/month + R10 000 setup) until they say otherwise; and in dev
**every** Head Office is `<slug>.localhost:<port>`, never a `vula-app.co.za`
domain.

Two things that shaped how the catalogue is applied:

- **A catalogue built from scratch does not survive a restart.** `seedPlans`
  re-inserts any of its own codes that are missing, so deleting the four
  bootstrap plans only hides them until the next boot, which would leave twelve
  tiers. So the four bootstrap codes are **updated in place** into Vula Start /
  Grow / Network / Market Enterprise, and the other four are created. The cost is
  a code/name mismatch (`business` is displayed as "Vula Grow"); the benefit is a
  catalogue that stays at eight across restarts.
- **Therefore the eight are a demo registry catalogue, not the product's.** If
  they should be what a fresh control plane seeds, they belong in `SEED_PLANS`,
  which drags in the plan migrations and ten test files — a deliberate change,
  not a seeding one.

`Everyday Retail` was reconfigured from 25 tills down to 20 (owner's call) so it
fits a plan at all: 25 exceeded every cap, including Vula Market Enterprise's.
The push took, and the store now reports 20 terminals.

Head Offices: all five panels now point at `<slug>.localhost` on 3260/3262/
3264/3266/3268, and the reseed tool creates each panel's instance if it is
missing — its own env file with a distinct port, database and JWT secret (two
panels must never share a branch registry). It **adopts** the original
`head-office.env` for the primary panel instead of minting a second file, since
that file's database path is where the running panel's branch registry lives.

Final state: 8 plans · 10 clients · 9 stores · 5 Head Offices · 0 unassigned.

## 2026-09-14 — plan codes derived from plan names

Owner: "make sure plan codes are based on Plan name". The eight tiers were
seeded with codes like `business`, `multi-store` and `enterprise` while their
names read Vula Grow / Vula Network / Vula Market Enterprise — a mismatch
invisible in the UI but wrong in the API, the licence claims and any script.

Now the catalogue lives in `SEED_PLANS` under name-derived codes (`vula-start`,
`vula-grow`, `vula-branch`, `vula-network`, `vula-market`, `vula-market-plus`,
`vula-market-enterprise`, `vula-spares-network`), all eight priced per terminal
at the house default.

- **A migration renames rather than duplicates.** `seedPlans` re-inserts any of
  its own codes that are missing, so retiring `business` without a migration
  would leave a registry holding both `business` and `vula-grow` on the next
  boot. `renamePlansToNameCodes` renames the four retired codes in place — ids
  untouched, so every company's plan reference survives — and only when the
  target is absent, so a reseeded registry is left alone.
- **Two neighbouring migrations had to be corrected**, because they refer to the
  codes of their own era and run _before_ the rename: `restructurePlans` keys on
  `enterprise` to keep that tier custom, and `renameRetailPlanToBusiness` maps
  the historical `retail` onto `business` so the new step can carry it on to
  `vula-grow`.
- None of the eight is custom any more, so the two billing tests that relied on
  the seeded Enterprise being custom now mark a tier as negotiated themselves —
  which is what the Plans screen does.

Verified on the live registry: after a restart the catalogue reads as the eight
name-derived codes and all ten clients kept their plan. Tests: **195 green
across 17 suites**.

## 2026-09-14 — nine new branches, and the reseed tool made re-runnable

Owner: the merchants whose Head Office had no branches (Kloof Auto Spares,
Cresta Grocers, AHK Spares) should get three stores each — jhb, dbn, ct — with
data; and `kloof-autu-spares` was a typo for `kloof-auto-spares`.

- **Typo fixed** in the registry (company slug, panel slug, panel name and
  base_url), the env file and database file on disk, `fleet.sh`, the readme and
  this tool. Verified: `http://kloof-auto-spares-ho.localhost:3264` answers. (The
  old name still answers too — `*.localhost` all resolves to loopback, so the
  hostname is a label, not a virtual host.)
- **Nine stores created** (`fleet.sh create`, which also provisions each branch's
  Head Office token), each seeded with the retail demo dataset — 26 products and
  52 orders — and their `store_name` and `vertical` restored afterwards, because
  that seeder hardcodes "Kasi Fresh Mart" and its `--force` wipe resets the
  vertical to the default. Three tills for each JHB branch, two for DBN and CT.
- **`reseed-fleet.ts` is now idempotent**: it reuses existing clients, skips
  already-registered stores, and updates panels in place (by numeric id — the
  panel routes do not accept a slug). It refuses only a registry holding stores
  it does not manage, and the dry run prints the whole plan without writing.
- Result: **18 stores · 10 clients · 5 Head Offices · 0 unassigned**, 64 tills
  plus 5 offices, and a health sweep reporting **23 up, 0 down**.

Still outstanding: the panels do not yet list their branches. `branch_stores` is
populated by the control plane's topology wiring (or by hand on the panel's
Stores page), and neither the reseed tool nor the store-create path does it —
each new branch's `head_office_token` is provisioned on the store side but never
registered with its merchant's panel.

## 2026-09-14 — every Head Office gets its branches

Owner: `http://kloof-auto-spares-ho.localhost:3264/stores` showed no stores —
"register for all HO that don't have registered stores".

`reseed-fleet.ts` now finishes the wiring: after registering the stores it calls
each panel's `POST /api/internal/branches` (upsert by slug) for every branch of
that merchant, authenticated with the panel's own `CONTROL_PLANE_TOKEN` from its
env file — the registry never serialises that token, so the env file is where the
tool can honestly get it.

Two things the token work exposed:

- **The demo seeder's `--force` wipe takes the branch's Head Office token with
  it.** `fleet.sh create` provisions one, the wipe removes it, and the panel then
  refuses the registration with a 400 — the same two-sided-credential gap that
  made the whole fleet look Offline on the 14th, one layer down. The tool now
  renews a missing token on the store (`settings.head_office_token` +
  `head_office_enabled = 1`) before registering, which is the control plane's job
  in this design anyway.
- **`PUT /panels/:id` needs the numeric id, not the slug** (`400 Invalid store
id` otherwise) — caught on the first live run, after the stores had registered.

Result, verified by reading each panel's `branch_stores` and comparing every
token against the branch's own settings: **13 branches across 5 panels, all
paired** — Urban Threads 3, HM Spares 1, Kloof 3, Cresta 3, AHK 3.

## 2026-10-06 — the deployed demo fleet's Head Office wiring, fixed live

The demo fleet's Urban Threads Head Office reported `Invalid control plane token`
on every branch ping. Reading the three databases side by side explained it: the
panel's `branch_stores` rows carried a stale `control_plane_token` and a NULL
`head_office_token`, while each branch accepted its own env `CONTROL_PLANE_TOKEN`
on the vendor routes and its `settings.head_office_token` on the merchant routes.
The panel therefore sent no merchant header at all, and its legacy fallback
carried the wrong vendor token. The rows now carry the two credentials the live
branches actually accept (read on the box, never printed); all three branches
ping `up` from the panel.

Two more found the same way:

- **The demo panel still pointed at the retired `demo-ho` hostname** — probes
  said "no available server" (an edge 503) because the deployment now answers on
  `demo-urban-threads-ho`. `PUT /api/panels/5` re-probed the new URL and health
  came back `up`. The registry was the one place a renamed deployment's URL had
  never been updated.
- **The nightly demo-reset goldens predated the fleet repair**, so the 02:17
  restore would have reinstated the stale URLs and tokens. All seven goldens were
  re-snapshotted (`sqlite3 .backup`) from the live volumes.

The branch rows were written directly (no panel API exposes the merchant
credential); the path that normally sets them — the wizard's `wire_topology`
step — only runs for CP-created deployments, and this demo fleet was assembled
by hand around the seeded databases.

## 2026-10-06 — the fleet's data moved onto the host tree

The demo fleet and both control planes kept their `/data` on Docker named
volumes — the fallback Coolify 4.3.23's API forced (binds are refused:
`host_path` is "not allowed", `type: bind` is invalid, and there is no
server-execute endpoint to work around it). The owner asked for the agreed tree:

    /data/apps/vula-app/control-plane/<env>/control-plane.db
    /data/apps/vula-app/clients/<client>/head-office/head-office.db
    /data/apps/vula-app/clients/<client>/stores/<store>/za-pos.db

Each of the 13 deployments was migrated with a verified procedure: stop → copy →
`diff -rq` → park the original under `/root/vula-migration-backup` → remove the
container and volume → recreate the volume **of the same name** with
`--opt type=none --opt device=… --opt o=bind` → deploy from Coolify. The volume
keeps its name, so Coolify's configuration is untouched; the volume's `_data`
and the tree path are the same inode. A pilot store went first, including a
deliberate second redeploy to prove the bind survives Coolify's rebuilds; two
rehearsal apps needed one redeploy after a race with the volume swap. All 13
verified healthy afterwards, with logins. Data: ~18 MB in total.

Rolling with it:

- `vula-backup.sh` mirrors the tree into `/backups/vula-app` (the old
  `/backups/vula` renamed), skips bind-backed volumes in its legacy-volume
  sweep, and no longer prunes the goldens (`-prune`/`-delete` cannot combine —
  it uses `-exec rm`).
- `vula-demo-reset.sh` restores goldens into the new paths, logs to
  `/var/log/vula-demo-reset.log`, and was run in anger as the test (jhb matched
  its golden exactly: 1467 orders, 2 till claims).
- Crons staggered: backup 02:10, reset 02:17 — a same-minute race could catch
  the reset mid-swap under a running backup.

Provisioning: `coolify.ts` now emits the canonical host path
(`vulaHostPath(kind, clientSlug, slug)`) in its result and names the exact host
command in its warning when Coolify refuses the bind;
`scripts/vula-bind-storage.sh` performs that step safely for any deployment,
new or old. Fully autonomous bind creation would need the CP to hold the
docker socket (or a mounted host tree) — deliberately not granted (tidbits).

## 2026-10-07 — watch paths, so a site change stops rebuilding the fleet

Every app watching a repo branch redeployed on **any** push to that branch,
because Coolify's `watch_paths` was blank and its code says exactly that:
blank watch paths → deploy on every push; set → deploy only when a changed
file matches (with `!` negations, last match wins). One repo holds the site,
the stores, the Head Offices and (separately) this control plane, so a
marketing commit rebuilt all eleven tenant apps — and the website then queued
behind ten builds.

Now set, from the apps' real build inputs:

- stores and Head Offices (11 apps, repo `vula-app`): `**` minus
  `marketing/**`, `docs/**`, `prompts/**`, `plans/**`, `*.md` — code changes
  still deploy, unknown paths still deploy (fail-safe), site and doc edits do
  not.
- the website: `marketing/**` only — store commits no longer rebuild it.
- both control planes (repo `za-pos-control-plane`): `**` minus `prompts/**`
  and `*.md`.

Verified against Coolify's own matcher before applying, and end-to-end after:
a marketing-only commit (`4aab8954`) queued exactly one deployment — the
website — and no store. A marketing-only change now takes about a minute
instead of queueing behind ten rebuilds.

## 2026-10-07 — two new demo verticals, a rename, and the deployment plumbing straightened out

Owner brief: _"I want to add more demo store types — Hardware / Pharmacy"_,
_"so dont need to backup the demo stores"_, _"change the name of the
Restaurant — myDiner is a real restuarant name"_, later _"HO: make Base URL
clickable so can navigate to store"_ and _"update all docs"_.

- **Demo Hardware** (`demo-hardware.vula-app.co.za`) and **Demo Pharmacy**
  (`demo-pharmacy.vula-app.co.za`) are live. Seeded from the dev fleet's
  existing `builders-hardware` / `medisave-pharmacy` packs (30 and 27 product
  lines with ~1,400 sales of history each), onboarded through the staging
  control plane as real single-store clients (vula-demo plan, licensed 10,
  paid through 2099), placed on the bind tree, watch paths set, goldens
  snapshotted, and both added to the nightly reset. The wizard's missing
  vertical (findings) had to be corrected on both by hand — PUT plus a
  re-push.
- **The restaurant is Demo Diner** — live database, golden, seeder, marketing
  card and docs. All three new names read "Demo …" so they cannot collide with
  a real business.
- **Backups skip the demo clients** (`demo-*` / `*-demo`): they reset to
  goldens nightly and are regenerable from the seeders, so their dailies were
  noise. The rehearsal clients and both control planes stay covered — verified
  by running the job and reading what it wrote.
- **The Head Office's branch Base URL is a link** into the store (new tab,
  hover-underline, titled) — `head-office/frontend/src/pages/StoresPage.tsx`,
  verified in the served JavaScript bundle on both Head Offices, not just by
  "the deploy finished".
- **Watch paths refined per image**: stores no longer rebuild for a
  `head-office/` change and Head Offices not for `frontend/`; `scripts/**`
  deliberately stays watched because the production build compiles it into
  both images. Documented in the marketing README.
- **Coolify's deployment queue wedged for ~half an hour** — nothing deployed
  and it first looked like missed GitHub webhooks. `horizon:terminate` left it
  half-down; restarting the coolify container fixed it, and Coolify marked the
  12 stuck deployments as failed. Findings and tidbits carry the diagnosis and
  the remedy.
- Docs swept: both deploy runbooks to the new tree, the marketing README's
  deploy rules, the tenant deploy prompts, and this repo's planning files
  (task plan's current phase + `## Next Step`, findings, tidbits).

## 2026-10-08 — the control plane's release path is deliberate now

Both control-plane apps have **auto-deploy off**. The prompt was a release
showing two deployments per app in Coolify: the GitHub webhook delivers late
on this host (one to two minutes — sometimes not at all), so the manual
trigger I use when it goes quiet raced it, and the same commit built twice,
serially. For two apps released by hand anyway, deterministic beats
convenient: push, then deploy once (`POST /api/v1/deploy?uuid=…`, or the UI's
Redeploy). The setting lives on the application's _settings_, not the
applications row (`is_auto_deploy_enabled` reads NULL on the model; the
`application_settings` relation holds it). Documented in
`prompts/deploy-coolify-control-plane.md`; the store apps keep auto-deploy on
and rely on their watch paths.

**Same day, hours later — the fleet followed.** Two code commits landed on
`main` (the tenant workstream's `refactor(ui)` and `feat(demo)`) and rebuilt
thirteen apps: nine builds finished in 45 minutes while the rest sat queued,
which read, fairly, as a stuck queue. Nothing was stuck — but auto-deploy on
`main` means every development commit is a fleet release, so the fleet's
auto-deploy is **off** too (all thirteen tenant apps; the website stays on, so
a marketing push still publishes the site). The release path is now
`scripts/release-apps.sh` (`fleet` | `cp` | `all` | `<name>` | `list`) — one
command, Coolify still builds four at a time, and the rebuild happens when
someone chooses it. Verified: `vula-website` reads `auto_deploy=true`, the
stores and Head Office read `false`, and the push carrying this note queued
nothing.

## 2026-10-09 — warehouses: a store that doesn't sell

Owner question ("HO: IBT should we have warehouse to branch transfer"), then the two
decisions that shape it: a warehouse **does not consume the plan's store allowance**, and it
**runs no tills**. The transfer machinery never needed them — a transfer's two ends are
`stores` rows and the branch-side dispatch works on the _calling_ store's own catalogue by SKU
(decrement with an oversell refusal) — so the work was the label and its consequences, not the
movement.

**Schema.** `stores.kind` (`'store' | 'warehouse'`, default `'store'`) as an additive column,
with the DDL updated too. `terminal_count`'s CHECK relaxed from `BETWEEN 1 AND 99` to
`BETWEEN 0 AND 99` — SQLite cannot alter a CHECK, so the existing `rebuildTable` helper does a
guarded one-off rebuild (probed from `sqlite_master`, copying the **live** column list into the
now-complete `STORES_DDL`). Rehearsed against a `.backup` copy of the live registry before
anything else: 64 stores in, 64 out, identical row checksum, 64 terminal licences intact,
`foreign_key_check` silent, every column present, and 0 accepted while 100 and -1 are still
refused.

**Rules.** `countStoresForCompany` counts `kind = 'store'` only; the store-cap check is
**skipped** (not merely satisfied) for a warehouse, because a plan whose selling stores have
used the allowance would otherwise refuse the client's own back-of-house; a warehouse draws no
terminal allocation; `checkConfiguredTerminals` accepts 0 for a warehouse and nothing but ≥1
elsewhere; the orchestrator deploys a warehouse with `terminalCount: 0` (its `|| 1` would have
handed it a till); the store form offers Store/Warehouse and hides the terminal count; and the
configure payload carries `kind` on the wire — a tenant contract change, flagged for `za-pos`
below. The branch roster carries `kind` too, so the merchant's panel takes the label from the
control plane rather than asking for it again.

**Tenant side (flagged, done the same day in `~/apps/za-pos`):** `/api/internal/configure`
accepts `terminalCount: 0` **only** when the payload says `kind: "warehouse"` — a store
configured with no tills would quietly drop the device-claim enforcement — and the panel's
branch row, Stores badge and Transfers source list gained the same idea. `CONTEXT.md` documents
both (§glossary `kind`, the configure contract row).

Tests: 365 backend (+4 warehouse rules) and 24 UI (+2 form), typecheck clean.

## 2026-10-09 — the plan seed catches up with the prices we actually charge

The plan catalogue in code had drifted from the catalogue we sell: `SEED_PLANS` still seeded
every tier at **R500/till and R10 000 once-off**, while the live registry's rows — priced by
hand on the Plans page — say **R100–R150/till with R3 000–R6 000 setup**. Nothing broke, and
that is the point of the finding below: `refreshSeedPlanDefaults` only fills plans that are still
_unpriced_, so a fresh registry would have come up quoting R500/till to a new client while
production says R100–R150.

`SEED_PLANS` now carries the live rates, setup fees and the operator's sort order, with a comment
naming the rule: these numbers are the approved prices, and the Plans page (not this seed) is how
an existing client's price changes — a live client's price is a snapshot, never a re-derivation.

Repricing the seed moved 20 assertions across five suites (billing, pricing, subscription,
companies, migration), which is the measure of how deeply the old figures were baked in. Where a
test is about the _arithmetic_ (quantity × rate, the once-off added once) it now derives from the
payload's own `rateCents`/`setupFeeCents`, so the next price change touches one place — the seed —
instead of five files; where a test pins a _price_, it states the new number with the plan it came
from. 365 tests green, typecheck clean.

**Still to do — the add-on model (owner picked it, one call outstanding).** The approved pricing
page sells six monthly add-ons, and the product can only _grant_, not _bill_, features: a plan's
`features_json` is a list with no price, so an invoice has no line for "Head Office R99". Adding
that means per-feature prices on the plan, the purchased set on the client's subscription, a line
per add-on on the invoice, and the licence's `features[]` coming from what was bought. The one
call: two of the six add-ons have **no distinct entitlement** behind them today —
`laybys.ts` gates on `customer_credit` (so "Lay-by" and "Credit accounts" are one key) and the AI
routes gate on `ai_assistant` (so "Upload invoice" and "AI Copilot" are one key). Either the
product grows `layby` and `invoice_import` keys — with a migration granting them to every client
that already has the parent key, so nobody loses a feature they have — or the page groups those
pairs into one priced item. Recorded in `tidbits.md`.

## 2026-10-10 — the keys are split, and the add-ons can be sold

Owner: **"split the keys"** — the call I asked for. The pricing page sells six monthly add-ons, and
the product could only _grant_ features: a plan's `features_json` was a list with no prices, so an
invoice had no line for "Head Office R99". Two of those six had no entitlement of their own —
lay-bys were gated on `customer_credit`, and the supplier-invoice importer was gated on **nothing
at all** (with an AI key configured, anyone had it, while the page sold it at R99).

**The vocabulary grew to eight keys.** `layby` and `invoice_import` join `services/features.ts` —
the curated contract both applications read — with labels, descriptions and where each is
enforced. Every plan that already granted the parent keeps granting the child: the migration only
ever ADDS, so no client loses a feature, and a plan's own list is otherwise left exactly as the
office set it.

**A plan now prices its add-ons** (`feature_prices_json`, seeded from the approved page: R99 for
Head Office / AI Copilot / Upload invoice, R49 for Credit accounts / Lay-by / E-commerce), and the
Plans page edits them via `PUT /api/plans/:id`. **A subscription records what the client bought**
(`features_json` + an agreed-price snapshot in `addon_prices_json`), bought through the client
editor (`PUT /clients/:id` and `/companies/:id`) — each add-on listed with its price, ticking one
snapshots the price at that moment, because buying an add-on IS agreeing a price. **An invoice
itemises them** (`addons_json` on the invoice, one line each in the PDF and the email) and the
recurring total includes them, since every money path reads `quoteForSubscription`. **The licence
carries the union** — plan-included features plus what was bought — through the one place the two
are combined (`effectiveFeatures`).

The office's client card shows the add-ons and their monthly cost, and the subscription editor
offers the ones the plan prices but does not already include — selling a client what they already
have is not a thing the UI should offer.

**Two things the rehearsal caught, which is why it is run.** The additive pass's `addColumn`
helper guards on `PRAGMA table_info(stores)` — it is store-specific — so using it for a _plans_
column silently ALTERed `stores` instead, and the next boot failed with "table plans has no column
named feature_prices_json". Plans now have their own adder, and any database that ran the bad
build drops the stray column on boot (the treatment `vat_reg_no` got when it stopped belonging on
a store row). Rehearsed against a `.backup` copy of the live registry — which was itself
half-migrated, because the dev control plane's watch mode had already applied the earlier edits:
all 8 plans end up priced, every credit plan gains `layby`, the two AI plans gain
`invoice_import`, rates are untouched, and all 11 subscriptions keep exactly what they had.

**Tenant side (done in `~/apps/za-pos` the same day):** `laybys.ts` gates on `layby`,
`invoice-import.ts` on `invoice_import` (it had no gate), the register's nav gates Lay-buys on
`layby`, and `CONTEXT.md` records the vocabulary. CP tests 369 (+4), UI 24, typecheck clean.

**Same day — the plan form was missing its half.** The owner went to create a new plan and found no
Add-ons block: the price fields existed on the _client's_ subscription editor, but a plan could not
be given prices through the UI at all, and `POST /api/plans` did not read or store them either
(`createPlan` had no `feature_prices_json` in its INSERT). A plan's add-on prices could therefore
only be set by editing an _existing_ plan. Fixed on both paths: create now validates and stores
`featurePrices` (an unknown key is refused by name), and the form has an **Add-ons** section
listing the six priced features with a price each — hiding any feature the plan already includes,
because a price on an included feature is a price nobody ever pays. A new plan also now starts from
the approved prices rather than the retired seed's (R99 a till, R5 000 assisted set-up, R99/R49
add-ons), and a plan that prices nothing is legal — it bundles everything it offers.

Verified through the UI on the local control plane: created a plan, confirmed the six prices in the
registry, deleted it again (8 plans, as before). CP 370 tests (+1) and 24 UI, typecheck clean.

**Same day — the office speaks the page's language now.** Owner, looking at the Plans form: _"cp and
marketing dont match... upload invoice should have ai assisted"_. Two separate faults behind one
symptom:

- **The names disagreed.** The CP named the same six features "Customer credit", "Multi-store",
  "E-commerce bridges", "AI assistant", "Stock transfers", "Invoice import" — while the pricing page
  (and the invoice lines, which already used those words) said "Credit accounts", "Head Office",
  "E-commerce", "AI Copilot", "Inter-branch transfers", "Upload invoice **(AI assisted)**". A
  client reading an invoice saw one name and the office setting the price saw another. The
  vocabulary's labels now ARE the page's words, and `FEATURE_LABELS` (the invoice/quote map) is
  _derived_ from them, so the two can never drift again.
- **The plan form's own feature toggles listed only six keys** — a static `FEATURE_KEYS` in the
  frontend predating `layby` and `invoice_import` — so the office could not mark a plan as
  including either, and the toggles were the last place a hand-maintained vocabulary lived. Both
  keys are listed now, and the form's names are fetched from `GET /plans/features` instead of a
  local copy; the local maps are deleted. One source, eight keys, page words.

Verified in the running UI: the form's toggles read Credit accounts · Advanced reports ·
E-commerce · Head Office · Inter-branch transfers · AI Copilot · Lay-by · Upload invoice (AI
assisted), and the add-on rows read Head Office · AI Copilot · Upload invoice (AI assisted) ·
Credit accounts · Lay-by · E-commerce — the last four words identical to the pricing page. CP 370
tests + 24 UI green, typecheck clean.

**The same afternoon — three more from the owner's read of the Plans screen.** _"is marketing updated
as well: Upload invoice AI assisted / should CP plan not also show total price / features included in
plan should be separated and not something to choose."_

1. **The page now uses the same words as the office** — "Upload invoice (AI assisted)" in the add-on
   card _and_ in the quote builder's toggle (the builder reads its lines from `data-label`, so the
   quote a customer receives says it too). It had said "Upload invoice" with a separate "AI assisted"
   chip, which is the same mismatch the vocabulary change was about, one turned the other way.
2. **A plan row states its total.** Rate and once-off were there; now the row adds the one total a
   catalogue row can state honestly — the plan at ITS OWN ceiling, since the billable quantity
   belongs to each client: _"R 150,00 / month at 1 terminal per store · + R 444,00 if every add-on is
   taken"_. Both figures are arithmetic on the plan's own fields (`PlanTotalLine`).
3. **Features are a statement, not a picker.** The per-plan toggle list is gone. The form now reads
   _"Every plan includes Advanced reports · Inter-branch transfers — the product's own capabilities,
   not a per-plan choice"_, and for a tier that bundles — Vula Start is one — _"This plan also
   includes Credit accounts · E-commerce · Lay-by — its clients have these without buying them, so
   they are not priced below"_. Nothing is chosen; what a plan SELLS is the Add-ons block. Which keys
   are add-ons now comes from the vocabulary's `soldMonthly` (served by `GET /plans/features`), so the
   frontend's last hand-kept feature list is gone. A new plan is created including the base set and
   pricing the six add-ons at the vocabulary's defaults; **editing a plan never rewrites its features**,
   so the tiers that bundle keep doing so for the clients already on them.

Verified in the running UI: Vula Start's row shows the new total line; its edit form shows the three
included bundles and offers add-ons for the three it does not include; a new plan shows the base set
and all six add-ons. CP 370 tests + 24 UI green, typecheck clean, marketing rebuilt.

**Evening — the six are chargeable, so no plan may bundle them.** Owner, reading the page: _"but all
of these are chargeable"_ with the six add-on cards. He was right, and the CP was the side that
disagreed: **every tier bundled three to six of them** (Vula Network all six, Vula Start three), so
its clients were getting Credit accounts, Lay-by, E-commerce, Head Office, AI Copilot and Upload
invoice for nothing while the page sells them at R49/R99 a month. Nothing bought a single add-on
(`bought=[]` on all eleven clients).

Three changes, and a rule behind them:

- **A plan may not include a chargeable feature.** Refused by name at both plan write paths —
  _"customer_credit is chargeable — price it as an add-on instead of including it in the plan"_ —
  so the office cannot reintroduce a bundle. A plan's `features_json` is the product's base set;
  what it SELLS is `feature_prices_json`.
- **The existing bundles became PURCHASED add-ons.** The migration moves each plan's bundled
  chargeable features onto each of its clients as add-ons at the plan's own price, then strips them
  from the plan. Nobody loses a feature; the client starts paying for what the page sells.
  **Verified against a snapshot taken before it ran: all eleven clients' entitlement sets are
  identical before and after**, and the monthly consequence is now explicit — Urban Threads +R444
  (all six), Cresta Grocers and Street Gym +R246, four clients +R197, three +R147, Builders Hardware
  +R98.
- **Multi-store topology IS the Head Office add-on** — the deep end of this change. The wizard's
  and the upgrade's gate was "does the plan include `multi_store`", which is now "does the plan SELL
  it", and choosing multi-store **buys** it for the client (at the plan's price, audited) _before_
  its stores and Head Office exist, so the licences that follow carry it. A plan that prices nothing
  cannot offer the topology at all.

New plans are created including the base set and pricing the six at the vocabulary's defaults, and
editing a plan never rewrites its features — so the tiers that were mid-life keep their clients
whole through the migration above.

Tests updated to the new model (six assertions across three suites: what a plan includes, what a
licence carries, what a new plan may be created with), plus a test that a chargeable feature cannot
be bundled and its refusal says so. CP 371 tests (+1) and 24 UI green, typecheck clean, UI rebuilt.

**Same evening — choosing an add-on, and the wizard was missing it.** The owner, testing: _"now i can
choose an addon?"_ and _"i cant choose plgin when creating a new client"_. Two answers, one of them a
bug of mine.

- **Where you choose one:** the client, not the plan — _Clients → a client → Edit subscription →
  Add-ons_, six ticked rows priced from that client's plan. Verified in the UI: HM Spares shows R297
  a month with its three migrated add-ons ticked (Credit accounts, Lay-by, E-commerce).
- **A bug found while checking:** the add-on block had been inserted into the **Edit Client** modal
  instead of the **subscription editor** (my anchor matched the wrong `<select>`), and the Edit
  Client modal never sends `features` — so ticking there looked like it worked and did nothing. Moved
  to the subscription editor, where the state is seeded from the client's add-ons and the save sends
  them.
- **The wizard now sells add-ons too.** _New Client → step 1_ offers the six the chosen plan prices,
  and `POST /api/clients` accepts them: bought before any store exists, so the licences that follow
  carry them. A multi-store deployment buys Head Office whether or not it was ticked — the topology
  needs the capability — and the wizard shows that row forced. An add-on the plan does not sell is
  refused by name _before_ the company row is created.

CP 373 tests (+2: the onboarding purchase and the refusal) and 24 UI green, typecheck clean, UI
rebuilt.

**Where the two AI add-ons actually live (owner's question, 2026-10-10):** _"is there AI copilot or
similar for single stores - not upload invoice / is there upload invoice Ai assisted for HO?"_

Checked the code rather than assume, and the answer is a useful pair of facts:

- **AI Copilot is a STORE capability, and single stores have it.** It is the store's own assistant —
  _Dashboard → Ask AI_ → `/api/ai/*`, admin-only, gated on `ai_assistant` — answering from that shop's
  own figures, and it needs no Head Office. It is its own key, separate from the importer, so a client
  can buy the assistant without Upload invoice (the distinction the owner was drawing). One extra
  thing worth knowing: the **same key lights the panel's "Executive Retail AI Copilot"** (the panel
  has its own `/ai/ask`, which asks across branches), so for a group client one R99 add-on gives both
  surfaces. The vocabulary's `enforcedBy` said `store` only for `ai_assistant` — corrected to include
  `head-office`, since that gate is real.
- **Upload invoice is a BRANCH capability, and a Head Office cannot use it — by design.** The importer
  drafts a **goods receipt**; stock lives in each branch's own database and the panel holds none (it
  reads branches live), so the panel has nothing to receive into and has no such screen. The panel's
  licence does carry the key (it holds the client's entitlements), but nothing consumes it there.
  Commercially the useful part: it is bought **once per client**, not per branch — the licence reaches
  every store of that client, so one tick enables the importer in each of their branches' Purchasing
  screens.

Both descriptions in the vocabulary now say this, so the office reads the same thing.

## 2026-10-10 — the warehouse demo, and two defects it walked straight into

Standing up the `central-dc` warehouse instance (store repo's `progress.md` has the demo side) put
the first real invoice through this registry in days — and it failed. Two defects, both fixed and
pinned:

- **`invoices.addons_json` was in the DDL and in no column migration.** The invoice writer names the
  column unconditionally, so an existing registry (every real installation, including the live dev
  one) failed with "no column named addons_json" on its _next_ invoice; only fresh test databases had
  it, which is why 373 green tests said nothing. `addInvoiceColumn('addons_json', …)` plus three
  migration tests that boot against a **pre-add-on** database shape — including that a document raised
  before the model keeps `NULL` rather than being given invented add-on lines.
- **A warehouse was filed as a shop when it was activated in its panel.** The kind travelled on the
  roster push but not on `POST /api/internal/branches` (activation), which runs first — so Central DC
  arrived in the Kloof panel as `kind: store`, and the transfers screen sorts sources by exactly that.
  `registerBranchWithPanel` now sends it (with `wireStoreToHeadOffice` passing `store.kind`), and the
  panel stores it, keeping the existing kind when an older control plane omits the field.

Then the demo itself: the company's three Kloof branches and the new warehouse all hold a verified
**active** licence, `invoice_import` was bought for the client (one tick, R99, snapshot at the agreed
price, one invoice line), and the importer read a real supplier PDF — four lines, each matched to a
catalogue product by SKU. Registered as store 69: `kind: warehouse`, `terminalCount: 0`, no terminal
allocation, `headOfficeWiring: wired` on the first try once the deployment was up.

Also repaired on the live dev registry, because licensing could not be trusted without it: companies
1–6, 8 and 9 had never paid and had no trial, so their state was `suspended` **by design** — meaning
the moment their stores held a real licence they would refuse to sell. Each now has a paid renewal
invoice (plan rate, add-ons at agreed prices, setup fee where still unbilled) and `paid_through`
2026-11-10. CP backend 376 tests (+3), typecheck clean.

One more thing fell out of planning the release itself. The two entitlement
migrations change what clients are entitled to, and **nothing re-delivered the
licences they had already been given**: the health sweep refreshes a licence only
when the last delivery failed or the licence is half its offline window old
(seven of fourteen days). So the split keys would have reached the demo fleet's
registers about a week after the stores were deployed, and a store released in
that window would refuse features its client is paying for. The migrations now
queue the delivered licences (`licence_push_status = 'pending'` on every store and
panel), which puts them in the next sweep — ten minutes — and settles once
applied, so a second boot does not re-queue a delivered licence. Pinned by a
migration test that seeds a plan still bundling a chargeable feature, restarts
against it and asserts both the queueing and the settling.

## 2026-10-10 — released: control planes first, then the fleet they licence

Owner: "ok lets commit and release". Five commits (`e7c2d54` on dev/staging/main),
CP 377 tests, typecheck and build green. Auto-deploy is off for the control planes,
so the release is `scripts/release-apps.sh cp` — the script also lost the four
deleted rehearsal apps and gained the mode it needs to run at all (644 → 755).

**Order mattered more than usual, and the registry decided it.** Production was
running on the pre-split registry, so its stores' licences said the old thing while
the new tenant code enforces `layby` and `invoice_import`. Deploying the stores
first would have refused lay-bys the clients pay for. So: the control planes first
(their boot migrations rewrite the subscriptions and, since today, queue every
delivered licence for re-delivery), then the fleet once the sweep had delivered.

Verified on production rather than assumed: the office bundle now serves
`index-A9LOiJys.js` with the release's own marker string in it; a live demo store's
licence gained `layby` minutes after the control plane came up, without a hand
pushed licence, which is the re-delivery queue working end to end; lay-bys answer
200 and the invoice importer answers 402 with its "plan does not include" message —
the paid feature that used to be free is properly closed. The tenant fleet (three
Urban Threads branches, general, spares, restaurant, hardware, pharmacy, panel) was
then released and each serves the exact chunk hashes built here.

One operational trap recorded in tidb: the merchant panel's host is
`demo-urban-threads-ho.vula-app.co.za`; `demo-ho.vula-app.co.za` is an unknown host
and Coolify answers it with a 503 that reads like a dead deployment.

## 2026-10-10 — Resend, and a form that actually sends

Owner: _"we can use resend as we do for Optimed — I need to set up resend for vula-app"_. So the
quote request is no longer a `mailto:` that cannot send anything: the site has a form, and the
control plane sends it through **the same delivery optimed uses** — the office's SMTP mailbox
when it has one, otherwise Resend's HTTP API, no SDK, `RESEND_API_KEY` + `RESEND_FROM` read at
call time so a sender change needs a restart and never a rebuild.

- **The mailer grew a transport** (`services/mailer.ts`). `sendMail` picks SMTP when
  `isSmtpConfigured()`, else Resend, else the honest `smtp_not_configured` refusal; the private
  `send` became that shared entry point, so invoices, the SMTP test and the quote request all go
  through one place. `activeEmailTransport()` is reported by `GET /api/settings`, so the office
  is not told "SMTP is not configured" while mail is leaving through Resend. Attachments are
  mapped (base64) and `replyTo` becomes `reply_to`, which is what keeps a reply going to the
  visitor rather than to us.
- **`POST /api/public/quote-request`** is the control plane's first open surface. It is built to
  be treated as hostile: the office address is config (`QUOTE_TO`, default hello@) and the
  visitor's is one they typed — there is **no recipient field on the wire**, so it cannot be
  pointed at a third party to relay through our domain; it is rate-limited per source address
  (five an hour); it carries a honeypot that answers `ok` and sends nothing when filled; and
  every field is length-capped and shape-checked before composition. CORS allows
  `vula-app.co.za` (and the site's local dev servers) and nothing else.
- **The page grew a form** where the dead mailto was, and it collects a lead rather than a
  shrug (owner: "we can collect information regard Business name / email / Mobile number etc"):
  **business name, email and mobile number required**, contact name, the trade from the
  product's own vocabulary, a free note, the honeypot, and the quote attached from the builder's
  own state. The email the office receives leads with those fields — Business, Contact, Email,
  Mobile, Trade — then the quote, and replies go to the visitor. A failed
  post opens the visitor's mail app with the same quote instead, so the worst case is what the
  old button did. With JavaScript off the form's action _is_ that mailto, carrying the default
  quote, which is how the page already treats every other figure.

Verified: 9 new endpoint tests (payload to both addresses with `reply_to` the visitor; QUOTE_TO
overriding; a `to` in the body ignored; honeypot; validation; a transport refusal surfacing as
502 `quote_send_failed`; no-transport answering the same way so the endpoint never says whether
our mail is set up; CORS allow/deny; and the limiter refusing the sixth request without sending).
Control plane 386 tests, typecheck clean. Then end to end in a browser against the local stack:
the form posted to the local control plane, the mailer resolved its transport, the message went
out, and the page confirmed with the visitor's address in the reply.

**Two things this turned up, both worth acting on.** The local control plane's office settings
still hold a **Gmail app password** (`smtp.gmail.com`, `hoosain.madhi@gmail.com`, 16 characters)
— and it still authenticates, so it is not the one revoked earlier. Configuring Resend is what
retires it: with `RESEND_API_KEY` set, the office mailbox is only used when the office has
actually configured one. And my browser test used `thandi@cornermotors.co.za` as the visitor
address, which is a domain that may exist — one stray message went to it through that SMTP
account. A test address should have been `example.com`; recorded in tidbits so the next live
test uses one.

## The add-on model adds up (2026-10-10)

The pricing the owner approved (a per-till rate with the base set included, plus six
monthly add-ons at R99/R49) was already modelled in the registry — plan vocabulary,
per-plan prices, per-client purchases, the plan ∪ bought union on the licence, and the
add-ons in the invoice's line set. This pass closed the three places where the model did
not actually add up, plus the mirror that had drifted.

**The editor's quote was the visible one.** `SubscriptionQuotePreview` multiplied the
ticked quantity by the plan's rate and stopped there, so the owner's screenshot of a
client holding four add-ons read "Recurring (30 × R 1,00) R 30,00" — R 426 light against
what saving the form would bill. It now itemises terminals, each ticked add-on and the
total. The arithmetic lives in `frontend/src/lib/money.ts` as `addonLinesFor` (options
the plan sells, the ticks, the client's agreed prices) so it is unit-tested rather than
buried in JSX, and it resolves each price the way the server does: the agreement first,
the plan only as the fallback. The option rows show the agreed price too, marked
`· agreed` when a plan edit has since moved the catalogue — so the editor never shows a
figure the client is not on. A custom plan says plainly that its ticks are carried inside
the agreed flat amount.

**A custom plan's document was the incorrect one.** `invoiceLineItems` printed one
"Per month" line per snapshotted add-on on every invoice. On a per-terminal plan that is
exactly right and sums to the total. On a custom plan the recurring figure is one
negotiated number that does NOT add the add-ons (services/pricing.ts), so those lines
stated a charge the client was not paying and left the residual line to absorb the
difference. `InvoiceLineItem` now carries `included?: boolean`; on a flat deal the add-on
lines read "Included in the agreed amount" with no figure, and both renderers (PDF and
email) print the word rather than a money column. The agreed amount then prints whole.
The signal for "flat deal" is the absent terminal count/rate, which is sound because the
only invoices carrying an add-on snapshot are the computed subscription ones.

**Suspension needed the vendor half.** The register already refuses `ai_assistant` and
`invoice_import` on a suspended licence (`SUBSCRIPTION_GATED_FEATURES`), and that is
tested there. The claim now agrees with that intent: `SUSPENSION_STRIPPED_FEATURES` in
`services/features.ts` is applied at the one delivery boundary, so every issue path —
both Push Licence routes, a payment, a plan change, onboarding — obeys it without knowing
about it. Operational add-ons stay in the claim; suspension stops new sales, not a
merchant's access to its own data. The test decodes the licence the control plane actually
posted and asserts the suspended list, then the healthy one, so both directions are
pinned.

**Mirror and docs.** `schema.sql` did not carry three columns the DDL had shipped
(`company_subscriptions.features_json`, `addon_prices_json`, `invoices.addons_json`) — the
mirror is a reader's reference and it was telling a stale story. CONTEXT gained the
suspension rule and the custom-plan itemisation in §5, the current eight-key vocabulary
table in §2b (it still said six), and §2a was still describing the retired four tiers at
R500 — the seeded catalogue has been eight `vula-*` tiers at R100–R150 for a while, and a
doc that misstates the price list is how the next person misprices a client.

Verified: 405/405 backend (33 suites), 28/28 frontend, typecheck and `npm run build`
clean, and the tenant repo's 682/682 + 52/52 re-run as the cross-app gate. Not committed.

## The quote desk records (2026-10-13) — P1 backend, uncommitted

Owner: _"ok lets implement invoicing"_ — the desk's first phase: the record under the
marketing form's request. The endpoint that already emailed the office and the visitor now
records first and emails second. A transport failure keeps the lead (the row survives with
`email_error` stamped; the page's 502 → mailto fallback is unchanged), a honeypot fill or a
bad payload records nothing, and every request gets a number: `VULA-Q-<year>-<6 digits>` on
the invoice counter's rules (`quote_sequences`, increment in the reading statement,
self-heal from the highest number already written; the two `LIKE` prefixes cannot see each
other's rows).

**Server-priced, with a drift flag.** The route priced nothing before — `money()` only
shape-checked the page's strings. It now prices the configuration itself
(`services/quotePricing.ts`: the R99/till list rate, `DEFAULT_FEATURE_PRICES`, the R5 000 /
R1 500 setup pair) and keeps what the visitor saw beside what the catalogue says. A
disagreement — or an unreadable figure; `parseMoneyCents` refuses anything that is not the
page's money shape, a `<script>` tag has no digits to mine — sets `drift`, and the desk's
email names both figures while the visitor's copy keeps their builder's numbers. Refused
by name: an unknown add-on, a missing setup choice, Head Office on a single-store quote.
The page now posts its add-on keys and setup choice (`ADDON_KEY` maps its toggle shorthand
to the curated vocabulary) — **deploy the page before the CP**; the old endpoint ignores
the extra fields, so that order has no window. Reading the payload closely also caught the
old `tills` cap: the wire carries the _total_ across stores, so 3 stores × 20 tills was
refused by a bound of 50 — 500 now, with the reason in a comment.

**The desk reads it back.** `routes/quotes.ts` (office-only): `GET /api/quotes` with a
status filter and `GET /api/quotes/:id`, camelCase, JSON columns parsed, no DB names.
**The page.** `frontend/src/pages/QuotesPage.tsx` (nav "Quotes", beside Clients): summary
tiles, a status filter, drift and email-failed chips on the rows, and a detail modal that
shows the visitor's figures beside the catalogue's, the VAT breakout, and the email
outcome. Feature labels come from `GET /plans/features`, never a local copy (owner,
2026-10-10). Read-only — the PDF and the send action are P2.

Verified: 428/428 backend (35 suites; `quotePricing.test.ts` and `quotes.test.ts` new,
`publicQuotes.test.ts` updated), 28/28 CP frontend (3 suites), typecheck and `tsc -b`
clean, prettier clean on touched files. Not committed.

## The quotation goes out (2026-10-13) — P2, uncommitted

The desk's second phase: the record becomes a document. `POST /api/quotes/:id/send`
(office) builds the PDF, emails it to the prospect, and stamps the record. The office may
correct the configuration first — an explicit field re-prices from the catalogue and moves
`priced_*`, while the visitor's `requested_*` snapshot is never rewritten (the marketing
page itself asks a prospect for its real split, so this is the designed path). The
covering email is short, Reply-To the office (`office_email`/`smtp_from`), and the
attachment comes from the same builder the download route serves — what the operator
files is what the client receives.

**The document** (`services/quotePdf.ts`) shares the invoice's geometry constants on
purpose: A4, 48pt margins, the brand rule, the money column measured with pdfkit's own
metrics. It is headed **Quotation** and says it is not a tax invoice; the tax is broken
out of the inclusive figures at the snapshotted rate. The invoice footer is deliberately
not printed — nobody owes anything yet; a validity line stands in its place. Validity is
`quote_valid_days` (new office setting, 30 by default, edited in Settings beside the
invoice terms): `valid_until = today + N`, with a per-send `validDays` override in the
API. Success sets `status='quoted'`, `sent_at`, `valid_until` and audits `quote_sent`; a
refused or unconfigured send audits `result: 'failed'` and stamps nothing — the invoice
email route's honest-outcomes rule. A settled quote is refused with 409.

**The page** gained the actions: `Download PDF` (a blob fetch with the token, like
Billing), and Send / Send again opening an inline panel — stores, total tills, set-up,
and the add-ons from the vocabulary (Head Office disabled below two stores). After a send
the record shows "Sent <when> · valid until <date>".

Not yet surfaced (they land with P3's accept/decline pass): editing the prospect's note,
and the per-send validity override in the UI.

Verified: 436/436 backend (36 suites; `quotePdf.test.ts` new, five send tests added to
`quotes.test.ts`), 28/28 CP frontend, typecheck and `tsc -b` clean, prettier clean on
touched files. Not committed.

## The quote becomes a client (2026-10-13) — P3, uncommitted

The desk's third phase, the pipeline. `POST /api/quotes/:id/accept` and `/decline` record the
prospect's answer (audited `quote_accepted`/`quote_declined`; a settled quote refuses a second
verdict with 409), and `expired` is now derived on every read — a sent quote whose
`valid_until` has passed reads expired while the record keeps saying `quoted`, because that is
what happened; sending again extends it. The desk gained an Expired filter and chip, and the
client-less visitor (`business: ''`) is caught at the door.

**`POST /api/quotes/:id/create-client`** — only from an accepted quote, once. It reuses the
onboarding machinery rather than rebuilding it (`createCompany`, `setLicensedTerminalCount`,
`setSubscriptionPricing`, `setSubscriptionAddons`) but prices the subscription from the
**quote's own figures** — the quoted rate, the quoted add-on prices, the quoted once-off — not
from the plan's, deliberately: the quotation is the promise, and a plan edit since must not
re-price the client who said yes (the same grandfathering every agreed price gets; P4's served
list closes the loop between desk and plan). The office's panel pre-fills name, slug, plan and
licensed terminals from the record and can correct them; the quote keeps `company_id`, and the
desk links straight to the client page.

Verified: 441/441 backend (36 suites; five pipeline tests added), 28/28 CP frontend, typecheck
and `tsc -b` clean, prettier clean on touched files. Not committed.

## The desk drafts its own quotes (2026-10-13)

The gap the owner hit while testing: quotes could only arrive from the website's builder, so a
phone-in prospect had nowhere to land. `POST /api/quotes` (office) now drafts one from the
desk — business, contact, email, trade, note, stores, tills, add-ons and the set-up choice —
priced by the same catalogue, recording `source: 'office'` (a new column, defaulted to
'website', added with the usual column migration so existing registries keep working). There is
no `requested_*` snapshot (there was no page to disagree with) and no request email (the desk
is where it was born — `emailed_at` stays null and the detail reads "Drafted by the office").
Everything after creation is the identical pipeline: send, accept, create client. The Quotes
page gained the "Create quote" button, its modal, and an "Office" chip on the rows.

Verified: 444/444 backend (three draft tests added), 28/28 CP frontend, typecheck and `tsc -b`
clean, prettier clean. Not committed.

## Stores × tills, and the desk obeys it (2026-10-13)

The owner's first real test of the create form caught a desk bug: the office asked for
"Tills (total)" while the product prices per till, so "3 stores × 1 till" was entered as 1
and quoted at R99 instead of R297. The fix is the product's own model, everywhere: the
office's forms (create, send, edit) ask **Stores** and **Tills per store** and show the
computed total, exactly as the marketing builder does, and `validateQuoteConfig` refuses
the impossible shape — a quote cannot have fewer tills than stores, whether it arrives
from the page or from the office. The owner's own test quote can be corrected through the
new edit panel (which re-prices it to 3 tills) or deleted.

**And the desk gained the missing verbs.** `PUT /api/quotes/:id` edits a `new`/`quoted`
quote — the prospect's details and the configuration, the latter re-priced from the
catalogue with the visitor's `requested_*` snapshot never rewritten; a settled quote is
refused (409), audited as `quote_updated`. `DELETE /api/quotes/:id` removes any quote that
never became a client — the `company_id` link is the guard — audited as `quote_deleted`,
with the number retired rather than reused. The page grew an Edit panel, a Delete confirm
and the per-store inputs in all three forms.

Verified: 448/448 backend (four new edit/delete tests plus the refusal case), 28/28 CP
frontend, typecheck and `tsc -b` clean, prettier clean. Not committed.

## The documents wear the mark (2026-10-13)

The office's quotation and invoice PDFs now carry the Vula mark beside the office
identity — the same lockup the site's header uses. pdfkit cannot draw SVG, so
`frontend/public/vula-mark.png` (256px, rendered from `vula-mark.svg` with sharp) sits
beside the SVG, and `services/brandMark.ts` reads it from wherever the app serves the
SPA (public/ in dev, dist/ in the container), cached, returning null when the asset is
missing — a document must render with or without its letterhead. A missing asset is a
plain document, never an error.

The preview pass caught what the tests could not: coordinate-positioned header text
leaves pdfkit's flow cursor at that x, so the body title was indented by the header's
offset. Both documents reset `doc.x = 48` after the header, and the fix was verified by
rendering a real quotation and looking at it.

Verified: 449/449 backend (the mark test added), typecheck and prettier clean, the PNG
ships in the built UI and is served. Not committed.

## The line item spells the split out (2026-10-13)

Owner, reading the quotation: _"the till line item must be specific (1 till 3 stores)"_. The
priced line said `3 tills (3 × 1)` — terse enough that the desk itself once read it the wrong
way round. It now reads `3 tills (1 till per store × 3 stores)`, and a single-store quote
prints no split at all. One source (`priceQuote`) so the desk, the PDF and both emails say the
same thing; the marketing builder's line was updated to match, so a visitor's requested
figures and the catalogue's read alike. Non-dividing totals (hand-posted, legacy) degrade to
`(across N stores)`. A record keeps its stored snapshot until an edit re-prices it.

**And the line carries its rate (same day, owner's ask).** The till line now snapshots its
unit rate in cents (`rateCents`/`quantity` on the priced line — the invoice's
`terminal_price_cents` discipline, so a later list-price change cannot rewrite an issued
quote) and both renderers compose it the invoice's own way:
`3 tills (1 till per store × 3 stores) · 3 × R 99,00` with the line total in the amount
column. Flat add-ons carry no rate — their amount is the rate — and a line without one
renders exactly as before, so records priced earlier are untouched until an edit or a
re-send re-prices them. The owner asked comparing the quotation to the invoice:
quantity × rate in the description is this house's document convention.

**And an uneven estate is stateable (same day, the owner's own case).** _"how will quote
work if 1 store wants 2 till anther 3 and another 1?"_ — before this, the forms multiplied
evenly, so 3 stores × 2 priced 2/3/1 correctly but the words implied an even split. The
create/send/edit panels gained an optional "real split" field (`…or the real split — tills
per store`): typed as a list (`2, 3, 1`) it sets both the store count and the total, the
even inputs grey out beside it, and the line reads
`6 tills (2 + 3 + 1 across 3 stores) · 6 × R 99,00`. The price is unchanged by the shape —
per till wherever the till is — which the rate line now makes visible. `tillsSplit` rides
the same three bodies (a sent split overrides the even counts; sending only even counts
clears it), the priced line snapshots it, and the panels prefill it from the record. The
even path stays the default: the marketing builder multiplies evenly and the page defers
the real split to provisioning — which the office can now fix on the quote itself.

Verified: 450/450 backend, typecheck and prettier clean; the preview PDF rendered and
looked at. Not committed.

**And the tiles agreed with the forms.** The detail view's summary showed "Stores 3 /
Tills 3" — which reads as three tills per store if you are thinking per store, the same
misreading the line item invited. The tile says "Tills (total)" now, and the list rows
read "3 stores · 3 tills (1/store) · Assisted set-up", the qualifier the forms already
use ("= 3 tills total").

## The per-store price, and the add-ons follow it (2026-10-14)

The owner's list — R199 per store (first till included), R99 per additional till, Head Office
R199 for the business — landed as S1–S5 of the pricing plan, and mid-build the owner amended it
once more: _"the addons must be charge per store, no? so if three stores - laybuy must be
charged per store"_. So the five capability add-ons (lay-by, credit accounts, e-commerce, AI
Copilot, upload invoice) are now charged once per trading store; Head Office stays one charge,
because there is one panel for the company.

What that took, in order:

- **The plan carries the mode.** `plans.pricing_mode` gained `'per_store'` (the CHECK widening
  is a guarded table rebuild — the same pattern the stores table uses) and `store_price_cents`.
  The eight seeded tiers moved to it: 19900 per store, 9900 per additional till. A plan that
  already carried a rate keeps it; only never-priced tiers pick the catalogue up, so nothing
  live re-prices by a boot.
- **One arithmetic.** `calculateRecurringAmount(terms, licensed, stores)` is
  `stores × storeRate + max(0, licensed − stores) × tillRate` on `per_store`, `tills × rate` on
  `per_terminal`, and the agreed amount (or null) on `custom`; `quoteForSubscription` and
  `calculateRecurringSubscriptionAmount` are readers of it. The trading-store count is
  `countStoresForCompany` — `kind = 'store'` rows only, so a warehouse is never billed.
- **Grandfathering survives the mode.** The subscription snapshots the agreed per-store rate
  (`store_rate_cents`) beside the per-till rate, and the client's `addon_prices_json` snapshot
  keeps covering the add-ons — so a plan edit still re-prices nobody who has agreed terms.
- **The documents state both facts.** Invoices snapshot `store_count`/`store_price_cents`;
  `terminal_count` keeps meaning the licensed TOTAL so the additional count is the difference
  and pro-rata baselines still read from one column. The PDF/email lines read `Stores · 3 ×
R 199,00` and `Additional tills · 3 × R 99,00`, and a per-store add-on reads `Lay-by · Per
month · 3 × R 49,00` (older addon snapshots without the pair still render as they did).
- **Pro-rata follows the formula's own delta**, so a mid-period store-with-its-first-till moves
  the bill by `199 − 99 = R100`, not by a hand-written rule that could drift. `ProRataCharge`
  gained `extraStores` and the invoice description and the client card say "1 extra store and
  2 extra terminals" when that is what happened.
- **The desk quotes the list**, per store and per additional till, with each add-on multiplied
  by the stores it covers; the real-split feature answers with `(2 + 3 + 1 across 3 stores)` on
  the stores line and `(1 + 2 + 0 extra across 3 stores)` on the additional one.
- **The page follows the desk.** The pricing section was rewritten around the new model and now
  hydrates from `GET /api/public/pricing` (S5) — the markup's `data-store-cents`/`data-till-cents`
  are the no-JS default, each add-on button carries `data-per="store"` (or `company` for Head
  Office), and a failed fetch changes nothing.
- **The office's own surfaces** (Plans editor, the subscription editor's live preview, the
  client card's mid-period note) read the store figures too.

Verified on the local fleet: the page's default configuration (3 stores × 2 tills + Head
Office + credit + e-commerce) renders **R 1 387,00/m**, and `POST /api/quotes` for the same
configuration records the identical total and the identical lines; the page's request to
control-plane.localhost:3240/api/public/pricing lands in the browser. CP 455/455 (the pricing,
subscription, billing, companies, orchestration, quotes, migration and PDF suites all updated
to the new arithmetic — the old numbers asserted the per-till list), frontend build clean, and
the marketing page loads with the new section in a real browser. Not committed.

## The same day, two corrections (2026-10-14)

**The additional till is R49.** The owner weighed R99 / R50 / R25 against the list they had
just set and settled on R49 — "ok lets charge 49" — which is the number that makes the whole
price list uniform: R199 a store, R99 for the AI tier, R49 for everything else (a till, lay-by,
credit accounts, e-commerce). Implemented where the list lives: `LIST_TILL_RATE_CENTS`
(`services/quotePricing.ts`), the eight catalogue tiers' `terminalPriceCents`
(`SEED_PLANS`), and the page's `data-till-cents` no-JS default. The marketing page needed
nothing else — it hydrates from `GET /api/public/pricing`, so it followed the desk on its own.
Verified end to end on the local fleet: the page's default configuration reads **R1 237,00/m**
(3 stores 597 + 3 additional tills 147 + Head Office 199 + credit 147 + e-commerce 147) and
`POST /api/quotes` for the same configuration records exactly that. The eight live local plan
rows were moved to `per_store` 19900/4900 through the API. CP 457/457.

**A migration guard that could not fail, and did nothing.** Moving the plans surfaced a real
bug, the kind that only a live registry shows: `migratePlansPerStore` widened the
`pricing_mode` CHECK "unless the DDL already contains per_store" — and **the column
`max_terminals_per_store` contains that substring**, so the guard was true on every registry
that already had the modern plans table. The rebuild never ran, the CHECK stayed at
`('per_terminal', 'custom')`, and the office's attempt to move a plan to the per-store model
failed with `SQLITE_CONSTRAINT_CHECK`. A fresh database never sees it (its DDL starts widened)
and the older fixtures in `migration.test.ts` had their plans table rebuilt by
`restructurePlans` before this migration ever ran — which is exactly why 455 green tests did not
catch it. Fixed by reading the CHECK itself (`/pricing_mode\s+IN\s*\(([^)]*)\)/`) instead of
searching the DDL for a word, and pinned by a new fixture shaped like the live registry (current
table, old two-mode CHECK) asserting both that the widened CHECK accepts `per_store` and that
the rebuild keeps every row's id and rates. The lesson generalises: **a guard that reads a
schema by substring can be satisfied by a name elsewhere in the same text** — read the
constraint, not the document. Had this shipped, staging and production would have refused the
per-store mode silently, on the databases that matter.

**The self setup price is R1 500, and the plan says so (2026-10-14).** The office asked why the
new-client form offered "Self — R3 000" beside "Assisted — R5 000": the answer was that the two
buttons came from different places — assisted is a fixed R5 000 (a service the office performs,
stored on the client's subscription when chosen), while self rendered **the selected plan's own
`setup_fee_cents`**, and the catalogue's tiers carried R3 000 (R5 000 on Vula Network, R6 000 on
the three larger ones). Meanwhile the marketing page and the desk's list have always advertised
self at R1 500, so a client onboarded from a quote paid R1 500 and one onboarded straight onto a
plan paid R3 000 — two prices for one thing. The owner settled it: **self is R1 500**. All eight
seeded tiers now carry 150_000, the live local plans were moved to match (their own
`vula-standard` plan already sat there), and the page and desk needed nothing — they were right.

Found while fixing it: on the three R6 000 tiers the form's note computed `assisted − plan` and
would have read **"assisted adds −R 1 000,00"**. The note now states a difference only when
there is one, says so plainly when the plan charges the same either way, and warns the operator
when a plan's self figure is ABOVE the assisted price ("check the plan") instead of printing a
negative. The assisted figure itself moved to one constant (`frontend/src/lib/money.ts`) so the
onboarding form and the subscription editor cannot drift apart again.

Also found by opening the form: the plan dropdown read **"custom pricing"** for every catalogue
tier — the label only knew `per_terminal` and fell through to `custom` for the new mode. It now
reads `perStoreLabel`, e.g. "Vula Grow — R 199,00 / store / month (first till included) + R 49,00
per extra till" (both in the onboarding form and in the subscription editor's plan picker).

Verified in the browser on the local control plane: the form offers Self R 1 500,00 / Assisted
R 5 000,00 with the note "…assisted adds R 3 500,00 for the client", and the plan list states the
per-store pair. CP 457/457, frontend build clean.

## The onboarding pair gets one home (2026-10-14)

Asked whether the Plans editor's single "Onboarding (R)" field was right, the answer was "yes in
shape, no in labelling and no in plumbing": the plan carries one figure (its self-setup default)
while the assisted price lived as a constant in three places — the CP form, the desk's list and
the page's markup — so changing it meant a deploy, and only a deploy could keep them in step.
Done in one pass:

- **Office Settings gained the pair** (`setup_fee_self_cents` 150 000, `setup_fee_assisted_cents`
  500 000 — additive columns on the singleton, seeded with the published figures), exposed on
  `GET /api/settings` and editable from the Settings page. `priceQuote` now takes the fees
  (`officeSetupFees()`, the constants only as a fallback), and `GET /api/public/pricing` serves
  the same pair — so the desk, the onboarding form, the subscription editor and the marketing
  page all read one place. Changing the assisted price to R6 000 in Settings and reloading the
  page moves the cards and the builder button to R 6 000,00 — verified in the browser.
- **The plan's field is the per-tier override**: relabelled "Onboarding — self setup (R)" with a
  hint naming the assisted figure and where to change it, placeholder fixed off the stale
  `10000.00`, and a plan created without a figure now starts from the office's self price instead
  of a silent R0 (`resolvePlanPricing` returns undefined rather than 0 on a create). A deliberate
  0 still means "this tier waives onboarding".
- **The page hydrates the pair too** (cards and builder buttons), so the site follows Settings.

**And a browser-only bug the whole suite was blind to.** The page's hydration still showed the
old figures after the change: `GET /api/public/pricing` was registered ABOVE the router's CORS
middleware, and Express answers whatever matches first — so the route replied without
`Access-Control-Allow-Origin`, the browser refused to read the response, and the page silently
kept its static defaults. `curl` never shows this (no Origin header, no CORS needed) and neither
did the tests; only opening the page did. The route now sits below the middleware with a comment
saying why, and two tests pin it: the response must carry the site's origin, and the figures must
come from Office Settings. CP 461/461.

The generalisable lesson, alongside the substring-guard one: **middleware that a route's consumers
depend on must be registered before every route in its router**, and a failure the browser hides
(`.catch(() => undefined)`) needs a test that asserts the header, not just the body.

**E-commerce moves to the per-company side (2026-10-14).** The owner, looking at the page:
_"ecommerce should be for the whole business and not per store..."_ — and it should: the bridge is
ONE storefront connection (WooCommerce/Shopify) for the business, and a second branch does not
open a second online shop, so per-store billing charged the same integration again for every
branch. The per-company set is now explicit rather than a special case for Head Office:
`PER_COMPANY_FEATURE_KEYS = ['multi_store', 'ecommerce_bridges']` in `services/features.ts`,
applied by the one helper every reader shares (`addonQuantity`), served to the page as
`perStore: false` on `/api/public/pricing`, and mirrored in the CP frontend's `addonLinesFor`
(`PER_COMPANY_ADDONS`). The marketing page's e-commerce button is `data-per="company"` and its
card reads "/ month, for the business", with the no-JS default recomputed: the page's own default
configuration (3 stores × 2 tills, Head Office, credit accounts, e-commerce) is now
**R1 139,00/m** — 597 + 147 + 199 + 147 + 49 — and `POST /api/quotes` for the same configuration
records exactly that, with the e-commerce line stated as ×1 and credit accounts as ×3.

The rule as it now stands: **R199 per trading store (first till included), R49 per extra till,
R199 Head Office and R49 e-commerce once per business, and R49/R99 per store for the four
per-store capabilities** (credit accounts, lay-by, the assistant, the invoice importer). Pinned by
a new pricing test (the per-company lines stay ×1 on a three-store quote while lay-by multiplies)
and by the public-list test asserting `perStore: false` for e-commerce. CP 462/462.

**Production SMTP is Zoho (owner, 2026-10-14).** Recorded so the earlier finding does not have to
be rediscovered: the CP sends its invoices and quotations over SMTP, and production will use the
Zoho mailbox that owns `billing@vula-app.co.za`. The trap that made this necessary is already in
the Settings page's own copy — a provider accepts a From it does not own and then drops the mail
silently, which is how the Gmail attempt looked successful and delivered nothing. The host field
now names Zoho's settings outright (`smtp.zoho.com:587`, or the account's region, with an
app-specific password when 2FA is on) beside the existing From-ownership warning, so configuring
it is a copy of two values rather than a search. What remains is the owner's action: set the host,
username, app password and From on the production control plane, then use "Send a test email to"
— which is the only check that proves delivery rather than acceptance.

## A quote can price off the list — and the conversion bug that surfaced (2026-10-14)

The owner has a real prospect who asked for a quotation **yesterday**, i.e. under the old per-till
list, and wants to honour it while charging the add-ons per store where they apply. The desk
couldn't: a quote was priced from the published list and nothing else — the create/edit payload
took stores, tills, add-ons, setup and the split, with no rate anywhere. So this landed:

- **A quote chooses its basis.** `quotes.pricing_basis` is `'store'` (the published list) or
  `'till'` (the older terms, every till at one rate — the shape the page sold until this week).
  The per-till line states the estate beside it ("(2 tills per store)") and the add-ons still
  follow the per-store rule, which is exactly what the owner asked for: old rates for the tills,
  current quantities for the capabilities.
- **Unit rates are overridable, per line.** `store_rate_cents`, `till_rate_cents`,
  `setup_fee_override_cents` and `addon_rates_json` (a key → cents map) hold whatever the office
  overrode; a blank field is the list's figure. Every priced line records `listCents` **when it
  departs** — so the record, and the desk, can state what was given up (the client's PDF shows
  only the price). `priceQuote` takes the overrides as a `rates` object, so the arithmetic has one
  home as before.
- **The desk's create and edit panels** gained a Prices block: the basis toggle, a rate per store,
  a rate per till, the once-off, and a price per selected add-on — each with the published figure
  as its placeholder, read from `GET /api/public/pricing` so the office sees what they are
  departing from. The detail view says "Priced off the published list — on the older per-till
  terms" and chips each off-list line with its list figure.
- **A R0 override is expressible** (type `0`): a line given away is a price, not a blank.

**And then the bug this uncovered, which is the more serious half.** The quote → client
conversion had never been updated when the list moved per-store: `create-client` wrote the desk's
TILL rate and **no store rate at all**, taking the pricing mode from the chosen plan. So a client
created from a per-store quote would have been billed stores at _nothing_ — R147/month instead of
R744 for the owner's own example — and any override would have been dropped in the same way. It is
now read from the quote's own terms (basis → `per_store`/`per_terminal`, the store and till rates,
the add-on unit prices, the setup), which is also what makes an off-list quote survive conversion:
the quotation is the promise. Pinned by a test that provisions the estate the quote describes and
asserts the client's monthly IS the quote's monthly total (it fails on the old code: R346 instead
of R943).

**And the concession is behind a deliberate step (owner, same day): _"older terms will be for one
customer only"_.** Correct — the old terms are a concession for one agreement, not a second price
list, so the Prices block no longer sits open on every quote inviting a casual undercut: the
create panel shows "Prices: the published list" with a "Price off-list — a concession…" button,
and the fields appear only when that is clicked. Reopening a quote that already carries one (the
edit panel) opens the block with its figures, so the concession is visible where it exists and
absent where it doesn't. A "Use the published list" link resets the block in one click. Verified
in the built UI: fresh quote collapsed, the concession one step behind the button, the existing
off-list quote's edit panel open and pre-filled at R99.

Verified through the built UI on the local control plane: a draft for 3 stores × 2 tills priced
per till at R99 reads **6 tills · 6 × R 99,00 — list R 744,00 — R 594,00/month**, carries the
off-list banner, and R 5 000 set-up. CP 465/465. Nothing committed yet.
