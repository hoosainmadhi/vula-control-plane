import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../app.js';
import { createImageRelease } from '../services/releaseCatalog.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { env } from '../config/env.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

const app = createApp();
const COOLIFY = 'http://coolify.test';
let token = '';
let fetchMock: ReturnType<typeof jest.spyOn>;
let createBody: Record<string, unknown> | null = null;
const oldCoolify = {
  COOLIFY_API_URL: process.env.COOLIFY_API_URL,
  COOLIFY_API_TOKEN: process.env.COOLIFY_API_TOKEN,
  COOLIFY_PROJECT_UUID: process.env.COOLIFY_PROJECT_UUID,
  COOLIFY_SERVER_UUID: process.env.COOLIFY_SERVER_UUID,
  COOLIFY_GITHUB_APP_UUID: process.env.COOLIFY_GITHUB_APP_UUID,
};
const oldStaging = env.stagingMode;

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  createBody = null;
  env.stagingMode = false;
  process.env.COOLIFY_API_URL = COOLIFY;
  process.env.COOLIFY_API_TOKEN = 'test-token';
  process.env.COOLIFY_PROJECT_UUID = 'project-test';
  process.env.COOLIFY_SERVER_UUID = 'server-test';
  process.env.COOLIFY_GITHUB_APP_UUID = 'github-test';
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const s = String(url);
    const method = init?.method ?? 'GET';
    if (s.startsWith(COOLIFY)) {
      if (s.endsWith('/applications/dockerimage')) {
        createBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(201, { uuid: 'new-store-app' });
      }
      if (s.includes('/envs/bulk') || s.includes('/storages'))
        return jsonResponse(201, { ok: true });
      if (s.includes('/deployments/')) return jsonResponse(200, { status: 'finished' });
      if (s.includes('/deploy')) {
        return jsonResponse(200, { deployments: [{ deployment_uuid: 'dep-1' }] });
      }
      if (method === 'GET' && /\/applications\/[^/]+$/.test(s)) {
        return jsonResponse(200, {
          uuid: 'new-store-app',
          name: 'za-pos-m4-store-a',
          status: 'running:healthy',
          container_present: true,
          build_pack: 'dockerimage',
          fqdn: 'http://localhost:3245',
          docker_registry_image_name: 'ghcr.io/hoosainmadhi/vula-pos-store@sha256',
          docker_registry_image_tag: 'e'.repeat(64),
        });
      }
      return jsonResponse(200, { ok: true });
    }
    if (s.endsWith('/health')) {
      return jsonResponse(200, {
        status: 'ok',
        app: 'vula',
        version: '1.0.0',
        database: 'connected',
      });
    }
    if (s.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, storeName: 'Naming Store', version: '1.0.0' });
    }
    return jsonResponse(200, { ok: true, applied: {}, licenceSequence: 1 });
  });
  createImageRelease({
    kind: 'store',
    tag: 'naming-test',
    digest: `sha256:${'e'.repeat(64)}`,
    version: '1.0.0',
    channel: 'stable',
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
  });
});

afterEach(() => {
  fetchMock?.mockRestore();
  env.stagingMode = oldStaging;
  for (const [name, value] of Object.entries(oldCoolify)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('onboarding deploymentName propagation', () => {
  it('uses the requested deploymentName for the Coolify app', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(authHeader(token))
      .send({
        name: 'Naming Client',
        slug: 'naming-client',
        deploymentType: 'single_store',
        autoDeploy: true,
        stores: [
          {
            name: 'Naming Store',
            slug: 'naming-store',
            deploymentName: 'm4-store-a',
            baseUrl: 'http://localhost:3245',
            terminalCount: 1,
          },
        ],
      })
      .expect(201);

    expect(createBody?.name).toBe('za-pos-m4-store-a');
    expect(res.body.job.status).toBe('complete');
  });
});
