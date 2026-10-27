import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../app.js';
import { env } from '../config/env.js';
import {
  createCompany,
  createPanel,
  createReleasePromotion,
  createStore,
  getLatestReleasePromotion,
  getManagedApplication,
  getRegistryDb,
  registerManagedApplication,
  resetRegistryDb,
  setStoreCompany,
} from '../config/registryDb.js';
import { createImageRelease } from '../services/releaseCatalog.js';
import { assertApplicationAllowed } from '../services/applicationGuard.js';
import {
  clearPromotionCandidateCache,
  promotionPreview,
  startPromotion,
  testedCandidateForStaging,
} from '../services/promotion.js';
import { authHeader, jsonResponse, loginAsOffice } from './helpers.js';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const D = `sha256:${'d'.repeat(64)}`;
const E = `sha256:${'e'.repeat(64)}`;
const F = `sha256:${'f'.repeat(64)}`;
const TAG = 'v2026.10.26-promo';
const STAGING_URL = 'https://staging-cp.test';

const candidate = () => ({
  tag: TAG,
  commit: '1'.repeat(40),
  publishedAt: '2026-10-26 12:00:00',
  store: {
    digest: C,
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
    channel: 'beta',
    releaseId: 1,
    tag: TAG,
    publishedAt: '2026-10-26 12:00:00',
  },
  ho: {
    digest: D,
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
    channel: 'beta',
    releaseId: 2,
    tag: TAG,
    publishedAt: '2026-10-26 12:00:00',
  },
  staging: { stores: 9, panels: 1, verifiedAt: '2026-10-26T12:05:00.000Z' },
});

let calls: Array<{ method: string; url: string; body: string }> = [];
let fetchMock: ReturnType<typeof jest.spyOn>;

const saved = {
  cpEnvironment: env.cpEnvironment,
  isProduction: env.isProduction,
  allowedAppUuids: [...env.allowedAppUuids],
  githubPromotionToken: env.githubPromotionToken,
  githubRepository: env.githubRepository,
  githubPromotionWorkflow: env.githubPromotionWorkflow,
  githubPromotionRef: env.githubPromotionRef,
  stagingCpUrl: env.stagingCpUrl,
  stagingReleaseReadToken: env.stagingReleaseReadToken,
  releaseReadToken: env.releaseReadToken,
  releaseCiToken: env.releaseCiToken,
};

const restoreEnv = () => {
  env.cpEnvironment = saved.cpEnvironment;
  env.isProduction = saved.isProduction;
  env.allowedAppUuids = [...saved.allowedAppUuids];
  env.githubPromotionToken = saved.githubPromotionToken;
  env.githubRepository = saved.githubRepository;
  env.githubPromotionWorkflow = saved.githubPromotionWorkflow;
  env.githubPromotionRef = saved.githubPromotionRef;
  env.stagingCpUrl = saved.stagingCpUrl;
  env.stagingReleaseReadToken = saved.stagingReleaseReadToken;
  env.releaseReadToken = saved.releaseReadToken;
  env.releaseCiToken = saved.releaseCiToken;
};

const makeStore = (input: {
  slug: string;
  digest: string;
  schema?: number;
  lastReleaseId: number;
  paused?: boolean;
  health?: 'up' | 'down' | 'unknown';
}) => {
  const company = createCompany({ name: `Client ${input.slug}`, slug: `client-${input.slug}` });
  const store = createStore(
    {
      name: `Store ${input.slug}`,
      slug: input.slug,
      terminalCount: 1,
      baseUrl: `https://${input.slug}.example`,
    },
    'cp-token',
  );
  setStoreCompany(store.id, company.id);
  getRegistryDb()
    .prepare(
      `UPDATE stores SET company_id = ?, coolify_uuid = ?, deploy_mode = 'image',
         deploy_status = 'deployed', image_digest = ?, image_tag = ?, last_release_id = ?,
         schema_version = ?, release_state = ?, last_health_status = ?, status = ?
       WHERE id = ?`,
    )
    .run(
      company.id,
      `uuid-${input.slug}`,
      input.digest,
      'v-old',
      input.lastReleaseId,
      input.schema ?? 1,
      'healthy',
      input.health ?? 'up',
      input.paused ? 'paused' : 'active',
      store.id,
    );
  return { company, store };
};

const makePanel = (input: {
  slug: string;
  digest: string;
  schema?: number;
  lastReleaseId: number;
}) => {
  const company = createCompany({ name: `Client ${input.slug}`, slug: `client-${input.slug}` });
  const panel = createPanel({
    companyId: company.id,
    slug: input.slug,
    name: `Head Office ${input.slug}`,
    baseUrl: `https://${input.slug}.example`,
    controlPlaneToken: 'ho-token',
  });
  getRegistryDb()
    .prepare(
      `UPDATE panels SET coolify_uuid = ?, deploy_mode = 'image', deploy_status = 'deployed',
         image_digest = ?, image_tag = 'v-old', last_release_id = ?, schema_version = ?,
         release_state = 'healthy', last_health_status = 'up'
       WHERE id = ?`,
    )
    .run(`uuid-${input.slug}`, input.digest, input.lastReleaseId, input.schema ?? 1, panel.id);
  return { company, panel };
};

const seedCandidateReleases = () => {
  const storeRelease = createImageRelease({
    kind: 'store',
    tag: TAG,
    digest: C,
    version: TAG,
    revision: '1'.repeat(40),
    channel: 'beta',
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
  });
  const hoRelease = createImageRelease({
    kind: 'ho',
    tag: TAG,
    digest: D,
    version: TAG,
    revision: '1'.repeat(40),
    channel: 'beta',
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
  });
  return { storeRelease, hoRelease };
};

const configurePromotion = () => {
  env.cpEnvironment = 'production';
  env.githubPromotionToken = 'gh-token';
  env.githubRepository = 'hoosainmadhi/vula-app';
  env.githubPromotionWorkflow = 'promote-production.yml';
  env.githubPromotionRef = 'main';
  env.stagingCpUrl = STAGING_URL;
  env.stagingReleaseReadToken = 'read-token';
};

const mockNetwork = (options: { manifestStoreDigest?: string; manifestHoDigest?: string } = {}) => {
  fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: s, body: String(init?.body ?? '') });
    if (s === `${STAGING_URL}/api/releases/tested-candidate`) {
      const auth = (init?.headers as Record<string, string> | undefined)?.['x-release-read-token'];
      if (auth !== 'read-token') return jsonResponse(401, { error: 'Unauthorized' });
      return jsonResponse(200, candidate());
    }
    if (s.includes('/releases/tags/')) {
      return jsonResponse(200, {
        assets: [
          {
            name: 'release-manifest.json',
            url: 'https://api.github.com/repos/hoosainmadhi/vula-app/releases/assets/1',
          },
        ],
      });
    }
    if (s.endsWith('/releases/assets/1')) {
      return new Response(
        JSON.stringify({
          release: TAG,
          commit: '1'.repeat(40),
          images: {
            store: { digest: options.manifestStoreDigest ?? C },
            ho: { digest: options.manifestHoDigest ?? D },
          },
          schema: {
            store: { schemaVersion: 1, minSchemaVersion: 1, maxSchemaVersion: 1 },
            ho: { schemaVersion: 1, minSchemaVersion: 1, maxSchemaVersion: 1 },
          },
        }),
        { status: 200 },
      );
    }
    if (s.includes('/actions/workflows/') && s.endsWith('/dispatches')) {
      return new Response(null, { status: 204 });
    }
    if (s.includes('/actions/workflows/') && s.includes('/runs')) {
      return jsonResponse(200, {
        workflow_runs: [
          {
            id: 77,
            html_url: 'https://github.com/hoosainmadhi/vula-app/actions/runs/77',
            status: 'in_progress',
            conclusion: null,
            head_branch: 'main',
            created_at: new Date().toISOString(),
          },
        ],
      });
    }
    return jsonResponse(200, { ok: true });
  });
};

beforeEach(() => {
  resetRegistryDb();
  calls = [];
  clearPromotionCandidateCache();
  restoreEnv();
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
  restoreEnv();
  clearPromotionCandidateCache();
});

describe('staging tested candidate', () => {
  it('returns the newest tag only when every demo tenant runs it healthily', () => {
    const { storeRelease, hoRelease } = seedCandidateReleases();
    makeStore({ slug: 'demo-one', digest: C, lastReleaseId: storeRelease.id });
    makeStore({ slug: 'demo-two', digest: C, lastReleaseId: storeRelease.id });
    makePanel({ slug: 'demo-ho', digest: D, lastReleaseId: hoRelease.id });

    const result = testedCandidateForStaging();
    expect(result.tag).toBe(TAG);
    expect(result.store.digest).toBe(C);
    expect(result.ho.digest).toBe(D);
    expect(result.staging.stores).toBe(2);
    expect(result.staging.panels).toBe(1);
  });

  it('refuses to skip a half-rolled-out newest tag in favour of an older one', () => {
    const { storeRelease, hoRelease } = seedCandidateReleases();
    const olderStore = createImageRelease({
      kind: 'store',
      tag: 'v-older',
      digest: A,
      version: 'v-older',
      channel: 'beta',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    const olderHo = createImageRelease({
      kind: 'ho',
      tag: 'v-older',
      digest: B,
      version: 'v-older',
      channel: 'beta',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    makeStore({ slug: 'demo-one', digest: C, lastReleaseId: storeRelease.id });
    makeStore({ slug: 'demo-two', digest: A, lastReleaseId: olderStore.id });
    makePanel({ slug: 'demo-ho', digest: B, lastReleaseId: olderHo.id });
    expect(olderHo.id).toBeGreaterThan(0);

    expect(() => testedCandidateForStaging()).toThrow(/staging_not_fully_deployed/);
  });

  it('serves the candidate only to a caller with the read token', async () => {
    const app = createApp();
    const { storeRelease, hoRelease } = seedCandidateReleases();
    makeStore({ slug: 'demo-one', digest: C, lastReleaseId: storeRelease.id });
    makePanel({ slug: 'demo-ho', digest: D, lastReleaseId: hoRelease.id });
    env.releaseReadToken = 'read-token';

    await request(app).get('/api/releases/tested-candidate').expect(401);
    const ok = await request(app)
      .get('/api/releases/tested-candidate')
      .set('x-release-read-token', 'read-token')
      .expect(200);
    expect(ok.body.tag).toBe(TAG);
  });
});

describe('production promotion preview', () => {
  it('shows the candidate, the current fleet, update count and blockers', async () => {
    configurePromotion();
    seedCandidateReleases();
    const olderStore = createImageRelease({
      kind: 'store',
      tag: 'v-old',
      digest: A,
      version: 'v-old',
      channel: 'stable',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    const olderHo = createImageRelease({
      kind: 'ho',
      tag: 'v-old',
      digest: B,
      version: 'v-old',
      channel: 'stable',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    makeStore({ slug: 'hm-stores-jhb', digest: A, lastReleaseId: olderStore.id });
    makeStore({ slug: 'hm-stores-cpt', digest: A, lastReleaseId: olderStore.id, schema: 5 });
    makePanel({ slug: 'hm-stores-ho', digest: B, lastReleaseId: olderHo.id });
    mockNetwork();

    const preview = await promotionPreview({ releaseManager: true });
    expect(preview.environment).toBe('production');
    expect(preview.candidate?.tag).toBe(TAG);
    expect(preview.targets.stores).toHaveLength(2);
    expect(preview.targets.panels).toHaveLength(1);
    expect(preview.updatesRequired).toBe(3);
    expect(preview.current.stores.tag).toBe('v-old');
    expect(preview.current.stores.healthy).toBe(2);
    expect(preview.blockers.join(' ')).toMatch(/schema_incompatible/);
    expect(preview.canPromote).toBe(false);
  });

  it('is read-only outside production', async () => {
    env.cpEnvironment = 'staging';
    const preview = await promotionPreview({ releaseManager: true });
    expect(preview.environment).toBe('staging');
    expect(preview.enabled).toBe(false);
    expect(preview.canPromote).toBe(false);
  });
});

describe('production promotion start', () => {
  const seedTargets = () => {
    const { storeRelease, hoRelease } = seedCandidateReleases();
    const olderStore = createImageRelease({
      kind: 'store',
      tag: 'v-old',
      digest: A,
      version: 'v-old',
      channel: 'stable',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    const olderHo = createImageRelease({
      kind: 'ho',
      tag: 'v-old',
      digest: B,
      version: 'v-old',
      channel: 'stable',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    const jhb = makeStore({ slug: 'hm-stores-jhb', digest: A, lastReleaseId: olderStore.id });
    const cpt = makeStore({ slug: 'hm-stores-cpt', digest: A, lastReleaseId: olderStore.id });
    const ho = makePanel({ slug: 'hm-stores-ho', digest: B, lastReleaseId: olderHo.id });
    return { storeRelease, hoRelease, olderStore, olderHo, jhb, cpt, ho };
  };

  it('requires the release-manager role and the exact confirmation tag', async () => {
    configurePromotion();
    seedTargets();
    mockNetwork();
    await expect(
      startPromotion({
        tag: TAG,
        confirmTag: TAG,
        actor: 'viewer@test.local',
        releaseManager: false,
      }),
    ).rejects.toThrow(/promotion_requires_release_manager/);
    await expect(
      startPromotion({
        tag: TAG,
        confirmTag: 'other',
        actor: 'office@test.local',
        releaseManager: true,
      }),
    ).rejects.toThrow(/promotion_confirmation_required/);
  });

  it('refuses when the GitHub manifest does not carry the approved digests', async () => {
    configurePromotion();
    seedTargets();
    mockNetwork({ manifestStoreDigest: E });
    await expect(
      startPromotion({
        tag: TAG,
        confirmTag: TAG,
        actor: 'office@test.local',
        releaseManager: true,
      }),
    ).rejects.toThrow(/promotion_digest_mismatch/);
    expect(calls.some((call) => call.url.endsWith('/dispatches'))).toBe(false);
    expect(getLatestReleasePromotion()).toBeNull();
  });

  it('dispatches the existing workflow and records the run', async () => {
    configurePromotion();
    seedTargets();
    mockNetwork();
    const promotion = await startPromotion({
      tag: TAG,
      confirmTag: TAG,
      actor: 'office@test.local',
      releaseManager: true,
    });
    expect(promotion.status).toBe('running');
    expect(promotion.tag).toBe(TAG);
    expect(promotion.githubRunUrl).toContain('/actions/runs/77');
    const dispatch = calls.find((call) => call.url.endsWith('/dispatches'));
    expect(dispatch).toBeDefined();
    expect(JSON.parse(dispatch!.body)).toEqual({
      ref: 'main',
      inputs: { release_tag: TAG, confirm_release_tag: TAG },
    });
  });

  it('refuses a second promotion while one is in flight', async () => {
    configurePromotion();
    seedTargets();
    mockNetwork();
    createReleasePromotion({
      tag: 'v-earlier',
      commitSha: '2'.repeat(40),
      storeDigest: E,
      hoDigest: F,
      requestedBy: 'office@test.local',
    });
    await expect(
      startPromotion({
        tag: TAG,
        confirmTag: TAG,
        actor: 'office@test.local',
        releaseManager: true,
      }),
    ).rejects.toThrow(/promotion_in_progress/);
  });

  it('refuses a manual CI release while a different promotion is in flight', async () => {
    configurePromotion();
    createReleasePromotion({
      tag: 'v-other',
      commitSha: '2'.repeat(40),
      storeDigest: E,
      hoDigest: F,
      requestedBy: 'office@test.local',
    });
    env.releaseCiToken = 'ci-token';
    const app = createApp();
    await request(app)
      .post('/api/releases/ci')
      .set('x-release-ci-token', 'ci-token')
      .send({
        scope: 'production-hm-stores',
        manifest: {
          release: TAG,
          commit: '1'.repeat(40),
          images: { store: { digest: C }, ho: { digest: D } },
          schema: {
            store: { schemaVersion: 1, minSchemaVersion: 1, maxSchemaVersion: 1 },
            ho: { schemaVersion: 1, minSchemaVersion: 1, maxSchemaVersion: 1 },
          },
        },
      })
      .expect(409);
  });

  it('links the CI callback batches and completes the promotion', async () => {
    configurePromotion();
    const { storeRelease, hoRelease } = seedCandidateReleases();
    // The production targets already run the approved digests, so the apply
    // path is an idempotent skip and the test never calls Coolify.
    const jhb = makeStore({ slug: 'hm-stores-jhb', digest: C, lastReleaseId: storeRelease.id });
    const ho = makePanel({ slug: 'hm-stores-ho', digest: D, lastReleaseId: hoRelease.id });
    const promotion = createReleasePromotion({
      tag: TAG,
      commitSha: '1'.repeat(40),
      storeDigest: C,
      hoDigest: D,
      requestedBy: 'office@test.local',
    })!;
    env.releaseCiToken = 'ci-token';
    const app = createApp();

    const res = await request(app)
      .post('/api/releases/ci')
      .set('x-release-ci-token', 'ci-token')
      .send({
        scope: 'production-hm-stores',
        manifest: {
          release: TAG,
          commit: '1'.repeat(40),
          images: { store: { digest: C }, ho: { digest: D } },
          schema: {
            store: { schemaVersion: 1, minSchemaVersion: 1, maxSchemaVersion: 1 },
            ho: { schemaVersion: 1, minSchemaVersion: 1, maxSchemaVersion: 1 },
          },
        },
      })
      .expect(200);

    const completed = getLatestReleasePromotion()!;
    expect(completed.id).toBe(promotion.id);
    expect(completed.status).toBe('complete');
    expect(completed.store_batch_id).toBeGreaterThan(0);
    expect(completed.ho_batch_id).toBeGreaterThan(0);
    expect(res.body.ok).toBe(true);
    // The idempotent targets were skipped, never deployed.
    const ids = (res.body.batches as Array<{ items: Array<{ tenant_id: number }> }>).flatMap(
      (batch) => batch.items.map((item) => item.tenant_id),
    );
    expect(ids).toContain(jhb.store.id);
    expect(ids).toContain(ho.panel.id);
  });
});

describe('CP-managed application boundary', () => {
  it('accepts a verified managed UUID without a static allowlist, but not a renamed app', () => {
    env.isProduction = true;
    env.allowedAppUuids = [];
    registerManagedApplication({
      kind: 'store',
      coolifyUuid: 'managed-uuid',
      name: 'za-pos-managed',
      projectUuid: 'proj',
      serverUuid: 'srv',
      domain: 'https://managed.example',
      volumeName: 'vol',
    });
    expect(getManagedApplication('store', 'managed-uuid')).not.toBeNull();
    expect(() =>
      assertApplicationAllowed('store', {
        uuid: 'managed-uuid',
        name: 'za-pos-managed',
        build_pack: 'dockerimage',
        project_uuid: 'proj',
      }),
    ).not.toThrow();
    expect(() =>
      assertApplicationAllowed('store', {
        uuid: 'managed-uuid',
        name: 'za-pos-someone-else',
        build_pack: 'dockerimage',
        project_uuid: 'proj',
      }),
    ).toThrow(/application_identity_mismatch/);
    expect(() =>
      assertApplicationAllowed('store', {
        uuid: 'unknown-uuid',
        name: 'za-pos-managed',
        build_pack: 'dockerimage',
      }),
    ).toThrow(/application_allowlist_missing/);
  });

  it('refuses a managed app that moved to another project', () => {
    env.isProduction = false;
    env.allowedAppUuids = [];
    registerManagedApplication({
      kind: 'ho',
      coolifyUuid: 'managed-ho',
      name: 'vula-managed',
      projectUuid: 'proj',
      serverUuid: 'srv',
      domain: 'https://managed-ho.example',
    });
    expect(() =>
      assertApplicationAllowed('ho', {
        uuid: 'managed-ho',
        name: 'vula-managed',
        build_pack: 'dockerimage',
        project_uuid: 'other',
      }),
    ).toThrow(/application_project_mismatch/);
  });
});
