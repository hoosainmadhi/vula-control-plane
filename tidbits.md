# Tidbits — small deferred items & backlog

> Prioritised for the next workspace. ~~Struck~~ items are done.

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
- **Payment gateway** — settlement is still recorded by hand (payments now record
  `completed`, and the sweep never fabricates one). A provider webhook is the next
  step; nothing in the invoice model blocks it.
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
