import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createStore, getRegistryDb, getStoreById, resetRegistryDb } from '../config/registryDb.js';
import { createImageRelease } from '../services/releaseCatalog.js';
import { reconcileTenantRuntime } from '../services/releaseOrchestrator.js';
import { jsonResponse } from './helpers.js';

const A = `sha256:${'a'.repeat(64)}`;
let fetchMock: ReturnType<typeof jest.spyOn>;
const old = {
  COOLIFY_API_URL: process.env.COOLIFY_API_URL,
  COOLIFY_API_TOKEN: process.env.COOLIFY_API_TOKEN,
  COOLIFY_PROJECT_UUID: process.env.COOLIFY_PROJECT_UUID,
  COOLIFY_SERVER_UUID: process.env.COOLIFY_SERVER_UUID,
  COOLIFY_GITHUB_APP_UUID: process.env.COOLIFY_GITHUB_APP_UUID,
};

beforeEach(() => {
  resetRegistryDb();
  process.env.COOLIFY_API_URL = 'http://coolify.test';
  process.env.COOLIFY_API_TOKEN = 'test-token';
  process.env.COOLIFY_PROJECT_UUID = 'project';
  process.env.COOLIFY_SERVER_UUID = 'server';
  process.env.COOLIFY_GITHUB_APP_UUID = 'github';
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const s = String(url);
    if (s.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, storeName: 'Reconcile Store', version: '1.0.0' });
    }
    if (s.endsWith('/api/internal/telemetry')) {
      return jsonResponse(200, {
        ok: true,
        app: 'vula',
        version: '1.0.0',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
      });
    }
    if (s.endsWith('/health')) {
      return jsonResponse(200, {
        status: 'ok',
        app: 'vula',
        version: '1.0.0',
        revision: null,
        database: 'connected',
      });
    }
    if (s.endsWith('/storages')) {
      return jsonResponse(200, {
        persistent_storages: [{ name: 'test-volume', mount_path: '/data' }],
        file_storages: [],
      });
    }
    if (s.includes('/deployments/applications/')) return jsonResponse(200, []);
    if (s.endsWith('/applications/app')) {
      return jsonResponse(200, {
        uuid: 'app',
        name: 'za-pos-test',
        status: 'running:healthy',
        container_present: true,
        build_pack: 'dockerimage',
        fqdn: 'https://reconcile.example',
        docker_registry_image_name: 'ghcr.io/hoosainmadhi/vula-pos-store@sha256',
        docker_registry_image_tag: A.replace(/^sha256:/, ''),
      });
    }
    return jsonResponse(200, {});
  });
});

afterEach(() => {
  fetchMock.mockRestore();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('runtime reconciliation', () => {
  it('corrects failed desired state only after verifying the running Release A', async () => {
    const release = createImageRelease({
      kind: 'store',
      tag: 'A',
      digest: A,
      version: '1.0.0',
      channel: 'stable',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    const store = createStore(
      {
        name: 'Reconcile Store',
        slug: 'reconcile-store',
        terminalCount: 1,
        baseUrl: 'https://reconcile.example',
      },
      'cp-token',
    );
    getRegistryDb()
      .prepare(
        `UPDATE stores SET coolify_uuid = 'app', volume_name = 'test-volume',
           image_digest = ?, image_tag = 'A', last_release_id = ?, desired_release_id = 999,
           deploy_status = 'failed', release_state = 'failed', schema_version = 1 WHERE id = ?`,
      )
      .run(A, release.id, store.id);

    const result = await reconcileTenantRuntime('store', store.id, 'office@test', 'test reconcile');
    expect(result.status).toBe('complete');
    expect(result.releaseId).toBe(release.id);
    const updated = getStoreById(store.id)!;
    expect(updated.deploy_status).toBe('deployed');
    expect(updated.release_state).toBe('healthy');
    expect(updated.desired_release_id).toBe(release.id);
    expect(updated.last_release_id).toBe(release.id);
    expect(updated.image_digest).toBe(A);
  });

  it('refuses when container presence is not true', async () => {
    const release = createImageRelease({
      kind: 'store',
      tag: 'A2',
      digest: A,
      version: '1.0.0',
      channel: 'stable',
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
    });
    const store = createStore(
      {
        name: 'Reconcile Store',
        slug: 'reconcile-store-2',
        terminalCount: 1,
        baseUrl: 'https://reconcile2.example',
      },
      'cp-token',
    );
    getRegistryDb()
      .prepare(
        `UPDATE stores SET coolify_uuid = 'app', volume_name = 'test-volume',
           image_digest = ?, last_release_id = ?, deploy_status = 'failed', release_state = 'failed' WHERE id = ?`,
      )
      .run(A, release.id, store.id);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const s = String(url);
      if (s.endsWith('/applications/app')) {
        const response = await original(url, init);
        const body = (await response.json()) as Record<string, unknown>;
        body.container_present = false;
        return jsonResponse(200, body);
      }
      return original(url, init);
    });

    await expect(reconcileTenantRuntime('store', store.id, 'office@test')).rejects.toThrow(
      /no_container/,
    );
    expect(getStoreById(store.id)!.deploy_status).toBe('failed');
  });
});
