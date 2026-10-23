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
- `src/routes/releases.ts`
- `src/__tests__/releases.test.ts`
- `docs/m4-shared-image-control-plane.md`
- `docs/m4-architecture-review.md`
- `docs/m4.1-live-integration-plan.md`

Modified:

- `src/config/registryDb.ts` / `schema.sql` — release tables, tenant image
  state, release state, phases, deployment tracking.
- `src/config/env.ts` / `.env.sample` — image names, health/lock timing,
  allowlist, legacy-onboarding opt-in.
- `src/__tests__/env-setup.ts` — pins the explicit legacy-onboarding opt-in for
  tests that exercise the old path.
- `src/services/coolify.ts` — dockerimage creation, digest patch, deployment
  status/storages clients, trigger id.
- `src/services/storeProvisioning.ts` — image-first onboarding, verification,
  production/opt-in fallback policy.
- `src/services/clientOrchestrator.ts` — image-first onboarding and verification.
- `src/routes/index.ts` — release routes.
- `CONTEXT.md`, `progress.md`, `findings.md`, `task_plan.md` — doctrine and
  review record.

## 7. M4.1 live-integration plan (approval required before execution)

**Objective:** validate the controller against the real Coolify API and one
isolated test tenant, without migrating an existing demo. The exact staging
targets, credential boundaries, test-release strategy, read-only contract
evidence, abort conditions and cleanup are in
[`docs/m4.1-live-integration-plan.md`](./m4.1-live-integration-plan.md).

1. **Preconditions**
   - CP deployed to staging from the reviewed `dev` commit (separate approval).
   - `VULA_ALLOWED_APP_UUIDS` populated with only the test app UUID(s); any app
     UUID created during the pilot must be added before its first upgrade.
   - One stable Store release and one stable HO release registered by digest,
     with version/revision/schema metadata.
   - A new test tenant/app with its own copied DB and volume; no existing demo
     is used or modified.
   - Backups/rollback source understood; no live credential rotation.
2. **Read-only/live preflight**
   - Confirm `/health`, app kind, storage `/data`, tenant identity and schema.
   - Confirm the app is `dockerimage` and its UUID is allowlisted.
3. **Provisioning**
   - Create a new test Store from the stable digest; verify exact digest,
     runtime env independence, volume, health version/revision and no build.
4. **Upgrade**
   - Apply the next test release; confirm stop-first, Coolify `queued` →
     `deploying` → `verifying` → `healthy`, no two writers, image/version change.
5. **Safety negatives**
   - Repeat the same release (already-current no-op).
   - Concurrent apply (one lock, no second deploy).
   - Force a deployment failure and confirm no tenant image update; roll back to
     the previous release and verify schema/health.
   - Remove `/data` from a copy and confirm the preflight refuses before stop.
   - Point at a non-allowlisted app and confirm refusal.
   - Register a schema-incompatible release and confirm refusal.
6. **Waves**
   - Two test tenants in two waves with `stopOnFailure=true`; fail wave 1 and
     confirm wave 2 is skipped. Repeat with `stopOnFailure=false` only in an
     isolated test if approved.
7. **Audit and evidence**
   - Export `release_batches`, items, deployments, audit rows and deployment
     logs; record timings, Coolify status transitions, image digests and
     health/revision. No secrets in evidence.
8. **Rollback plan**
   - Stop/delete the test apps and volumes; never touch existing demos. If an
     existing app were ever used, rollback requires the previous image plus the
     schema-compatibility check and a verified DB copy; that is not part of
     M4.1.

**Explicitly excluded:** fleet migration, existing demo modification, CP
production deployment, credential rotation, registry publication, shared proxy/
`acme.json`/DNS/firewall changes.
