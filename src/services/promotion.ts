import {
  controlPlaneEnvironment,
  env,
  logger,
  type ControlPlaneEnvironment,
} from '../config/env.js';
import {
  createReleasePromotion,
  expireStalePromotions,
  getActiveReleasePromotion,
  getActiveReleasePromotionByTag,
  getLatestReleasePromotion,
  getReleasePromotion,
  updateReleasePromotion,
  type ReleasePromotion,
} from '../config/registryDb.js';
import { HttpError } from '../utils/errors.js';
import {
  DIGEST_RE,
  getDeploymentLock,
  listImageReleases,
  listTenantReleaseStates,
  releaseSupportsSchema,
  type ImageRelease,
  type ReleaseKind,
  type TenantReleaseState,
} from './releaseCatalog.js';
import { getBatch } from './releaseOrchestrator.js';

/**
 * One-click production promotion.
 *
 * The Control Plane never drives Coolify directly on the production fleet for a
 * promotion: the operator approves a tag that staging has already deployed,
 * the backend verifies the GitHub release manifest still carries the same
 * digests, and it dispatches the existing `promote-production.yml` workflow.
 * That workflow calls back into POST /api/releases/ci, which reuses the normal
 * stop-first release engine. This module owns the operator-facing view and the
 * single in-flight promotion record; it does not duplicate deployment logic.
 */

export const PROMOTION_SCOPE = 'production-hm-stores';
const HM_SCOPE_PREFIX = 'hm-stores-';
const DEMO_SCOPE_PREFIX = 'demo-';

export interface CandidateImage {
  digest: string;
  schemaVersion: number;
  schemaMin: number;
  schemaMax: number;
  channel: string;
  releaseId: number;
  tag: string;
  publishedAt: string;
}

export interface PromotionCandidate {
  tag: string;
  commit: string | null;
  publishedAt: string | null;
  store: CandidateImage;
  ho: CandidateImage;
  staging: { stores: number; panels: number; verifiedAt: string };
}

export interface PromotionCurrent {
  tag: string | null;
  digest: string | null;
  healthy: number;
  total: number;
  updated: number;
}

export interface PromotionTarget {
  tenantType: 'store' | 'panel';
  id: number;
  name: string;
  slug: string;
  baseUrl: string;
  deployMode: TenantReleaseState['deployMode'];
  currentTag: string | null;
  currentDigest: string | null;
  schemaVersion: number | null;
  runtimeHealth: TenantReleaseState['runtimeHealth'];
  releaseState: TenantReleaseState['releaseState'];
  paused: boolean;
  needsUpdate: boolean;
  blocker: string | null;
  warning: string | null;
}

export interface PromotionBatchView {
  kind: ReleaseKind;
  id: number;
  status: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error: string | null;
  items: Array<{
    tenantType: string;
    tenantId: number;
    name: string;
    status: string;
    error: string | null;
  }>;
}

export interface PromotionView {
  id: number;
  tag: string;
  commit: string | null;
  status: ReleasePromotion['status'];
  requestedBy: string;
  reason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  storeDigest: string;
  hoDigest: string;
  githubRunUrl: string | null;
  githubStatus: string | null;
  githubConclusion: string | null;
  batches: PromotionBatchView[];
}

export interface PromotionPreview {
  environment: ControlPlaneEnvironment;
  scope: typeof PROMOTION_SCOPE;
  enabled: boolean;
  disabledReason: string | null;
  candidate: PromotionCandidate | null;
  candidateError: string | null;
  current: { stores: PromotionCurrent; panels: PromotionCurrent };
  targets: { stores: PromotionTarget[]; panels: PromotionTarget[] };
  updatesRequired: number;
  blockers: string[];
  warnings: string[];
  canPromote: boolean;
  promotion: PromotionView | null;
}

const isDemoTenant = (state: TenantReleaseState): boolean =>
  state.deployMode === 'image' && state.slug.startsWith(DEMO_SCOPE_PREFIX);

const isPromotionTarget = (state: TenantReleaseState): boolean =>
  state.slug.startsWith(HM_SCOPE_PREFIX);

const releaseOf = (releases: ImageRelease[], kind: ReleaseKind, tag: string) =>
  releases.find((release) => release.kind === kind && release.tag === tag && release.is_active) ??
  null;

const imageOut = (release: ImageRelease): CandidateImage => ({
  digest: release.digest,
  schemaVersion: release.schema_version,
  schemaMin: release.schema_min,
  schemaMax: release.schema_max,
  channel: release.channel,
  releaseId: release.id,
  tag: release.tag,
  publishedAt: release.published_at,
});

/**
 * The staging CP answers this. A candidate is the newest tag for which BOTH
 * images exist and every in-scope demo tenant already runs that exact digest in
 * a healthy state. A half-rolled-out tag is never silently skipped in favour of
 * an older one: the caller is told to wait.
 */
export const testedCandidateForStaging = (): PromotionCandidate => {
  const stores = listTenantReleaseStates('store').filter(isDemoTenant);
  const panels = listTenantReleaseStates('panel').filter(isDemoTenant);
  if (stores.length === 0 && panels.length === 0) {
    throw new HttpError(
      404,
      'no_staging_demo_tenants: no image-mode demo tenants are registered on this Control Plane',
    );
  }

  const releases = listImageReleases({ activeOnly: true });
  const tags: string[] = [];
  for (const release of releases) {
    if (!tags.includes(release.tag)) tags.push(release.tag);
  }

  for (const tag of tags) {
    const storeRelease = releaseOf(releases, 'store', tag);
    const hoRelease = releaseOf(releases, 'ho', tag);
    if (!storeRelease || !hoRelease) continue;

    const mismatched: string[] = [];
    for (const state of stores) {
      if (
        state.lastReleaseId !== storeRelease.id ||
        state.imageDigest !== storeRelease.digest ||
        state.releaseState !== 'healthy' ||
        state.runtimeHealth === 'down'
      ) {
        mismatched.push(`${state.slug} (${state.releaseState}/${state.runtimeHealth})`);
      }
    }
    for (const state of panels) {
      if (
        state.lastReleaseId !== hoRelease.id ||
        state.imageDigest !== hoRelease.digest ||
        state.releaseState !== 'healthy' ||
        state.runtimeHealth === 'down'
      ) {
        mismatched.push(`${state.slug} (${state.releaseState}/${state.runtimeHealth})`);
      }
    }

    if (mismatched.length) {
      throw new HttpError(
        409,
        `staging_not_fully_deployed: ${tag} has not reached every demo tenant (${mismatched
          .slice(0, 5)
          .join(', ')}${mismatched.length > 5 ? ', …' : ''})`,
        'staging_not_fully_deployed',
      );
    }

    const commit =
      storeRelease.revision && hoRelease.revision && storeRelease.revision !== hoRelease.revision
        ? null
        : (storeRelease.revision ?? hoRelease.revision ?? null);

    return {
      tag,
      commit,
      publishedAt:
        storeRelease.published_at > hoRelease.published_at
          ? storeRelease.published_at
          : hoRelease.published_at,
      store: imageOut(storeRelease),
      ho: imageOut(hoRelease),
      staging: {
        stores: stores.length,
        panels: panels.length,
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  throw new HttpError(
    404,
    'no_complete_staging_release: no tag has both a Store and a Head Office image',
  );
};

interface CandidateFetch {
  candidate: PromotionCandidate | null;
  error: string | null;
}

let candidateCache: { at: number; value: CandidateFetch } | null = null;
const CANDIDATE_CACHE_MS = 15_000;

/** Read the staging candidate, cached briefly because the UI polls. */
export const fetchStagingCandidate = async (): Promise<CandidateFetch> => {
  if (candidateCache && Date.now() - candidateCache.at < CANDIDATE_CACHE_MS) {
    return candidateCache.value;
  }
  const missing: string[] = [];
  if (!env.stagingCpUrl) missing.push('STAGING_CP_URL');
  if (!env.stagingReleaseReadToken) missing.push('STAGING_RELEASE_READ_TOKEN');
  if (missing.length) {
    const value = {
      candidate: null,
      error: `staging_candidate_source_not_configured: ${missing.join(' and ')} must be set on the production Control Plane`,
    };
    candidateCache = { at: Date.now(), value };
    return value;
  }

  let value: CandidateFetch;
  try {
    const res = await fetch(`${env.stagingCpUrl}/api/releases/tested-candidate`, {
      redirect: 'error',
      headers: { 'x-release-read-token': env.stagingReleaseReadToken! },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as
      (PromotionCandidate & { error?: string }) | { error?: string } | null;
    if (res.ok && body && 'tag' in body && 'store' in body && 'ho' in body) {
      value = { candidate: body as PromotionCandidate, error: null };
    } else {
      value = {
        candidate: null,
        error:
          (body && 'error' in body && typeof body.error === 'string' && body.error) ||
          `staging_candidate_unavailable: the staging Control Plane answered ${res.status}`,
      };
    }
  } catch (err) {
    value = {
      candidate: null,
      error: `staging_candidate_unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  candidateCache = { at: Date.now(), value };
  return value;
};

/** Test seam: a fresh promotion must not read a candidate cached in a prior test. */
export const clearPromotionCandidateCache = (): void => {
  candidateCache = null;
};

const currentSummary = (
  targets: PromotionTarget[],
  candidateDigest: string | null,
): PromotionCurrent => {
  const tags = [...new Set(targets.map((target) => target.currentTag).filter(Boolean))] as string[];
  const digests = [
    ...new Set(targets.map((target) => target.currentDigest).filter(Boolean)),
  ] as string[];
  return {
    tag: tags.length === 0 ? null : tags.length === 1 ? tags[0] : 'mixed',
    digest: digests.length === 1 ? digests[0] : null,
    healthy: targets.filter((target) => target.runtimeHealth === 'up').length,
    total: targets.length,
    updated: candidateDigest
      ? targets.filter((target) => target.currentDigest === candidateDigest).length
      : 0,
  };
};

const buildTarget = (
  state: TenantReleaseState,
  candidate: CandidateImage | null,
): PromotionTarget => {
  const paused = state.status === 'paused';
  const needsUpdate = candidate ? state.imageDigest !== candidate.digest : false;
  const candidateSchema = candidate
    ? {
        schema_min: candidate.schemaMin,
        schema_max: candidate.schemaMax,
      }
    : null;
  let blocker: string | null = null;
  if (!paused && state.deployMode === 'dockerfile') {
    blocker =
      'legacy_dockerfile: this tenant needs a blue/green migration before shared-image releases';
  } else if (!paused && state.deployMode === 'unprovisioned') {
    blocker = 'not_provisioned: no shared-image application is recorded for this tenant';
  } else if (candidate && !paused && needsUpdate) {
    if (state.schemaVersion === null || state.schemaVersion === undefined) {
      blocker =
        'schema_unreported: the deployment has not reported its database schema; refusing an image change';
    } else if (!releaseSupportsSchema(candidateSchema!, state.schemaVersion)) {
      blocker = `schema_incompatible: image supports schema ${candidate.schemaMin}..${candidate.schemaMax}, deployment is at ${state.schemaVersion}`;
    } else if (['queued', 'deploying', 'verifying'].includes(state.releaseState)) {
      blocker = `deployment_in_progress: release state is ${state.releaseState}`;
    } else {
      const lock = getDeploymentLock(state.tenantType, state.id);
      if (lock) {
        const expires = Date.parse(`${lock.expires_at.replace(' ', 'T')}Z`);
        if (Number.isFinite(expires) && expires > Date.now()) {
          blocker = 'deployment_locked: another release operation holds this tenant';
        }
      }
    }
  }
  let warning: string | null = null;
  if (paused) warning = 'paused: the release batch will skip this tenant';
  else if (state.runtimeHealth === 'down') warning = 'runtime_down: the last health check failed';
  return {
    tenantType: state.tenantType,
    id: state.id,
    name: state.name,
    slug: state.slug,
    baseUrl: state.baseUrl,
    deployMode: state.deployMode,
    currentTag: state.imageTag,
    currentDigest: state.imageDigest,
    schemaVersion: state.schemaVersion,
    runtimeHealth: state.runtimeHealth,
    releaseState: state.releaseState,
    paused,
    needsUpdate,
    blocker,
    warning,
  };
};

const targetViews = (candidate: PromotionCandidate | null) => {
  const stores = listTenantReleaseStates('store')
    .filter(isPromotionTarget)
    .map((state) => buildTarget(state, candidate?.store ?? null));
  const panels = listTenantReleaseStates('panel')
    .filter(isPromotionTarget)
    .map((state) => buildTarget(state, candidate?.ho ?? null));
  const all = [...stores, ...panels];
  return {
    stores,
    panels,
    updatesRequired: all.filter((target) => target.needsUpdate && !target.paused).length,
    blockers: all
      .filter((target) => target.blocker)
      .map((target) => `${target.name}: ${target.blocker}`),
    warnings: all
      .filter((target) => target.warning)
      .map((target) => `${target.name}: ${target.warning}`),
  };
};

const batchView = (
  kind: ReleaseKind,
  id: number | null,
  names: Map<string, string>,
): PromotionBatchView | null => {
  if (!id) return null;
  const detail = getBatch(id);
  if (!detail) return null;
  return {
    kind,
    id: detail.batch.id,
    status: detail.batch.status,
    total: detail.batch.total,
    succeeded: detail.batch.succeeded,
    failed: detail.batch.failed,
    skipped: detail.batch.skipped,
    error: detail.batch.error,
    items: detail.items.map((item) => ({
      tenantType: item.tenant_type,
      tenantId: item.tenant_id,
      name:
        names.get(`${item.tenant_type}:${item.tenant_id}`) ??
        `${item.tenant_type} ${item.tenant_id}`,
      status: item.status,
      error: item.error,
    })),
  };
};

const tenantNames = (): Map<string, string> => {
  const names = new Map<string, string>();
  for (const state of listTenantReleaseStates('store')) {
    names.set(`store:${state.id}`, state.name);
  }
  for (const state of listTenantReleaseStates('panel')) {
    names.set(`panel:${state.id}`, state.name);
  }
  return names;
};

export const promotionView = (promotion: ReleasePromotion | null): PromotionView | null => {
  if (!promotion) return null;
  const names = tenantNames();
  const batches = [
    batchView('store', promotion.store_batch_id, names),
    batchView('ho', promotion.ho_batch_id, names),
  ].filter((batch): batch is PromotionBatchView => Boolean(batch));
  return {
    id: promotion.id,
    tag: promotion.tag,
    commit: promotion.commit_sha,
    status: promotion.status,
    requestedBy: promotion.requested_by,
    reason: promotion.reason,
    createdAt: promotion.created_at,
    startedAt: promotion.started_at,
    completedAt: promotion.completed_at,
    error: promotion.error,
    storeDigest: promotion.store_digest,
    hoDigest: promotion.ho_digest,
    githubRunUrl: promotion.github_run_url,
    githubStatus: promotion.github_status,
    githubConclusion: promotion.github_conclusion,
    batches,
  };
};

const TERMINAL_BATCH = new Set(['complete', 'partial', 'failed', 'dry_run']);

/**
 * Finish a promotion from the batches it owns. `complete` only when every
 * batch completed; a partial/failed batch is a failed promotion, because the
 * fleet is not uniformly on the approved release.
 */
export const settlePromotionFromBatches = (id: number): ReleasePromotion | null => {
  const promotion = getReleasePromotion(id);
  if (!promotion) return null;
  const ids = [promotion.store_batch_id, promotion.ho_batch_id].filter(
    (value): value is number => typeof value === 'number',
  );
  if (ids.length === 0) return promotion;
  const details = ids.map((batchId) => getBatch(batchId)).filter(Boolean) as NonNullable<
    ReturnType<typeof getBatch>
  >[];
  if (details.length !== ids.length || details.some((d) => !TERMINAL_BATCH.has(d.batch.status))) {
    return updateReleasePromotion(id, {
      status: promotion.status === 'dispatching' ? 'running' : promotion.status,
      startedAt: promotion.started_at ?? new Date().toISOString(),
    });
  }
  const ok = details.every((d) => d.batch.status === 'complete');
  const failedBatches = details.filter((d) => d.batch.status !== 'complete');
  return updateReleasePromotion(id, {
    status: ok ? 'complete' : 'failed',
    completedAt: new Date().toISOString(),
    error: ok
      ? null
      : failedBatches
          .map(
            (d) =>
              `${d.batch.kind} batch ${d.batch.id}: ${d.batch.status}` +
              (d.batch.error ? ` (${d.batch.error})` : ''),
          )
          .join('; '),
  });
};

const parseDbTime = (value: string): number => Date.parse(`${value.replace(' ', 'T')}Z`);

const githubHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.githubPromotionToken}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'vula-control-plane',
});

const githubJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  if (!env.githubPromotionToken) {
    throw new HttpError(
      409,
      'github_dispatch_not_configured: GITHUB_PROMOTION_TOKEN is not set on this Control Plane',
      'github_dispatch_not_configured',
    );
  }
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    redirect: 'error',
    headers: { ...githubHeaders(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as
    (T & { message?: string }) | { message?: string } | null;
  if (!res.ok) {
    throw new HttpError(
      502,
      `github_request_failed: ${res.status} ${(body && 'message' in body && body.message) || 'GitHub API refused the request'}`,
      'github_request_failed',
    );
  }
  return body as T;
};

const assetText = async (url: string): Promise<string> => {
  const first = await fetch(url, {
    redirect: 'manual',
    headers: { ...githubHeaders(), Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(20_000),
  });
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    if (!location)
      throw new HttpError(502, 'release_manifest_missing: GitHub returned no asset location');
    // The signed redirect target is fetched without the token: a credential is
    // never sent to a host the caller did not configure.
    const second = await fetch(location, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!second.ok)
      throw new HttpError(502, 'release_manifest_missing: the release asset could not be read');
    return second.text();
  }
  if (!first.ok)
    throw new HttpError(502, 'release_manifest_missing: the release asset could not be read');
  return first.text();
};

interface ReleaseManifest {
  release: string;
  commit: string;
  images: { store?: { digest?: string }; ho?: { digest?: string } };
  schema?: Record<
    string,
    { schemaVersion?: number; minSchemaVersion?: number; maxSchemaVersion?: number }
  >;
}

/**
 * Read the manifest the workflow will use. Comparing it to the approved
 * candidate proves the promotion deploys exactly the digests staging tested,
 * not a tag repointed since then.
 */
export const fetchReleaseManifest = async (tag: string): Promise<ReleaseManifest> => {
  const release = await githubJson<{
    assets?: Array<{ name?: string; url?: string; browser_download_url?: string }>;
  }>(`/repos/${env.githubRepository}/releases/tags/${encodeURIComponent(tag)}`);
  const asset = (release.assets ?? []).find((item) => item.name === 'release-manifest.json');
  if (!asset?.url) {
    throw new HttpError(
      409,
      `release_manifest_missing: GitHub release ${tag} has no release-manifest.json asset`,
      'release_manifest_missing',
    );
  }
  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(await assetText(asset.url)) as ReleaseManifest;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      `release_manifest_invalid: could not parse release-manifest.json for ${tag}`,
      'release_manifest_invalid',
    );
  }
  if (manifest.release !== tag) {
    throw new HttpError(
      409,
      `release_manifest_mismatch: manifest is for ${manifest.release}, expected ${tag}`,
      'release_manifest_mismatch',
    );
  }
  const storeDigest = manifest.images?.store?.digest;
  const hoDigest = manifest.images?.ho?.digest;
  if (!storeDigest || !DIGEST_RE.test(storeDigest)) {
    throw new HttpError(
      409,
      'release_manifest_invalid: the manifest has no valid store image digest',
    );
  }
  if (!hoDigest || !DIGEST_RE.test(hoDigest)) {
    throw new HttpError(
      409,
      'release_manifest_invalid: the manifest has no valid Head Office image digest',
    );
  }
  return manifest;
};

const findDispatchedRun = async (
  since: number,
): Promise<{
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
} | null> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const runs = await githubJson<{
        workflow_runs?: Array<{
          id: number;
          html_url: string;
          status: string;
          conclusion: string | null;
          head_branch?: string;
          created_at?: string;
        }>;
      }>(
        `/repos/${env.githubRepository}/actions/workflows/${encodeURIComponent(
          env.githubPromotionWorkflow,
        )}/runs?event=workflow_dispatch&per_page=10`,
      );
      const match = (runs.workflow_runs ?? [])
        .filter((run) => {
          const created = run.created_at ? Date.parse(run.created_at) : NaN;
          return (
            run.head_branch === env.githubPromotionRef &&
            Number.isFinite(created) &&
            created >= since - 10_000
          );
        })
        .sort((a, b) => b.id - a.id)[0];
      if (match) return match;
    } catch (err) {
      logger.warn(`Could not locate the dispatched promotion run yet: ${String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
};

/** Dispatch the existing workflow; the backend holds the only GitHub credential. */
export const dispatchPromotion = async (
  promotion: ReleasePromotion,
  manifest: ReleaseManifest,
): Promise<ReleasePromotion> => {
  const startedAt = Date.now();
  await githubJson(
    `/repos/${env.githubRepository}/actions/workflows/${encodeURIComponent(
      env.githubPromotionWorkflow,
    )}/dispatches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: env.githubPromotionRef,
        inputs: { release_tag: promotion.tag, confirm_release_tag: promotion.tag },
      }),
    },
  );
  const run = await findDispatchedRun(startedAt);
  return (
    updateReleasePromotion(promotion.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      githubRunId: run?.id ?? null,
      githubRunUrl: run?.html_url ?? null,
      githubStatus: run?.status ?? 'queued',
      githubConclusion: run?.conclusion ?? null,
      error: null,
    }) ?? promotion
  );
};

const runStatus = async (promotion: ReleasePromotion): Promise<ReleasePromotion> => {
  if (!promotion.github_run_id || !env.githubPromotionToken) return promotion;
  try {
    const run = await githubJson<{
      status: string;
      conclusion: string | null;
      html_url: string;
    }>(`/repos/${env.githubRepository}/actions/runs/${promotion.github_run_id}`);
    const updated =
      updateReleasePromotion(promotion.id, {
        githubStatus: run.status,
        githubConclusion: run.conclusion,
        githubRunUrl: run.html_url,
      }) ?? promotion;
    const failed = ['failure', 'cancelled', 'timed_out', 'action_required'].includes(
      run.conclusion ?? '',
    );
    if (failed && !updated.store_batch_id && !updated.ho_batch_id) {
      return (
        updateReleasePromotion(promotion.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: `workflow_${run.conclusion}: the promotion workflow did not complete (${run.html_url})`,
        }) ?? updated
      );
    }
    if (
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      !updated.store_batch_id &&
      !updated.ho_batch_id
    ) {
      return (
        updateReleasePromotion(promotion.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: `workflow_completed_without_release: the workflow finished but no batch reached the Control Plane (${run.html_url})`,
        }) ?? updated
      );
    }
    return updated;
  } catch (err) {
    logger.warn(`Could not read GitHub promotion run ${promotion.github_run_id}: ${String(err)}`);
    return promotion;
  }
};

/** Reconcile an in-flight promotion from local batches and, when needed, GitHub. */
export const reconcilePromotion = async (): Promise<ReleasePromotion | null> => {
  expireStalePromotions(env.promotionTimeoutMinutes);
  let promotion = getActiveReleasePromotion();
  if (!promotion) return null;
  if (promotion.store_batch_id || promotion.ho_batch_id) {
    return settlePromotionFromBatches(promotion.id);
  }
  promotion = await runStatus(promotion);
  if (promotion.status !== 'dispatching' && promotion.status !== 'running') return promotion;
  const ageMs = Date.now() - parseDbTime(promotion.created_at);
  if (Number.isFinite(ageMs) && ageMs > env.promotionTimeoutMinutes * 60_000) {
    return updateReleasePromotion(promotion.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: `promotion_timed_out: no staging-verified release callback within ${env.promotionTimeoutMinutes} minutes`,
    });
  }
  return promotion;
};

export const promotionPreview = async (input: {
  releaseManager: boolean;
}): Promise<PromotionPreview> => {
  const environment = controlPlaneEnvironment();
  if (environment !== 'production') {
    return {
      environment,
      scope: PROMOTION_SCOPE,
      enabled: false,
      disabledReason:
        'promotion_requires_production: production promotion is only available on the production Control Plane',
      candidate: null,
      candidateError: null,
      current: {
        stores: currentSummary([], null),
        panels: currentSummary([], null),
      },
      targets: { stores: [], panels: [] },
      updatesRequired: 0,
      blockers: [],
      warnings: [],
      canPromote: false,
      promotion: null,
    };
  }

  const targetCandidate = await fetchStagingCandidate();
  const candidate = targetCandidate.candidate;
  const current = targetViews(candidate);

  const missing: string[] = [];
  if (!env.githubPromotionToken) missing.push('GITHUB_PROMOTION_TOKEN');
  if (!env.stagingCpUrl) missing.push('STAGING_CP_URL');
  if (!env.stagingReleaseReadToken) missing.push('STAGING_RELEASE_READ_TOKEN');
  const enabled = missing.length === 0;
  const disabledReason = enabled
    ? null
    : `promotion_not_configured: ${missing.join(', ')} must be set on the production Control Plane`;

  const active = await reconcilePromotion();
  const blockers = [...current.blockers];
  if (targetCandidate.error) blockers.push(targetCandidate.error);
  if (current.stores.length + current.panels.length === 0) {
    blockers.push(`no_promotion_targets: no image-mode ${HM_SCOPE_PREFIX}* tenants are registered`);
  }
  const canPromote =
    enabled &&
    input.releaseManager &&
    Boolean(candidate) &&
    current.updatesRequired > 0 &&
    blockers.length === 0 &&
    !active;

  return {
    environment,
    scope: PROMOTION_SCOPE,
    enabled,
    disabledReason,
    candidate,
    candidateError: targetCandidate.error,
    current: {
      stores: currentSummary(current.stores, candidate?.store.digest ?? null),
      panels: currentSummary(current.panels, candidate?.ho.digest ?? null),
    },
    targets: { stores: current.stores, panels: current.panels },
    updatesRequired: current.updatesRequired,
    blockers,
    warnings: current.warnings,
    canPromote,
    promotion: promotionView(active ?? getLatestReleasePromotion()),
  };
};

export interface StartPromotionInput {
  tag: string;
  confirmTag: string;
  actor: string;
  reason?: string | null;
  releaseManager: boolean;
}

/**
 * Approve and dispatch a promotion. Every check that matters runs here, on the
 * server: environment, release-manager role, exact tag confirmation, staging
 * readiness, target schema, duplicate lock, and manifest digests.
 */
export const startPromotion = async (input: StartPromotionInput): Promise<PromotionView> => {
  if (controlPlaneEnvironment() !== 'production') {
    throw new HttpError(
      409,
      'promotion_requires_production: production promotion is only available on the production Control Plane',
      'promotion_requires_production',
    );
  }
  if (!input.releaseManager) {
    throw new HttpError(
      403,
      'promotion_requires_release_manager: release-manager permission is required to promote a production release',
      'promotion_requires_release_manager',
    );
  }
  if (!input.tag || input.tag !== input.confirmTag) {
    throw new HttpError(
      400,
      'promotion_confirmation_required: tag and confirmTag must match exactly',
      'promotion_confirmation_required',
    );
  }
  if (!env.githubPromotionToken) {
    throw new HttpError(
      409,
      'github_dispatch_not_configured: GITHUB_PROMOTION_TOKEN is not set on this Control Plane',
      'github_dispatch_not_configured',
    );
  }

  const fetched = await fetchStagingCandidate();
  const candidate = fetched.candidate;
  if (!candidate) {
    throw new HttpError(
      409,
      fetched.error ??
        'staging_candidate_unavailable: no fully tested staging release is available',
      'staging_candidate_unavailable',
    );
  }
  if (candidate.tag !== input.tag) {
    throw new HttpError(
      409,
      `promotion_candidate_changed: the staging-tested release is ${candidate.tag}, not ${input.tag}`,
      'promotion_candidate_changed',
    );
  }

  const targets = targetViews(candidate);
  if (targets.blockers.length) {
    throw new HttpError(
      409,
      `promotion_blocked: ${targets.blockers.join('; ')}`,
      'promotion_blocked',
    );
  }
  if (targets.stores.length + targets.panels.length === 0) {
    throw new HttpError(
      409,
      `no_promotion_targets: no image-mode ${HM_SCOPE_PREFIX}* tenants are registered`,
      'no_promotion_targets',
    );
  }
  if (targets.updatesRequired === 0) {
    throw new HttpError(
      409,
      'nothing_to_promote: every target already runs the approved digests',
      'nothing_to_promote',
    );
  }

  // Read the manifest before taking the lock: a missing or mismatched release
  // asset can never become an approved in-flight promotion.
  const manifest = await fetchReleaseManifest(candidate.tag);
  const manifestStore = manifest.images.store?.digest;
  const manifestHo = manifest.images.ho?.digest;
  if (manifestStore !== candidate.store.digest || manifestHo !== candidate.ho.digest) {
    throw new HttpError(
      409,
      `promotion_digest_mismatch: the GitHub release manifest does not match the staging-tested digests (staging store ${candidate.store.digest.slice(
        0,
        19,
      )}…, manifest store ${(manifestStore ?? 'none').slice(0, 19)}…)`,
      'promotion_digest_mismatch',
    );
  }

  expireStalePromotions(env.promotionTimeoutMinutes);
  const created = createReleasePromotion({
    tag: candidate.tag,
    commitSha: candidate.commit,
    storeDigest: candidate.store.digest,
    hoDigest: candidate.ho.digest,
    requestedBy: input.actor,
    reason: input.reason ?? null,
  });
  if (!created) {
    throw new HttpError(
      409,
      'promotion_in_progress: another production promotion is already running',
      'promotion_in_progress',
    );
  }

  try {
    const running = await dispatchPromotion(created, manifest);
    return promotionView(running)!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateReleasePromotion(created.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: message,
    });
    throw err;
  }
};

/**
 * Called by the CI callback before any batch starts: the workflow's manifest
 * must carry the exact digests the operator approved.
 */
export const promotionForCi = (
  tag: string,
  storeDigest: string,
  hoDigest: string,
): ReleasePromotion | null => {
  const promotion = getActiveReleasePromotionByTag(tag);
  if (!promotion) return null;
  if (promotion.store_digest !== storeDigest || promotion.ho_digest !== hoDigest) {
    updateReleasePromotion(promotion.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error:
        'promotion_digest_mismatch: the workflow manifest did not match the approved digests; no production change was made',
    });
    throw new HttpError(
      409,
      'promotion_digest_mismatch: the workflow manifest did not match the approved digests',
      'promotion_digest_mismatch',
    );
  }
  return (
    updateReleasePromotion(promotion.id, {
      status: 'running',
      startedAt: promotion.started_at ?? new Date().toISOString(),
    }) ?? promotion
  );
};

export const linkPromotionBatch = (
  promotion: ReleasePromotion | null,
  kind: ReleaseKind,
  batchId: number,
): void => {
  if (!promotion) return;
  updateReleasePromotion(
    promotion.id,
    kind === 'store' ? { storeBatchId: batchId } : { hoBatchId: batchId },
  );
};
