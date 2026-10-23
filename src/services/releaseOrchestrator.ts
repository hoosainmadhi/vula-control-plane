import {
  type ImageRelease,
  type ReleaseAction,
  type ReleaseBatch,
  type ReleaseBatchItem,
  type ReleaseChannel,
  type TenantReleaseState,
  type TenantType,
  acquireDeploymentLock,
  createReleaseBatch,
  createReleaseBatchItem,
  createReleaseDeployment,
  finishReleaseDeployment,
  getImageRelease,
  getLastSuccessfulForwardDeployment,
  getReleaseBatch,
  getRunningReleaseDeployment,
  getTenantReleaseState,
  imageNameFor,
  listImageReleases,
  listReleaseBatchItems,
  listTenantReleaseStates,
  markTenantDeployStatus,
  recordProvisionedRelease,
  releaseDeploymentLock,
  releaseSupportsSchema,
  setTenantCoolifyTarget,
  setTenantDesiredRelease,
  tenantTypeForKind,
  updateReleaseBatch,
  updateReleaseBatchItem,
  updateReleaseDeploymentTracking,
  updateTenantReleaseState,
} from './releaseCatalog.js';
import {
  createHeadOfficeImageDeployment,
  createStoreImageDeployment,
  getApplication,
  getApplicationDeployments,
  getApplicationStorages,
  getDeployment,
  stopApplication,
  triggerDeploy,
  updateApplicationImage,
  type CoolifyDeploymentSummary,
} from './coolify.js';
import { assertApplicationAllowed } from './applicationGuard.js';
import { fetchTelemetry, ping, pingPanel } from './storeClient.js';
import {
  getPanelById,
  getStoreById,
  recordAuditLog,
  recordErrorEvent,
} from '../config/registryDb.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/errors.js';
import { ValidationError } from '../utils/validate.js';
import { logger } from '../utils/logger.js';

export type ApplyStatus = 'complete' | 'failed' | 'skipped';

export interface ApplyReleaseResult {
  status: ApplyStatus;
  tenantType: TenantType;
  tenantId: number;
  releaseId: number;
  action: ReleaseAction;
  fromReleaseId: number | null;
  fromDigest: string | null;
  toDigest: string;
  coolifyUuid: string | null;
  reason?: string;
  error?: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the tenant's public health endpoint; no credential is sent. */
export const waitForTenantHealth = async (
  baseUrl: string,
  timeoutMs = env.releaseHealthTimeoutMs,
  intervalMs = env.releaseHealthIntervalMs,
  expected: { version: string; revision?: string | null } | null = null,
): Promise<boolean> => {
  const clean = baseUrl.replace(/\/+$/, '');
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const res = await fetch(`${clean}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          status?: unknown;
          app?: unknown;
          service?: unknown;
          version?: unknown;
          revision?: unknown;
        } | null;
        const identified =
          body?.status === 'ok' || body?.app === 'vula' || body?.service === 'vula-head-office';
        const versionMatches =
          !expected || (typeof body?.version === 'string' && body.version === expected.version);
        const revisionMatches =
          !expected?.revision ||
          (typeof body?.revision === 'string' && body.revision === expected.revision);
        if (identified && versionMatches && revisionMatches) return true;
      }
    } catch {
      // Container still restarting or the route is not ready.
    }
    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return false;
};

/**
 * Post-deploy readiness. Coolify can report `running:unhealthy` while a new
 * container is warming up, then become healthy. Poll for the exact image and
 * health rather than treating the first transient status as a terminal failure.
 * A definitively failed/exited/stopped app or a wrong image fails immediately;
 * time out only when the app never reaches the expected state.
 */
export const waitForApplicationReady = async (
  coolifyUuid: string,
  release: ImageRelease,
  baseUrl: string,
  timeoutMs = env.releaseHealthTimeoutMs,
  intervalMs = env.releaseHealthIntervalMs,
): Promise<{ ok: boolean; error?: string }> => {
  const expectedTag = release.digest.replace(/^sha256:/, '');
  const expectedName = `${imageNameFor(release.kind)}@sha256`;
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const deadline = Date.now() + timeoutMs;
  do {
    let application;
    try {
      application = await getApplication(coolifyUuid);
    } catch {
      if (Date.now() >= deadline) break;
      await delay(intervalMs);
      continue;
    }

    const status = String(application.status ?? '').toLowerCase();
    // Coolify's human-readable status is unreliable in both directions after a
    // restart: it can say running:healthy while absent, or exited while the new
    // container is already serving. Only a definitive `failed` status is
    // terminal; readiness itself is proven by the image fields and /health.
    if (/failed/.test(status)) {
      return { ok: false, error: `application_status_${status}` };
    }
    const imageName = String(application.docker_registry_image_name ?? '');
    const imageTag = String(application.docker_registry_image_tag ?? '');
    if (imageName !== expectedName || imageTag !== expectedTag) {
      return {
        ok: false,
        error: `application_image_mismatch: expected ${expectedName}:${expectedTag}, running ${imageName || '(none)'}:${imageTag || '(none)'}`,
      };
    }

    try {
      const res = await fetch(`${cleanBase}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => null)) as {
        status?: unknown;
        app?: unknown;
        service?: unknown;
        version?: unknown;
        revision?: unknown;
        database?: unknown;
      } | null;
      const identified = body?.app === 'vula' || body?.service === 'vula-head-office';
      const versionMatches = body?.version === release.version;
      const revisionMatches = !release.revision || body?.revision === release.revision;
      const databaseMatches = release.kind !== 'store' || body?.database === 'connected';
      if (res.ok && identified && versionMatches && revisionMatches && databaseMatches) {
        return { ok: true };
      }
    } catch {
      // Container is still warming up or the route is not ready.
    }

    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return {
    ok: false,
    error: `health_timeout_or_version_mismatch: ${cleanBase}/health did not report version ${release.version}`,
  };
};

const assertReleaseKind = (release: ImageRelease, tenantType: TenantType): void => {
  if (tenantTypeForKind(release.kind) !== tenantType) {
    throw new ValidationError(
      `Release ${release.id} is for ${release.kind === 'store' ? 'stores' : 'Head Offices'}, not ${tenantType}s`,
    );
  }
};

const schemaFailure = (state: TenantReleaseState, release: ImageRelease): string | null => {
  const existing = Boolean(state.coolifyUuid || state.imageDigest);
  if (!existing) return null;
  if (state.schemaVersion === null || state.schemaVersion === undefined) {
    return 'schema_unreported: the deployment has not reported its database schema version; refusing an image change until it does';
  }
  if (!releaseSupportsSchema(release, state.schemaVersion)) {
    return (
      `schema_incompatible: image supports schema ${release.schema_min}..${release.schema_max}, ` +
      `deployment is at ${state.schemaVersion}`
    );
  }
  return null;
};

const SUCCESS_STATUSES = new Set(['finished', 'success', 'succeeded', 'completed', 'complete']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'error']);
const ACTIVE_STATUSES = new Set([
  'queued',
  'in_progress',
  'in-progress',
  'running',
  'starting',
  'building',
  'deploying',
]);

const isTerminal = (status: string): boolean =>
  SUCCESS_STATUSES.has(status) || FAILURE_STATUSES.has(status);
const isSuccess = (status: string): boolean => SUCCESS_STATUSES.has(status);
const isActive = (status: string): boolean =>
  ACTIVE_STATUSES.has(status) || (!isTerminal(status) && status.length > 0);

/** Poll Coolify's deployment record — a 200 from POST /deploy is not success. */
export const waitForCoolifyDeployment = async (
  deploymentUuid: string,
  timeoutMs = env.releaseHealthTimeoutMs,
  intervalMs = env.releaseHealthIntervalMs,
): Promise<{ ok: boolean; status: string; error?: string }> => {
  const deadline = Date.now() + timeoutMs;
  let last: CoolifyDeploymentSummary | null = null;
  do {
    try {
      last = await getDeployment(deploymentUuid);
      const status = String(last.status ?? '').toLowerCase();
      if (isSuccess(status)) return { ok: true, status };
      if (FAILURE_STATUSES.has(status)) {
        return { ok: false, status, error: `coolify_deployment_${status}` };
      }
    } catch (err) {
      last = null;
      if (Date.now() >= deadline) {
        return {
          ok: false,
          status: 'unknown',
          error: `coolify_deployment_status_unavailable: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return {
    ok: false,
    status: String(last?.status ?? 'timeout').toLowerCase(),
    error: 'coolify_deployment_timeout',
  };
};

/**
 * Stop-first confirmation. Coolify's default rolling update can briefly run the
 * old and new container together; both would mount the same SQLite volume. We
 * do not start the new image until Coolify reports the old one is no longer
 * running.
 */
export const waitForApplicationStopped = async (
  coolifyUuid: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  do {
    const application = await getApplication(coolifyUuid);
    // `container_present === false` is authoritative evidence that the app's
    // container is gone. The human-readable status can remain running:healthy
    // after Coolify has removed it, so status alone is not sufficient.
    if (application.container_present === false) return true;
    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return false;
};

/**
 * Onboarding uses the same proof as an upgrade: the Coolify deployment must
 * reach a terminal success, the running application must not be in a failed
 * state, and `/health` must report the release's own version/revision.
 */
export const verifyImageDeployment = async (
  coolifyUuid: string,
  release: ImageRelease,
  deploymentUuid: string | null,
  baseUrl: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  if (!deploymentUuid) {
    throw new Error(
      'deployment_not_tracked: Coolify accepted the request but returned no deployment id; refusing to treat the API response as success',
    );
  }
  const deployment = await waitForCoolifyDeployment(
    deploymentUuid,
    options.timeoutMs,
    options.intervalMs,
  );
  if (!deployment.ok) {
    throw new Error(deployment.error ?? `coolify_deployment_${deployment.status}`);
  }
  const readiness = await waitForApplicationReady(
    coolifyUuid,
    release,
    baseUrl,
    options.timeoutMs,
    options.intervalMs,
  );
  if (!readiness.ok) throw new Error(readiness.error ?? 'application_not_ready');
};

/**
 * Verify the tenant's own identity and `/data` storage before changing its image.
 * A successful token call is identity proof; the store name is also compared
 * when the tenant reports it. Missing storage is fatal because a new image
 * could otherwise create a replacement database on an empty directory.
 */
const assertTenantPreflight = async (
  tenantType: TenantType,
  state: TenantReleaseState,
): Promise<{ name?: string } | null> => {
  if (!state.coolifyUuid) return null;
  const application = await getApplication(state.coolifyUuid);
  assertApplicationAllowed(tenantType === 'store' ? 'store' : 'ho', application);
  if (application.build_pack !== 'dockerimage') {
    throw new HttpError(
      409,
      `Application ${state.coolifyUuid} is a ${application.build_pack} app; a shared-image upgrade must use a blue/green migration, not an in-place conversion`,
      'in_place_image_upgrade_unsupported',
    );
  }
  const storages = await getApplicationStorages(state.coolifyUuid);
  if (!storages.some((storage) => storage.mount_path === '/data')) {
    throw new HttpError(
      409,
      `missing_tenant_storage: application ${state.coolifyUuid} has no /data storage; refusing to start a replacement database`,
      'missing_tenant_storage',
    );
  }
  if (tenantType === 'store') {
    const store = getStoreById(state.id)!;
    const status = (await ping(store)) as { ok?: unknown; storeName?: unknown } | null;
    if (status?.ok !== true) {
      throw new HttpError(
        409,
        'Store identity check failed: /api/internal/status was not ok',
        'tenant_identity_failed',
      );
    }
    if (typeof status.storeName === 'string' && status.storeName !== store.name) {
      throw new HttpError(
        409,
        `tenant_identity_mismatch: deployment reports "${status.storeName}", registry expects "${store.name}"`,
        'tenant_identity_mismatch',
      );
    }
  } else {
    const panel = getPanelById(state.id)!;
    const status = (await pingPanel(panel)) as { ok?: unknown } | null;
    if (status?.ok !== true) {
      throw new HttpError(
        409,
        'Head Office identity check failed: /api/internal/status was not ok',
        'tenant_identity_failed',
      );
    }
  }
  return application;
};

/**
 * A crashed controller leaves a `running` history row and eventually an expired
 * lock. Before a new deployment, reconcile the Coolify job: a live job blocks
 * the new request; a terminal/lost job is marked failed so the retry is deliberate.
 */
const reconcileInFlightDeployment = async (state: TenantReleaseState): Promise<void> => {
  const running = getRunningReleaseDeployment(state.tenantType, state.id);
  if (!running) return;

  let active = false;
  if (running.coolify_deployment_uuid) {
    try {
      const deployment = await getDeployment(running.coolify_deployment_uuid);
      active = isActive(String(deployment.status ?? '').toLowerCase());
    } catch {
      active = true;
    }
  } else if (state.coolifyUuid) {
    try {
      const deployments = await getApplicationDeployments(state.coolifyUuid);
      active = deployments.some((deployment) =>
        isActive(String(deployment.status ?? '').toLowerCase()),
      );
    } catch {
      active = true;
    }
  }

  if (active) {
    throw new HttpError(
      409,
      'deployment_in_progress: a Coolify deployment for this tenant is still active; refusing a second deployment',
      'deployment_in_progress',
    );
  }
  finishReleaseDeployment(running.id, 'failed', {
    error: 'stale_running_deployment: reconciled before a new release attempt',
  });
};

const skipped = (
  state: TenantReleaseState,
  release: ImageRelease,
  action: ReleaseAction,
  reason: string,
): ApplyReleaseResult => ({
  status: 'skipped',
  tenantType: state.tenantType,
  tenantId: state.id,
  releaseId: release.id,
  action,
  fromReleaseId: state.lastReleaseId,
  fromDigest: state.imageDigest,
  toDigest: release.digest,
  coolifyUuid: state.coolifyUuid,
  reason,
});

/**
 * Apply one immutable release to one tenant. The lock is acquired before any
 * network call; a second request for the same tenant is a no-op with `locked`.
 * Schema compatibility is checked before Coolify is touched, and a failed
 * deployment never rewrites the tenant's current release fields.
 */
export const applyReleaseToTenant = async (
  tenantType: TenantType,
  tenantId: number,
  releaseId: number,
  options: {
    actor: string;
    action?: ReleaseAction;
    batchId?: number | null;
    reason?: string;
    /** Test seam; production uses the env defaults. */
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
  },
): Promise<ApplyReleaseResult> => {
  const release = getImageRelease(releaseId);
  if (!release) throw new HttpError(404, 'Release not found');
  if (!release.is_active) throw new ValidationError('Release is not active');
  assertReleaseKind(release, tenantType);

  let state = getTenantReleaseState(tenantType, tenantId);
  if (!state)
    throw new HttpError(404, tenantType === 'store' ? 'Store not found' : 'Head Office not found');

  const action: ReleaseAction = options.action ?? (state.coolifyUuid ? 'upgrade' : 'provision');

  if (action === 'provision' && state.coolifyUuid) {
    throw new HttpError(
      409,
      'This tenant already has a Coolify application; use upgrade or rollback instead of provisioning a second one',
      'already_provisioned',
    );
  }
  if (action !== 'provision' && !state.coolifyUuid) {
    throw new HttpError(
      409,
      'This tenant has no Coolify application yet; provision it before upgrading or rolling back',
      'not_provisioned',
    );
  }

  const lock = acquireDeploymentLock(tenantType, tenantId, {
    batchId: options.batchId ?? null,
    reason: options.reason ?? `release ${release.id}`,
  });
  if (!lock) {
    const result = skipped(
      state,
      release,
      action,
      'locked: another deployment is already in progress',
    );
    recordAuditLog(options.actor, 'release_skipped', tenantType, tenantId, {
      reason: result.reason,
      after: { releaseId: release.id, digest: release.digest },
    });
    return result;
  }

  const deploymentId = createReleaseDeployment({
    tenantType,
    tenantId,
    releaseId: release.id,
    batchId: options.batchId ?? null,
    action,
    fromReleaseId: state.lastReleaseId,
    fromDigest: state.imageDigest,
    toDigest: release.digest,
  });

  try {
    // Idempotent no-op: the exact digest is already recorded and healthy.
    if (
      action !== 'rollback' &&
      state.imageDigest === release.digest &&
      state.deployStatus === 'deployed'
    ) {
      finishReleaseDeployment(deploymentId, 'skipped', { error: 'already_current' });
      recordAuditLog(options.actor, 'release_skipped', tenantType, tenantId, {
        reason: 'already_current',
        after: { releaseId: release.id, digest: release.digest },
      });
      return skipped(
        state,
        release,
        action,
        'already_current: this deployment already runs the release',
      );
    }
    if (state.desiredReleaseId === release.id && state.deployStatus === 'provisioning') {
      finishReleaseDeployment(deploymentId, 'skipped', { error: 'already_deploying' });
      return skipped(
        state,
        release,
        action,
        'already_deploying: this release is already being deployed',
      );
    }

    const schemaError = schemaFailure(state, release);
    if (schemaError) {
      finishReleaseDeployment(deploymentId, 'failed', { error: schemaError });
      markTenantDeployStatus(tenantType, tenantId, 'failed', 'failed');
      recordAuditLog(options.actor, 'release_failed', tenantType, tenantId, {
        reason: schemaError,
        after: { releaseId: release.id, digest: release.digest },
        result: 'failed',
      });
      return {
        status: 'failed',
        tenantType,
        tenantId,
        releaseId: release.id,
        action,
        fromReleaseId: state.lastReleaseId,
        fromDigest: state.imageDigest,
        toDigest: release.digest,
        coolifyUuid: state.coolifyUuid,
        error: schemaError,
      };
    }

    // A crashed controller may have left a Coolify job running. Reconcile
    // before any new work; never start a second deployment against it.
    await reconcileInFlightDeployment(state);

    // Existing tenants get identity and /data storage proof before their image
    // is touched. A new tenant has no dashboard/database yet to verify.
    if (action !== 'provision') {
      await assertTenantPreflight(tenantType, state);
    }

    state = {
      ...state,
      deployStatus: 'provisioning',
      desiredReleaseId: release.id,
      releaseState: 'queued',
    };
    setTenantDesiredRelease(tenantType, tenantId, release.id);
    markTenantDeployStatus(tenantType, tenantId, 'provisioning', 'queued');
    updateReleaseDeploymentTracking(deploymentId, { phase: 'queued' });

    let coolifyUuid = state.coolifyUuid;
    let volumeName = state.volumeName;
    let deploymentUuid: string | null = null;

    if (action === 'provision') {
      if (tenantType === 'store') {
        const store = getStoreById(tenantId)!;
        const result = await createStoreImageDeployment({
          slug: store.slug,
          domain: store.base_url,
          deploymentName: store.deployment_name ?? undefined,
          clientSlug: store.company_id ? (state.companySlug ?? store.slug) : store.slug,
          release,
          controlPlaneToken: store.control_plane_token,
          onCreated: ({ coolifyUuid: createdUuid, volumeName: createdVolume }) => {
            setTenantCoolifyTarget(tenantType, tenantId, createdUuid, createdVolume);
            recordProvisionedRelease(tenantType, tenantId, release, createdUuid, createdVolume);
          },
        });
        coolifyUuid = result.coolifyUuid;
        volumeName = result.volumeName;
        setTenantCoolifyTarget(tenantType, tenantId, coolifyUuid, volumeName);
        recordProvisionedRelease(tenantType, tenantId, release, coolifyUuid, volumeName);
        deploymentUuid = await triggerDeploy(coolifyUuid, true);
      } else {
        const panel = getPanelById(tenantId)!;
        const result = await createHeadOfficeImageDeployment({
          slug: panel.slug,
          domain: panel.base_url,
          deploymentName: panel.deployment_name ?? undefined,
          clientSlug: state.companySlug ?? panel.slug,
          release,
          controlPlaneToken: panel.control_plane_token,
          onCreated: ({ coolifyUuid: createdUuid, volumeName: createdVolume }) => {
            setTenantCoolifyTarget(tenantType, tenantId, createdUuid, createdVolume);
            recordProvisionedRelease(tenantType, tenantId, release, createdUuid, createdVolume);
          },
        });
        coolifyUuid = result.coolifyUuid;
        volumeName = result.volumeName;
        setTenantCoolifyTarget(tenantType, tenantId, coolifyUuid, volumeName);
        recordProvisionedRelease(tenantType, tenantId, release, coolifyUuid, volumeName);
        deploymentUuid = await triggerDeploy(coolifyUuid, true);
      }
    } else {
      if (!coolifyUuid)
        throw new HttpError(409, 'Cannot upgrade a tenant without a Coolify application');
      // Coolify's rolling update can run the old and new container together.
      // Both mount the same SQLite volume, so stop the old one first and prove
      // it is no longer running before changing the image.
      await stopApplication(coolifyUuid);
      if (!(await waitForApplicationStopped(coolifyUuid))) {
        throw new Error(
          `application_stop_timeout: ${coolifyUuid} container absence was not confirmed by Coolify; refusing to start a second SQLite writer`,
        );
      }
      await updateApplicationImage(coolifyUuid, release);
      deploymentUuid = await triggerDeploy(coolifyUuid, true);
    }

    if (!deploymentUuid) {
      throw new Error(
        'deployment_not_tracked: Coolify accepted the request but returned no deployment id; refusing to treat the API response as success',
      );
    }
    updateReleaseDeploymentTracking(deploymentId, {
      phase: 'deploying',
      coolifyUuid,
      coolifyDeploymentUuid: deploymentUuid,
    });
    markTenantDeployStatus(tenantType, tenantId, 'provisioning', 'deploying');

    const deployment = await waitForCoolifyDeployment(
      deploymentUuid,
      options.healthTimeoutMs,
      options.healthIntervalMs,
    );
    if (!deployment.ok) {
      throw new Error(deployment.error ?? `coolify_deployment_${deployment.status}`);
    }

    updateReleaseDeploymentTracking(deploymentId, { phase: 'verifying' });
    markTenantDeployStatus(tenantType, tenantId, 'provisioning', 'verifying');
    const readiness = await waitForApplicationReady(
      coolifyUuid,
      release,
      state.baseUrl,
      options.healthTimeoutMs,
      options.healthIntervalMs,
    );
    if (!readiness.ok) {
      throw new Error(readiness.error ?? 'application_not_ready');
    }

    const schemaVersion =
      action === 'rollback'
        ? state.schemaVersion
        : Math.max(state.schemaVersion ?? 0, release.schema_version);
    updateTenantReleaseState(tenantType, tenantId, {
      imageDigest: release.digest,
      imageTag: release.tag,
      releaseId: release.id,
      channel: release.channel,
      previousReleaseId: state.lastReleaseId,
      schemaVersion,
      appVersion: release.version,
      deployStatus: 'deployed',
      releaseState: action === 'rollback' ? 'rolled_back' : 'healthy',
      coolifyUuid,
      volumeName,
    });
    finishReleaseDeployment(deploymentId, 'complete', { coolifyUuid });
    recordAuditLog(options.actor, 'release_applied', tenantType, tenantId, {
      before: {
        releaseId: state.lastReleaseId,
        digest: state.imageDigest,
        schemaVersion: state.schemaVersion,
      },
      after: {
        releaseId: release.id,
        tag: release.tag,
        digest: release.digest,
        schemaVersion,
        action,
      },
      reason: options.reason ?? `release ${release.id}`,
    });
    return {
      status: 'complete',
      tenantType,
      tenantId,
      releaseId: release.id,
      action,
      fromReleaseId: state.lastReleaseId,
      fromDigest: state.imageDigest,
      toDigest: release.digest,
      coolifyUuid,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishReleaseDeployment(deploymentId, 'failed', {
      error: message,
      coolifyUuid: state.coolifyUuid,
    });
    markTenantDeployStatus(tenantType, tenantId, 'failed', 'failed');
    recordErrorEvent({
      source: 'deploy',
      entityType: tenantType,
      entityId: tenantId,
      message,
      appVersion: state.appVersion,
      environment: state.environment,
    });
    recordAuditLog(options.actor, 'release_failed', tenantType, tenantId, {
      reason: message,
      after: { releaseId: release.id, digest: release.digest },
      result: 'failed',
    });
    logger.warn(`Release ${release.id} failed for ${tenantType} ${tenantId}: ${message}`);
    return {
      status: 'failed',
      tenantType,
      tenantId,
      releaseId: release.id,
      action,
      fromReleaseId: state.lastReleaseId,
      fromDigest: state.imageDigest,
      toDigest: release.digest,
      coolifyUuid: state.coolifyUuid,
      error: message,
    };
  } finally {
    releaseDeploymentLock(tenantType, tenantId, lock.token);
  }
};

export interface RollbackEligibility {
  eligible: boolean;
  targetReleaseId: number | null;
  reason: string | null;
}

/**
 * Server-owned rollback eligibility. A rollback returns to the release the
 * tenant ran before the current release was applied, so the target comes from
 * verified successful forward history (provision/upgrade INTO the current
 * release), never from `previous_release_id` alone:
 *
 *   A -> B -> rollback A      no target (B is a forward Upgrade, not a rollback)
 *   A -> B -> C -> rollback B target A (not C, the release just left)
 *
 * The target must still be in the catalog, be active, match the tenant kind,
 * and support the database schema the tenant currently runs.
 */
export const getRollbackEligibility = (state: TenantReleaseState): RollbackEligibility => {
  if (!state.lastReleaseId) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason: 'No verified successful deployment is recorded for this tenant',
    };
  }
  const forward = getLastSuccessfulForwardDeployment(
    state.tenantType,
    state.id,
    state.lastReleaseId,
  );
  if (!forward) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason:
        'No verified successful forward deployment into the current release is recorded; use Upgrade to change releases',
    };
  }
  const targetId = forward.from_release_id;
  if (!targetId) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason:
        'The current release is the first verified deployment for this tenant; there is no earlier release to roll back to',
    };
  }
  const target = getImageRelease(targetId);
  if (!target) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason: `Rollback target release ${targetId} is not in the catalog`,
    };
  }
  if (target.kind !== (state.tenantType === 'store' ? 'store' : 'ho')) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason: 'Rollback target release is for a different application kind',
    };
  }
  if (!target.is_active) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason: 'Rollback target release is inactive',
    };
  }
  if (state.schemaVersion === null || state.schemaVersion === undefined) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason: 'Current database schema is not reported',
    };
  }
  if (!releaseSupportsSchema(target, state.schemaVersion)) {
    return {
      eligible: false,
      targetReleaseId: null,
      reason: `Rollback target supports schema ${target.schema_min}..${target.schema_max}, current schema is ${state.schemaVersion}`,
    };
  }
  return { eligible: true, targetReleaseId: target.id, reason: null };
};

export const rollbackTenant = async (
  tenantType: TenantType,
  tenantId: number,
  actor: string,
  toReleaseId?: number,
): Promise<ApplyReleaseResult> => {
  const state = getTenantReleaseState(tenantType, tenantId);
  if (!state)
    throw new HttpError(404, tenantType === 'store' ? 'Store not found' : 'Head Office not found');
  const eligibility = getRollbackEligibility(state);
  if (!eligibility.eligible || !eligibility.targetReleaseId) {
    throw new HttpError(
      409,
      `rollback_not_eligible: ${eligibility.reason ?? 'no valid rollback target'}`,
      'rollback_not_eligible',
    );
  }
  if (toReleaseId !== undefined && toReleaseId !== eligibility.targetReleaseId) {
    throw new HttpError(
      409,
      `rollback_not_eligible: release ${toReleaseId} is not the verified rollback target; use Upgrade to move to another release`,
      'rollback_not_eligible',
    );
  }
  const target = getImageRelease(eligibility.targetReleaseId);
  if (!target) throw new HttpError(404, 'Rollback target release not found');
  return applyReleaseToTenant(tenantType, tenantId, target.id, {
    actor,
    action: 'rollback',
    reason: `rollback from ${state.lastReleaseId ?? 'unknown'}`,
  });
};

export interface StartBatchInput {
  releaseId: number;
  actor: string;
  tenantIds?: number[];
  environment?: string;
  channel?: ReleaseChannel;
  waveSize?: number;
  dryRun?: boolean;
  /** Default true: a failed wave stops the remaining waves. */
  stopOnFailure?: boolean;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
}

export interface BatchResult {
  batch: ReleaseBatch;
  items: ReleaseBatchItem[];
}

/**
 * Roll a release out in waves. Each item is still gated by its own lock and
 * schema check; a dry run only records the plan and never calls Coolify.
 */
export const startReleaseBatch = async (input: StartBatchInput): Promise<BatchResult> => {
  const release = getImageRelease(input.releaseId);
  if (!release) throw new HttpError(404, 'Release not found');
  if (!release.is_active) throw new ValidationError('Release is not active');
  const tenantType = tenantTypeForKind(release.kind);
  const waveSize = input.waveSize ?? 1;
  if (!Number.isInteger(waveSize) || waveSize < 1 || waveSize > 50) {
    throw new ValidationError('waveSize must be an integer between 1 and 50');
  }

  let states = listTenantReleaseStates(tenantType);
  if (input.tenantIds?.length) {
    const wanted = new Set(input.tenantIds);
    states = states.filter((s) => wanted.has(s.id));
    if (states.length !== wanted.size) {
      throw new ValidationError('One or more tenantIds do not exist for this release kind');
    }
  }
  if (input.environment) {
    states = states.filter((s) => s.environment === input.environment);
  }
  if (input.channel) {
    states = states.filter((s) => s.releaseChannel === input.channel);
  }
  if (!states.length) throw new ValidationError('No tenants match this rollout');

  const batch = createReleaseBatch({
    releaseId: release.id,
    kind: release.kind,
    channel: input.channel ?? release.channel,
    waveSize,
    requestedBy: input.actor,
    dryRun: Boolean(input.dryRun),
    total: states.length,
    stopOnFailure: input.stopOnFailure !== false,
  });

  const items = states.map((state, index) => {
    const action: ReleaseAction = state.coolifyUuid ? 'upgrade' : 'provision';
    return createReleaseBatchItem({
      batchId: batch.id,
      tenantType,
      tenantId: state.id,
      waveNo: Math.floor(index / waveSize) + 1,
      action,
      fromDigest: state.imageDigest,
      toDigest: release.digest,
    });
  });

  recordAuditLog(
    input.actor,
    input.dryRun ? 'release_wave_planned' : 'release_wave_started',
    'release',
    release.id,
    {
      after: {
        batchId: batch.id,
        total: states.length,
        waveSize,
        tenantIds: states.map((s) => s.id),
        dryRun: Boolean(input.dryRun),
      },
    },
  );

  if (input.dryRun) {
    updateReleaseBatch(batch.id, { status: 'dry_run', completed_at: new Date().toISOString() });
    return { batch: getReleaseBatch(batch.id)!, items: listReleaseBatchItems(batch.id) };
  }

  updateReleaseBatch(batch.id, { status: 'running', started_at: new Date().toISOString() });
  let succeeded = 0;
  let failed = 0;
  let skippedCount = 0;
  const stateById = new Map(states.map((s) => [s.id, s]));

  const waves = new Map<number, ReleaseBatchItem[]>();
  for (const item of items) {
    const list = waves.get(item.wave_no) ?? [];
    list.push(item);
    waves.set(item.wave_no, list);
  }

  for (const waveNo of [...waves.keys()].sort((a, b) => a - b)) {
    let waveFailed = 0;
    for (const item of waves.get(waveNo)!) {
      const state = stateById.get(item.tenant_id)!;
      if (state.status === 'paused') {
        updateReleaseBatchItem(item.id, {
          status: 'skipped',
          error: 'tenant_paused',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        });
        skippedCount += 1;
        continue;
      }
      updateReleaseBatchItem(item.id, { status: 'running', started_at: new Date().toISOString() });
      const result = await applyReleaseToTenant(tenantType, item.tenant_id, release.id, {
        actor: input.actor,
        action: item.action,
        batchId: batch.id,
        reason: `batch ${batch.id} wave ${waveNo}`,
        healthTimeoutMs: input.healthTimeoutMs,
        healthIntervalMs: input.healthIntervalMs,
      });
      if (result.status === 'complete') {
        succeeded += 1;
        updateReleaseBatchItem(item.id, {
          status: 'complete',
          from_digest: result.fromDigest,
          to_digest: result.toDigest,
          completed_at: new Date().toISOString(),
        });
      } else if (result.status === 'skipped') {
        skippedCount += 1;
        updateReleaseBatchItem(item.id, {
          status: 'skipped',
          error: result.reason ?? 'skipped',
          completed_at: new Date().toISOString(),
          metadata: { reason: result.reason },
        });
      } else {
        failed += 1;
        waveFailed += 1;
        updateReleaseBatchItem(item.id, {
          status: 'failed',
          error: result.error ?? 'release failed',
          completed_at: new Date().toISOString(),
        });
      }
    }

    if (waveFailed > 0 && input.stopOnFailure !== false) {
      // A failed pilot wave is a stop condition. Do not let the next wave
      // touch more tenants; record why each remaining tenant was not attempted.
      for (const item of items) {
        if (item.wave_no <= waveNo) continue;
        updateReleaseBatchItem(item.id, {
          status: 'skipped',
          error: 'previous_wave_failed',
          completed_at: new Date().toISOString(),
          metadata: { reason: 'previous_wave_failed', failedWave: waveNo },
        });
        skippedCount += 1;
      }
      break;
    }
  }

  const status = failed > 0 ? (succeeded + skippedCount > 0 ? 'partial' : 'failed') : 'complete';
  updateReleaseBatch(batch.id, {
    status,
    succeeded,
    failed,
    skipped: skippedCount,
    completed_at: new Date().toISOString(),
  });
  recordAuditLog(input.actor, 'release_wave_finished', 'release', release.id, {
    after: { batchId: batch.id, status, succeeded, failed, skipped: skippedCount },
    result: status === 'failed' ? 'failed' : 'ok',
  });
  return { batch: getReleaseBatch(batch.id)!, items: listReleaseBatchItems(batch.id) };
};

export const getBatch = (id: number): BatchResult | null => {
  const batch = getReleaseBatch(id);
  if (!batch) return null;
  return { batch, items: listReleaseBatchItems(id) };
};

export interface RuntimeReconcileResult {
  status: 'complete';
  tenantType: TenantType;
  tenantId: number;
  releaseId: number;
  digest: string;
  version: string;
  schemaVersion: number;
  deployStatus: 'deployed';
  releaseState: 'healthy';
}

/**
 * Read-only verification of a tenant's actual running state, followed by an
 * audited correction of the registry when the running app conclusively matches
 * a registered release. Failed release/rollback history is preserved; this
 * never creates a successful deployment or rollback record.
 */
export const reconcileTenantRuntime = async (
  tenantType: TenantType,
  tenantId: number,
  actor: string,
  reason?: string,
): Promise<RuntimeReconcileResult> => {
  if (tenantType !== 'store') {
    throw new HttpError(
      409,
      'runtime_reconciliation_store_only: runtime reconciliation is currently supported for Stores only',
      'runtime_reconciliation_store_only',
    );
  }
  const state = getTenantReleaseState(tenantType, tenantId);
  if (!state) throw new HttpError(404, 'Store not found');
  if (!state.coolifyUuid) {
    throw new HttpError(409, 'runtime_reconciliation_no_app: Store has no Coolify application');
  }

  const application = await getApplication(state.coolifyUuid);
  if (application.uuid !== state.coolifyUuid) {
    throw new HttpError(409, 'runtime_reconciliation_uuid_mismatch: Coolify returned another app');
  }
  if (application.container_present !== true) {
    throw new HttpError(
      409,
      'runtime_reconciliation_no_container: the application container is not present',
      'runtime_reconciliation_no_container',
    );
  }
  if (application.build_pack !== 'dockerimage') {
    throw new HttpError(
      409,
      'runtime_reconciliation_not_image: application is not a Docker Image app',
    );
  }
  assertApplicationAllowed('store', application);

  const imageName = String(application.docker_registry_image_name ?? '');
  const imageTag = String(application.docker_registry_image_tag ?? '');
  const digest = imageName.endsWith('@sha256')
    ? /^[a-f0-9]{64}$/i.test(imageTag)
      ? `sha256:${imageTag.toLowerCase()}`
      : null
    : (/@sha256:[a-f0-9]{64}$/i.exec(imageName)?.[0].slice(1)?.toLowerCase() ?? null);
  if (!digest) {
    throw new HttpError(
      409,
      'runtime_reconciliation_image_unverified: the running image is not pinned by an immutable digest',
      'runtime_reconciliation_image_unverified',
    );
  }

  const release = listImageReleases({ kind: 'store' }).find(
    (candidate) => candidate.digest === digest,
  );
  if (!release) {
    throw new HttpError(
      409,
      `runtime_reconciliation_release_unknown: no registered Store release matches ${digest}`,
      'runtime_reconciliation_release_unknown',
    );
  }

  const storages = await getApplicationStorages(state.coolifyUuid);
  const dataStorages = storages.filter(
    (storage) => storage.type === 'persistent' && storage.mount_path === '/data',
  );
  if (dataStorages.length !== 1) {
    throw new HttpError(
      409,
      'runtime_reconciliation_storage_unverified: expected exactly one persistent /data storage',
      'runtime_reconciliation_storage_unverified',
    );
  }
  if (
    state.volumeName &&
    dataStorages[0].name &&
    !dataStorages[0].name.endsWith(state.volumeName)
  ) {
    throw new HttpError(
      409,
      'runtime_reconciliation_volume_mismatch: the /data storage is not the registered tenant volume',
      'runtime_reconciliation_volume_mismatch',
    );
  }

  const coolifyDeployments = await getApplicationDeployments(state.coolifyUuid);
  const activeDeployment = coolifyDeployments.find((deployment) =>
    isActive(String(deployment.status ?? '').toLowerCase()),
  );
  const runningRelease = getRunningReleaseDeployment(tenantType, tenantId);
  if (activeDeployment || runningRelease) {
    throw new HttpError(
      409,
      'runtime_reconciliation_deployment_active: a Coolify or Control Plane deployment is still active',
      'runtime_reconciliation_deployment_active',
    );
  }

  const store = getStoreById(tenantId)!;
  const status = (await ping(store)) as { ok?: unknown; storeName?: unknown } | null;
  if (status?.ok !== true) {
    throw new HttpError(409, 'runtime_reconciliation_identity_failed: tenant status is not ok');
  }
  if (typeof status.storeName === 'string' && status.storeName !== store.name) {
    throw new HttpError(
      409,
      `runtime_reconciliation_identity_mismatch: deployment reports "${status.storeName}", registry expects "${store.name}"`,
      'runtime_reconciliation_identity_mismatch',
    );
  }

  const telemetry = await fetchTelemetry(store);
  if (telemetry.version !== release.version) {
    throw new HttpError(
      409,
      `runtime_reconciliation_version_mismatch: running ${telemetry.version}, release ${release.version}`,
      'runtime_reconciliation_version_mismatch',
    );
  }
  if (typeof telemetry.schemaVersion !== 'number') {
    throw new HttpError(409, 'runtime_reconciliation_schema_unknown: tenant schema is unavailable');
  }
  if (!releaseSupportsSchema(release, telemetry.schemaVersion)) {
    throw new HttpError(
      409,
      `runtime_reconciliation_schema_mismatch: schema ${telemetry.schemaVersion} is outside release ${release.id}`,
      'runtime_reconciliation_schema_mismatch',
    );
  }

  const cleanBase = store.base_url.replace(/\/+$/, '');
  const healthRes = await fetch(`${cleanBase}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const health = (await healthRes.json().catch(() => null)) as {
    status?: unknown;
    app?: unknown;
    version?: unknown;
    revision?: unknown;
    database?: unknown;
  } | null;
  if (
    !healthRes.ok ||
    health?.status !== 'ok' ||
    health.app !== 'vula' ||
    health.version !== release.version ||
    (release.revision && health.revision !== release.revision) ||
    health.database !== 'connected'
  ) {
    throw new HttpError(
      409,
      'runtime_reconciliation_health_mismatch: running health does not match the registered release',
      'runtime_reconciliation_health_mismatch',
    );
  }

  const before = {
    imageDigest: state.imageDigest,
    imageTag: state.imageTag,
    desiredReleaseId: state.desiredReleaseId,
    lastReleaseId: state.lastReleaseId,
    deployStatus: state.deployStatus,
    releaseState: state.releaseState,
    schemaVersion: state.schemaVersion,
  };
  updateTenantReleaseState(tenantType, tenantId, {
    imageDigest: release.digest,
    imageTag: release.tag,
    releaseId: release.id,
    channel: release.channel,
    previousReleaseId:
      state.lastReleaseId === release.id ? state.previousReleaseId : state.lastReleaseId,
    schemaVersion: telemetry.schemaVersion,
    appVersion: release.version,
    deployStatus: 'deployed',
    releaseState: 'healthy',
    coolifyUuid: state.coolifyUuid,
    volumeName: state.volumeName,
  });
  recordAuditLog(actor, 'tenant_runtime_reconciled', tenantType, tenantId, {
    before,
    after: {
      releaseId: release.id,
      digest: release.digest,
      tag: release.tag,
      version: release.version,
      schemaVersion: telemetry.schemaVersion,
      deployStatus: 'deployed',
      releaseState: 'healthy',
    },
    reason: reason ?? 'read-only runtime reconciliation',
  });

  return {
    status: 'complete',
    tenantType,
    tenantId,
    releaseId: release.id,
    digest: release.digest,
    version: release.version,
    schemaVersion: telemetry.schemaVersion,
    deployStatus: 'deployed',
    releaseState: 'healthy',
  };
};
