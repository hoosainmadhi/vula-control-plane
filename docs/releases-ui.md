# Control Plane Releases UI

The Releases workspace builds on the existing Control Plane APIs and components.

## Delivered

- Fleet overview for Stores and Head Offices with environment, current/desired
  version, digest, channel, deploy state and release state.
- Search and kind filters, health/attention summary.
- Release catalog with immutable digest, version, revision, channel and schema
  range.
- Publish-release form requiring the tag to be typed before submission.
- Per-tenant Upgrade and Rollback dialogs with typed tenant-slug confirmation.
- Rollout dialog with release, tenant selection, wave size, dry run and
  stop-on-failure; batch table and item detail with errors.
- Per-tenant release history, including failed attempts and error text.
- Release-manager controls are disabled for non-managers and enforced again by
  the server through `requireReleaseManager`.

## Authorization

`GET /api/releases/capabilities` drives the read-only state in the UI. Every
release mutation route requires an office session plus an email in
`RELEASE_MANAGER_EMAILS`; production with an empty allowlist denies mutations.
Existing failed history is never rewritten by the UI.

## Validation

- Frontend production build: passing.
- Frontend UI suite: 33/33.
- Full CP backend suite: 539/539, 42 suites; typecheck and build clean.
- Live staging check: fleet, catalog, rollouts and history rendered; staging
  release-manager actions available; CP healthy.

## Environment, runtime health and rollback eligibility

- The header environment comes from `GET /api/auth/me` (server-derived): a CP
  running with `VULA_STAGING_MODE=true` renders **Staging**, not Production.
- Summary “Runtime healthy” counts `runtimeHealth === 'up'` from the live
  health probe. It is deliberately independent of release history: a tenant
  whose last action was a successful rollback can still count as healthy.
- The fleet table keeps two separate columns: **Runtime** (up/down/unknown)
  and **Last release** (deployed, rolled back, failed, …).
- Rollback target selection is derived from **verified successful deployment
  history and direction**, not from `previous_release_id`. The server takes the
  most recent `complete` `provision`/`upgrade` deployment whose
  `to_release_id` is the tenant's current release, and offers that row's
  `from_release_id`. Rollback rows are excluded from this lookup, which gives:
  - `A → B → rollback A`: no rollback target. B is a forward move and remains
    available through **Upgrade**, not Rollback.
  - `A → B → C → rollback B`: the target is A, not C (the release just left).
- The target must still be in the catalog, be active, match the tenant kind,
  and support the database schema the tenant currently runs. Otherwise the
  button is disabled and its tooltip carries `rollbackReason`.
- `rollbackTenant()` enforces the same rules with `409 rollback_not_eligible`.
  A caller-supplied `toReleaseId` must equal the server-verified target;
  any other release is refused with a message directing it to Upgrade.
- Live staging verification after the direction fix (2026-10-23): header
  **Staging**, Tenants 2, Runtime healthy 2, Needs attention 0, Active
  releases 3. Store A (`A → B → A`, `previousReleaseId = B`) reports
  `rollbackEligible: false` with “The current release was restored by a
  rollback; there is no earlier verified release to roll back to. Use Upgrade
  to move forward”. Store B (first deployment) reports
  `rollbackEligible: false` with “No verified successful forward deployment
  into the current release is recorded; use Upgrade to change releases”.
  Upgrade remains enabled for both.
