import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetRegistryDb } from '../config/registryDb.js';
import { createImageRelease } from '../services/releaseCatalog.js';
import { waitForApplicationReady } from '../services/releaseOrchestrator.js';
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

const app = (status: string, over: Record<string, unknown> = {}) => ({
  uuid: 'app',
  name: 'za-pos-test',
  status,
  container_present: true,
  build_pack: 'dockerimage',
  docker_registry_image_name: 'ghcr.io/hoosainmadhi/vula-pos-store@sha256',
  docker_registry_image_tag: A.replace(/^sha256:/, ''),
  ...over,
});
const health = (over: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    status: 'ok',
    app: 'vula',
    version: '2.0.0',
    revision: 'rev-b',
    database: 'connected',
    ...over,
  });

beforeEach(() => {
  resetRegistryDb();
  process.env.COOLIFY_API_URL = 'http://coolify.test';
  process.env.COOLIFY_API_TOKEN = 'test-token';
  process.env.COOLIFY_PROJECT_UUID = 'project';
  process.env.COOLIFY_SERVER_UUID = 'server';
  process.env.COOLIFY_GITHUB_APP_UUID = 'github';
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const release = () =>
  createImageRelease({
    kind: 'store',
    tag: 'B',
    digest: A,
    version: '2.0.0',
    revision: 'rev-b',
    channel: 'beta',
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
  });

describe('post-deployment readiness', () => {
  it('polls through warm-up unhealthy status until the exact release is healthy', async () => {
    const rel = release();
    let calls = 0;
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.endsWith('/applications/app')) {
        calls += 1;
        return jsonResponse(200, app(calls < 3 ? 'running:unhealthy' : 'running:healthy'));
      }
      return health();
    });
    await expect(waitForApplicationReady('app', rel, 'http://store.test', 300, 5)).resolves.toEqual(
      { ok: true },
    );
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('waits for the health endpoint to report the exact version and revision', async () => {
    const rel = release();
    let healthCalls = 0;
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.endsWith('/applications/app')) return jsonResponse(200, app('running:healthy'));
      healthCalls += 1;
      return healthCalls < 3 ? health({ version: '1.0.0' }) : health();
    });
    await expect(waitForApplicationReady('app', rel, 'http://store.test', 300, 5)).resolves.toEqual(
      { ok: true },
    );
  });

  it('fails immediately on a terminal application failure', async () => {
    const rel = release();
    fetchMock.mockImplementation(async (url: string | URL | Request) =>
      String(url).endsWith('/applications/app')
        ? jsonResponse(200, app('exited:unhealthy'))
        : health(),
    );
    const result = await waitForApplicationReady('app', rel, 'http://store.test', 300, 5);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/application_status_exited/);
  });

  it('fails closed with a timeout when the app never becomes healthy', async () => {
    const rel = release();
    fetchMock.mockImplementation(async (url: string | URL | Request) =>
      String(url).endsWith('/applications/app')
        ? jsonResponse(200, app('running:unhealthy'))
        : health(),
    );
    const result = await waitForApplicationReady('app', rel, 'http://store.test', 30, 5);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/health_timeout_or_version_mismatch/);
  });

  it('rejects an app pinned to the wrong image', async () => {
    const rel = release();
    fetchMock.mockImplementation(async (url: string | URL | Request) =>
      String(url).endsWith('/applications/app')
        ? jsonResponse(200, app('running:healthy', { docker_registry_image_tag: 'f'.repeat(64) }))
        : health(),
    );
    const result = await waitForApplicationReady('app', rel, 'http://store.test', 300, 5);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/application_image_mismatch/);
  });
});
