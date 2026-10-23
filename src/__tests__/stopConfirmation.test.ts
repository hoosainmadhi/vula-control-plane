import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { waitForApplicationStopped } from '../services/releaseOrchestrator.js';
import { jsonResponse } from './helpers.js';

let fetchMock: ReturnType<typeof jest.spyOn>;
const old = {
  COOLIFY_API_URL: process.env.COOLIFY_API_URL,
  COOLIFY_API_TOKEN: process.env.COOLIFY_API_TOKEN,
  COOLIFY_PROJECT_UUID: process.env.COOLIFY_PROJECT_UUID,
  COOLIFY_SERVER_UUID: process.env.COOLIFY_SERVER_UUID,
  COOLIFY_GITHUB_APP_UUID: process.env.COOLIFY_GITHUB_APP_UUID,
};

beforeEach(() => {
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

const appResponse = (status: string, containerPresent: boolean | undefined) =>
  jsonResponse(200, {
    uuid: 'app',
    name: 'za-pos-m4-store-a',
    status,
    ...(containerPresent === undefined ? {} : { container_present: containerPresent }),
  });

describe('stop confirmation', () => {
  it('accepts authoritative container absence even when status is stale', async () => {
    fetchMock.mockImplementation(async () => appResponse('running:healthy', false));
    await expect(waitForApplicationStopped('app', 100, 5)).resolves.toBe(true);
  });

  it('waits through a delayed container disappearance', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return appResponse('running:healthy', calls >= 3 ? false : true);
    });
    await expect(waitForApplicationStopped('app', 200, 5)).resolves.toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('fails closed while a container is still present', async () => {
    fetchMock.mockImplementation(async () => appResponse('running:healthy', true));
    await expect(waitForApplicationStopped('app', 30, 5)).resolves.toBe(false);
  });

  it('fails closed when container presence is unknown, even if status says exited', async () => {
    fetchMock.mockImplementation(async () => appResponse('exited:unhealthy', undefined));
    await expect(waitForApplicationStopped('app', 30, 5)).resolves.toBe(false);
  });
});
