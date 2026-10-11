import request from 'supertest';
import { createApp } from '../app.js';
import { getRegistryDb, resetRegistryDb } from '../config/registryDb.js';

describe('GET /health', () => {
  afterEach(() => {
    resetRegistryDb();
  });

  it('answers ok with the registry database connected', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected' });
    expect(typeof res.body.version).toBe('string');
  });

  it('answers 503 with database unhealthy when the registry cannot be queried', async () => {
    // Warm the singleton, then close the handle under it: the lazy getter
    // returns the closed instance, so the probe's SELECT must fail — exactly
    // what a Coolify healthcheck needs to see when the registry is gone.
    getRegistryDb().close();
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'error', database: 'unhealthy' });
  });
});
