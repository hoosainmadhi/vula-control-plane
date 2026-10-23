import { Router } from 'express';
import { requireOffice, requireReleaseManager, isReleaseManagerEmail } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import {
  parseIdParam,
  requireInt,
  optionalInt,
  optionalString,
  optionalBool,
} from '../utils/validate.js';
import { recordAuditLog } from '../config/registryDb.js';
import {
  createImageRelease,
  getImageRelease,
  listImageReleases,
  listReleaseBatches,
  listReleaseDeployments,
  listTenantReleaseStates,
  getTenantReleaseState,
  setTenantReleaseChannel,
  tenantTypeOf,
  channelOf,
  kindOf,
  type ReleaseChannel,
  type ReleaseKind,
} from '../services/releaseCatalog.js';
import {
  applyReleaseToTenant,
  getBatch,
  getRollbackEligibility,
  reconcileTenantRuntime,
  rollbackTenant,
  startReleaseBatch,
} from '../services/releaseOrchestrator.js';

export const releasesRouter = Router();
releasesRouter.use(requireOffice);

releasesRouter.get(
  '/capabilities',
  asyncHandler(async (req, res) => {
    res.json({
      email: req.auth!.email,
      releaseManager: isReleaseManagerEmail(req.auth!.email),
      configured: true,
    });
  }),
);

const releaseOut = (release: ReturnType<typeof getImageRelease> & object) => ({
  id: release.id,
  kind: release.kind,
  tag: release.tag,
  digest: release.digest,
  version: release.version,
  revision: release.revision,
  channel: release.channel,
  schemaVersion: release.schema_version,
  schemaMin: release.schema_min,
  schemaMax: release.schema_max,
  notes: release.notes,
  isActive: Boolean(release.is_active),
  publishedAt: release.published_at,
  createdAt: release.created_at,
});

const stateOut = (state: ReturnType<typeof getTenantReleaseState> & object) => {
  const rollback = getRollbackEligibility(state as never);
  return {
    tenantType: state.tenantType,
    id: state.id,
    name: state.name,
    slug: state.slug,
    baseUrl: state.baseUrl,
    environment: state.environment,
    companyId: state.companyId,
    companySlug: state.companySlug,
    status: state.status,
    deployStatus: state.deployStatus,
    coolifyUuid: state.coolifyUuid,
    volumeName: state.volumeName,
    imageDigest: state.imageDigest,
    imageTag: state.imageTag,
    releaseChannel: state.releaseChannel,
    desiredReleaseId: state.desiredReleaseId,
    lastReleaseId: state.lastReleaseId,
    previousReleaseId: state.previousReleaseId,
    lastReleaseAt: state.lastReleaseAt,
    releaseState: state.releaseState,
    schemaVersion: state.schemaVersion,
    appVersion: state.appVersion,
    runtimeHealth: state.runtimeHealth,
    rollbackEligible: rollback.eligible,
    rollbackReleaseId: rollback.targetReleaseId,
    rollbackReason: rollback.reason,
  };
};

const batchOut = (batch: NonNullable<ReturnType<typeof getBatch>>) => ({
  batch: {
    id: batch.batch.id,
    releaseId: batch.batch.release_id,
    kind: batch.batch.kind,
    channel: batch.batch.channel,
    status: batch.batch.status,
    waveSize: batch.batch.wave_size,
    requestedBy: batch.batch.requested_by,
    dryRun: Boolean(batch.batch.dry_run),
    stopOnFailure: Boolean(batch.batch.stop_on_failure),
    total: batch.batch.total,
    succeeded: batch.batch.succeeded,
    failed: batch.batch.failed,
    skipped: batch.batch.skipped,
    error: batch.batch.error,
    createdAt: batch.batch.created_at,
    startedAt: batch.batch.started_at,
    completedAt: batch.batch.completed_at,
  },
  items: batch.items.map((item) => ({
    id: item.id,
    tenantType: item.tenant_type,
    tenantId: item.tenant_id,
    wave: item.wave_no,
    action: item.action,
    status: item.status,
    fromDigest: item.from_digest,
    toDigest: item.to_digest,
    error: item.error,
    startedAt: item.started_at,
    completedAt: item.completed_at,
  })),
});

releasesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const kind = req.query.kind ? kindOf(req.query.kind) : undefined;
    const channel = req.query.channel ? channelOf(req.query.channel) : undefined;
    const activeOnly = req.query.active === 'true';
    res.json(
      listImageReleases({
        kind: kind as ReleaseKind | undefined,
        channel: channel as ReleaseChannel | undefined,
        activeOnly,
      }).map((release) => releaseOut(release as never)),
    );
  }),
);

releasesRouter.post(
  '/',
  requireReleaseManager,
  asyncHandler(async (req, res) => {
    const release = createImageRelease(req.body);
    recordAuditLog(req.auth!.email, 'release_published', 'release', release.id, {
      before: null,
      after: {
        kind: release.kind,
        tag: release.tag,
        digest: release.digest,
        version: release.version,
        channel: release.channel,
        schemaVersion: release.schema_version,
      },
    });
    res.status(201).json(releaseOut(release));
  }),
);

/** Fleet-wide image state; this is the release controller's roster view. */
releasesRouter.get(
  '/fleet',
  asyncHandler(async (_req, res) => {
    const stores = listTenantReleaseStates('store').map((state) => stateOut(state as never));
    const panels = listTenantReleaseStates('panel').map((state) => stateOut(state as never));
    res.json({ stores, panels });
  }),
);

releasesRouter.get(
  '/batches',
  asyncHandler(async (_req, res) => {
    res.json(
      listReleaseBatches().map((batch) => ({
        id: batch.id,
        releaseId: batch.release_id,
        kind: batch.kind,
        channel: batch.channel,
        status: batch.status,
        waveSize: batch.wave_size,
        requestedBy: batch.requested_by,
        dryRun: Boolean(batch.dry_run),
        stopOnFailure: Boolean(batch.stop_on_failure),
        total: batch.total,
        succeeded: batch.succeeded,
        failed: batch.failed,
        skipped: batch.skipped,
        createdAt: batch.created_at,
        startedAt: batch.started_at,
        completedAt: batch.completed_at,
      })),
    );
  }),
);

releasesRouter.get(
  '/batches/:id',
  asyncHandler(async (req, res) => {
    const batch = getBatch(parseIdParam(req.params.id));
    if (!batch) throw new HttpError(404, 'Release batch not found');
    res.json(batchOut(batch));
  }),
);

releasesRouter.get(
  '/tenants/:tenantType/:tenantId/history',
  asyncHandler(async (req, res) => {
    const tenantType = tenantTypeOf(req.params.tenantType);
    const tenantId = parseIdParam(req.params.tenantId);
    if (!getTenantReleaseState(tenantType, tenantId)) {
      throw new HttpError(
        404,
        tenantType === 'store' ? 'Store not found' : 'Head Office not found',
      );
    }
    res.json(listReleaseDeployments(tenantType, tenantId));
  }),
);

releasesRouter.patch(
  '/tenants/:tenantType/:tenantId/channel',
  requireReleaseManager,
  asyncHandler(async (req, res) => {
    const tenantType = tenantTypeOf(req.params.tenantType);
    const tenantId = parseIdParam(req.params.tenantId);
    const channel = channelOf((req.body ?? {}).channel);
    const before = getTenantReleaseState(tenantType, tenantId);
    if (!before)
      throw new HttpError(
        404,
        tenantType === 'store' ? 'Store not found' : 'Head Office not found',
      );
    setTenantReleaseChannel(tenantType, tenantId, channel);
    recordAuditLog(req.auth!.email, 'tenant_release_channel_changed', tenantType, tenantId, {
      before: { channel: before.releaseChannel },
      after: { channel },
    });
    res.json(stateOut(getTenantReleaseState(tenantType, tenantId)! as never));
  }),
);

releasesRouter.post(
  '/tenants/:tenantType/:tenantId/reconcile',
  requireReleaseManager,
  asyncHandler(async (req, res) => {
    const tenantType = tenantTypeOf(req.params.tenantType);
    const tenantId = parseIdParam(req.params.tenantId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await reconcileTenantRuntime(
      tenantType,
      tenantId,
      req.auth!.email,
      optionalString(body, 'reason', 500) ?? undefined,
    );
    res.json({ result });
  }),
);

releasesRouter.post(
  '/tenants/:tenantType/:tenantId/apply',
  requireReleaseManager,
  asyncHandler(async (req, res) => {
    const tenantType = tenantTypeOf(req.params.tenantType);
    const tenantId = parseIdParam(req.params.tenantId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const releaseId = typeof body.releaseId === 'number' ? body.releaseId : Number(body.releaseId);
    if (!Number.isInteger(releaseId) || releaseId < 1) {
      throw new HttpError(400, 'releaseId is required');
    }
    const action =
      body.action === 'provision' || body.action === 'upgrade' || body.action === 'rollback'
        ? body.action
        : undefined;
    const result = await applyReleaseToTenant(tenantType, tenantId, releaseId, {
      actor: req.auth!.email,
      action,
      reason: optionalString(body, 'reason', 500) ?? undefined,
    });
    res.status(result.status === 'failed' ? 502 : 200).json({ result });
  }),
);

releasesRouter.post(
  '/tenants/:tenantType/:tenantId/rollback',
  requireReleaseManager,
  asyncHandler(async (req, res) => {
    const tenantType = tenantTypeOf(req.params.tenantType);
    const tenantId = parseIdParam(req.params.tenantId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body.toReleaseId;
    const toReleaseId = raw === undefined || raw === null ? undefined : Number(raw);
    if (toReleaseId !== undefined && (!Number.isInteger(toReleaseId) || toReleaseId < 1)) {
      throw new HttpError(400, 'toReleaseId must be a positive integer');
    }
    const result = await rollbackTenant(tenantType, tenantId, req.auth!.email, toReleaseId);
    res.status(result.status === 'failed' ? 502 : 200).json({ result });
  }),
);

releasesRouter.post(
  '/:id/rollout',
  requireReleaseManager,
  asyncHandler(async (req, res) => {
    const releaseId = parseIdParam(req.params.id);
    const release = getImageRelease(releaseId);
    if (!release) throw new HttpError(404, 'Release not found');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tenantIds = Array.isArray(body.tenantIds)
      ? body.tenantIds.map((id) => {
          const value = Number(id);
          if (!Number.isInteger(value) || value < 1) {
            throw new HttpError(400, 'tenantIds must be positive integers');
          }
          return value;
        })
      : undefined;
    const waveSize =
      body.waveSize === undefined ? 1 : requireInt(body, 'waveSize', { min: 1, max: 50 });
    const environment = optionalString(body, 'environment', 40) ?? undefined;
    const channel = body.channel === undefined ? undefined : channelOf(body.channel);
    const dryRun = optionalBool(body, 'dryRun') ?? false;
    const stopOnFailure = optionalBool(body, 'stopOnFailure') ?? true;
    const result = await startReleaseBatch({
      releaseId,
      actor: req.auth!.email,
      tenantIds,
      environment,
      channel: channel as ReleaseChannel | undefined,
      waveSize,
      dryRun,
      stopOnFailure,
    });
    res.status(201).json(batchOut(result));
  }),
);
