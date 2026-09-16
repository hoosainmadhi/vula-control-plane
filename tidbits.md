# Tidbits — small deferred items & backlog

> Prioritised for the next workspace. ~~Struck~~ items are done.

## Settled — do not build (2026-09-16)

- **Support is not billed separately.** The per-terminal rate includes support
  (owner, 2026-09-16). No support line, tier, charge type or toggle — if it comes
  up again, the answer is in CONTEXT §5e and AGENTS.md's locked-rules section.
  Related ideas that are consequently *not* backlog: support retainers, per-branch
  support fees, support call-out charges.

## Deferred from the invoice-document pass (2026-09-16)

- ~~**Invoice numbering**~~ **shipped 2026-09-16** (`VULA-2026-000001`, from the
  `invoice_sequences` counter). ~~**Stored VAT split**~~ **shipped 2026-09-16**:
  prices are quoted incl. VAT, the split is stored per invoice with the rate, and
  the document is a tax invoice once Vula's `vat_reg_no` is set on Settings.
  **Phase 3 is down to print CSS.**
- **Print CSS.** The Billing page's "Print" uses the browser's default print of
  the SPA modal; a proper `@media print` sheet (or just pointing Print at the PDF)
  would drop the buttons, nav and grey overlay from a printed invoice. The PDF is
  now the better answer for anything a client sees, so this is cosmetic.
- **Nine clients have a R10 000 onboarding charge nobody has billed.** Every
  client except AHK Spares and Street Gym is `not_invoiced`. As of the fourth pass
  this no longer needs a decision per client: whichever invoice is raised next for
  each of them carries it (the renewal sweep included), and the modal shows the
  line before it goes out.
- **The invoice PDF has no logo and no VAT number line.** Both wait on a real
  decision (a vendor logo file, and the VAT treatment above), so the document
  shows identity and arithmetic only.
- **Attachments are generated per send.** A 2–3KB PDF built on each email is
  fine; if invoices ever carry many line items or a logo, caching by invoice id
  would be worth it.
- **`invoicePdf.ts` measures with the standard Helvetica metrics.** If a branded
  TTF is ever embedded, `moneyColumnFits()` must measure that font instead — it
  takes the font name and size as arguments for exactly that reason.

## Deferred from the settings/mailer phase (2026-09-16)

- **Phase 3 of the plan is queued:** invoice numbering (a monotonic
  `VULA-2026-000001` sequence instead of date + random 4 digits), the stored
  VAT split (subtotal / VAT / total on the invoice), and a PDF + print CSS.
  **The PDF shipped 2026-09-16** (`services/invoicePdf.ts`, attached to the mail
  and downloadable from Billing); what remains is numbering, VAT and print CSS.
- **`billing_settings.email_invoice` / `auto_renew` gate nothing.** They are
  settable over the API and read by nothing — there is no automatic send and
  the sweep only *creates* renewal invoices. Either give them a behaviour
  (auto-email a raised invoice; auto-renew on the sweep) or drop them before an
  operator believes they are configured.
- **The SMTP password is stored in plaintext.** Same posture as the tenant's
  mailer and recorded under "Deployment secrets at rest" below; the mailer is
  the second credential this app stores, alongside the per-store tokens that
  belong to the same AES-256-GCM task.
- **Nothing emails the office when something breaks.** The Errors feed (§30)
  records failures but no one is told; with SMTP configured, a daily digest or
  an alert on a new fingerprint is the obvious next use of the mailer — and it
  needs a decision about who receives it first.
- **A failed test email is not audited.** Success is (`settings_test_email`);
  a failure is only on screen. Deliberate for now — a setup mistake is not a
  privileged action worth a row — but it means "we tried and it failed" is not
  answerable from the trail, unlike the client-facing invoice send.
- **The Settings page has no "send a copy to myself" or address verification.**
  The test email is the only proof a credential works, and it needs a save
  first (the UI says so).

## Production deployment — close before cutover (2026-09-14)

From the review behind `za-pos/prompts/deploy-production-vula-app.md` §10.

- ~~**This image does not build in a clean context.**~~ **Fixed 2026-09-14** (was: `frontend/tsconfig.node.json`
  asks for `types: ["node"]`, but `@types/node` is not declared in
  `frontend/package.json` — locally the root install hoists it, so `npm run
  build` passes and the failure only appears in Coolify's build:
  `error TS2688: Cannot find type definition file for 'node'`. One-line fix
  (declare the dependency in the frontend, refresh its lockfile), verified to
  make the image build. **Blocks deploying this app at all.**
- ~~**This image pins `EXPOSE 3240`**~~ **Fixed 2026-09-14**: default, `EXPOSE` and healthcheck all 3000, matching the injected `PORT` (was: and probes `localhost:3240/health`, while
  Coolify injects `PORT=3000` for the proxy.** The container can serve traffic
  and still be marked unhealthy, which reads as a failed deploy. Align the image
  (default `PORT=3000`) or pin the resource's proxy port — decide once.
- ~~**The licence private key refuses lazily.**~~ **Fixed 2026-09-14**: checked at boot (was: `licenceSigner.loadKeys()` exits
  with a FATAL log on first use in production, so a keyless CP boots looking
  healthy and dies when the first client is onboarded. Make it a boot gate.
- ~~**`BACKUP_DIR` is not injected into store deployments.**~~ **Fixed 2026-09-14** (was: Every provisioned
  store therefore writes snapshots into the container's writable layer, where a
  rebuild destroys them. Add it to the store env payload (`/data/backups`).
- ~~**`HEAD_OFFICE_TOKEN` is not injected either.**~~ **Fixed 2026-09-14**: both directions live in `services/topology.ts`, shared by the wizard and `POST /api/stores` (was: The branch is provisioned with
  a merchant token but the merchant's panel is never told it, so the panel
  reports a healthy branch as Offline — the failure that has now been repaired by
  hand twice. Inject it, and register the branch with the panel
  (`POST /api/internal/branches`) as part of provisioning.
- ~~**The data tree is not automatic.**~~ **Fixed 2026-09-14**: provisioning writes it, and the images fix ownership from inside (was: The production layout
  (`/data/apps/vula-app/{cp,store,ho}/…`) needs each host directory created and
  `chown 1000:1000` before first start: these are bind mounts, so the host
  ownership overrides the image's `chown /data`, and the container runs as
  `node` (uid 1000). A root-owned directory means SQLite cannot create its WAL
  and the container dies at boot. Have provisioning do it rather than document
  it.
- **Volume renames orphan data.** Coolify keys persistent storage by name, so a
  change to the tree applies to new deployments only.

## Deferred SPOG surfaces (2026-09-14, after the Errors page)

Spec: `~/Downloads/vula-control-plane-agent-ui-revision.md` (§25–§36, §39).
Order is buildable-first; each is its own increment.

- ~~**Errors page (§30)**~~ **shipped 2026-09-14** (`error_events` feed, nav +
  `ErrorsPage`).
- ~~**Devices page (§25)**~~ **shipped 2026-09-14** (`GET /api/devices`, nav +
  `DevicesPage`; read-only — no per-device command API exists).
- ~~**Versions page (§32)**~~ **shipped 2026-09-14** (`GET /api/versions`, nav +
  `VersionsPage`). **Still open: the "minimum supported version" policy** — the
  page omits it because nothing defines it. Decide where it lives (env var, a CP
  setting, or a plan column) and who guarantees it before adding the line.
- ~~**Deployments page (§33)**~~ **shipped 2026-09-14** (`GET /api/deployments`,
  nav + `DeploymentsPage`, read-only). **Still open: a job records no image
  version, environment or operator**, so those spec columns are omitted; adding
  them means changing the orchestrator's writes, since `deployment_jobs` has no
  such columns today.
- **Blocked — do not start without tenant work:**
  - **Sync dashboard / Sync Inspector (§28/§29)** — `pendingEvents`,
    `failedEvents`, `lastSyncAt` and per-till `lastSeenAt` are contracted but
    **null until za-pos ships device heartbeats**; there is no sync-event store
    to inspect by `sync_event_id`/`correlation_id`, so §29 has nothing to query.
  - **Printers page (§27)** — no printer agent exists in the tenant.
  - **Backups page (§36)** — needs a tenant internal endpoint; za-pos exposes
    `/api/backups` to its own admins only. Cross-repo (za-pos + CP).
  - **Logs, Feature Flags (§34), Migrations (§35), Integrations, Services,
    API Explorer, Webhooks** — no data model at all.
- **The grouped nav (§39) is now the obvious follow-up, and the owner's call.**
  Four surfaces shipped (Devices, Versions, Deployments, Errors) on top of
  Clients/Plans/Billing, so the flat bar is seven items and the spec's groups
  (FLEET, RELEASES, OBSERVABILITY, PLATFORM…) would read better. It is a design
  change to the shell, not a data problem — but the spec's other groups
  (OPERATIONS/Health/Sync/Jobs, DEVELOPER/Diagnostics/Sync Inspector/API
  Explorer/Webhooks) still have no data, so only the groups holding shipped
  surfaces should be introduced.

## Deferred from the subscription redesign (2026-09-13)

- **The live fleet's plans arrived as `custom`.** Starter/Business/Multi-Store
  carried flat prices; rather than re-interpret them as per-terminal rates (which
  would have multiplied live bills by till count) they became `custom`. To restore
  automatic renewal either set a per-terminal rate, or put the old flat figure in
  the plan's **agreed amount** (2026-09-13) so it bills flat each period. (See
  findings.md 2026-09-13.)
- **Pro-rata upgrades** — changing the licensed quantity mid-period bills the new
  quantity from the next period, not pro rata. Decide the policy before real money.
- **Per-invoice VAT** — the invoice still has no subtotal/VAT/total split (see the
  older item below); the redesign put the arithmetic in place, not the tax.
- **Subscription snapshots / grandfathering** — a plan edit still changes every
  client on it. Snapshot the rate onto the subscription before changing a price on a
  live customer.
- **Additional-branch onboarding fee (§14 of the brief)** — deliberately not built.
  The architecture allows it (a plan column + a per-store charged flag); today the
  onboarding charge is once per client.
- **Payment gateway** — settlement is still recorded by hand (payments record
  `completed`, the sweep never fabricates one, and the UI offers only manual EFT
  and bank transfer since 2026-09-16). A provider webhook is the next step; nothing
  in the invoice model blocks it. When it lands, "charge the card" is a **new
  action** beside *Record payment* — not a relabelling of it — and the gateway
  method values the API still accepts gain their real meaning.
- **Register display of the allowance** — `/api/runtime-config` publishes
  `subscription.maxTerminals` and the register's type carries it; the "N of M
  licensed" line in the till picker is not drawn yet (the gate itself is live).
- **Legacy `branch_stores.control_plane_token`** in za-pos is still named for the
  vendor credential; the additive `head_office_token` is what wires topology.

## Deferred from the production-readiness review (2026-09-12)

Source: the deep-dive report (see findings.md, 2026-09-12) — items too
small/late for the P0–P2 phase set in task_plan.md.

- **Invoice numbers** — date + random 4 digits; a UNIQUE collision surfaces
  as a raw DB error instead of a retry. Move to a monotonic sequence
  (`VULA-2026-000001`).
- **VAT treatment of Vula's own billing** — decide incl./excl. and document
  it before real customer invoices; the invoice model eventually needs
  subtotal / VAT / total + seller VAT number (separate from the merchant's
  POS VAT, which must stay off this plane — see P2).
- **Annual pricing** — prefer monthly × 10 (~two months free) over a
  separate annual catalogue.
- **Plan edits vs grandfathering** — subscription snapshots (P1) before
  changing any price on a live customer; plan changes get an explicit
  effective date, never silent retroactive edits.
- **Archived plans UI** — `plans.is_active` toggle + Active/Archived split;
  never delete a plan that has been billed.
- **Deployment secrets at rest** — encrypt stored CP credentials
  (AES-256-GCM under a `VULA_SECRET_ENCRYPTION_KEY` master key).
- **CP auth hardening** — RBAC roles (platform owner / support / billing /
  read-only) and shorter sessions (HttpOnly cookies) before wider
  operational use; today it is one week-long `office` JWT in localStorage.
- **HO menu fallback (za-pos)** — the hostname-derived Head Office URL in
  `frontend/src/config.ts` must never be authoritative in production;
  runtime config wins, and the menu is role-gated.
- **Activation flow** — prefer first-login activation links over delivering
  temp passwords long-term; the reveal-once-never-stored posture stays.

## Deferred from the licensing work (2026-09-10)

- ~~**Billing recording (L3)**~~ **shipped 2026-09-11** — invoices, payments,
  paid-through advancement, automated renewals, Billing UI.
- ~~**Feature enforcement (L4)**~~ **CP authority side shipped 2026-09-11** —
  curated vocabulary + validation, `requireFeature` 402 gates, licence
  propagation on entitlement change, register states surfaced; contract in
  CONTEXT §2b. The store side (`requireFeature` middleware, checkout/sync
  gate, `/api/runtime-config` subscription block, register banners) is the
  **za-pos workstream**.
- **Head Office entitlement (L5)** — the panel should gate `multi_store`.
- **Store telemetry** — app/schema/config version, heartbeat, per-terminal
  last-seen, sync events. Without it the SPOG's Version / Sync / terminal-online /
  Diagnostics fields have no data and would be designed twice.
- **Plan deactivation UI** — `plans.is_active` exists with no toggle.
- **Audit trail (§38)** — every privileged action (push, pause, licence, rotate,
  support session) is currently unattributed.
- **Lease key rotation** — `keyId` is in the claims and the store records it, but
  there is no rotation flow or key set.
- **Enforcement against a customer-hosted container** — asymmetric signing binds
  only where the vendor hosts the container; a customer with root can swap the
  public key. Recorded as an accepted limitation in `za-pos` `findings.md`.

## Struck / reassigned from the fleet set (2026-09-10)

- ~~F3a fleet summary on the CP~~ **STRUCK** — it planned a control-plane dashboard
  carrying product count, orders/revenue, open tills and low-stock. The developer
  control plane must not carry business metrics (§1, §8, §40); that dashboard is the
  merchant's Head Office, and it already exists there.
- **F3b catalogue push / F3c IBT** — flagged as **belonging to Head Office**, not the
  CP. Both are business functions on business data, and `za-pos/head-office` already
  implements them. Revisit before building a second copy here.

## Next workspace — fleet phase set F1–F3 (planned 2026-09-06)

Full roadmap in `task_plan.md` → "Phase set (planned 2026-09-06):
fleet operations F1–F3". Items below marked **F1/F2/F3** are promoted
into that plan.

- ~~Audit table (`store_audit`)~~ **planned F1** — house spec, deferred
  from v1, lands with the ops-hardening phase.
- ~~DELETE `/api/stores/:id`~~ **planned F1** — pause-first teardown
  policy (confirm by slug, revoke token, blocked while active).
- ~~Automated health sweep (10-min interval)~~ **planned F1** — env-
  gated, like optimed's `startHealthSweep`.
- ~~Persist the last push/health _error message_~~ **planned F1** —
  `last_config_error`/`last_health_error` columns.
- ~~Terminal names beyond "Till N"~~ **planned F1** — payload already
  supports a `name` per till; surface it in the edit modal.
- ~~Coolify auto-provisioning for stores~~ **planned F2** — env-gated
  client; needs the vula-app.co.za wildcard DNS live first; the manual
  runbook stays as fallback.
- ~~Live store insight (orders/cash-up dashboards per store), central
  catalogue, IBT~~ **planned F3** — F3a fleet summary, F3b catalogue
  push, F3c IBT; tenant side needs internal-API v0.3.0 in
  ~/apps/za-pos (cross-referenced there).

## Still deferred

- **No frontend test runner.** `frontend/package.json` has no `test` script, so
  UI-level regressions cannot be covered — e.g. the 2026-09-16 fix that moved
  action notices into a fixed toast (the backend refusal it surfaces *is* covered,
  in `stores.test.ts`). Adding vitest + testing-library is the prerequisite before
  any further UI-behaviour fixes claim test coverage.
- **Remove-then-pause ergonomics on the store card.** Remove still refuses an
  active store by design (pause-first teardown, CONTEXT §2a); the 2026-09-16 fix
  only made that refusal visible. A future pass could put the Pause action *inside*
  the remove confirmation, or disable Remove on an active card with the reason
  shown, so the two steps read as one workflow.
- **Two notice idioms.** `ClientDetailPage`/`StoresPage`/`StoreDetailPage` use the
  shared `NoticeBanner` (typed `Notice`); `CompaniesPage`/`PanelsPage` still carry
  their own string-only inline block. Converge when those advanced pages are next
  touched.
- Auto-re-push on PUT when terminal_count/base_url changes (deliberately
  explicit-only in v1 — F1 adds drift visibility; revisit auto-push if
  drift bites).
- ~~Restaurant vertical: add `restaurant` to the CP vocabulary when the
  tenant lands P4~~ **shipped 2026-09-11** (tenant P4 landed; mirror =
  StoreVertical + STORE_VERTICALS + UI/stub/tests, pharmacy precedent).
- Push this repo to GitHub (`gh repo create hoosainmadhi/za-pos-control-plane
--private --source . --remote origin --push`) when asked.
- CSP is minimal (`style-src 'unsafe-inline'`) — tighten if a CSP audit ever
  runs.
- `scripts/dev-store-stub.ts` compiles into the Docker image via tsc (src of
  truth tsconfig includes scripts/) — acceptable; exclude scripts/ from the
  prod tsc pass if size ever matters.
- **vula-app.co.za not registered yet** — docs assume the wildcard scheme
  (`<slug>.vula-app.co.za` + `cp.vula-app.co.za`); DNS must be added when the
  domain goes live (blocks F2 go-live).
- Dev-office email default is still `admin@za-pos.local` (env default +
  docs). A later pass could move to `@vula.local`-style defaults; branding
  pass deliberately left config defaults alone.
