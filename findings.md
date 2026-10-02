# Findings

## 2026-10-02 (late) — the rehearsal's biggest catch: a suspended client's till traded anyway

The owner rang a sale on a **suspended** client's store and it went through.
The control plane had done everything right — the licence signed at
`issue_licences` carried `billingState: 'suspended'` — and the store traded
anyway.

- **The tenant's acceptance path flattened the state machine.**
  `za-pos/src/services/licence.ts` treated a licence with no `paidThrough` as
  "informational" (a pre-subscription-redesign assumption — null used to mean
  *no billing model*) and mapped every signed state to **active** unless it
  was a trial. The paid path had the mirror hole: date math only, so a
  **manually suspended** client with a paid period outstanding also kept
  trading. Both fixed: the signed billing state is now the authority for
  suspension (and survives as `trial`/`unlicensed` doctrine), pinned by two
  new tests (tenant `e4b94ff`).
- **Why the rehearsal could catch it at all:** the strict state machine means
  an onboarded-but-unpaid client is *suspended* — and the §7 rehearsal
  deliberately walks that state before any payment. A demo fleet that seeds
  paying customers would never have noticed. The failure was invisible in the
  panel (the CP derives and shows `suspended` honestly) and lived entirely in
  the till.
- **Pause is a different thing, and the owner saw that too.** Pausing a store
  flips a registry flag and refuses CP→store pushes — the till keeps trading
  on its licence, because a paused store *refuses the very push that would
  tell it it's paused*. That is documented behaviour (cutover §9), not a bug
  — but the owner's expectation (pause = till stops) is legitimate, and there
  is a clean design if wanted: **push a sales-blocked licence first, then
  flip to paused**; resume re-pushes the normal licence. Awaiting the owner's
  go — it changes documented pause semantics (CONTEXT §2b).
- **Also raised:** every store's centre label read "Vula Store" — the
  tenant's default `store_name`, which nothing sets because the configure
  contract carries no name. Proposal: add `name` to the configure payload
  (a wire-contract change — CONTEXT.md update on both sides) so provisioning
  stamps the trading name the CP already knows.

## 2026-10-02 (night) — a store with no Head Office renders a link to the developer's own machine

Seen live in the staging rehearsal: a store that was never wired to a Head
Office renders a "Head Office" nav link pointing at `http://localhost:3260`.

- **The CP side is correct.** `topology.ts` pushes
  `headOffice: { enabled: true, url: panel.base_url, token }` to every wired
  branch, so any store wired to a real Head Office links at the real origin.
  The rehearsal store was added to its client *after* the Head Office was
  deleted, so nothing ever wired it.
- **The tenant side is the defect.** The store resolves its HO URL as
  `settings.head_office_url` → `HO_URL` env → **`http://localhost:3260`** — a
  development port as the production last resort (`src/services/settings.ts`).
  A fresh, unwired store therefore advertises a live-looking link to a dead
  address. Flagged for the tenant workstream: an unwired store should hide or
  disable the Head Office link; a hardcoded dev fallback must never be the
  production answer. Deciding that also decides what a single-store client's
  store shows — the link may simply not belong there.

## 2026-10-01 — the operator's .env is part of the test environment, and 4.3.23 no longer sells bind mounts

Owner: *"look at .env in ~/apps/optimed-control-plane"* — the credential
hand-off for the cutover, which met two things this tree had never met before.

- **The suite's greenness silently depended on the shape of a file nobody
  commits.** Two upgrade suites failed the moment real `COOLIFY_*` keys landed
  in the local `.env` — not because of the new storage-fallback code (the stash
  experiment failed identically without it) but because `config/env.ts` runs
  `dotenv.config()` at import time, and imports happen *after* jest's
  `setupFiles`. Deleting the keys in `env-setup.ts` was therefore undone by the
  very next import: with a config present, every suite's provisioning paths
  flipped from "Coolify not configured" to live calls against generic mocks
  that answer no uuid (`head_office_deploy failed: Coolify create application
  returned no uuid`). The fix pins the five keys to empty strings in
  `env-setup.ts` — dotenv never overrides an existing variable, and
  `readCoolifyConfig` treats `''` as unconfigured — leaving
  `configureCoolify()` in charge of the one suite that wants them. The
  general lesson is the one the scratch-DB guard already taught: a seam that
  reads the environment must have the test harness own the environment, not
  inherit whatever the operator's machine happens to hold.
- **The Coolify API is environment too, and it moved under the adopted
  payload.** The client's create-and-deploy quirks were documented against
  Coolify 4.3.10; the real instance is 4.3.23, where the storage POST refuses
  bind mounts outright (`host_path` → "This field is not allowed") and
  `dockerfile_location` validates only the `/Dockerfile` form, not `Dockerfile`.
  A named volume is the one persistent form the API still accepts, so
  `deployFromSpec` now tries the per-client host path first and falls back to a
  named volume, pinned by an orchestration test. The quiet consequence is
  bigger than the code: the §10 backup script globs host paths that API-created
  deployments no longer have — the databases live under
  `/var/lib/docker/volumes/<name>/_data` — and the runbook now says so before
  the restore drill depends on it.

## 2026-09-30 — the optimed comparison, and a Coolify probe adopted

Owner: *"look at ~/apps/optimed-control-plane to see coolify integration"* — the
reference implementation's Coolify client, read against this repo's, with the
cutover in mind.

- **The two clients diverged from a common ancestor, and each kept one half.**
  Optimed's wraps the whole application lifecycle (create, deploy, stop, start,
  restart, domain read/update, delete, a connectivity probe and a
  manual-onboarding-instructions fallback); this repo's does creation and deploy
  only — but for two application types from one repo (`dockerfile_location`),
  with the lease public key and `APP_URL` injected into every deployment, a
  per-client host-path layout, and a configurable repo/branch. Neither is a
  superset; the lifecycle half is what this repo never grew.
- **The lifecycle exports were dead code here.** `stopApplication`,
  `startApplication` and `deleteApplication` were exported with no callers, so
  "pause a store" stops at the registry flag while optimed's suspend stops the
  container. Whether pausing a store should stop its container is a product
  decision, not cleanup — recorded in tidbits rather than wired silently.
- **The probe was the one piece worth adopting today.** `npm run probe` verifies
  the Coolify API URL, token and UUIDs against the real instance before anything
  depends on provisioning — without it, a wrong API URL surfaces only
  mid-onboarding as a failed store deployment. It went in verbatim (same
  plain-text `/api/v1/version` endpoint, same env names) with a small test suite;
  the first version of that suite deleted the `COOLIFY_*` variables it was
  checking and poisoned the tests after it — a probe test that mutates the
  process environment needs its own restore.
- **The API quirks are already encoded here.** `deployFromSpec` uses
  `applications/private-github-app`, env vars without `is_build_time`, storage
  via POST, and the per-client bind-mount layout — the same quirks optimed's
  findings documented against Coolify v4.3.10. The common ancestor shows in the
  shared `request` wrapper's error handling too.

## 2026-09-25 (pass 4) — a word with no writer, and payloads that never met the policy

- **`overdue` was vocabulary without a writer.** The status sat in the CHECK
  constraint, rendered as a Billing badge and was treated as "unpaid" by the
  renewal sweep — and nothing in the codebase ever set it, so a lapsed invoice
  read as `pending` for ever. The lesson generalises past this column: a status
  the UI can display is a claim the system can be in that state, and if nothing
  writes it, the claim is false. Now a daily tick materialises it, touching only
  `pending` rows so a paid or voided invoice is never restated — which is also
  what makes the operation safe to repeat.
- **"Automatic renewal" was a copy claim with no worker behind it.** The sweep
  existed, was correct, and was reachable only by calling a route by hand, while
  the Billing page described renewals as something that happens. The fix is the
  same shape as the health sweep's: a scheduled caller. The tick keeps one
  invariant that the test file pins explicitly — it raises documents and marks
  them late, and it never records a settlement, because only an explicit
  settlement may move `paid_through`. An automatic job that can move money is how
  the fabricated-settlement defect would come back.
- **My first test of the tick was wrong, and the code was right.** I asserted a
  renewal invoice would be raised for a client that already had an open one; the
  sweep reuses the open invoice instead. That is the correct behaviour (one open
  document per client, not a daily pile), and the test now says so in two cases
  rather than one — the reuse is a rule worth stating, not an accident.
- **Two scheduled jobs, one implementation of the guards.** Rather than copy the
  skip-don't-queue and nothing-at-boot logic, `startScheduledTask` now owns it and
  the health sweep delegates. The proof that the refactor was behaviour-preserving
  is that its six existing tests passed untouched.
- **A fix does not propagate to payloads that never went through it.** Pass 2
  built the URL trust boundary for store and panel routes; the onboarding wizard
  accepted a nested `baseUrl` and wrote it straight into a row, so the same
  smuggling was still available one layer up — and the nested entries were
  defaulted rather than validated (`typeof x === 'number' ? x : 1` accepts `NaN`,
  `-5` and `1e9`). Three copies of that cast existed (wizard stores, wizard Head
  Office, upgrade Head Office). This is the second time in this review that the
  same policy had drifted across call sites; the answer is one helper per payload
  shape, called by both routes.
- **The exception had to be chosen, not assumed.** Onboarding raises rows before
  their containers exist, so requiring a live host there would break the wizard —
  the same tension development mode already resolves for the registry routes. The
  checker takes `allowUnreachable` for that caller while still applying the
  address policy and refusing a definitive wrong-kind answer. And the probe runs
  only for a URL the operator supplied: a URL derived from the client slug cannot
  be an attacker's, and probing it would add a timeout per store to every run.
- **A non-array `stores` used to be a 500.** `(req.body?.stores ?? []).map(...)`
  threw on any truthy non-array, so malformed input produced a stack trace instead
  of a validation message. Guarded with a 400 — the same class as the missing
  `purpose` column earlier in this review: the shape of the data was assumed
  rather than checked, and the assumption held only for well-behaved clients.

## 2026-09-25 (pass 2) — the URL that carried the secret

- **Four copies of a policy, two of them absent.** Store create and Head Office
  create each implemented the app-kind probe inline (with slightly different
  messages); store edit validated the shape but never probed; Head Office edit
  did not even check the scheme — `String(body.baseUrl).trim()` straight into
  the row. The asymmetry is the whole finding: creation was careful, editing was
  not, and editing is the operation that moves an *existing* secret to a new
  host. One helper now owns it, and the routes cannot drift because they have
  nothing to drift.
- **The sharpest edge was not the missing IP check; it was the missing re-probe.**
  The review's headline was SSRF to cloud metadata. The more likely disaster in
  this codebase was quieter: repoint a store at `https://attacker.example`, and
  the next licence push hands over that store's token — no internal network
  needed, just one authenticated PUT. Both are closed, but the re-probe is the
  one that would have been forgotten if the fix had been "add an IP blocklist".
- **A production-only policy, and the trade is written down.** The dev fleet and
  every test in the suite register `http://localhost:32xx`, so blanket refusal
  would break the system it protects. The address policy therefore applies when
  `env.isProduction`, and it is deliberately *stricter* there in a second way:
  an unreachable URL is refused in production, because the token leaves on the
  first push, while development keeps allowing it (rows precede containers).
  Two behaviours on one input, chosen by environment, each documented where it
  is implemented.
- **A test that reads a build artifact reports on the last build.** I added a
  test scanning `frontend/dist` for the dev credentials; it failed — legitimately
  — because the earlier `npm run build` had died on a typecheck error, so the
  artifact predated the fix. A unit test can only ever describe the last build,
  and it will report a false failure the moment the source is newer. The check
  moved into `scripts/check-dist.mjs`, wired into `npm run build`, where the
  artifact and the assertion are created together; the suite keeps the source
  guard, which is what it can actually verify.
- **Two fixture lessons from the new suite, both in one run.** (1) The first
  run's failures were not the code: `makeCompany` seeded neither
  `licensedTerminalCount` nor `paidThrough`, so every store create under it was
  refused 402 — the same fixture fix Pass 1 needed in two other suites, which is
  itself the signal that "a client fixture is a paying client" belongs in a
  shared helper rather than copied per suite. (2) Half the remaining noise was
  `mockResolvedValue` handing the *same* `Response` object to several calls; a
  body can be read once, so the later reads threw "Body is unusable". A fresh
  `Response` per call is what the other suites already do.
- **The limiter needed two dimensions, not one.** Keyed by address alone, one
  bad actor behind a shared NAT (or the proxy address before `trust proxy` was
  configured) locks out every user; keyed by account alone, one IP can hammer
  unlimited accounts. The login limiter now enforces both and refuses if either
  bucket is full, and a refused request does not extend the window it was
  refused for — otherwise the limiter itself keeps the door shut.
- **`trust proxy` is a security setting, not plumbing.** The default here is 0
  hops, which ignores `X-Forwarded-For` entirely. Trusting it unprompted would
  let any caller choose the address the login limiter keys on — a lockout is the
  mild version of that; evasion is the worse one. The value is explicit because
  only the deployment knows its topology.
- **Verification that the policy is real, not just unit-tested.** The suite
  exercises the production branch through a parameter seam; the deployment also
  refuses all seven cases when booted with `NODE_ENV=production` against a copy
  of the live registry — plaintext, loopback, RFC1918, the metadata address and
  hostname, an internal hostname, and an unreachable public URL — each with the
  rule that refused it named in the message.

## 2026-09-25 (pass 3) — the delete guard, the un-clearable column, and a transaction that never ran

- **`db.transaction(fn)` returns a function; it does not run it.** The
  better-sqlite3 API hands back a wrapper you must invoke, and the two new
  transactions in the client/company PUTs assigned it and moved on — so the
  routes read the untouched row back and answered 200 having written nothing.
  Five tests failed at once, which is what a no-op refactor looks like. The tell
  was an instrumented `updateCompany` that never logged: the function was never
  called. The house pattern was already in the codebase (`billing.ts` does
  `const settle = db.transaction(…); settle()`); the new code simply didn't
  follow it. Lesson: when a change moves writes into a transaction, assert the
  writes still happen — the presence-flag test caught this only because it
  asserted the *effect* (null clears), not the call.
- **A guard is only as good as what it counts.** Company deletion blocked
  stores and Head Offices but not invoices — and invoices, with their payments,
  cascade away with the company. A billing system that can erase a client's
  financial history by deleting the client row is not a billing system. The
  blocker now counts invoices, and when it is the money that blocks, the advice
  changes: you cannot fix that one by reassigning rows, so the message says
  *suspend instead*, not *remove those first*.
- **COALESCE is a write API with one hand tied.** `updateCompany` COALESCEd
  every column, so the API could set but never clear — an expired trial was
  un-clearable and a wrong paid-through date permanent, while the routes (and
  the office's empty date fields) had been treating null as "clear" all along.
  Presence-flag semantics — absent = unchanged, explicit null = clear — is what
  the callers already assumed; the helper just never delivered it.
- **Atomicity is about the failure path, and the failure path is where half-done
  lives.** The client PUT wrote the company fields, then validated allocations,
  then pushed licences — so a refused allocation left a renamed, re-planned
  client behind an "Update failed" toast. The operator's mental model is "the
  edit failed, nothing changed"; the data said otherwise. One transaction per
  logical operation, with the network push deliberately outside it.
- **A probe that reads `None` for two keys is telling you about the probe.**
  Verifying the null-clearing fix against a copy of the live registry, the first
  probe reported FAIL: `paidThrough` cleared but `billingState` came back `None`
  too. The response had been slow (three licence pushes to unreachable stores at
  5 s each) and the helper had silently fallen back to a raw-string dict — both
  keys missing, not one. The raw dump showed 200 with `billingState: 'suspended'`
  and the activation note: the code was right and the test harness was lying.
  On this surface, assert on the parsed body or dump the raw response; a silent
  fallback turns a pass into a false failure, and the temptation then is to
  "fix" working code.
- **Pause-first belongs on every teardown of a managed deployment.** Stores had
  it since 2026-09-10; panels did not. The rule is not about the registry row —
  it is about the surprise of the control plane ceasing to manage a live system.
  Same guard, same message shape, same UI affordance (Pause beside Remove) on
  both panel surfaces.

## 2026-09-25 — settling the review's billing findings, and what "paying" actually buys

The production review (`review-23Sep2026.md`) was verified claim by claim against
the code before anything was believed — the same rule as the 2026-09-12 review.
Every P0 checked out. This pass covers its first bundle: settlement → entitlement.

- **The deepest finding was one the reviewer only brushed: `purpose` was never
  stored.** AGENTS.md documented `purpose` on POST and GET, the create routes
  accepted it, the pro-rata and onboarding flows depended on it — and the invoices
  table had no such column. It shaped the amounts at creation and vanished, so
  settlement *could not* ask what a document was for. Fixing the settlement gate
  meant persisting it first; the doc/code mismatch was real in both directions.
- **Legacy rows cannot all be told apart, and the migration says so.** The
  backfill labels what the stored shapes prove (`pro_rata` from its period stamp;
  `onboarding` where the amount is exactly the setup fee and no recurring line
  exists) and leaves the rest at `initial` — which advances, as those rows always
  did. Guessing further would have fabricated history; the alternative was
  labelling an unknowable renewal as a one-off and breaking its settlement. The
  order lesson came free: the backfill needs columns that `migrateInvoiceLines`
  adds later in boot, so it runs after that step — the legacy fixture caught the
  first placement immediately.
- **"Paying" and "extending" are now different facts.** Settlement marks the
  document paid and records the payment; `paid_through` moves only for
  `initial`/`renewal`. The response carries `periodAdvanced` and the UI's toast
  says which happened — the old message announced "Subscription advanced" for a
  settlement that had done no such thing.
- **The amount recorded must be the amount invoiced.** The old code took whatever
  figure was typed and marked the invoice paid in full. Partial settlements are a
  ledger feature that does not exist, so a short payment is refused
  (`payment_amount_mismatch`) rather than silently converting into a full one.
- **One transaction for the financial writes, network outside it.** Payment,
  document, setup-fee state and paid period commit or fail together; the licence
  push stays outside because a delivery failure must never roll back money that
  actually moved. Every settlement is audited (`invoice_settled`) with its
  purpose — symmetric with `invoice_voided`, which was audited while settlement
  was not.
- **The strict state machine was an owner decision, not just a review finding.**
  Never-paid-without-trial deriving 'active' was a recorded L2 doctrine decision
  from 2026-09-11 ("keeps trading"). The review called it a hole; with the fleet
  still dev-only the owner chose strictness, and the enforcement test that pinned
  the old doctrine now pins the new one with the reasoning. On the live copy the
  change is visible immediately: eight of eleven clients read `suspended`, which
  is the honest answer to "is this customer entitled to trade".
- **The sweep became the recovery mechanism the docs promised.** `licenceNeedsDelivery`
  fires on a failed push or past half the offline window (`maxOfflineUntil` is
  stamped at signing, so a paid-up store could drift into expiry with nothing
  re-issuing), and deliberately never pushes to a store that did not answer. The
  scheduler shipped on 2026-09-17 was the missing half: the review found the doc
  promise and the scheduler found the mechanism to keep it.
- **The custom-client renewal flow changed shape and needed saying.** A
  hand-priced invoice used to double as a custom client's renewal by accident of
  the old settlement rule. Now the create modal asks whether the charge bills the
  period; choosing renewal is how a custom client's `paid_through` moves. Without
  that select, fixing the gate would have silently broken custom renewals — the
  kind of regression a green suite would not have explained.

## 2026-09-17 — a fleet page that reported history, and the number that proved it

- **Sixty-four of sixty-four green lights, forty-nine of them wrong.** The registry
  said every store was `up`; a real sweep of the same fleet minutes later found 15 up
  and 49 down. Both statements came from the same code against the same data — the
  difference is that the `up` values were written when each store was deployed, and
  nothing had ever re-probed them. This is the repo's recurring defect in its purest
  form: not a wrong calculation but a *displayed state that was never true*, and one
  the operator would act on (the fleet looked healthy enough to leave alone).
- **The fix was already written and simply never called.** `services/healthSweep.ts`
  has probed the whole fleet since 2026-09-11 and `POST /api/stores/health-sweep`
  exposes it — but nothing scheduled it, and the only polling in the SPA is a 4-second
  refresh while a store is provisioning. So the capability existed for weeks with
  nobody's hand on the trigger. Worth checking for a caller before building a
  scheduler for something that already works.
- **Two guards matter more than the timer itself.** Skipping a tick while a sweep is
  in flight keeps one probe in flight rather than a growing queue of them against a
  partly-unreachable fleet; and starting one interval after boot rather than at boot
  means a restart loop (which this repo has hit — five duplicate `tsx watch`
  processes in the 2026-09-10 incident) cannot turn into a fleet-wide hammering. Both
  are pinned by tests, and the in-flight one was verified by removing the guard and
  watching the test report three concurrent sweeps.
- **Measuring the cost before choosing the interval.** Fifty-one failures across 64
  stores and 6 panels complete in well under a minute because an unreachable host
  fails fast rather than at the 5-second timeout — worth knowing, because the
  opposite assumption ("42 unreachable stores × 5 s = a stalled sweep") would have
  argued for a much longer interval than the fleet needs.
- **Verification that did not touch the thing being fixed.** The sweep was run against
  a *copy* of the live registry on a spare port, which is what makes the before/after
  claim (64 up → 15 up, 49 down) a real observation rather than a prediction. The live
  registry was left reading 64/64 `up`, and that stale snapshot is itself the
  evidence: the truth was measurable only because the copy was swept.

## 2026-09-17 — a dev server that had been serving yesterday's code for ten hours

- **The `touch` remedy stopped working, and that changes the diagnosis.** Asked to
  make a client's stores alphabetical, I edited `src/routes/clients.ts` and checked the
  live API — which still answered in the old order. The `tsx watch` child on `:3240`
  had started at **19:17 the previous evening** and never reloaded; `touch`ing the
  edited file (this repo's own recorded remedy, from the 2026-09-16 stale-Vite entry)
  did not shake it either. The watcher process is alive — it just stopped noticing
  writes. Two conclusions worth keeping: when live behaviour disagrees with a change,
  **check the process start time before doubting the code**; and "wait for the
  watcher" is not a verification step, because the watcher can fail silently and does
  not announce it. The live check was therefore re-done properly — a copy of the live
  registry, served by a scratch instance on a spare port — which is the pattern the
  scratch-DB guard already recommends.
- **Sorting a list at the source beats sorting it in each view, and only because
  there were two views.** The client's stores reach the screen twice: as chips on the
  client card and as the shared store cards on the client's own page. Two filters over
  `listStores()` were producing one order that neither surface owned, so the fix is one
  function both call. Worth noting what made this cheap: the two call sites were
  already the same expression, which is what a duplicated filter looks like right
  before it becomes two different answers.
- **A sort needs a collation and a tie-break, or it is environment-dependent.**
  `localeCompare` without a locale follows the host's default, so the same fleet could
  order differently on a different machine; `'en'` pins it. ICU's primary-level
  comparison also gives what a person means by alphabetical for mixed-case names —
  `ALRODE`, `Atteridgeville`, `Bloemfontein` — where a byte sort would put every
  capital first. The unique slug breaks exact ties, so the list cannot flicker between
  two equal names.
- **The check that would have fooled me:** my first pass compared the API's order to
  Python's `sorted()`, which is byte-wise, and reported AHK's 41 branches as "NOT
  alphabetical". The app was right and the checker was wrong. Worth remembering before
  reporting a defect in a collation-sensitive list: match the comparison to the
  collation being tested, or you are testing your checker.

## 2026-09-16 (eleventh pass) — a counter that had to stay ahead of something it could not see

- **A local number that has to beat a remote number is not a counter, it is a
  mirror.** `stores.licence_sequence` was incremented locally and never compared
  with anything, while the tenant refuses any licence below the sequence it already
  holds. So the number could only be right by luck. It was luck that depended on the
  registry never being rebuilt — and the repo's own documented re-seed recipe
  (`scripts/reseed-fleet.ts`) moves the database aside and rebuilds from scratch,
  which starts every row at 0 while the deployments keep counting. That is exactly
  what happened on 2026-09-14, and the evidence is still in `error_events`: a cluster
  of "sequence 2 older than the stored 3" rows the same day, for stores 2, 3, 4 and 9.
- **The reported failure was four clicks deep, and unfixable by clicking.**
  `urban-threads-ho` (the Head Office of the client the UI labels _Multi-Store_) held
  **10**; the registry row held **6**. Each retry incremented by one _before_ pushing,
  so the operator needed five blind clicks to get past it — and had no way to know
  that. "Push Licence failed" was a correct refusal with an impossible recovery.
- **Verified against the live deployment rather than reasoned about.** Reading
  `GET /api/internal/status` on `:3260` returned `licence.sequence: 10` — the exact
  number in the refusal — while `panels.id=1` held 6. The same probe showed store 4
  ahead by 1 and two unlicensed Head Offices reporting `sequence: 0`. That turned
  "probably a stale counter" into a known quantity, and it is also how the fix's
  input was chosen: the field was already on the wire, and the CP was already calling
  that endpoint on every health check and **throwing the field away**.
- **The answer was to ask the authority, not to trust the memory.** Every
  registry-rebuilding path resets the CP; nothing resets the deployment. So
  `licenceDelivery.ts` reads the sequence the deployment holds before allocating, and
  raises the counter to at least that value. Two properties matter more than the
  mechanism: it **only ever raises** (an unlicensed Head Office reports 0, and a
  deployment behind us is left alone), and it is **best-effort** (an unreachable or
  older deployment behaves exactly as before, including surfacing the refusal rather
  than hiding it — the honest limit, pinned by a test).
- **Six copies of the same four lines was the reason the bug could exist.**
  Issuing a licence meant allocate → sign → push, copied into the stores route, the
  panels route, the payment/plan-change re-push, the orchestrator's `issue_licences`
  step and provisioning. Any invariant added to one of them silently missed the
  others — and recording a payment on the same client would have kept failing after
  the button was fixed. `deliverStoreLicence` / `deliverPanelLicence` now own it.
  Worth noting what made the consolidation safe: the six bodies were checked to be
  functionally identical first (`entitlementsForStore` already derives `maxTerminals`
  from `terminalAllowance`), so it is a move, not a behaviour change.
- **A repair nobody is told about is the defect this repo already named once.**
  The counter jumps 6 → 11 for a reason no operator chose, so it is reported twice:
  an audit row (`licence_sequence_reconciled`, before/after/reason) and a
  `reconciled: { from, to, reported }` field the SPA turns into _"the deployment
  already held v10, so the control plane caught up"_. The same reasoning as
  `setupFeeReleased` in the ninth pass.
- **The audit trail gains its first non-operator actor.** `actor` is free TEXT and
  all 76 existing rows say `office`. Recording this as `office` would claim the
  operator chose a renumbering they never saw, so it is `control-plane`. A new
  convention, deliberately: the trail can now distinguish a machine repair from a
  human decision.
- **Two things the dev stub was lying about, both fixed here.** It rejected an
  _equal_ sequence (`<=`) while the tenant accepts it (`<`, an idempotent
  re-delivery) — a stub stricter than its own contract would have hidden a real
  off-by-one. And its `/api/internal/status` reported no licence at all, so nothing
  local could exercise the reconcile; it now reports `subscription.sequence` and
  `STUB_LICENCE_SEQUENCE` can seed it. Dev-stub parity is a claim, and this is the
  drift it is supposed to prevent.
- **Floor, not ceiling — and the fleet reality is worth stating.** This repair fixes
  the **2** rows currently refused for a stale sequence (store 4 and panel 1). The
  other **51** failed licence rows are unrelated: 42 unreachable (production
  hostnames that do not resolve from the CP's host, so the CP has no evidence they
  are down and none that they are up) and 9 with a wrong token or a missing public
  key on the local mockups. Reconciling a sequence does nothing for those, and
  saying so is more useful than implying the fleet went green.
- **Rejected, and why.** Making the read _reactive_ (reconcile only after a 409)
  would cost nothing in the happy path, but it depends on interpreting a refusal and
  adds a re-sign-and-retry path; asking before issuing is one rule with one place to
  look. Also rejected: a manual "set the sequence" action — an operator being asked
  to type a number the system can read for itself is not a repair, it is a trap.
  Left alone: `nextLicenceSequence` still consumes a number when a push fails
  (harmless, and changing it would introduce a concurrency question nothing needs).
- **Verification, because a green suite is not a repaired fleet.** Both live cases
  were pushed for real and both repaired: panel 1 `6 → 11` (deployment held 10) and
  store 4 `5 → 7` (held 6), each returning `reconciled` and each ending `ok` with the
  deployment then reporting the new number. A store already in sync (`mydiner`,
  registry 6 = deployment 6) issued 7 with **no** `reconciled` field — the floor was
  a no-op, which is the case that would have caught an over-eager repair. The
  historical failure rows are still in the feed, as intended: history survives
  recovery. The whole loop was also exercised against the dev stub on a scratch
  registry (`CP_DB_PATH=/tmp/…`) with the stub seeded at 5 so the reconcile had to
  fire: the CP raised its counter `0 → 5` and the stub accepted **6**, then 7.
  Nothing was written to the live registry except the two intended repairs.
- **The committed tree is not prettier-clean, and `npm run format` proves it.**
  Running the repo's own formatter rewrote ~50 files — including 36 this change never
  touched (README, the deploy runbook, unrelated pages and services). `npx prettier
  --check` flags committed files, with prettier **3.9.6** installed against a
  `^3.4.2` range, so the drift is a version/config question rather than anyone's
  sloppiness. Those 36 files were restored and the substantive edits were re-applied
  by hand in the files that mattered (`stores.ts`, `stores.test.ts`, `AGENTS.md`,
  `CONTEXT.md`, `task_plan.md`, `PanelsPage.tsx`, `storeProvisioning.ts`), cutting the
  diff from ~1180 changed lines to ~700 — a fix that arrives buried in reformatting is
  a fix nobody reviews. Worth deciding deliberately: pin prettier, or reformat the
  repo once as its own commit. Either way, the next `npm run format` will rewrite those
  50 files again, so the decision should come before someone runs it mid-feature.
  **Also noted, not mine:** `src/routes/companies.ts` carries an uncommitted change
  (plan edit → auto-push licences to every subscribed company) that appeared during
  this session; it was left exactly as found.

- **A pre-existing trap found while verifying, noticed not fixed:** `npm run smoke`
  cannot pass as documented. The script's header says to run `npm run stub`, "token
  below", but `npm run stub` starts the stub with its own default token
  (`smoke-token-1`), which the CP rightly refuses — a supplied token must be 64
  lowercase hex — so `STUB_TOKEN` and `CONTROL_PLANE_TOKEN` have to be set to the
  same 64-hex value by hand. Also worth knowing before anyone runs it in anger: the
  smoke script creates `smoke-*` rows and deliberately never deletes them, so running
  it against the live registry leaves cruft that later reads as a defect (the
  2026-09-16 reseed leftovers were exactly that). Run it against a scratch
  `CP_DB_PATH`.

## 2026-09-16 (tenth pass) — a price is a deal, and a plan is a catalogue

- **The bug was in the direction of the read, not the arithmetic.** Nothing was
  wrong with `licensed × rate`; what was wrong was _where the rate came from_ —
  the plan, read live at invoice time. Eleven clients across four tiers meant one
  plan edit moved every client's bill with no decision and no record. The fix
  copies the terms onto the client and never reads the plan again for money
  (caps and features still come from the plan: they are entitlements, not prices).
  Worth stating as a rule: **anything a client has been promised belongs to the
  client's record, not to the catalogue that generated it.**
- **A snapshot needs a way to be updated, or it is a trap.** Grandfathering without
  a re-price action would mean a price rise could never reach an existing client —
  revenue stranded in the name of correctness. `POST /clients/:id/reprice` is
  therefore part of the feature, not an extra: audited, one client at a time, with
  the client page saying which state they are in.
- **The change broke the sweep, and the sweep was already fragile.** The renewal
  sweep read the _plan_ to decide whether a client had a billable figure, so once
  prices moved to the agreement it tried to invoice a client that had agreed
  nothing — and because `createInvoiceForCompany` was not isolated per client, that
  one client aborted the whole sweep (the route returned 400 and nobody else was
  evaluated). Both fixed: the guard reads the effective price, and each client is
  wrapped so its failure is recorded in `summary.errors` and the sweep continues —
  the same isolation the health sweep gives each store.
- **Pro-rata needed a period identity, not just a number.** The first cut computed
  the charge from (current quantity vs last settled quantity) and never recorded
  that it had billed it, so the button could be pressed twice and bill the same
  days twice. `invoices.pro_rata_period` names the paid period a charge covered, so
  "already billed" is a fact about the data rather than a hope about the operator —
  and voiding frees it, which is the same release semantics as the onboarding
  charge. A rule that can be applied twice is not a rule.
- **A whole period remaining is still chargeable.** The first guard refused to
  pro-rate when the days left equalled the period length, on the reasoning that the
  next invoice would cover it — but the next invoice is for the _next_ period. The
  client had paid for this one, so the extra terminals are uncovered for all of it.
  The test now pins the 30-of-30 case.
- **An invoice line with no line.** A hand-priced or custom-priced invoice showed
  its amount only in the totals: the PDF's line table had no rows, because the rows
  were built from `terminal_count`/`setup_fee_cents` and nothing else. Putting the
  description in the header was a partial fix; the real one is a line model
  (`invoiceLineItems`) that turns any amount the structured lines do not explain
  into its own line, shared by the PDF and the email so the two cannot drift. This
  is what a pro-rata charge needed, and it fixed hand-priced invoices at the same
  time.
- **Conventions must be stated where they are used.** 30 days for a month and 365
  for a year are arithmetic choices, not facts about the world; they live in one
  exported constant with the reasoning beside them, and CONTEXT §5e repeats it. A
  silent convention is indistinguishable from a bug to whoever reads the next
  invoice.

## 2026-09-16 (ninth pass) — labels that promise what the system does not do

## 2026-09-16 (ninth pass) — labels that promise what the system does not do

- **"Pay" was a claim about money movement.** The button recorded a settlement that
  had already happened outside the app. Every other mislabelling we have removed
  this session was the same shape: the invoice-email stub that reported a send, the
  auto-renewal that recorded a payment nobody made. A label is a contract with the
  operator about what will happen when they click; "Pay" broke it in the direction
  that matters most, because money is involved.
- **Offering an unintegrated payment method is the same defect in a dropdown.**
  "Stripe Gateway", "PayPal" and "Card Terminal / POS" were selectable with no
  gateway behind any of them, so a manual EFT could be recorded as `stripe` — and
  the payments table would then say a card network was involved. Removing them was
  the smallest honest fix; the deeper fix is the gateway itself (still on the
  backlog), at which point a gateway method becomes a _new action_ rather than a
  relabelling of "Record payment".
- **A word can be right for a status and wrong for an action.** The invoice status
  is `cancelled` in the schema and the CHECK cannot be altered in place; the
  operator nonetheless voids an issued document. Rather than migrate an enum for a
  word, the SPA maps the stored value to _Voided_ — the same shape as the register
  and licence label maps, and it keeps the wire contract still.
- **A side effect nobody is told about is a bug waiting to be reported.** Voiding
  the last invoice carrying the once-off releases that charge; the API has said
  `setupFeeReleased: true` since the fourth pass, but the UI ignored it, so the
  operator's only signal was an unexplained R10 000 reappearing on the next
  invoice. The confirmation now states it.
- **Voiding an issued document wants attributing.** Push, pause, licence issue,
  support sessions and settings edits were all audited; voiding was not. The
  `invoice_voided` row now records the before/after status and whether the release
  happened — the audit trail is the answer to "who voided this invoice and why",
  which is exactly the question an invoice dispute starts with.

## 2026-09-16 (eighth pass) — an invoice that changed its story when a plan was renamed

## 2026-09-16 (eighth pass) — an invoice that changed its story when a plan was renamed

- **One screen was reading history through today's catalogue.** The Billing detail
  view printed the plan by looking up the _client's_ plan at render time, so
  renaming a tier rewrote what every past invoice appeared to say — and a client
  moved to a different plan would "have been" on the new one all along. Everything
  else on the invoice was already a snapshot (`terminal_count`,
  `terminal_price_cents`, `setup_fee_cents`, the VAT rate); the plan was the one
  fact still borrowed. Asking to show the plan on the invoice surfaced it.
- **The rule worth stating once:** an invoice is a document, so each fact that
  describes the deal is copied onto it at issue and never re-derived. That is now
  tabulated in CONTEXT §5e, so the next field added to an invoice starts from the
  right question — "was this true when we raised it?" — rather than from what is
  convenient to join.
- **A snapshot needs an honest empty state.** A client with no plan shows "No plan
  recorded on this invoice" instead of the previous fallback `'Custom'`, which
  silently asserted a tier for an invoice that had none. A test asserts `null`
  survives to the wire.
- **The test that proves a snapshot is the rename.** Capturing a value is easy to
  fake — reading it back from the live source also "works" until the source
  changes. The regression test renames the plan after issuing and asserts the old
  invoice still reads the old name while a newly raised one reads the new name.

## 2026-09-16 (seventh pass) — a document that looks official and is not quite right

## 2026-09-16 (seventh pass) — a document that looks official and is not quite right

- **Two defects of the same class, fixed together.** An invoice number that can
  collide (`INV-<date>-<4 random digits>` in the same second) and a total that
  states no tax are both ways for a document to look authoritative while being
  wrong. They are invisible in the happy path — which is why they survived to the
  point of going to a real client.
- **VAT-inclusive pricing makes the arithmetic one-directional, and there is no
  room for a float.** Prices incl. VAT means `subtotal = round(total × 100 /
(100 + rate))` and `vat = total − subtotal`, so the parts always add back to what
  the client actually pays. The alternative (compute VAT and add it) puts the
  rounding on the total, which changes the amount the client was quoted. The test
  deliberately uses amounts that do not divide cleanly — 1c, 7c, 99c, R115 000,01 —
  because those are where an implementation that rounds twice loses a cent.
- **The rate and the split belong on the invoice, not in settings alone.** A rate
  is a fact about today; an invoice is a fact about the day it was raised. Storing
  `vat_rate` with the document is what makes "never restate an issued invoice"
  true rather than aspirational — and it is why a rate change leaves the existing
  rows untouched, which the test asserts by changing the rate between two invoices.
- **Pre-split invoices keep NULLs.** Ten live invoices were issued without a tax
  breakdown. Deriving one now would print figures that were never on the document
  the client received — the same principle as not rewriting a number we already
  issued.
- **A monotonic counter must be seeded defensively.** A year's sequence starts from
  the highest number already written for that year, not from zero: restoring a
  backup, importing a fleet, or a database that issued numbers before a crash would
  otherwise hand out a number that exists. The test writes `VULA-<year>-000042` by
  hand and asserts the next invoice is `000043`.
- **The number format is a contract with the reader.** `VULA-2026-000001` says the
  vendor, the year and the position in that year's run. The old format said the
  date and four random digits, from which nothing can be reconciled — which is what
  "fix invoice numbering" was really about.
- **A label that omits tax invites a wrong decision.** `R500,00 / terminal / month`
  reads as ex-VAT to anyone who has quoted ex-VAT before; it now says "incl. VAT",
  alongside the Settings field that explains the same rule. Pricing decisions are
  made from labels, so the label is part of the pricing model.

## 2026-09-16 (pre-commit sweep) — three docs described a product that no longer exists

Pre-commit sweep of the markdown, prompted by the owner's "update all relevant md
files". Three claims were false, all of them in files a newcomer reads first:

- **`README.md` said billing was not built** — "Billing _recording_
  (invoices/payments) is not built — `paid_through` is set by hand today". False
  since 2026-09-11, and doubly false after this session (invoices, payments,
  renewals, the mailer and the PDF all exist). The scope list also stopped at
  licences: no billing, no settings, no observability.
- **`prompts/deploy-coolify-control-plane.md` warned about two image traps that
  were fixed on 2026-09-14** — a healthcheck pinned to 3240 while Coolify injects
  `PORT=3000`, and a licence key checked lazily. Both were corrected in the code;
  the runbook kept telling every deployer to work around them. Verified against
  `Dockerfile` (`ENV PORT=3000`, `EXPOSE 3000`, healthcheck on 3000) and
  `src/config/env.ts` (the production boot gate) before rewriting.
- **The same runbook's advice for a token mismatch was the worst possible fix** —
  "if it was lost, delete and recreate the store row; v1 has no token-rotation
  UI". That is precisely the path this session replaced, and following it throws
  away a store's history, licence allocation and deployment jobs. It now points at
  Configure → _Control-plane token_.
- Added while there, because the deploy story changed: mail is configured on
  **Settings**, not in env; no env var and no headless browser is needed for
  invoice PDFs (pdfkit is pure JS — a fact that matters for a small Coolify
  image); and the troubleshooting list gained the two honest mail refusals.
- **The pattern worth naming:** every one of these was a _true_ statement at the
  time it was written. Docs do not fail when the code changes — nothing tests
  them — so the only defence is reading them against the code before shipping a
  change, which is what this pass did.

## 2026-09-16 (sixth pass) — one charge, three names, and a subject posing as a line

- **The same money was called three things.** "Once-off onboarding" (the plan
  field and the server), "Vula onboarding and deployment" (the Billing detail
  view, which is where the owner read it) and "Onboarding" (the client page's
  button). The owner asked for the line under the name they had seen, which is the
  honest way to settle it: the label now lives in one constant on each side of the
  build and the _documents_ use it. Worth noting how the ambiguity arose — each
  surface was written at a different time and none of them owned the vocabulary.
- **A description drawn as a table row is a line item without an amount.** The PDF
  printed `invoice.description` as the first row of the amounts table, so the
  invoice subject appeared to be an uncharged item and the once-off — the actual
  first thing being charged — sat second. Moving the subject up beside the title
  fixed both the reading and the ordering requirement in one change.
- **Ordering is a real requirement, not a preference, and it needs a test.** The
  owner wants the once-off first "when applicable", which means it must stay first
  as rows come and go (recurring-only invoices, hand-priced ones). The email is
  where that is assertable as text (`indexOf` of the label vs the recurring row);
  the PDF sorts from the same code path, so one assertion covers the intent without
  scraping a compressed stream.
- **A UI claim outlived the rule it described.** "The onboarding charge rides the
  client's first invoice only — never a renewal" was true on 2026-09-16 morning
  and false by the afternoon, when the charge began riding whichever invoice came
  next. Nothing failed — it was help text — which is exactly why it would have
  survived indefinitely. When a rule changes, the copy that states it is part of
  the change.

## 2026-09-16 (fifth pass) — "I don't see it" was three explanations fighting in one modal

- **The feature was working; the modal was describing it instead of showing it.**
  Asked to double-check, the create-invoice modal rendered nothing at all until a
  client was picked, then a small grey line about the once-off, then a separate
  "Amount" field and a "What is this for? (optional)" field whose helper explained
  an internal rule — three partial explanations of the same invoice spread across
  four places, and the actual figures nowhere. Replacing all of it with a single
  panel of the lines and the total (subscription, once-off, total) answers the
  question the operator is actually asking, and made "I don't see the once-off"
  impossible.
- **A label that changes from optional to required is a contradiction, not a
  nuance.** "What is this for? (optional)" became mandatory as soon as an amount
  was typed, and the reason — the server refuses a hand-priced invoice with no
  description — is a _server_ rule the operator should never have to infer from
  helper text. The field is now simply absent until it is needed, and asked for by
  name when it is.
- **Explaining a rule in the field's help text is a smell.** "Left blank, the
  invoice describes the subscription it bills" described the server's fallback
  rather than the operator's decision. The fix states the outcome instead ("The
  invoice will read Subscription — Vula Spares Network"), and the server's rule is
  documented in CONTEXT §5e where it belongs.
- **Vocabulary drifted in the modal all along.** It said "Company" (the advanced
  page's term) and "Generate Invoice" while its own heading said "Raise an
  Invoice", in a UI whose merchant term is "Client" everywhere else. Small, but it
  is the surface an operator uses most.
- **A case-sensitive check missed a rendered uppercase heading.** My own live
  verification pattern `/What this invoice will carry/` failed against a panel
  whose heading is uppercased by CSS, so `innerText` returns it in caps — briefly
  making it look like the panel was not rendering. Worth remembering when
  asserting on rendered text: match the _rendered_ case, not the source's.

## 2026-09-16 (fourth pass) — the once-off needed capturing, not a support charge

- **"Bill the once-off" was a rule the panel could not enforce by itself.** The
  charge was only ever attached to an `initial` invoice, so it was captured at
  onboarding and never again: a client invoiced once before the charge was set (or
  whose invoice was cancelled) carried an unbilled R10 000 indefinitely — nine of
  eleven live clients were in exactly that state. The fix is not a new button but a
  change of trigger: the charge now rides on **whichever invoice is raised next**,
  and `setupFeeDueCents` makes double-billing structurally impossible rather than
  something the code has to check for.
- **Automatic capture has to be visible.** A charge that appears on a customer's
  invoice without anyone clicking for it is fine only while the office can see it
  happened: it is itemised as its own line, shown in the create modal (with the
  opt-out), and counted in the renewal sweep's summary. The alternative — silent
  automatic billing — is how a vendor earns a support call.
- **Asked about support, the owner answered with a pricing rule, not a feature.**
  _"ignore support charges. we charging per terminal which includes support."_
  Worth recording as a commercial decision rather than a backlog item, since
  "bill for support" looks like an obvious gap and is in fact a settled question.
  It is now in CONTEXT §5e, the glossary, AGENTS.md's locked-rules section and
  tidbits, so a future session meets the decision before the idea.
- **§40 caught a field name again.** `setupFeeInvoiceNumber` failed the
  privacy-boundary test's name walk on the client/company endpoints — the test
  cannot distinguish a vendor's document number from a merchant's billing data,
  and deliberately does not try. `setupFeeRef` clears it. Second instance of the
  same lesson (2026-09-11's `salesBlocked` → `tradingBlocked`): on this surface,
  reach for a neutral name first.
- **Six existing tests broke, and every break was the feature working.** Each
  expected a hand-priced amount and got amount + R10 000. They now pass
  `includeOnboarding: false` with a comment explaining that the invoice in
  question is about something else — which is more honest than loosening the
  assertions, since it states the intent the test always had.

## 2026-09-16 (third pass) — a script that "pointed at a scratch file" wrote to the live registry

**What happened.** To check the invoice PDF's layout with realistic content
(onboarding line, footer, long client name) I wrote a throwaway script whose
first line was `process.env.CP_DB_PATH = '/tmp/pdf-check.db'`. It did not open
the scratch file. It opened `data/control-plane.db`, created a company
("Urban Threads Retail Group", slug `urban-threads-check`), raised a R14 500
invoice for it, and **overwrote the office identity settings** — name, email,
phone, address and the invoice footer — with the test values.

**Why.** ESM hoists imports above the module body. `env.dbPath` is read when
`src/config/registryDb.ts` is first evaluated, which happens _while the import
statements run_, i.e. before the assignment on line 1 of my script ever executes.
Assigning `process.env` in the file is therefore not a configuration step at all
when the consumer reads env at import time — it is a no-op with a misleading look.

**How it was caught and repaired.** The second run failed with
`SQLITE_CONSTRAINT_UNIQUE` on the company slug, which is what gave it away: a
fresh scratch DB cannot have a duplicate. Repair, in order:

1. The owner's settings were recovered from a PDF rendered two minutes earlier
   (the header and footer are drawn from exactly those fields), restored via
   `PUT /api/settings`, and re-verified. SMTP — host, user, password — was never
   touched by the bad write and is intact.
2. The fabricated company was deleted through `DELETE /api/companies/:id`, which
   cascades to its invoice and its subscription row (audited, and it is the
   sanitised path rather than hand-written SQL).
3. Verified back to the pre-damage shape: 11 companies, 10 invoices, 64 stores,
   6 panels, no rows left for the deleted id.

**The guard that goes with it.** Scratch scripts now (a) take `CP_DB_PATH` from
the shell — `CP_DB_PATH=/tmp/x.db npx tsx script.ts` — and (b) refuse to run at
all unless it starts with `/tmp/`. Both matter: the shell assignment happens
before the process starts, and the guard makes the mistake impossible rather than
merely unlikely. This is the same lesson as the 2026-09-10 `tsx watch`
corruption, one layer out: a tool that _looks_ pointed at a scratch file is not
evidence that it is.

## 2026-09-16 (third pass) — the invoice PDF: three bugs a text dump reveals

- **A money column narrower than the money.** The first cut used the tenant's
  column geometry — `x = 495, width = 57` — which is 57pt for a string that
  measures 59.9pt at 11pt bold, so pdfkit wrapped `R 14 500,00` into
  `R 14 500,0` / `0`. It surfaced only because the rendered text was read back
  with `pdftotext -layout`; nothing about the code looked wrong. Fixed at 110pt
  with `lineBreak: false`, and `moneyColumnFits()` now asserts the fit.
- **Two offsets that were guesses.** `y += 16` after a description, and
  `top + 14` for the field under a client name: both are only right for
  single-line content, so a long description had the total rule drawn through its
  second line and a long merchant name ran into the email row. Both come from
  `heightOfString()` now. The general lesson for this builder: every vertical
  step that follows variable text must be measured.
- **A footer pinned to the foot of the page** (`Math.max(y, 720)`) left half an
  A4 blank on a one-line invoice — the judge's geometry scan (ink bands) caught
  it as a 48%-of-page void with an isolated band near the bottom. Documents flow;
  they do not need to fill the sheet.
- **The tenant's PDF-text test trick does not generalise.** Their
  `labels.test.ts` inflates the content streams and decodes `<hex>` tokens to
  assert on drawn text. That works for their font setup; with the standard fonts
  pdfkit writes **literal** strings with kerning numbers interleaved
  (`[V 60 ula Software 0] TJ`), where a kerning value is indistinguishable from a
  digit in the content — `[12 Rustenb 20 urg ...]` is the string "12 Rustenburg".
  A text-scrape assertion built on that would be fiction, so the CP's test asserts
  the geometry with pdfkit's own metrics (`moneyWidth`, `moneyColumnFits`) and
  the endpoint contract instead, and the visual check was done by reading the
  rendered text. Worth knowing before copying their helper into another repo.
- **A right margin inherited quietly.** The tenant draws to 552pt while setting a
  48pt margin (both sides), because their content width is `504 = 552 - 48`. The
  asymmetry is invisible in their code and was in mine, where the money column
  ended 5pt outside the text box. The CP's document is measured from a single
  `PAGE_RIGHT = 547`, so nothing can drift off the margin unnoticed.
- **Nine clients owe onboarding nobody could bill.** Across the live registry,
  every client except the two mockup ones is `not_invoiced` with a R10 000
  once-off charge. The panel _showed_ it ("Not invoiced yet") and had no action to
  raise it — an accounting entry that existed as a label. That is the concrete
  face of "need somewhere to bill it".
- **Cancelling an invoice left the charge it carried marked as billed.** Watching
  the owner use the new billing form exposed it: they raised an `initial` invoice
  for myDiner (recurring + the R10 000 onboarding), cancelled it, and the
  subscription stayed `invoiced` with nothing due — so the charge could never be
  raised again, while the invoice that would have collected it no longer existed.
  A cancelled invoice must release the one-off charge it was the last to carry.
  Two lessons: a _state_ derived from a cancelled document has to be unwound when
  that document is voided, and the fastest way to find these is to watch a real
  person drive the feature rather than to re-read your own tests (all 228 were
  green while the charge was stranded).

## 2026-09-16 (later) — a stub that reports success, and a credential nobody could repair

- **"Invalid control plane token" is always a two-sided credential mismatch, and
  the CP had no way to fix its side.** The store at `http://ahk-spares-ct.localhost:3278`
  holds its own `CONTROL_PLANE_TOKEN`; creating the registry row without pasting
  that value makes the CP generate a different one, so the first push 401s. The
  API's own advice (in the reveal-once modal) was _"delete this store record and
  add it again pasting that token instead"_ — which throws away the row's history,
  its licence allocation and its deployment-job references to fix a typo. Repaired
  in place now (see progress); verified by creating a probe, watching it fail, and
  watching the same row push successfully after the credential was replaced.
- **Reproduced before diagnosing, on a throwaway store.** Creating the probe
  against the real deployment produced the exact string the owner saw
  (`lastConfigError: "Store POST /api/internal/configure failed: Invalid control
plane token"`), which is what turned "probably the token" into a known path.
  An unassigned store allocates nothing, so this is safe to do against the live
  fleet (findings, 2026-09-16 earlier entry).
- **The owner's `:3278` store cannot be added under AHK Spares as the fleet
  stands.** That client is licensed for 123 terminals with 123 allocated, so
  `POST /api/stores {companyId: 10}` is refused **402
  `terminal_allocation_exceeded`** ("AHK Spares is licensed for 123 terminals,
  with 123 already allocated. This store needs 2."). That refusal is correct — it
  is a commercial decision, not a bug — but it means the demo client's mockup
  fleet (41 branches × 3 tills) now exactly fills its licence, and any further
  branch needs the quantity raised first.
- **`POST /billing/invoices/:id/email` was a stub that lied, and the UI believed
  it.** It wrote an `invoice_emailed` audit row, answered `{ ok: true, sentAt }`,
  and sent nothing; the Billing page toasted "emailed successfully". Nothing in
  the schema recorded whether an email ever went out, so the lie was
  unfalsifiable — no `emailed_at`, no failure state. Two of this codebase's
  recurring defects in one route: fabricated success (§27's warning) and a claim
  with no evidence behind it.
- **Three things in this codebase are called "settings".** The tenant's `settings`
  (per store), `billing_settings` (per client, `company_id`) and the new
  `office_settings` (the vendor, one row). The singleton is named for the office
  because `settings` and `billing_settings` were both taken; CONTEXT §5 spells out
  which is which, since a future reader picking the wrong one would put a
  merchant's data on the vendor plane.
- **A form round-trip must not be able to blank a credential.** The tenant masks
  secrets and treats the mask as "unchanged"; the CP does the same for `smtpPass`.
  The alternative (echo the real password to the browser so the form can resubmit
  it) would put a live credential in every page load and in the CSP-permitted
  script scope for nothing.
- **Clearing the SMTP host clears the credential with it.** A password kept for a
  server that is no longer configured is a credential with no owner; the route
  blanks user/password/from together, and the test asserts the stored row.
- **Ordering is part of the message.** The first cut of `/settings/test-email`
  validated the recipient before noticing SMTP was unconfigured, so the operator
  was told to set an office email when the actual problem was that no mail server
  existed. Found by clicking the button in the browser — no test asserted the
  message, only the code.
- **The mailer is stubbed at the transport, not at our service.** Both suites mock
  `nodemailer.createTransport` and assert on what the control plane does with a
  transport (stamp, audit, refuse, report), so the tests cover our behaviour
  without an SMTP server anywhere in CI.
- **Two money formatters now exist, deliberately.** `frontend/src/lib/money.ts`
  renders amounts in the browser; `src/utils/money.ts` renders them in mail the
  server builds. They cannot share a module across the Vite/tsc build, so the
  duplication is documented in both files rather than hidden.
- **Still open, and recorded rather than silently decided:** the per-client
  `billing_settings.email_invoice` / `auto_renew` flags remain API-only and gate
  nothing — there is still no automatic send, so `email_invoice` has no behaviour
  to describe yet. The SMTP password is stored in plaintext like the tenant's
  (tidbits.md already carries "secrets at rest" encryption as the fix).

## 2026-09-16 — an action that reports its refusal where nobody is looking

- **"The button does nothing" was a working guard with an invisible message.** The
  pause-first rule on store teardown (`409 store_active`) fired correctly and the
  UI surfaced it correctly — into a banner rendered in document flow at the bottom
  of the page. On a 44-card client that is several screens below the card the
  operator just clicked. The refusal was never missing; its _position_ was. Worth
  checking first on any "nothing happens" report: is the feedback rendered, or just
  rendered off-screen?
- **Collapsing the confirm UI on failure removes the last evidence of the click.**
  `removeStore` calls `onDone?.()` in both the success and failure paths, so a
  refused remove resets Confirm/Cancel to a plain "Remove" — the one visible change
  the operator would otherwise notice. A failed destructive action should leave its
  confirmation (and the reason) standing, not tidy itself away.
- **A fixed toast is the right home for action outcomes here, and inline flow is
  not.** The fleet surfaces are unbounded in length by design; anything reported at
  the foot of them is invisible in practice. Anchoring to the viewport costs one
  shared component and removes the whole class of bug for every action that
  reports through `notify` — push, diagnostics, pause, support, remove.
- **The guard is right; the ergonomics were not.** Pause-first exists so a live till
  cannot vanish from the fleet in one click, and CONTEXT §2a documents it. The
  correct fix was to make the refusal legible, never to soften the guard.
- **A throwaway unassigned store is the clean way to prove a teardown path.**
  `POST /api/stores` without `companyId` is not cap-policed and allocates nothing,
  so the full create → refuse → pause → delete cycle can be exercised against a
  live CP without touching any client's licensed terminals. Worth remembering
  before probing destructive routes against real fleet rows (which is how
  `ahk-spares-jhb` was removed during this investigation).
- **Demo registries accumulate cruft that later reads as a bug.** Three stale
  `reseed-fleet` AHK rows (localhost URLs, build `0.3.0`, licence push failed) sat
  inside the mockup client and made its counts disagree with its own branches —
  44 stores where 41 were seeded. Seeding tools should own the whole client's rows,
  or the leftover set becomes indistinguishable from a defect on screen.
- **A running Vite dev server can serve a stale transform, and the page then lies
  about your fix.** After editing the three pages, the browser kept rendering the
  old inline banner while the file on disk was correct — the long-running
  `vite` process had picked up an earlier edit but missed the later writes, so its
  module graph kept the superseded transform. A `touch` on the edited files fixed
  it. The check that settles it in one command: `curl -s
http://localhost:3241/src/pages/<Page>.tsx | grep -c NoticeBanner`. Beware the
  trap in grepping transformed output — it emits double quotes, so a search for
  `notice.kind === 'ok'` finds nothing even when the old code is what is being
  served; absence of the new symbol is the reliable signal.
- **High-level Playwright clicks did not register in this in-app browser; page-side
  `.click()` did.** Tabs and card buttons both ignored `locator.click()` while
  `evaluate(() => el.click())` worked immediately — worth knowing before
  concluding a UI control is broken rather than the click never landing.
- **Stale doc, noticed not fixed:** `0195a43`'s message records "Suite 199 green (17
  suites)"; the suite reports **198** tests across those 17 suites, consistently, on
  the same tree. One test's worth of drift in a commit message changes nothing about
  the code, so it is left as history rather than rewritten — noted here because this
  repo treats a doc/code disagreement as something to record, not to quietly
  reconcile.

## 2026-09-14 — Deployments: the half-success a status pill hides

- **The orchestration history was already durable and already detailed** — it was
  simply only reachable per client, so nothing new had to be recorded to build
  §33. Same lesson as Devices: check what exists before collecting more.
- **A `complete` step is not necessarily a clean step.** `deployment_job_steps`
  carries `warnings_json` for best-effort operations that failed while the step
  still succeeded. A live wizard run showed `store_deploy_urban-threads` complete
  with 2 warnings and `issue_licences` with 1; a page that renders only
  status pills would report that deployment as flawless. The detail view shows
  the warnings inline.
- **One key cannot mean two things.** The first cut returned `steps` as tallies
  on the list and as rows on the detail. Renamed to `stepCounts` on the list
  before it shipped — the kind of ambiguity that is cheap to fix now and
  expensive once a page depends on it.
- **Jobs carry no version, environment or operator.** `deployment_jobs` has
  `type`, `status`, `error`, `started_at`, `completed_at` and nothing else; the
  image deployed is not recorded, and `audit_logs.actor` is 'office' for whoever
  was signed in. The spec's Version/Environment/Operator columns are therefore
  omitted rather than filled from a guess. If those columns are wanted, the
  orchestrator has to start recording them at deploy time — a write-side change,
  not a display one.
- **The step tally needed one query, not N.** `listStepsForJob` per job would
  have been a query per row on the fleet page; a single `GROUP BY job_id` gives
  the counts for every job at once.

## 2026-09-14 — Versions: what telemetry can and cannot answer

- **There is no version history, only a current value.** `app_version` and
  `schema_version` are overwritten by `recordTelemetry` on every health check or
  sweep. So §32 can answer "what is out there now" and cannot answer "what did
  this store run last week" — worth knowing before anyone promises a fleet
  upgrade timeline from this data.
- **"Minimum supported" is a policy, not a fact.** Nothing in the control plane
  defines a minimum build: no env var, no constant, no plan column. The spec asks
  the page to show one. Defaulting it to `0.0.0`, or inferring it as "the oldest
  build deployed", would both silently manufacture a support commitment, so the
  line is omitted and the omission is documented (CONTEXT §5c, tidbits.md). If
  the owner wants it, it needs a real decision about who guarantees what.
- **A NULL version is a bucket, not a missing value.** A store registered but
  never probed has no `app_version`; dropping it from the distribution would make
  the fleet totals disagree with the Stores list. It gets its own row.
- **"Most deployed" needed a tie rule.** Two builds with equal counts are common
  early on; breaking the tie alphabetically keeps the figure stable across
  refreshes instead of flickering with map iteration order.
- **A Head Office has no environment**, so its members cannot contribute to the
  per-environment counts. The row shows "No environment recorded" rather than
  bucketing every panel into `development`, which would have been wrong.

## 2026-09-14 — the Devices surface: collected then discarded

- **The data was already there.** Per-till `claimed`, `deviceId`, `sessionOpen`
  and `lastSeenAt` have been in `stores.last_telemetry_json` since the v0.4.0
  telemetry contract; `telemetrySummary` reduced them to
  `{configured, claimed, open, online}` and dropped the rest. So §25 needed no
  new collection — only exposure. Worth remembering before building any other
  "the CP doesn't know X" surface: check `last_telemetry_json` first.
- **`lastSeenAt` is a reserved null, not missing data.** The contract already
  documents it (and `pendingEvents`/`failedEvents`) as null until the tenant
  ships device heartbeats. That made "claimed but not reporting" a real,
  distinct state rather than something to guess at, so it gets its own status
  (`claimed`) instead of being rounded to online or offline.
- **A name sort is not a roster order.** Sorting devices by name put a renamed
  "Bakery" before "Front counter"; the view now carries the till number and
  sorts on it. Caught by the test, not by review.
- **`POST /stores` silently ignores unknown body keys.** Sending `terminalNames`
  at create (a field `PUT /stores/:id` accepts) returns 201 with the names
  quietly dropped — the same silent-ignore shape za-pos recorded for
  `settings.head_office_token`. Worth knowing when a create-shaped test fixture
  appears to do nothing.
- **A Head Office is not a device with till state.** `panels` has no
  `environment` column and no terminal/session/telemetry columns at all, so an
  office device carries nulls and `claimed: true` (it is the app itself) — the
  alternative was inventing values to fill the spec's columns.
- **The spec's device _actions_ are blocked, not deferred.** Rename / rotate
  token / revoke / force logout / run diagnostics all need the tenant to expose
  a per-device command API; the CP holds a store-level token and nothing
  per-device. Shipped the page read-only rather than the buttons.

## 2026-09-14 — what the deferred SPOG set can actually be built on

- **Most of the deferred nav has no data behind it.** Checked each surface
  against the schema before planning. Buildable now: **Errors** (latest-only
  per store, hence the new `error_events` table), **Devices** (per-till
  `deviceId`/`claimed`/`sessionOpen`/`lastSeenAt` are already in
  `stores.last_telemetry_json` — `telemetrySummary` reduces them to counts, so
  it needs _exposing_, not collecting), **Versions** (`app_version` /
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
DESC, id DESC LIMIT 1`. Getting this wrong would have shown the _first_
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
  failure text a store returns _is_ a `{ error }` validation message (§40 line
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
  clear it. (Earlier lesson, still true: a field merely _named_ `salesBlocked` fails
  it.)
- **The tenant enforced no terminal cap at all.** `claimDevice` validated only that
  the till existed and was unique; `configure` accepted any 1–99. The licence
  carried `maxTerminalsPerStore` since 2026-09-10 but nothing read it. Now the store
  gates NEW claims on the licence's `maxTerminals` — claimed terminals against the
  signed entitlement, never devices online — keeps a device's _move_ working, and
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
