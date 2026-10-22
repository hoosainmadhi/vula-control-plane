import crypto from 'node:crypto';
import {
  getRegistryDb,
  getStoreById,
  getPanelById,
  getCompanyById,
  type PanelRecord,
  type StoreRecord,
} from '../config/registryDb.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/errors.js';
import { ValidationError } from '../utils/validate.js';

/**
 * The shared-image release catalog and per-tenant release state.
 *
 * The catalog is deliberately vendor-side: an image release is identified by
 * the exact published digest (never a mutable tag alone), declares the schema
 * range it can open, and is rolled out through explicit batches. Tenant rows
 * carry the image they actually run plus the previous release, which is what
 * makes a schema-checked rollback possible without consulting Coolify's history.
 */

export type ReleaseKind = 'store' | 'ho';
export type ReleaseChannel = 'stable' | 'beta' | 'canary';
export type TenantType = 'store' | 'panel';
export type ReleaseAction = 'provision' | 'upgrade' | 'rollback';

export const RELEASE_KINDS: readonly ReleaseKind[] = ['store', 'ho'];
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'beta', 'canary'];
export const TENANT_TYPES: readonly TenantType[] = ['store', 'panel'];
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export interface ImageRelease {
  id: number;
  kind: ReleaseKind;
  tag: string;
  digest: string;
  version: string;
  revision: string | null;
  channel: ReleaseChannel;
  schema_version: number;
  schema_min: number;
  schema_max: number;
  notes: string | null;
  is_active: number;
  published_at: string;
  created_at: string;
}

export interface TenantReleaseState {
  tenantType: TenantType;
  id: number;
  name: string;
  slug: string;
  baseUrl: string;
  environment: string | null;
  companyId: number | null;
  companySlug: string | null;
  status: 'active' | 'paused';
  deployStatus: 'not_deployed' | 'provisioning' | 'deployed' | 'failed';
  coolifyUuid: string | null;
  volumeName: string | null;
  imageDigest: string | null;
  imageTag: string | null;
  releaseChannel: ReleaseChannel;
  desiredReleaseId: number | null;
  lastReleaseId: number | null;
  previousReleaseId: number | null;
  lastReleaseAt: string | null;
  releaseState:
    'idle' | 'queued' | 'deploying' | 'verifying' | 'healthy' | 'failed' | 'rolled_back';
  schemaVersion: number | null;
  appVersion: string | null;
}

export interface ReleaseBatch {
  id: number;
  release_id: number;
  kind: ReleaseKind;
  channel: string;
  status: 'planned' | 'running' | 'complete' | 'partial' | 'failed' | 'dry_run';
  wave_size: number;
  requested_by: string;
  dry_run: number;
  stop_on_failure: number;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ReleaseBatchItem {
  id: number;
  batch_id: number;
  tenant_type: TenantType;
  tenant_id: number;
  wave_no: number;
  action: ReleaseAction;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  from_digest: string | null;
  to_digest: string | null;
  error: string | null;
  metadata_json: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const channelOf = (value: unknown): ReleaseChannel => {
  if (typeof value !== 'string' || !RELEASE_CHANNELS.includes(value as ReleaseChannel)) {
    throw new ValidationError(`channel must be one of: ${RELEASE_CHANNELS.join(', ')}`);
  }
  return value as ReleaseChannel;
};

const kindOf = (value: unknown): ReleaseKind => {
  if (typeof value !== 'string' || !RELEASE_KINDS.includes(value as ReleaseKind)) {
    throw new ValidationError(`kind must be one of: ${RELEASE_KINDS.join(', ')}`);
  }
  return value as ReleaseKind;
};

const tenantTypeOf = (value: unknown): TenantType => {
  if (typeof value !== 'string' || !TENANT_TYPES.includes(value as TenantType)) {
    throw new ValidationError(`tenant type must be one of: ${TENANT_TYPES.join(', ')}`);
  }
  return value as TenantType;
};

const integerField = (value: unknown, name: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ValidationError(`${name} must be an integer >= ${min}`);
  }
  return value;
};

const stringField = (value: unknown, name: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${name} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`${name} is too long`);
  return trimmed;
};

export const normalizeDigest = (value: unknown): string => {
  const digest = stringField(value, 'digest', 80).toLowerCase();
  if (!DIGEST_RE.test(digest)) {
    throw new ValidationError('digest must be a sha256:<64 lowercase hex> image digest');
  }
  return digest;
};

export const imageNameFor = (kind: ReleaseKind): string =>
  kind === 'store' ? env.storeImageName : env.headOfficeImageName;

/** A Coolify image tag: the digest's hex half, valid for its tag field. */
export const imageTagFor = (release: Pick<ImageRelease, 'digest'>): string =>
  release.digest.replace(/^sha256:/, '');

/** Exact Coolify image reference: name plus immutable digest, no mutable tag. */
export const imageReferenceFor = (release: Pick<ImageRelease, 'kind' | 'digest'>): string =>
  `${imageNameFor(release.kind)}@${release.digest}`;

/** Validate the declared schema range and target. */
export const assertSchemaRange = (release: {
  schema_version: number;
  schema_min: number;
  schema_max: number;
}): void => {
  if (release.schema_min < 0 || release.schema_max < release.schema_min) {
    throw new ValidationError('schema_min/schema_max must be a valid non-negative range');
  }
  if (release.schema_version < release.schema_min || release.schema_version > release.schema_max) {
    throw new ValidationError('schema_version must lie inside schema_min..schema_max');
  }
};

export const releaseSupportsSchema = (
  release: Pick<ImageRelease, 'schema_min' | 'schema_max'>,
  schemaVersion: number,
): boolean => schemaVersion >= release.schema_min && schemaVersion <= release.schema_max;

export const createImageRelease = (input: unknown): ImageRelease => {
  const body = (input ?? {}) as Record<string, unknown>;
  const kind = kindOf(body.kind);
  const tag = stringField(body.tag, 'tag', 128);
  const digest = normalizeDigest(body.digest);
  const version = stringField(body.version, 'version', 80);
  const revision =
    body.revision === undefined || body.revision === null
      ? null
      : stringField(body.revision, 'revision', 80);
  const channel = channelOf(body.channel ?? 'stable');
  const schemaVersion = integerField(body.schemaVersion, 'schemaVersion', 0);
  const schemaMin = integerField(body.schemaMin, 'schemaMin', 0);
  const schemaMax = integerField(body.schemaMax, 'schemaMax', 0);
  assertSchemaRange({
    schema_version: schemaVersion,
    schema_min: schemaMin,
    schema_max: schemaMax,
  });
  const notes =
    body.notes === undefined || body.notes === null ? null : stringField(body.notes, 'notes', 1000);
  const isActive = body.isActive === undefined ? 1 : body.isActive ? 1 : 0;

  try {
    const info = getRegistryDb()
      .prepare(
        `INSERT INTO image_releases
           (kind, tag, digest, version, revision, channel, schema_version, schema_min, schema_max, notes, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        tag,
        digest,
        version,
        revision,
        channel,
        schemaVersion,
        schemaMin,
        schemaMax,
        notes,
        isActive,
      );
    return getImageRelease(Number(info.lastInsertRowid))!;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new HttpError(
        409,
        'A release with this kind and tag or digest already exists',
        'release_exists',
      );
    }
    throw err;
  }
};

export const getImageRelease = (id: number): ImageRelease | null =>
  (getRegistryDb().prepare('SELECT * FROM image_releases WHERE id = ?').get(id) as
    ImageRelease | undefined) ?? null;

export const listImageReleases = (
  filters: {
    kind?: ReleaseKind;
    channel?: ReleaseChannel;
    activeOnly?: boolean;
  } = {},
): ImageRelease[] => {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filters.kind) {
    clauses.push('kind = ?');
    args.push(filters.kind);
  }
  if (filters.channel) {
    clauses.push('channel = ?');
    args.push(filters.channel);
  }
  if (filters.activeOnly) clauses.push('is_active = 1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return getRegistryDb()
    .prepare(`SELECT * FROM image_releases ${where} ORDER BY published_at DESC, id DESC`)
    .all(...args) as ImageRelease[];
};

/** Latest active release on a channel — the default for new onboarding. */
export const resolveReleaseForChannel = (
  kind: ReleaseKind,
  channel: ReleaseChannel = 'stable',
): ImageRelease | null =>
  (getRegistryDb()
    .prepare(
      `SELECT * FROM image_releases
        WHERE kind = ? AND channel = ? AND is_active = 1
        ORDER BY published_at DESC, id DESC LIMIT 1`,
    )
    .get(kind, channel) as ImageRelease | undefined) ?? null;

export const resolveDefaultRelease = (kind: ReleaseKind): ImageRelease | null =>
  resolveReleaseForChannel(kind, 'stable');

const storeState = (store: StoreRecord): TenantReleaseState => ({
  tenantType: 'store',
  id: store.id,
  name: store.name,
  slug: store.slug,
  baseUrl: store.base_url,
  environment: store.environment,
  companyId: store.company_id,
  companySlug: store.company_id ? (getCompanyById(store.company_id)?.slug ?? null) : null,
  status: store.status,
  deployStatus: store.deploy_status,
  coolifyUuid: store.coolify_uuid,
  volumeName: store.volume_name,
  imageDigest: store.image_digest ?? null,
  imageTag: store.image_tag ?? null,
  releaseChannel: store.release_channel ?? 'stable',
  desiredReleaseId: store.desired_release_id ?? null,
  lastReleaseId: store.last_release_id ?? null,
  previousReleaseId: store.previous_release_id ?? null,
  lastReleaseAt: store.last_release_at ?? null,
  releaseState: store.release_state ?? 'idle',
  schemaVersion: store.schema_version ?? null,
  appVersion: store.app_version ?? null,
});

const panelState = (panel: PanelRecord): TenantReleaseState => ({
  tenantType: 'panel',
  id: panel.id,
  name: panel.name,
  slug: panel.slug,
  baseUrl: panel.base_url,
  environment: null,
  companyId: panel.company_id,
  companySlug: getCompanyById(panel.company_id)?.slug ?? null,
  status: panel.status,
  deployStatus: panel.deploy_status,
  coolifyUuid: panel.coolify_uuid,
  volumeName: panel.volume_name,
  imageDigest: panel.image_digest ?? null,
  imageTag: panel.image_tag ?? null,
  releaseChannel: panel.release_channel ?? 'stable',
  desiredReleaseId: panel.desired_release_id ?? null,
  lastReleaseId: panel.last_release_id ?? null,
  previousReleaseId: panel.previous_release_id ?? null,
  lastReleaseAt: panel.last_release_at ?? null,
  releaseState: panel.release_state ?? 'idle',
  schemaVersion: panel.schema_version ?? null,
  appVersion: panel.app_version ?? null,
});

export const getTenantReleaseState = (
  tenantType: TenantType,
  tenantId: number,
): TenantReleaseState | null => {
  if (tenantType === 'store') {
    const store = getStoreById(tenantId);
    return store ? storeState(store) : null;
  }
  const panel = getPanelById(tenantId);
  return panel ? panelState(panel) : null;
};

export const listTenantReleaseStates = (tenantType: TenantType): TenantReleaseState[] => {
  const db = getRegistryDb();
  if (tenantType === 'store') {
    return (db.prepare('SELECT * FROM stores ORDER BY name').all() as StoreRecord[]).map(
      storeState,
    );
  }
  return (db.prepare('SELECT * FROM panels ORDER BY name').all() as PanelRecord[]).map(panelState);
};

export const tenantTypeForKind = (kind: ReleaseKind): TenantType =>
  kind === 'store' ? 'store' : 'panel';

/** A lock prevents two release operations racing the same tenant. */
export interface DeploymentLock {
  token: string;
  expiresAt: string;
}

export const acquireDeploymentLock = (
  tenantType: TenantType,
  tenantId: number,
  options: { batchId?: number | null; reason?: string; minutes?: number } = {},
): DeploymentLock | null => {
  const db = getRegistryDb();
  const token = crypto.randomUUID();
  const minutes = options.minutes ?? env.releaseLockMinutes;
  return db.transaction((): DeploymentLock | null => {
    db.prepare("DELETE FROM deployment_locks WHERE expires_at <= datetime('now')").run();
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO deployment_locks
           (tenant_type, tenant_id, lock_token, batch_id, reason, expires_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
      )
      .run(
        tenantType,
        tenantId,
        token,
        options.batchId ?? null,
        options.reason ?? null,
        `+${minutes} minutes`,
      );
    if (info.changes === 0) return null;
    const row = db
      .prepare('SELECT expires_at FROM deployment_locks WHERE tenant_type = ? AND tenant_id = ?')
      .get(tenantType, tenantId) as { expires_at: string };
    return { token, expiresAt: row.expires_at };
  })();
};

export const getDeploymentLock = (
  tenantType: TenantType,
  tenantId: number,
): {
  lock_token: string;
  batch_id: number | null;
  reason: string | null;
  expires_at: string;
} | null =>
  (getRegistryDb()
    .prepare(
      'SELECT lock_token, batch_id, reason, expires_at FROM deployment_locks WHERE tenant_type = ? AND tenant_id = ?',
    )
    .get(tenantType, tenantId) as
    | { lock_token: string; batch_id: number | null; reason: string | null; expires_at: string }
    | undefined) ?? null;

export const releaseDeploymentLock = (
  tenantType: TenantType,
  tenantId: number,
  token: string,
): void => {
  getRegistryDb()
    .prepare(
      'DELETE FROM deployment_locks WHERE tenant_type = ? AND tenant_id = ? AND lock_token = ?',
    )
    .run(tenantType, tenantId, token);
};

export interface TenantReleaseUpdate {
  imageDigest: string;
  imageTag: string;
  releaseId: number;
  channel: ReleaseChannel;
  previousReleaseId: number | null;
  schemaVersion?: number | null;
  appVersion?: string | null;
  deployStatus: 'deployed' | 'failed' | 'provisioning';
  releaseState?:
    'idle' | 'queued' | 'deploying' | 'verifying' | 'healthy' | 'failed' | 'rolled_back';
  coolifyUuid?: string | null;
  volumeName?: string | null;
}

export const updateTenantReleaseState = (
  tenantType: TenantType,
  tenantId: number,
  input: TenantReleaseUpdate,
): void => {
  const db = getRegistryDb();
  const table = tenantType === 'store' ? 'stores' : 'panels';
  const sets = [
    'image_digest = ?',
    'image_tag = ?',
    'release_channel = ?',
    'desired_release_id = ?',
    'last_release_id = ?',
    'previous_release_id = ?',
    "last_release_at = datetime('now')",
    'deploy_status = ?',
    "updated_at = datetime('now')",
  ];
  const args: unknown[] = [
    input.imageDigest,
    input.imageTag,
    input.channel,
    input.releaseId,
    input.releaseId,
    input.previousReleaseId,
    input.deployStatus,
  ];
  if (input.schemaVersion !== undefined) {
    sets.push('schema_version = ?');
    args.push(input.schemaVersion);
  }
  if (input.releaseState !== undefined) {
    sets.push('release_state = ?');
    args.push(input.releaseState);
  }
  if (input.appVersion !== undefined) {
    sets.push('app_version = ?');
    args.push(input.appVersion);
  }
  if (input.coolifyUuid !== undefined) {
    sets.push('coolify_uuid = COALESCE(?, coolify_uuid)');
    args.push(input.coolifyUuid);
  }
  if (input.volumeName !== undefined) {
    sets.push('volume_name = COALESCE(?, volume_name)');
    args.push(input.volumeName);
  }
  args.push(tenantId);
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...args);
};

export const setTenantDesiredRelease = (
  tenantType: TenantType,
  tenantId: number,
  releaseId: number,
): void => {
  const table = tenantType === 'store' ? 'stores' : 'panels';
  getRegistryDb()
    .prepare(
      `UPDATE ${table} SET desired_release_id = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(releaseId, tenantId);
};

export const setTenantReleaseChannel = (
  tenantType: TenantType,
  tenantId: number,
  channel: ReleaseChannel,
): void => {
  const table = tenantType === 'store' ? 'stores' : 'panels';
  getRegistryDb()
    .prepare(`UPDATE ${table} SET release_channel = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(channel, tenantId);
};

export const setTenantReleaseState = (
  tenantType: TenantType,
  tenantId: number,
  releaseState:
    'idle' | 'queued' | 'deploying' | 'verifying' | 'healthy' | 'failed' | 'rolled_back',
): void => {
  const table = tenantType === 'store' ? 'stores' : 'panels';
  getRegistryDb()
    .prepare(`UPDATE ${table} SET release_state = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(releaseState, tenantId);
};

/** Persist the Coolify target as soon as the app exists, before the deploy trigger. */
export const setTenantCoolifyTarget = (
  tenantType: TenantType,
  tenantId: number,
  coolifyUuid: string,
  volumeName: string,
): void => {
  const table = tenantType === 'store' ? 'stores' : 'panels';
  getRegistryDb()
    .prepare(
      `UPDATE ${table}
          SET coolify_uuid = ?, volume_name = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(coolifyUuid, volumeName, tenantId);
};

export const markTenantDeployStatus = (
  tenantType: TenantType,
  tenantId: number,
  status: 'provisioning' | 'failed' | 'deployed',
  releaseState?:
    'idle' | 'queued' | 'deploying' | 'verifying' | 'healthy' | 'failed' | 'rolled_back',
): void => {
  const table = tenantType === 'store' ? 'stores' : 'panels';
  if (releaseState) {
    getRegistryDb()
      .prepare(
        `UPDATE ${table} SET deploy_status = ?, release_state = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(status, releaseState, tenantId);
    return;
  }
  getRegistryDb()
    .prepare(`UPDATE ${table} SET deploy_status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, tenantId);
};

/**
 * Record the image a new deployment was created from. Called by the onboarding
 * path immediately after Coolify returns; the caller still owns the health
 * transition to `deployed`.
 */
export const recordProvisionedRelease = (
  tenantType: TenantType,
  tenantId: number,
  release: ImageRelease,
  coolifyUuid: string,
  volumeName: string,
): void => {
  updateTenantReleaseState(tenantType, tenantId, {
    imageDigest: release.digest,
    imageTag: release.tag,
    releaseId: release.id,
    channel: release.channel,
    previousReleaseId: null,
    schemaVersion: release.schema_version,
    appVersion: release.version,
    deployStatus: 'provisioning',
    releaseState: 'queued',
    coolifyUuid,
    volumeName,
  });
};

export const createReleaseBatch = (input: {
  releaseId: number;
  kind: ReleaseKind;
  channel: string;
  waveSize: number;
  requestedBy: string;
  dryRun: boolean;
  total: number;
  stopOnFailure?: boolean;
}): ReleaseBatch => {
  const info = getRegistryDb()
    .prepare(
      `INSERT INTO release_batches
         (release_id, kind, channel, status, wave_size, requested_by, dry_run, stop_on_failure, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.releaseId,
      input.kind,
      input.channel,
      input.dryRun ? 'dry_run' : 'planned',
      input.waveSize,
      input.requestedBy,
      input.dryRun ? 1 : 0,
      input.stopOnFailure === false ? 0 : 1,
      input.total,
    );
  return getReleaseBatch(Number(info.lastInsertRowid))!;
};

export const getReleaseBatch = (id: number): ReleaseBatch | null =>
  (getRegistryDb().prepare('SELECT * FROM release_batches WHERE id = ?').get(id) as
    ReleaseBatch | undefined) ?? null;

export const listReleaseBatches = (limit = 50): ReleaseBatch[] =>
  getRegistryDb()
    .prepare('SELECT * FROM release_batches ORDER BY id DESC LIMIT ?')
    .all(limit) as ReleaseBatch[];

export const updateReleaseBatch = (id: number, patch: Partial<ReleaseBatch>): void => {
  const allowed: Array<keyof ReleaseBatch> = [
    'status',
    'succeeded',
    'failed',
    'skipped',
    'error',
    'started_at',
    'completed_at',
  ];
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      args.push(patch[key]);
    }
  }
  if (!sets.length) return;
  args.push(id);
  getRegistryDb()
    .prepare(`UPDATE release_batches SET ${sets.join(', ')} WHERE id = ?`)
    .run(...args);
};

export const createReleaseBatchItem = (input: {
  batchId: number;
  tenantType: TenantType;
  tenantId: number;
  waveNo: number;
  action: ReleaseAction;
  fromDigest?: string | null;
  toDigest: string;
}): ReleaseBatchItem => {
  const info = getRegistryDb()
    .prepare(
      `INSERT INTO release_batch_items
         (batch_id, tenant_type, tenant_id, wave_no, action, from_digest, to_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.batchId,
      input.tenantType,
      input.tenantId,
      input.waveNo,
      input.action,
      input.fromDigest ?? null,
      input.toDigest,
    );
  return getReleaseBatchItem(Number(info.lastInsertRowid))!;
};

export const getReleaseBatchItem = (id: number): ReleaseBatchItem | null =>
  (getRegistryDb().prepare('SELECT * FROM release_batch_items WHERE id = ?').get(id) as
    ReleaseBatchItem | undefined) ?? null;

export const listReleaseBatchItems = (batchId: number): ReleaseBatchItem[] =>
  getRegistryDb()
    .prepare('SELECT * FROM release_batch_items WHERE batch_id = ? ORDER BY wave_no, id')
    .all(batchId) as ReleaseBatchItem[];

export const updateReleaseBatchItem = (
  id: number,
  patch: Partial<ReleaseBatchItem> & { metadata?: unknown },
): void => {
  const allowed: Array<keyof ReleaseBatchItem> = [
    'status',
    'error',
    'started_at',
    'completed_at',
    'from_digest',
    'to_digest',
  ];
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      args.push(patch[key]);
    }
  }
  if (patch.metadata !== undefined) {
    sets.push('metadata_json = ?');
    args.push(JSON.stringify(patch.metadata));
  }
  if (!sets.length) return;
  args.push(id);
  getRegistryDb()
    .prepare(`UPDATE release_batch_items SET ${sets.join(', ')} WHERE id = ?`)
    .run(...args);
};

export const createReleaseDeployment = (input: {
  tenantType: TenantType;
  tenantId: number;
  releaseId: number;
  batchId?: number | null;
  action: ReleaseAction;
  fromReleaseId?: number | null;
  fromDigest?: string | null;
  toDigest: string;
}): number => {
  const info = getRegistryDb()
    .prepare(
      `INSERT INTO release_deployments
         (tenant_type, tenant_id, release_id, batch_id, action, from_release_id, to_release_id,
          from_digest, to_digest, status, phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'queued')`,
    )
    .run(
      input.tenantType,
      input.tenantId,
      input.releaseId,
      input.batchId ?? null,
      input.action,
      input.fromReleaseId ?? null,
      input.releaseId,
      input.fromDigest ?? null,
      input.toDigest,
    );
  return Number(info.lastInsertRowid);
};

export const updateReleaseDeploymentTracking = (
  id: number,
  input: {
    phase?: string;
    coolifyUuid?: string | null;
    coolifyDeploymentUuid?: string | null;
  },
): void => {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (input.phase !== undefined) {
    sets.push('phase = ?');
    args.push(input.phase);
  }
  if (input.coolifyUuid !== undefined) {
    sets.push('coolify_uuid = COALESCE(?, coolify_uuid)');
    args.push(input.coolifyUuid);
  }
  if (input.coolifyDeploymentUuid !== undefined) {
    sets.push('coolify_deployment_uuid = ?');
    args.push(input.coolifyDeploymentUuid);
  }
  if (!sets.length) return;
  args.push(id);
  getRegistryDb()
    .prepare(`UPDATE release_deployments SET ${sets.join(', ')} WHERE id = ?`)
    .run(...args);
};

export const getRunningReleaseDeployment = (
  tenantType: TenantType,
  tenantId: number,
): {
  id: number;
  action: ReleaseAction;
  phase: string;
  coolify_uuid: string | null;
  coolify_deployment_uuid: string | null;
  created_at: string;
} | null =>
  (getRegistryDb()
    .prepare(
      `SELECT id, action, phase, coolify_uuid, coolify_deployment_uuid, created_at
         FROM release_deployments
        WHERE tenant_type = ? AND tenant_id = ? AND status = 'running'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(tenantType, tenantId) as
    | {
        id: number;
        action: ReleaseAction;
        phase: string;
        coolify_uuid: string | null;
        coolify_deployment_uuid: string | null;
        created_at: string;
      }
    | undefined) ?? null;

export const finishReleaseDeployment = (
  id: number,
  status: 'complete' | 'failed' | 'skipped',
  input: { error?: string | null; coolifyUuid?: string | null } = {},
): void => {
  getRegistryDb()
    .prepare(
      `UPDATE release_deployments
          SET status = ?, phase = ?, error = ?, coolify_uuid = COALESCE(?, coolify_uuid),
              completed_at = datetime('now')
        WHERE id = ?`,
    )
    .run(
      status,
      status === 'complete' ? 'healthy' : status === 'failed' ? 'failed' : 'skipped',
      input.error ?? null,
      input.coolifyUuid ?? null,
      id,
    );
};

export const listReleaseDeployments = (tenantType: TenantType, tenantId: number, limit = 20) =>
  getRegistryDb()
    .prepare(
      `SELECT * FROM release_deployments
        WHERE tenant_type = ? AND tenant_id = ?
        ORDER BY id DESC LIMIT ?`,
    )
    .all(tenantType, tenantId, limit) as Array<{
    id: number;
    tenant_type: TenantType;
    tenant_id: number;
    release_id: number | null;
    batch_id: number | null;
    action: ReleaseAction;
    from_release_id: number | null;
    to_release_id: number | null;
    from_digest: string | null;
    to_digest: string | null;
    status: string;
    phase: string;
    error: string | null;
    coolify_uuid: string | null;
    coolify_deployment_uuid: string | null;
    created_at: string;
    completed_at: string | null;
  }>;

export { tenantTypeOf, channelOf, kindOf };
