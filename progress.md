# Progress

## 2026-09-16 (eighth pass) — the plan on the invoice

Owner: *"we should [show] the plan in the invoice."*

- **The plan is now on the document, as a snapshot.** `invoices.plan_code` /
  `plan_name` are written when the invoice is raised and never read back from the
  catalogue: renaming a plan must not restate what an issued invoice says. That
  was already untrue in one place — the Billing detail view looked up the
  *client's current* plan and printed it on old invoices — so the UI now reads the
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

Owner: *"fix invoice numbering"* + *"prices inc VAT"*. Both were on the
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
  per-terminal label now says *incl. VAT* — otherwise the office reads a rate as
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

Owner: *"alway have the Vula onboarding and deployment first line item when
applicable in invoice."*

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

Owner: *"i dont see the once off when creating an invoice"* and *"this is
confusing: What is this for? (optional) -> Left blank, the invoice describes the
subscription it bills."*

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
  says *"— leave empty to bill the subscription"*, the description field appears
  **only when an amount is typed**, and it asks *"What is this amount for?"* with
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

Owner: *"when creating an invoice: check if once-off has been payed. if not it
invoice it"* and *"Allow to bill for support as well"*.

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
  owner answered: *"ignore support charges. we charging per terminal which includes
  support"*. So no support line, tier or charge type — and it is written into
  CONTEXT §5e, the glossary, AGENTS.md ("Commercial rules locked with the owner")
  and tidbits, because "add a support fee" is an obvious-looking feature for a
  future session to invent.
- **A field name had to change for §40.** Naming the carrying document
  `setupFeeInvoiceNumber` failed the privacy-boundary test, which walks field
  *names* on the client and company endpoints and cannot tell a vendor document
  number from a merchant's billing data. Renamed `setupFeeRef` — the same lesson
  as `salesBlocked` → `tradingBlocked` in 2026-09-11.

Tests: CP **233 green (19 suites)**; backend typecheck, frontend `tsc -b` and the
production build clean. Six existing billing tests were given an explicit
`includeOnboarding: false`, each with a comment saying why that invoice is not the
moment to capture the charge. Not committed (house rule).

## 2026-09-16 (third pass) — the invoice as a document, and somewhere to bill a once-off

Owner follow-ups on the mailer, all about the invoice itself:

1. *"in Email: Sent by the Vula control plane"* — "control plane" is internal
   vendor vocabulary a merchant should never read on an invoice. Every mail now
   signs off with the office's own name (`Sent by {office name}`), the test email
   included, and a test asserts the phrase never appears in an invoice email.
2. *"can we not have pdf invoice attached to email"* — **yes.** `services/invoicePdf.ts`
   renders an A4 invoice with pdfkit (the tenant's engine and conventions), the
   mailer attaches it, and `GET /api/billing/invoices/:id/pdf` serves the same
   document, so the download and the attachment cannot diverge. The Billing
   invoice modal gained "Download PDF" (fetched with the session token, then
   handed to the browser as a blob).
3. *"What about charging once off payment? need somewhere to bill it"* — this was
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

Owner: *"continue with phase 2"* — the CP settings singleton + Settings page +
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

Owner report: *"client : Client Details -> remove -> Confirm remove : store is not
removed."* Not a broken handler — the pause-first guard was working exactly as
designed and saying so, into the wrong place.

- **Diagnosis.** `DELETE /api/stores/:id` refuses an `active` store with **409
  `store_active`** ("Pause it first, then remove it"). Every seeded store is
  active, so every Remove was refused. The refusal *was* reported:
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
- **Verified end-to-end** against the running CP with a throwaway *unassigned*
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
  (`stores.test.ts` asserts 409 + "pause it first"); the *presentation* fix is not,
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

Owner: *"we should group by client name / company name no?"* — yes, and the
registry shows why that needs care rather than being a straight nesting.

**The fleet is majority-unowned.** Of 16 stores and 65 tills, only 11 stores /
28 tills belong to a client:

| Client | Stores | Tills |
| --- | --- | --- |
| *(no client)* | 5 | **37** |
| Urban Threads Retail Group | 3 | 9 |
| Kloof Auto Spares | 3 | 8 |
| Cresta Grocers | 2 | 5 |
| AHK Spares | 2 | 4 |
| myDiner | 1 | 2 |

So client becomes a **section band** (not a second collapse level — two nested
disclosures would mean two clicks to reach any till), and the five unowned stores
get an explicitly marked **`Unassigned — no client`** section, amber and sorted
last. That section is the largest on the page (37 tills), which is the honest
picture: most of this fleet is not attributed to anyone. Hiding those stores
would misstate the fleet; filing them under a client would invent ownership.

- The client name moved off the store header onto the band, so it is stated once
  instead of on every store row.
- **A data bug fell out of the exercise:** company *HM Spares* owns a Head Office
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

**Why this one first.** A store row keeps only the *latest* failure
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
- **`custom` plans may hold a monthly charge.** Owner: *"so that the custom plans
  hold a monthly charge"*. New additive column `plans.custom_amount_cents` (integer
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
(9 modified files, 404 insertions, frontend not typechecking: it billed *configured*
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
  `terminal_limit_reached`) while a device *moving* keeps its claim and existing
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
every store's tills fit its client's plan ceiling *before* writing anything (that
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
  codes of their own era and run *before* the rename: `restructurePlans` keys on
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
