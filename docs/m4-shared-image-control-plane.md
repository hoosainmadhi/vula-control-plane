# M4 — Shared-Image Release Controller (repository-side)

> **Superseded for operations** by [`docs/control-plane-guide.md`](control-plane-guide.md).
> This file is retained as the design history of the M4 implementation; the
> current release/rollback rules and deployment policy are in the guide.

**Status:** implemented and tested in the Control Plane repository only. **No
Control Plane deployment, no registry publish, no live Coolify change and no
existing-tenant migration was performed.** Existing uncommitted work in this
repository was preserved.

## 1. What changed

The Control Plane now has a release catalog and a per-tenant release controller
for shared GHCR images:

- an immutable image release is registered by `kind`, tag, `sha256` digest,
  version, channel and supported schema range;
- a tenant's live image digest, tag, channel, desired release, last release and
  previous release are persisted on `stores` / `panels`;
- new onboarding uses the latest active **stable** release when one exists,
  creating a Coolify `dockerimage` application from the digest instead of a
  Git/Dockerfile build. Production refuses a Dockerfile build when no stable
  release exists; non-production fallback requires the explicit
  `ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true` opt-in;
- existing `dockerimage` tenants can be upgraded by digest;
- every operation is per-tenant locked and deduplicated;
- schema compatibility is checked before Coolify is called;
- releases can be rolled out in sequential waves, or planned with `dryRun`;
- every attempt, batch item and transition is recorded for audit;
- rollback targets the recorded previous release and refuses an incompatible
  schema.

## 2. Data model

### Release catalog

`image_releases`: `kind` (`store`/`ho`), immutable `tag` + `digest`, `version`,
`channel` (`stable`/`beta`/`canary`), `schema_version` (what the image creates),
`schema_min`/`schema_max` (what it can open), notes, active flag, published time.
`UNIQUE(kind, digest)` and `UNIQUE(kind, tag)` prevent duplicate registrations.

### Tenant state

`stores` and `panels` gained:

`image_digest`, `image_tag`, `release_channel`, `desired_release_id`,
`last_release_id`, `previous_release_id`, `last_release_at`; `panels` also gained
`schema_version` (stores already had it). These are the source of truth for the
tenant's current and previous release.

### Deployment audit

- `release_batches` — one row per rollout, with wave size, dry-run flag, counts
  and terminal status.
- `release_batch_items` — one row per tenant per wave, with action, status,
  from/to digest and error.
- `release_deployments` — the per-tenant chronological history.
- `deployment_locks` — primary key `(tenant_type, tenant_id)`, with a lock
  token and expiry. A stale lock is deleted before a new acquire; a live lock
  makes the second request a no-op.
- Existing `audit_logs` records `release_published`, `release_wave_*`,
  `release_applied`, `release_skipped`, `release_failed` and
  `tenant_release_channel_changed`.

`schema.sql` mirrors the new DDL; the registry auto-migration adds the columns
and tables to an existing database. The live registry was not opened or
migrated in this pass.

## 3. Deployment behaviour

### New tenant provisioning

`createStoreImageDeployment` / `createHeadOfficeImageDeployment` create a
Coolify **Docker Image** application:

- image name includes the digest (`ghcr.io/…/vula-pos-store@sha256:…`);
- no Git repository, Dockerfile, build context or build-time env;
- `health_check_host=127.0.0.1`, path `/health`, port 3000;
- auto-deploy off, HTTPS on;
- a tenant-specific persistent volume `vula-<kind>-<slug>-sqlite-db` mounted at
  `/data`;
- the existing control-plane token is reused; a new JWT secret is generated;
- the standard runtime env only (`DB_PATH`, `BACKUP_DIR`, `IMAGE_DIR`,
  `LEASE_PUBLIC_KEY`, `LEASE_KEY_ID`, `APP_URL`, `TRUST_PROXY`), never a
  tenant secret as a build argument.

Creation and deploy are separate: the app UUID/volume are persisted as soon as
Coolify creates the app, before env/storage/trigger work. The onboarding path
then triggers the deploy and verifies the Coolify deployment, application state
and the release's own `/health` version/revision.

The onboarding path (`runStoreProvisioning` and `clientOrchestrator`) uses the
latest active stable release when present and records the image fields. A
production onboarding without a stable release is refused. The legacy Dockerfile
path is allowed only for non-production with the explicit
`ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true` opt-in (default false). **A production
tenant therefore cannot silently fall back to a Dockerfile build.**

### Existing tenant upgrade

The application must already be a `dockerimage` app. The controller first
verifies the application name/allowlist, `/data` storage and tenant identity,
then stops the old container and waits until it is no longer running. Only then
does it patch the image and trigger the deploy. This stop-first order prevents
two containers from writing the same SQLite volume. A Dockerfile app is refused
with `in_place_image_upgrade_unsupported`; converting it requires a blue/green
migration, so a live database is never attached to a half-switched app.

**Coolify API success is not deployment success.** The controller polls the
Coolify deployment record until a terminal state, rejects failure/timeout,
checks the application status, and requires `/health` to report the release's
version/revision before updating the tenant's image fields. A missing deployment
id fails closed.

### Deduplication and locking

- Same digest already recorded and healthy → `skipped: already_current`; no
  Coolify call.
- Same release already provisioning → `skipped: already_deploying`.
- Another live lock for the tenant → `skipped: locked`; no Coolify call.
- Two simultaneous requests: the unique `deployment_locks` primary key admits
  one; the other returns the no-op. The test suite covers the concurrent case.
- An expired lock is reclaimed, but a still-running `release_deployments` row is
  reconciled against Coolify first. A live Coolify deployment blocks; a stale
  row is marked failed and the retry is explicit.
- `desired_release_id` is persisted before the trigger, so a crash leaves the
  intended state visible.

### Schema safety

An existing tenant with no reported schema version is refused
(`schema_unreported`) until it reports one. An image whose
`schema_min..schema_max` does not include the tenant's current schema is refused
before Coolify is called (`schema_incompatible`). A rollback target is subject
to the same check: an older image that cannot open the current schema is
refused, and the live database is not switched. New tenants are allowed to
start at the release's declared `schema_version`.

### Waves and rollback

`POST /api/releases/:id/rollout` selects by tenant ids, store environment and/or
tenant release channel, then groups tenants into waves of `waveSize` (1–50).
Waves run sequentially; a paused tenant is recorded as `skipped: tenant_paused`.
`dryRun: true` records the plan and calls nothing. `stopOnFailure` defaults to
true: a failed wave marks all remaining items `skipped: previous_wave_failed`
and stops the rollout before touching more tenants.

Tenant `release_state` (`idle`/`queued`/`deploying`/`verifying`/`healthy`/
`failed`/`rolled_back`) and `release_deployments.phase` make the lifecycle
visible. `coolify_deployment_uuid` is recorded when the trigger is accepted.

Rollback uses `previous_release_id` by default, or an explicit `toReleaseId`.
After a successful rollback, `last_release_id` becomes the target and
`previous_release_id` becomes the release that was rolled back from, so the
operation is auditable. There is **no automatic rollback on a failed deploy**;
the operator chooses the target, and the schema gate protects the database.

## 4. API surface

All routes are office-authenticated.

| Method & path                                               | Purpose                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/releases?kind=&channel=&active=true`              | release catalog                                                                                                                    |
| `POST /api/releases`                                        | register an immutable release (kind, tag, digest, version, optional revision, channel, schemaVersion, schemaMin, schemaMax, notes) |
| `GET /api/releases/fleet`                                   | per-store/per-panel image, channel, desired/last/previous release, schema and release state                                        |
| `GET /api/releases/batches` · `/api/releases/batches/:id`   | rollout history and items                                                                                                          |
| `POST /api/releases/:id/rollout`                            | wave rollout, optional `tenantIds`, `environment`, `channel`, `waveSize`, `dryRun`, `stopOnFailure`                                |
| `POST /api/releases/tenants/:tenantType/:tenantId/apply`    | apply one release (`provision`/`upgrade`/`rollback` inferred or explicit)                                                          |
| `POST /api/releases/tenants/:tenantType/:tenantId/rollback` | roll back to the previous or explicit release                                                                                      |
| `PATCH /api/releases/tenants/:tenantType/:tenantId/channel` | set the tenant's release channel                                                                                                   |
| `GET /api/releases/tenants/:tenantType/:tenantId/history`   | release deployments for one tenant                                                                                                 |

`tenantType` is `store` or `panel`; a store release cannot be applied to a
panel and vice versa.

## 5. Tests and acceptance evidence

New suite: `src/__tests__/releases.test.ts` — **29 tests**:

- digest/channel/schema validation and duplicate registration;
- existing-image upgrade pins the digest, records `release_deployments`, and
  updates tenant image/previous/last fields;
- already-current no-op and live-lock no-op make no Coolify calls;
- schema-incompatible upgrade and rollback are refused before Coolify;
- new tenant provisions through `applications/dockerimage`, bulk env, storage
  and deploy, with a tenant-specific volume and the existing control token;
- rollback moves `last_release_id`/`previous_release_id` correctly;
- dry-run wave calls nothing; a real three-tenant, two-wave rollout completes
  with correct wave membership and one patch per tenant;
- failed Coolify deployment, delayed queued/deploying states and timeout;
- old healthy container with a mismatched version;
- missing `/data` storage, identity mismatch and non-allowlisted app refusals;
- stop-first order, concurrent duplicate application, expired-lock takeover and
  active-in-flight blocking;
- a trigger failure followed by a retry that does not duplicate the app;
- production onboarding without a stable release;
- stop-on-failure wave; paused tenant skip;
- office auth, release creation and a dry-run wave through the HTTP API.

Full Control Plane backend on the isolated `m4/shared-image-release` branch:
**532/532 tests, 42 suites**; the main `dev` working tree with its pre-existing
unrelated tests is **506/506**. `npm run typecheck` and `npm run build` are
clean on the branch. No frontend files were changed for M4.

See `docs/m4-architecture-review.md` for the P0/P1/P2 review and
`docs/m4.1-live-integration-plan.md` for the Stage A isolated live-integration
plan. Stage A is not approved or executed; the Coolify token-scope and
unpushed-branch gates are recorded there.

## 6. Deferred / known limits

- **No Release UI yet.** The API is usable by the operator/CLI; a Releases page
  is the next UI increment.
- **No release registration automation yet.** A stable release must be
  registered through the API (or a future CI step) before onboarding can use
  the shared-image path. Production onboarding refuses the legacy Dockerfile
  path; non-production fallback requires the explicit
  `ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true` opt-in.
- **Existing Dockerfile tenants are not converted in place.** They require a
  blue/green migration, which is deliberately out of this repository-side pass.
- **Panel schema reporting is limited.** `panels.schema_version` is set when a
  panel is provisioned/upgraded through this controller; an existing panel with
  no reported schema fails closed on its first image change.
- **No automatic rollback.** A failed deploy is recorded and the tenant is
  marked failed; the operator chooses a schema-safe rollback.
- **No image signature/attestation verification** beyond the private GHCR
  digest; that is a supply-chain follow-up.
- **No background queue.** A large wave runs synchronously in the API request;
  a durable worker and resume endpoint are the next production step.
- **Live Coolify API assumptions** (`application.status`, storage/deployment
  list shapes) were confirmed read-only for Dockerfile apps; a live Docker Image
  app and live stop remain to be exercised in Stage A/B.
- **The production allowlist is static env.** A newly provisioned app's UUID
  must be added to `VULA_ALLOWED_APP_UUIDS` before its first upgrade; a
  DB-backed allowlist is a follow-up.
- **No live registry/Coolify call was made.** All Coolify interactions in tests
  are mocked; acceptance on a real test tenant still needs a separate approval.
