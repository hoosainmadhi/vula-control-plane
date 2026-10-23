# M4 Architecture and Reliability Review

**Status:** repository-side review and fixes complete. **No Control Plane
deployment, live release registration, tenant migration, credential rotation or
Coolify change was made.** The existing uncommitted work in this repository was
preserved; M4 changes remain uncommitted for review.

## 1. Scope reviewed

- release catalog and release metadata;
- Coolify shared-image provisioning and digest upgrades;
- tenant image/version/channel state;
- deployment locks, deduplication and in-flight recovery;
- schema compatibility gates and rollback;
- release waves and stop conditions;
- onboarding integration and production fallback policy;
- audit history and API authorization;
- registry/storage/identity safety.

## 2. P0 findings and fixes

### P0-1 — Coolify API acceptance was treated as deployment success

**Risk:** `triggerDeploy` returned no deployment id, and the controller could
mark a tenant healthy from `/health` alone. During a failed rolling upgrade the
**old container** can still answer `/health`, so the CP could record the new
digest while the old image was running.

**Fix:** the deploy trigger now returns Coolify's deployment id. Both onboarding
and upgrades poll `GET /api/v1/deployments/:uuid` until a terminal status, reject
`failed`/`cancelled`/timeout, verify the application is not failed/exited/stopped,
then require `/health` to report the **release's version and revision**. A
missing deployment id is a hard failure, not success. Tests cover failed
deployments, delayed queues, timeouts and an old healthy container.

### P0-2 — Rolling updates could run two SQLite writers

**Risk:** Coolify's rolling update can start the new container before the old one
is gone. Both mount the same `/data` SQLite volume.

**Fix:** for an existing tenant the controller calls Coolify stop, polls the
application until it is no longer running, then patches the image and triggers
the deploy. If the stop cannot be proven, the release fails before starting a
second writer. Tests assert stop → patch → deploy order.

### P0-3 — No storage or tenant-identity preflight

**Risk:** an upgrade could start against a missing `/data` mount and create a
replacement database, or against an application the registry did not intend.

**Fix:** before an image change the controller:

- requires a `/data` storage entry through the Coolify storages API;
- verifies the app is a `dockerimage` app;
- verifies the application name/allowlist;
- calls the tenant's own `/api/internal/status` with its control-plane token;
- for stores, compares the reported `storeName` with the registry and fails on a
  mismatch.

A missing storage, identity mismatch or failed token call is fatal.

### P0-4 — New tenants could silently fall back to Dockerfile builds

**Risk:** production onboarding without an approved stable release used the
legacy Dockerfile path.

**Fix:** production onboarding now refuses when no active stable release exists.
The legacy Dockerfile path is allowed only when
`ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true` **and** the deployment is not
production. The default is false; `.env.sample` documents the opt-in. Existing
tests pin the flag to exercise the old path explicitly.
**Remaining:** the Dockerfile→dockerimage migration for already-existing
tenants is a separate, approved blue/green change.

### P0-5 — A bad registry row could target an unrelated Coolify app

**Risk:** the controller modified whatever `stores.coolify_uuid` /
`panels.coolify_uuid` pointed at.

**Fix:** every existing application change now requires:

- a name matching `za-pos-` (store) or `vula-` (Head Office);
- membership in `VULA_ALLOWED_APP_UUIDS` when that list is set;
- a non-empty allowlist in production.

An empty production allowlist refuses to modify existing apps. Tests use the
prefix path; the live allowlist must be populated before M4.1.

### P0-6 — A trigger/setup failure could create a duplicate app on retry

**Risk:** the app was created before the deploy trigger, but its UUID was only
persisted after a successful release. A failed trigger left an app the registry
did not know about; a retry created another one.

**Fix:** creation and triggering are separate. An `onCreated` callback persists
the app UUID and volume immediately after Coolify creates the app, before env,
storage or trigger work. The trigger-failure test proves the retry upgrades the
same app rather than creating a second.

## 3. P1 findings and fixes

1. **Desired release was not persisted before deploy.** `desired_release_id` is
   now written before the trigger, so `already_deploying` is reachable and the
   desired state survives a crash.
2. **Expired locks could start a conflicting deployment.** Before any new
   attempt the controller reconciles a running `release_deployments` row against
   Coolify's deployment record (and the application's deployment list when the
   trigger id was lost). A still-active job blocks; a stale row is marked failed
   and the retry is explicit. Expired locks are reclaimed; live locks still
   no-op.
3. **A failed pilot wave did not stop later waves.** `stopOnFailure` defaults to
   true. A failed wave marks all remaining items `skipped: previous_wave_failed`
   and no further Coolify call is made. It can be disabled explicitly.
4. **Deployment state was too coarse.** Added `release_state`
   (`idle`/`queued`/`deploying`/`verifying`/`healthy`/`failed`/`rolled_back`) and
   `release_deployments.phase`, plus `coolify_deployment_uuid`. The API exposes
   the state and phase; the batch detail carries updated items.
5. **Onboarding image path was not verified.** New image onboarding now uses the
   same Coolify deployment and version/revision health proof as an upgrade.
6. **Registry auth/missing image failures were not covered.** The release test
   suite now fails a 401/missing-image patch without changing the tenant, and a
   missing create returns a failed result with no app UUID.
7. **Error codes were not visible in returned messages.** Safety failures now
   include codes such as `missing_tenant_storage`, `tenant_identity_mismatch`,
   `deployment_in_progress`, `coolify_deployment_failed` and
   `application_allowlist_missing`.

## 4. P2 findings / remaining limitations

- **No background queue.** A release batch runs synchronously inside the API
  request. A large fleet/wave can outlive a proxy timeout even though the work
  continues. A durable worker/queue and a resume endpoint are the next
  production step.
- **No release UI.** The controller is API-only; a Releases page is deferred.
- **No image signature/attestation check.** The catalog validates digest format
  and exact-digest pinning, but does not verify a Sigstore/cosign signature or
  registry manifest at registration.
- **No automatic CI release registration.** A stable release must be registered
  through `POST /api/releases` (or a future CI step) before onboarding can use it.
- **Schema source is the registry.** The pre-deploy gate uses
  `stores.schema_version` / `panels.schema_version`. The controller does not
  refresh the store's schema from telemetry immediately before every release;
  adding that read is a follow-up (the store telemetry endpoint exposes
  `schemaVersion`). Existing panels without a reported schema fail closed.
- **Coolify API shape assumptions.** Read-only checks against installed Coolify
  4.4.7 confirmed `application.status`, `/applications/{uuid}/storages`
  (`/data`, persistent), deployment list records (`finished`, timestamps) and
  deployment-by-UUID. The image fields were nullable on the inspected Dockerfile
  apps, and the stop path is an async queued job that removes containers and
  writes `exited`; a live Docker Image app and a live stop must still be
  exercised in M4.1. If `status` is absent, stop-first fails closed rather than
  risking two SQLite writers.
- **No automatic rollback.** A failed deployment is recorded and the tenant is
  failed; the operator chooses the schema-safe rollback target.
- **Release authorization is office-wide.** Every office JWT can publish and
  roll out. A release-manager role/approval boundary is a security follow-up.
- **No release-catalog edit/retire UI/API.** Releases can be registered and
  listed; deactivating or editing an existing release is not exposed yet.
- **Coolify app name prefix is a heuristic.** The allowlist is the authoritative
  control; the prefix check is defence in depth.
- **The production allowlist is static env.** A newly provisioned app's UUID must
  be added to `VULA_ALLOWED_APP_UUIDS` before its first upgrade; a DB-backed
  allowlist or automatic registration of CP-created apps is a follow-up.
- **Onboarding creation failure after app creation is only partly stateful.**
  The app UUID is persisted via `onCreated`, but a failure before the result can
  leave the tenant at `provisioning` with a failed deployment step rather than a
  tenant-level failed state; the operator sees the failed step and can retry
  against the persisted UUID.

## 5. Test evidence

`src/__tests__/releases.test.ts` — **29 tests**, including:

- catalog validation and duplicate registration;
- upgrade, dedup, live lock, expired lock and active in-flight reconciliation;
- schema-incompatible upgrade/rollback refusals;
- missing `/data` storage and tenant identity mismatch;
- stop-first order;
- failed Coolify deployment, delayed queued/deploying states and timeout;
- old healthy container with the wrong version;
- registry authentication/missing image;
- concurrent duplicate application of one release;
- trigger failure followed by a retry that does **not** duplicate the app;
- production onboarding without a stable release;
- dry-run, stop-on-failure waves, paused tenants and wave ordering;
- office authentication, release creation and API dry-run wave.

Full Control Plane backend: **506/506 tests across 37 suites**; `npm run
typecheck` and `npm run build` clean. Build warning: the existing frontend bundle
is >500 kB; unrelated to M4.

## 6. Changed files (M4 review)

New:

- `src/services/releaseCatalog.ts`
- `src/services/releaseOrchestrator.ts`
- `src/services/applicationGuard.ts`
- `src/routes/releases.ts`
- `src/__tests__/releases.test.ts`
- `src/__tests__/stagingBoundary.test.ts`
- `docs/m4-shared-image-control-plane.md`
- `docs/m4-architecture-review.md`
- `docs/m4.1-live-integration-plan.md`
- `docs/m4.1-staging-ownership.json`
- `docs/m4.1-token-rotation-plan.md`
- `docs/m4.1-stage-a-execution.md`
- `docs/onboarding-deployment-name-defect.md`

Modified:

- `src/config/registryDb.ts` / `schema.sql` — release tables, tenant image
  state, release state, phases, deployment tracking.
- `src/config/env.ts` / `.env.sample` — image names, health/lock timing,
  allowlist, legacy-onboarding opt-in and the optional staging boundary.
- `src/__tests__/env-setup.ts` — pins the explicit legacy-onboarding opt-in for
  tests that exercise the old path.
- `src/services/coolify.ts` — dockerimage creation, digest patch, deployment
  status/storages clients, trigger id, exact staging creation checks.
- `src/services/storeProvisioning.ts` — image-first onboarding, verification,
  production/opt-in fallback policy and staging redeploy guard.
- `src/services/clientOrchestrator.ts` — image-first onboarding, verification
  and staging retry guard.
- `scripts/release-apps.sh` — reads only the Vula application's own credential;
  no OptiMed `.env` fallback.
- `src/routes/index.ts` — release routes.
- `CONTEXT.md`, `progress.md`, `findings.md`, `task_plan.md` — doctrine and
  review record.

## 7. M4.1 Stage A (complete under approved naming amendment 1)

**Execution result:** the CP and one Store are running and healthy. The Store app
is `za-pos-m4-staging-client-m4-store-a`, accepted by explicit amendment after
ownership verification; the exact UUID is allowlisted. No rename or recreation
was performed. Details:
[`docs/m4.1-stage-a-execution.md`](./m4.1-stage-a-execution.md). The separate
`deploymentName` onboarding defect is recorded in
[`docs/onboarding-deployment-name-defect.md`](./onboarding-deployment-name-defect.md).

**Objective:** validate one CP-provisioned Store from the approved arm64 image
on isolated staging infrastructure, without upgrading, rolling back, migrating a
demo or touching the production Control Plane. Exact targets, credentials,
release payload, abort conditions, stop-first recovery and cleanup are in
[`docs/m4.1-live-integration-plan.md`](./m4.1-live-integration-plan.md) and the
exact-resource manifest is
[`docs/m4.1-staging-ownership.json`](./m4.1-staging-ownership.json).

### 7.1 Read-only findings that change the approval

- **Coolify tokens are team-scoped, not project/app-scoped.** The installed
  Coolify 4.4.7 token belongs to Root Team (`id: 0`) and can see 28 applications,
  13 projects and one server. It supports `read`, `write`, `deploy`, `root` and
  sensitive abilities, but no per-project restriction. A new team cannot use the
  existing Root Team server; true isolation needs a separate Coolify instance or
  team-owned server.
- **The CP UUID allowlist is not token scoping.** `VULA_ALLOWED_APP_UUIDS` is a
  Control Plane guard for release operations. It does not reduce what a leaked
  Coolify token can modify. Stage A must explicitly accept the residual Root
  Team access or remain blocked. During preparation, shell-sourcing the CP
  `.env` emitted part of the existing token into a local tool log; treat that
  token as exposed. Its replacement is coordinated per application
  (`coolify-optimed-cp`, `coolify-vula-prod-cp`,
  `coolify-vula-staging-cp`, `coolify-vula-m4-staging-cp`) and is independent of
  Stage A. The Vula release script no longer falls back to OptiMed's `.env`.
- **The isolated branch is unpushed.** Stage A must deploy the exact reviewed
  `m4/shared-image-release` commit, not dirty `dev`; until that commit is on the
  CP remote (or packaged as an approved image), Stage A cannot start.
- **Staging URLs and TLS are available without DNS changes.** Wildcard DNS
  already resolves the proposed hosts. Existing subdomains have per-host Let's
  Encrypt certificates; the new hosts currently return the Traefik default
  certificate until their routers exist. No Cloudflare Tunnel, DNS edit, proxy
  edit or `acme.json` action is permitted.
- **The CP database must sit directly in the mounted volume.** The image defaults
  to `CP_DB_PATH=/data/control-plane.db` and `VOLUME /data`; Stage A uses a new
  `vula-cp-m4-staging-data` volume at `/data`, not the withdrawn
  `/data/m4-staging/...` path.

### 7.2 Stage A scope

1. Deploy `vula-cp-m4-staging` from the exact branch commit with a new empty
   registry, staging-only keys/credentials and auto-deploy off.
2. Register only the approved Store A digest
   (`sha256:6db6b974...`, `v2026.10.21-5781c2c`, revision `5781c2c0...`,
   schema 1/1/1).
3. Provision **one** Store through the CP client-onboarding API, with no manual
   Coolify app pre-creation: `za-pos-m4-store-a` at
   `https://m4-store-a.vula-app.co.za`, volume
   `vula-store-m4-store-a-sqlite-db`; then set the registry row to
   `environment: "staging"`.
4. Verify exact digest, arm64 registry manifest, per-host TLS, `/health`, tenant
   DB/schema, runtime env independence and one `/data` volume.
5. Enable the exact Store app UUID in `VULA_ALLOWED_APP_UUIDS`, restart the
   staging CP and verify no other tenant exists.
6. Record redacted Coolify API responses, CP job/steps and deployment lifecycle;
   fill the ownership manifest.

### 7.3 Not in Stage A

Release B publication, upgrade/rollback, wave tests, Store B, Head Office, demo
migration, production CP deployment, image publication, credential rotation,
DNS/proxy/`acme.json` changes and any unrelated app modification.

### 7.4 Repository-side staging boundary

`src/services/applicationGuard.ts` makes the isolation enforceable rather than
procedural:

- staging creation requires the effective Coolify project, server and
  destination to match `VULA_STAGING_*`;
- the expected app name must match `VULA_STAGING_APP_PREFIXES` and the FQDN must
  match the staging domain prefix/suffix;
- after Coolify creates the app, the CP persists the UUID and reads the app back
  to verify its exact name, Docker Image build pack, project (when reported) and
  FQDN; a mismatch fails the deployment;
- staging requires a non-empty exact UUID allowlist for every existing-app
  modification, including the redeploy/retry paths that previously bypassed the
  release controller;
- production behavior is unchanged unless `VULA_STAGING_MODE=true`.

Tests: `src/__tests__/stagingBoundary.test.ts` covers project/server/destination
mismatch, name/domain refusal, missing scope, created-app mismatch and the exact
allowlist. Full branch suite: **520/520** after this guard.

Residual: the staging CP still holds a Root Team Coolify token. The guard
prevents the CP's normal code paths from selecting another project/app, but a
server-side compromise could still use the token outside those paths.
