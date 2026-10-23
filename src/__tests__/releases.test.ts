import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../app.js';
import {
  createCompany,
  createStore,
  getRegistryDb,
  getStoreById,
  resetRegistryDb,
  setStoreCompany,
} from '../config/registryDb.js';
import {
  acquireDeploymentLock,
  createImageRelease,
  listReleaseDeployments,
} from '../services/releaseCatalog.js';
import {
  applyReleaseToTenant,
  rollbackTenant,
  startReleaseBatch,
} from '../services/releaseOrchestrator.js';
import { runStoreProvisioning } from '../services/storeProvisioning.js';
import { env } from '../config/env.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

const COOLIFY = 'http://coolify.test';
const OLD_DIGEST = `sha256:${'0'.repeat(64)}`;
const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const C = `sha256:${'c'.repeat(64)}`;
const D = `sha256:${'d'.repeat(64)}`;

let calls: Array<{ method: string; url: string; body: string }> = [];
let fetchMock: ReturnType<typeof jest.spyOn>;
let stopped = false;
let healthVersion = '1.0.0';
let deploymentStatus = 'finished';
let deploymentStatuses: string[] = [];
let patchFailureStatus: number | null = null;
let createFailureStatus: number | null = null;
let deployFailureStatus: number | null = null;
let missingStorage = false;
let storeStatusName: string | null = null;
let activeAppDeployment = false;
let createdAppName = 'za-pos-test';
let createdAppFqdn = 'https://test.example';

const configureCoolify = (): void => {
  process.env.COOLIFY_API_URL = COOLIFY;
  process.env.COOLIFY_API_TOKEN = 'coolify-token';
  process.env.COOLIFY_PROJECT_UUID = 'proj';
  process.env.COOLIFY_SERVER_UUID = 'srv';
  process.env.COOLIFY_GITHUB_APP_UUID = 'app';
};

const clearCoolify = (): void => {
  for (const key of [
    'COOLIFY_API_URL',
    'COOLIFY_API_TOKEN',
    'COOLIFY_PROJECT_UUID',
    'COOLIFY_SERVER_UUID',
    'COOLIFY_GITHUB_APP_UUID',
  ]) {
    delete process.env[key];
  }
};

const seedStore = (
  over: {
    slug?: string;
    coolifyUuid?: string | null;
    schema?: number | null;
    baseUrl?: string;
  } = {},
) => {
  const company = createCompany({
    name: `Client ${over.slug ?? 'a'}`,
    slug: `client-${over.slug ?? 'a'}`,
  });
  const store = createStore(
    {
      name: `Store ${over.slug ?? 'a'}`,
      slug: over.slug ?? 'store-a',
      terminalCount: 1,
      baseUrl: over.baseUrl ?? `https://${over.slug ?? 'store-a'}.example`,
    },
    'cp-token',
  );
  setStoreCompany(store.id, company.id);
  getRegistryDb()
    .prepare(
      `UPDATE stores SET coolify_uuid = ?, schema_version = ?, image_digest = ?, image_tag = 'old',
         last_release_id = ?, deploy_status = 'deployed' WHERE id = ?`,
    )
    .run(
      over.coolifyUuid === undefined ? `uuid-${over.slug ?? 'store-a'}` : over.coolifyUuid,
      over.schema === undefined ? 1 : over.schema,
      OLD_DIGEST,
      1,
      store.id,
    );
  return getStoreById(store.id)!;
};

const release = (
  over: Partial<{
    kind: 'store' | 'ho';
    tag: string;
    digest: string;
    version: string;
    channel: 'stable' | 'beta' | 'canary';
    schemaVersion: number;
    schemaMin: number;
    schemaMax: number;
  }> = {},
) =>
  createImageRelease({
    kind: 'store',
    tag: 'v1',
    digest: A,
    version: '1.0.0',
    channel: 'stable',
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
    ...over,
  });

beforeEach(() => {
  resetRegistryDb();
  // Keep the release suite deterministic even when a previous suite left the
  // singleton open with a file-backed registry in this worker.
  getRegistryDb().exec(
    'DELETE FROM release_batch_items; DELETE FROM release_deployments; DELETE FROM release_batches; DELETE FROM deployment_locks; DELETE FROM image_releases;',
  );
  getRegistryDb().exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS test_image_releases_kind_tag ON image_releases(kind, tag); CREATE UNIQUE INDEX IF NOT EXISTS test_image_releases_kind_digest ON image_releases(kind, digest);',
  );
  configureCoolify();
  calls = [];
  stopped = false;
  healthVersion = '1.0.0';
  deploymentStatus = 'finished';
  deploymentStatuses = [];
  patchFailureStatus = null;
  createFailureStatus = null;
  deployFailureStatus = null;
  missingStorage = false;
  storeStatusName = null;
  activeAppDeployment = false;
  createdAppName = 'za-pos-test';
  createdAppFqdn = 'https://test.example';
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: s, body: String(init?.body ?? '') });
    if (s.startsWith(COOLIFY)) {
      if (s.endsWith('/applications/dockerimage')) {
        if (createFailureStatus) {
          return jsonResponse(createFailureStatus, { message: 'image not found or unauthorized' });
        }
        return jsonResponse(201, { uuid: `new-${calls.length}` });
      }
      if (s.includes('/envs/bulk')) return jsonResponse(201, { ok: true });
      if (s.endsWith('/storages') && method === 'GET') {
        return jsonResponse(200, {
          persistent_storages: missingStorage ? [] : [{ mount_path: '/data', name: 'test-volume' }],
          file_storages: [],
        });
      }
      if (s.includes('/storages')) return jsonResponse(201, { ok: true });
      if (s.includes('/stop')) {
        stopped = true;
        return jsonResponse(200, { ok: true });
      }
      if (s.includes('/deployments/applications/')) {
        return jsonResponse(
          200,
          activeAppDeployment ? [{ deployment_uuid: 'active', status: 'in_progress' }] : [],
        );
      }
      if (s.includes('/deployments/')) {
        return jsonResponse(200, {
          deployment_uuid: s.split('/').pop(),
          status: deploymentStatuses.length ? deploymentStatuses.shift()! : deploymentStatus,
        });
      }
      if (s.includes('/deploy')) {
        if (deployFailureStatus) {
          return jsonResponse(deployFailureStatus, { message: 'deploy trigger failed' });
        }
        stopped = false;
        return jsonResponse(200, {
          deployments: [{ deployment_uuid: `dep-${calls.length}` }],
        });
      }
      if (method === 'GET' && /\/applications\/[^/]+$/.test(s)) {
        return jsonResponse(200, {
          uuid: s.split('/').pop(),
          name: createdAppName,
          fqdn: createdAppFqdn,
          status: stopped ? 'exited' : 'running:healthy',
          build_pack: 'dockerimage',
          docker_registry_image_name: 'ghcr.io/hoosainmadhi/vula-pos-store',
          docker_registry_image_tag: 'old',
        });
      }
      if (method === 'PATCH' && /\/applications\/[^/]+$/.test(s) && patchFailureStatus) {
        return jsonResponse(patchFailureStatus, { message: 'Unauthenticated.' });
      }
      return jsonResponse(200, { ok: true });
    }
    if (s.endsWith('/api/internal/status')) {
      return jsonResponse(200, {
        ok: true,
        ...(storeStatusName ? { storeName: storeStatusName } : {}),
      });
    }
    if (s.endsWith('/health')) {
      return jsonResponse(200, {
        status: 'ok',
        app: 'vula',
        version: healthVersion,
      });
    }
    return jsonResponse(200, {});
  });
});

afterEach(() => {
  fetchMock?.mockRestore();
  clearCoolify();
});

describe('shared-image release catalog', () => {
  it('validates digest, channel and schema range', () => {
    expect(() => release({ digest: 'sha256:not-a-digest' })).toThrow(/digest/i);
    expect(() => release({ channel: 'nightly' as never })).toThrow(/channel/i);
    expect(() => release({ schemaVersion: 2, schemaMin: 1, schemaMax: 1 })).toThrow(
      /schema_version/i,
    );
  });

  it('rejects a duplicate kind+tag/digest', () => {
    release();
    expect(() => release({ digest: B })).toThrow(/already exists/i);
    expect(() => release({ tag: 'v2' })).toThrow(/already exists/i);
  });
});

describe('per-tenant release application', () => {
  it('pins an existing dockerimage app to the release digest and records the transition', async () => {
    const store = seedStore({ slug: 'upgrade' });
    const rel = release();
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });

    expect(result.status).toBe('complete');
    expect(result.fromDigest).toBe(OLD_DIGEST);
    expect(result.toDigest).toBe(A);
    expect(calls.some((c) => c.method === 'PATCH' && c.url.includes(store.coolify_uuid!))).toBe(
      true,
    );
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/deploy'))).toBe(true);

    const updated = getStoreById(store.id)!;
    expect(updated.image_digest).toBe(A);
    expect(updated.image_tag).toBe('v1');
    expect(updated.last_release_id).toBe(rel.id);
    expect(updated.previous_release_id).toBe(1);
    expect(updated.deploy_status).toBe('deployed');
    expect(updated.schema_version).toBe(1);
    expect(listReleaseDeployments('store', store.id)[0].status).toBe('complete');
  });

  it('is idempotent when the tenant already runs the exact digest', async () => {
    const store = seedStore({ slug: 'current' });
    const rel = release();
    getRegistryDb()
      .prepare("UPDATE stores SET image_digest = ?, deploy_status = 'deployed' WHERE id = ?")
      .run(A, store.id);
    calls = [];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/already_current/);
    expect(calls).toHaveLength(0);
  });

  it('does not race a tenant that already holds a deployment lock', async () => {
    const store = seedStore({ slug: 'locked' });
    const rel = release();
    expect(acquireDeploymentLock('store', store.id)).not.toBeNull();
    calls = [];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/locked/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a schema-incompatible image before calling Coolify', async () => {
    const store = seedStore({ slug: 'schema', schema: 2 });
    const rel = release();
    calls = [];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/schema_incompatible/);
    expect(calls).toHaveLength(0);
    expect(getStoreById(store.id)!.image_digest).toBe(OLD_DIGEST);
  });

  it('refuses a second provisioning of a tenant that already has an application', async () => {
    const store = seedStore({ slug: 'already-provisioned' });
    const rel = release();
    calls = [];
    await expect(
      applyReleaseToTenant('store', store.id, rel.id, {
        actor: 'office@test.local',
        action: 'provision',
      }),
    ).rejects.toThrow(/already has a Coolify application/i);
    expect(calls).toHaveLength(0);
  });

  it('provisions a new tenant from the GHCR digest with its own volume and credentials', async () => {
    const store = seedStore({ slug: 'new-store', coolifyUuid: null, schema: null });
    getRegistryDb()
      .prepare(
        'UPDATE stores SET image_digest = NULL, image_tag = NULL, last_release_id = NULL WHERE id = ?',
      )
      .run(store.id);
    const rel = release({ tag: 'v-new', digest: C });
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('complete');
    expect(calls.some((c) => c.url.endsWith('/applications/dockerimage'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/envs/bulk'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/storages'))).toBe(true);
    const updated = getStoreById(store.id)!;
    expect(updated.coolify_uuid).toMatch(/^new-/);
    expect(updated.volume_name).toBe('vula-store-new-store-sqlite-db');
    expect(updated.image_digest).toBe(C);
    expect(updated.schema_version).toBe(1);
    expect(updated.deploy_status).toBe('deployed');
  });

  it('pins staging creation to the approved destination and verifies the created app', async () => {
    const oldStaging = {
      mode: env.stagingMode,
      project: env.stagingProjectUuid,
      server: env.stagingServerUuid,
      destination: env.stagingDestinationUuid,
      prefixes: [...env.stagingAppPrefixes],
      domainPrefix: env.stagingDomainPrefix,
      domainSuffix: env.stagingDomainSuffix,
    };
    const oldDestination = process.env.COOLIFY_DESTINATION_UUID;
    const oldAllowed = [...env.allowedAppUuids];
    env.stagingMode = true;
    env.stagingProjectUuid = 'proj';
    env.stagingServerUuid = 'srv';
    env.stagingDestinationUuid = 'dest-m4';
    env.stagingAppPrefixes = ['za-pos-m4-', 'vula-m4-'];
    env.stagingDomainPrefix = 'm4-';
    env.stagingDomainSuffix = '.vula-app.co.za';
    env.allowedAppUuids = [];
    process.env.COOLIFY_DESTINATION_UUID = 'dest-m4';
    createdAppName = 'za-pos-m4-store-a';
    createdAppFqdn = 'https://m4-store-a.vula-app.co.za';
    try {
      const store = seedStore({
        slug: 'm4-store-a',
        coolifyUuid: null,
        schema: null,
        baseUrl: 'https://m4-store-a.vula-app.co.za',
      });
      getRegistryDb()
        .prepare(
          'UPDATE stores SET image_digest = NULL, image_tag = NULL, last_release_id = NULL WHERE id = ?',
        )
        .run(store.id);
      const rel = release({ tag: 'v-stage', digest: C });
      expect(env.allowedAppUuids).toEqual([]);
      const result = await applyReleaseToTenant('store', store.id, rel.id, {
        actor: 'office@test.local',
        action: 'provision',
        healthTimeoutMs: 100,
        healthIntervalMs: 5,
      });

      expect(result.status).toBe('complete');
      const create = calls.find((c) => c.url.endsWith('/applications/dockerimage'));
      expect(create).toBeDefined();
      const body = JSON.parse(create!.body) as Record<string, unknown>;
      expect(body.name).toBe('za-pos-m4-store-a');
      expect(body.destination_uuid).toBe('dest-m4');
      expect(body.project_uuid).toBe('proj');
      expect(body.server_uuid).toBe('srv');
      expect(getStoreById(store.id)!.coolify_uuid).toMatch(/^new-/);
    } finally {
      env.stagingMode = oldStaging.mode;
      env.stagingProjectUuid = oldStaging.project;
      env.stagingServerUuid = oldStaging.server;
      env.stagingDestinationUuid = oldStaging.destination;
      env.stagingAppPrefixes = [...oldStaging.prefixes];
      env.stagingDomainPrefix = oldStaging.domainPrefix;
      env.stagingDomainSuffix = oldStaging.domainSuffix;
      env.allowedAppUuids = [...oldAllowed];
      if (oldDestination === undefined) delete process.env.COOLIFY_DESTINATION_UUID;
      else process.env.COOLIFY_DESTINATION_UUID = oldDestination;
    }
  });

  it('rolls back to the previous release only when the target schema is compatible', async () => {
    const store = seedStore({ slug: 'rollback' });
    const first = release({ tag: 'v1', digest: A });
    const second = release({ tag: 'v2', digest: B });
    getRegistryDb()
      .prepare(
        "UPDATE stores SET image_digest = ?, image_tag = 'v2', last_release_id = ?, previous_release_id = ?, schema_version = 1 WHERE id = ?",
      )
      .run(B, second.id, first.id, store.id);
    calls = [];
    const result = await rollbackTenant('store', store.id, 'office@test.local');
    expect(result.status).toBe('complete');
    expect(result.toDigest).toBe(A);
    const updated = getStoreById(store.id)!;
    expect(updated.image_digest).toBe(A);
    expect(updated.last_release_id).toBe(first.id);
    expect(updated.previous_release_id).toBe(second.id);
  });

  it('refuses a rollback whose target cannot open the current schema', async () => {
    const store = seedStore({ slug: 'rollback-schema' });
    const older = release({ tag: 'v0', digest: A, schemaVersion: 0, schemaMin: 0, schemaMax: 0 });
    getRegistryDb()
      .prepare(
        'UPDATE stores SET schema_version = 1, last_release_id = ?, previous_release_id = ? WHERE id = ?',
      )
      .run(older.id + 1, older.id, store.id);
    calls = [];
    const result = await rollbackTenant('store', store.id, 'office@test.local');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/schema_incompatible/);
    expect(calls).toHaveLength(0);
  });

  it('does not mark a deployment healthy when Coolify reports the deployment failed', async () => {
    const store = seedStore({ slug: 'deploy-failed' });
    const rel = release({ tag: 'deploy-failed', digest: B });
    deploymentStatus = 'failed';
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/coolify_deployment_failed/);
    const updated = getStoreById(store.id)!;
    expect(updated.image_digest).toBe(OLD_DIGEST);
    expect(updated.deploy_status).toBe('failed');
    expect(updated.release_state).toBe('failed');
  });

  it('does not accept an old healthy container when the new image version is not reported', async () => {
    const store = seedStore({ slug: 'version-mismatch' });
    const rel = release({ tag: 'version-mismatch', digest: B });
    healthVersion = '0.9.0';
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/health_timeout_or_version_mismatch/);
    expect(getStoreById(store.id)!.image_digest).toBe(OLD_DIGEST);
  });

  it('refuses an image change when the tenant has no /data storage', async () => {
    const store = seedStore({ slug: 'no-storage' });
    const rel = release({ tag: 'no-storage', digest: B });
    missingStorage = true;
    calls = [];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/missing_tenant_storage/);
    expect(calls.some((c) => c.url.includes('/stop'))).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH' && !c.url.includes('/envs/bulk'))).toBe(false);
  });

  it('refuses an image change when the tenant identity does not match', async () => {
    const store = seedStore({ slug: 'identity-mismatch' });
    const rel = release({ tag: 'identity', digest: B });
    storeStatusName = 'A Different Store';
    calls = [];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/tenant_identity_mismatch/);
    expect(calls.some((c) => c.url.includes('/stop'))).toBe(false);
  });

  it('enforces the Vula application allowlist, including the production-empty case', async () => {
    const store = seedStore({ slug: 'allowlist' });
    const rel = release({ tag: 'allowlist', digest: B });
    const oldProduction = env.isProduction;
    const oldAllowed = [...env.allowedAppUuids];
    try {
      env.isProduction = false;
      env.allowedAppUuids = ['another-app'];
      calls = [];
      const disallowed = await applyReleaseToTenant('store', store.id, rel.id, {
        actor: 'office@test.local',
        healthTimeoutMs: 100,
        healthIntervalMs: 5,
      });
      expect(disallowed.status).toBe('failed');
      expect(disallowed.error).toMatch(/application_not_allowlisted/);
      expect(calls.some((c) => c.url.includes('/stop'))).toBe(false);

      env.isProduction = true;
      env.allowedAppUuids = [];
      const missing = await applyReleaseToTenant('store', store.id, rel.id, {
        actor: 'office@test.local',
        healthTimeoutMs: 100,
        healthIntervalMs: 5,
      });
      expect(missing.status).toBe('failed');
      expect(missing.error).toMatch(/application_allowlist_missing/);
    } finally {
      env.isProduction = oldProduction;
      env.allowedAppUuids = oldAllowed;
    }
  });

  it('stops the old container before patching the image and deploying', async () => {
    const store = seedStore({ slug: 'stop-first' });
    const rel = release({ tag: 'stop-first', digest: B });
    calls = [];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('complete');
    const stopIndex = calls.findIndex((c) => c.url.includes('/stop'));
    const patchIndex = calls.findIndex(
      (c) => c.method === 'PATCH' && !c.url.includes('/envs/bulk'),
    );
    const deployIndex = calls.findIndex((c) => c.method === 'POST' && c.url.includes('/deploy'));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeGreaterThan(stopIndex);
    expect(deployIndex).toBeGreaterThan(patchIndex);
  });

  it('serialises two simultaneous applications of the same release', async () => {
    const store = seedStore({ slug: 'concurrent-release' });
    const rel = release({ tag: 'concurrent-release', digest: B });
    calls = [];
    const [a, b] = await Promise.all([
      applyReleaseToTenant('store', store.id, rel.id, {
        actor: 'office@test.local',
        healthTimeoutMs: 100,
        healthIntervalMs: 5,
      }),
      applyReleaseToTenant('store', store.id, rel.id, {
        actor: 'office@test.local',
        healthTimeoutMs: 100,
        healthIntervalMs: 5,
      }),
    ]);
    expect(a.status).toBe('complete');
    expect(b.status).toBe('skipped');
    expect(b.reason).toMatch(/locked|already_current/);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/deploy')).length).toBe(1);
    expect(getStoreById(store.id)!.image_digest).toBe(B);
  });

  it('takes over an expired lock but blocks while a Coolify deployment is active', async () => {
    const expired = seedStore({ slug: 'expired-lock' });
    const active = seedStore({ slug: 'active-deployment' });
    const rel = release({ tag: 'locks', digest: B });
    getRegistryDb()
      .prepare(
        `INSERT INTO deployment_locks
           (tenant_type, tenant_id, lock_token, expires_at)
         VALUES ('store', ?, 'expired', datetime('now', '-1 minute'))`,
      )
      .run(expired.id);
    const expiredResult = await applyReleaseToTenant('store', expired.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(expiredResult.status).toBe('complete');

    getRegistryDb()
      .prepare(
        `INSERT INTO release_deployments
           (tenant_type, tenant_id, release_id, action, status, phase)
         VALUES ('store', ?, ?, 'upgrade', 'running', 'deploying')`,
      )
      .run(active.id, rel.id);
    activeAppDeployment = true;
    calls = [];
    const activeResult = await applyReleaseToTenant('store', active.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(activeResult.status).toBe('failed');
    expect(activeResult.error).toMatch(/deployment_in_progress/);
    expect(calls.some((c) => c.url.includes('/stop'))).toBe(false);
  });

  it('waits through queued/deploying Coolify states before declaring success', async () => {
    const store = seedStore({ slug: 'delayed-deploy' });
    const rel = release({ tag: 'delayed', digest: B });
    deploymentStatuses = ['queued', 'in_progress', 'finished'];
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 200,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('complete');
    expect(getStoreById(store.id)!.image_digest).toBe(B);
    expect(
      calls.filter((c) => c.method === 'GET' && c.url.includes('/deployments/')).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('fails closed when the Coolify deployment never reaches a terminal state', async () => {
    const store = seedStore({ slug: 'deploy-timeout' });
    const rel = release({ tag: 'timeout', digest: B });
    deploymentStatus = 'in_progress';
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 60,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/coolify_deployment_timeout/);
    expect(getStoreById(store.id)!.image_digest).toBe(OLD_DIGEST);
  });

  it('records a registry authentication/missing-image failure without changing the tenant', async () => {
    const store = seedStore({ slug: 'registry-fail' });
    const rel = release({ tag: 'registry-fail', digest: B });
    patchFailureStatus = 401;
    const result = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/401|Unauthenticated|failed/i);
    expect(getStoreById(store.id)!.image_digest).toBe(OLD_DIGEST);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/deploy'))).toBe(false);
  });

  it('persists the new application before triggering, so a trigger failure cannot create a duplicate app', async () => {
    const store = seedStore({ slug: 'trigger-failure', coolifyUuid: null, schema: null });
    getRegistryDb()
      .prepare(
        'UPDATE stores SET image_digest = NULL, image_tag = NULL, last_release_id = NULL WHERE id = ?',
      )
      .run(store.id);
    const rel = release({ tag: 'trigger-failure', digest: C });
    deployFailureStatus = 500;
    calls = [];
    const failed = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(failed.status).toBe('failed');
    const afterFailure = getStoreById(store.id)!;
    expect(afterFailure.coolify_uuid).toMatch(/^new-/);
    expect(calls.filter((c) => c.url.endsWith('/applications/dockerimage'))).toHaveLength(1);

    deployFailureStatus = null;
    const retry = await applyReleaseToTenant('store', store.id, rel.id, {
      actor: 'office@test.local',
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(`${retry.status}: ${retry.error ?? 'no error'}`).toBe('complete: no error');
    expect(calls.filter((c) => c.url.endsWith('/applications/dockerimage'))).toHaveLength(1);
  });

  it('fails a new production tenant when no approved stable release exists', async () => {
    const store = createStore(
      {
        name: 'Production New',
        slug: 'production-new',
        terminalCount: 1,
        baseUrl: 'https://production-new.example',
        environment: 'production',
      },
      'cp-token',
    );
    calls = [];
    await runStoreProvisioning(store.id);
    expect(getStoreById(store.id)!.deploy_status).toBe('failed');
    expect(calls.some((c) => c.url.includes('/applications/private-github-app'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/applications/dockerimage'))).toBe(false);
  });
});

describe('release waves', () => {
  it('plans waves without calling Coolify on a dry run', async () => {
    const a = seedStore({ slug: 'wave-a' });
    seedStore({ slug: 'wave-b' });
    seedStore({ slug: 'wave-c' });
    const rel = release({ tag: 'wave', digest: B });
    calls = [];
    const result = await startReleaseBatch({
      releaseId: rel.id,
      actor: 'office@test.local',
      tenantIds: [a.id],
      waveSize: 2,
      dryRun: true,
    });
    expect(result.batch.status).toBe('dry_run');
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('stops subsequent waves after a failed pilot wave', async () => {
    const a = seedStore({ slug: 'wave-fail-a' });
    const b = seedStore({ slug: 'wave-fail-b' });
    const rel = release({ tag: 'wave-fail', digest: B });
    deploymentStatus = 'failed';
    calls = [];
    const result = await startReleaseBatch({
      releaseId: rel.id,
      actor: 'office@test.local',
      tenantIds: [a.id, b.id],
      waveSize: 1,
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.batch.status).toBe('partial');
    expect(result.batch.failed).toBe(1);
    expect(result.items.find((item) => item.tenant_id === a.id)!.status).toBe('failed');
    const second = result.items.find((item) => item.tenant_id === b.id)!;
    expect(second.status).toBe('skipped');
    expect(second.error).toMatch(/previous_wave_failed/);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/deploy')).length).toBe(1);
  });

  it('skips paused tenants without deploying them', async () => {
    const active = seedStore({ slug: 'wave-active' });
    const paused = seedStore({ slug: 'wave-paused' });
    getRegistryDb().prepare("UPDATE stores SET status = 'paused' WHERE id = ?").run(paused.id);
    const rel = release({ tag: 'wave-paused', digest: B });
    calls = [];
    const result = await startReleaseBatch({
      releaseId: rel.id,
      actor: 'office@test.local',
      tenantIds: [active.id, paused.id],
      waveSize: 2,
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.batch.succeeded).toBe(1);
    expect(result.batch.skipped).toBe(1);
    const pausedItem = result.items.find((item) => item.tenant_id === paused.id)!;
    expect(pausedItem.status).toBe('skipped');
    expect(pausedItem.error).toBe('tenant_paused');
    expect(getStoreById(paused.id)!.image_digest).toBe(OLD_DIGEST);
  });

  it('applies a release in wave order and reports the batch', async () => {
    const a = seedStore({ slug: 'wave-1' });
    const b = seedStore({ slug: 'wave-2' });
    const c = seedStore({ slug: 'wave-3' });
    const rel = release({ tag: 'wave-run', digest: B });
    calls = [];
    const result = await startReleaseBatch({
      releaseId: rel.id,
      actor: 'office@test.local',
      tenantIds: [a.id, b.id, c.id],
      waveSize: 2,
      healthTimeoutMs: 100,
      healthIntervalMs: 5,
    });
    expect(result.batch.status).toBe('complete');
    expect(result.batch.total).toBe(3);
    expect(result.batch.succeeded).toBe(3);
    expect(result.batch.failed).toBe(0);
    expect(new Set(result.items.map((item) => item.wave_no))).toEqual(new Set([1, 2]));
    expect(result.items.filter((item) => item.wave_no === 1)).toHaveLength(2);
    expect(result.items.filter((item) => item.wave_no === 2)).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
    expect(getStoreById(a.id)!.image_digest).toBe(B);
    expect(getStoreById(b.id)!.image_digest).toBe(B);
    expect(getStoreById(c.id)!.image_digest).toBe(B);
  });
});

describe('release API surface', () => {
  it('requires office auth and lists registered releases', async () => {
    const app = createApp();
    await request(app).get('/api/releases').expect(401);
    const token = await loginAsOffice(app);
    resetRegistryDb();
    const rel = release();
    const res = await request(app).get('/api/releases').set(authHeader(token)).expect(200);
    expect((res.body as Array<{ id: number }>)[0].id).toBe(rel.id);
  });

  it('creates a release and plans a dry-run wave through the API', async () => {
    const app = createApp();
    const token = await loginAsOffice(app);
    resetRegistryDb();
    const store = createStore(
      {
        name: 'API Store',
        slug: 'api-store',
        terminalCount: 1,
        baseUrl: 'https://api-store.example',
      },
      'cp-token',
    );
    const created = await request(app)
      .post('/api/releases')
      .set(authHeader(token))
      .send({
        kind: 'store',
        tag: 'api-v1',
        digest: D,
        version: '1.0.0',
        schemaVersion: 1,
        schemaMin: 1,
        schemaMax: 1,
      })
      .expect(201);
    const rollout = await request(app)
      .post(`/api/releases/${created.body.id}/rollout`)
      .set(authHeader(token))
      .send({ tenantIds: [store.id], waveSize: 2, dryRun: true })
      .expect(201);
    expect(rollout.body.batch.status).toBe('dry_run');
    expect(rollout.body.items).toHaveLength(1);
    expect(rollout.body.items[0].tenantId).toBe(store.id);
  });
});
