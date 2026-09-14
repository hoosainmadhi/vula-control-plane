import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { authHeader, jsonResponse, loginAsOffice } from './helpers.js';

const app = createApp();

let fetchMock: jest.SpyInstance;
let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, applied: { terminalCount: 1 } }));
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

const createStore = async (slug: string, port: number): Promise<number> => {
  const res = await request(app)
    .post('/api/stores')
    .set(auth())
    .send({ name: slug, slug, terminalCount: 1, baseUrl: `http://localhost:${port}/` });
  expect(res.status).toBe(201);
  return (res.body as { store: { id: number } }).store.id;
};

/** Serves telemetry reporting the given build, then probes health to record it. */
const recordVersion = async (storeId: number, version: string, schemaVersion: number): Promise<void> => {
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/api/internal/status')) return jsonResponse(200, { ok: true, version });
    if (u.endsWith('/api/internal/telemetry')) {
      return jsonResponse(200, {
        ok: true,
        app: 'vula',
        version,
        schemaVersion,
        generatedAt: new Date().toISOString(),
        sync: { lastSyncAt: null, pendingEvents: null, failedEvents: null },
        terminals: [],
      });
    }
    if (u.endsWith('/api/internal/licence')) return jsonResponse(200, { ok: true });
    return jsonResponse(200, { ok: true, applied: { terminalCount: 1 } });
  });
  const res = await request(app).post(`/api/stores/${storeId}/health`).set(auth());
  expect(res.body.healthStatus).toBe('up');
};

interface VersionRow {
  version: string | null;
  stores: number;
  panels: number;
  lastHeartbeatAt: string | null;
  members: Array<{ kind: string; name: string }>;
}

interface VersionsOut {
  versions: VersionRow[];
  schemas: Array<{ schemaVersion: number; stores: number }>;
  mostDeployed: Record<string, string | null>;
  totals: { stores: number; panels: number; storesReporting: number; panelsReporting: number };
}

const getVersions = async (): Promise<VersionsOut> => {
  const res = await request(app).get('/api/versions').set(auth());
  expect(res.status).toBe(200);
  return res.body as VersionsOut;
};

describe('GET /api/versions', () => {
  it('requires an office session', async () => {
    const res = await request(app).get('/api/versions');
    expect(res.status).toBe(401);
  });

  it('is empty on a fresh registry', async () => {
    const out = await getVersions();
    expect(out.versions).toEqual([]);
    expect(out.schemas).toEqual([]);
    expect(out.mostDeployed.production).toBeNull();
    expect(out.totals).toEqual({ stores: 0, panels: 0, storesReporting: 0, panelsReporting: 0 });
  });

  it('keeps a registered store that never reported in its own bucket', async () => {
    await createStore('silent-mall', 3291);
    const out = await getVersions();
    expect(out.versions).toHaveLength(1);
    expect(out.versions[0]).toMatchObject({ version: null, stores: 1, panels: 0 });
    expect(out.totals).toMatchObject({ stores: 1, storesReporting: 0 });
  });

  it('counts stores per version and names the members', async () => {
    const first = await createStore('jhb', 3292);
    const second = await createStore('cpt', 3293);
    const third = await createStore('dbn', 3294);
    await recordVersion(first, '1.8.4', 37);
    await recordVersion(second, '1.8.4', 37);
    await recordVersion(third, '1.8.3', 36);

    const out = await getVersions();
    // Most-deployed first.
    expect(out.versions.map((v) => v.version)).toEqual(['1.8.4', '1.8.3']);
    expect(out.versions[0]).toMatchObject({ stores: 2, panels: 0 });
    expect(out.versions[0]!.members.map((m) => m.name).sort()).toEqual(['cpt', 'jhb']);
    expect(out.versions[1]).toMatchObject({ stores: 1, panels: 0 });
    expect(out.totals).toMatchObject({ stores: 3, storesReporting: 3 });
  });

  it('reports the most-deployed build per environment', async () => {
    const a = await createStore('a-mall', 3295);
    const b = await createStore('b-mall', 3296);
    await recordVersion(a, '1.8.4', 37);
    await recordVersion(b, '1.8.4', 37);
    const out = await getVersions();
    // Stores default to the development environment.
    expect(out.mostDeployed.development).toBe('1.8.4');
    expect(out.mostDeployed.production).toBeNull();
  });

  it('spreads schema versions across stores', async () => {
    const a = await createStore('schema-a', 3297);
    const b = await createStore('schema-b', 3298);
    await recordVersion(a, '1.8.4', 37);
    await recordVersion(b, '1.8.4', 36);
    const out = await getVersions();
    expect(out.schemas).toEqual([
      { schemaVersion: 37, stores: 1 },
      { schemaVersion: 36, stores: 1 },
    ]);
  });

  it('includes a Head Office in its build row without an environment', async () => {
    const company = await request(app)
      .post('/api/companies')
      .set(auth())
      .send({ name: 'Urban Threads Retail Group', slug: 'urban-threads' });
    const companyId = (company.body as { id: number }).id;
    const panel = await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ name: 'Urban Threads HO', slug: 'urban-threads-ho', companyId, baseUrl: 'http://localhost:3260/' });
    expect(panel.status).toBe(201);

    // A panel reports its version through its own health probe.
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, version: '2.0.0' }));
    const health = await request(app).post('/api/panels/1/health').set(auth());
    expect(health.status).toBe(200);

    const out = await getVersions();
    expect(out.versions).toHaveLength(1);
    expect(out.versions[0]).toMatchObject({ version: '2.0.0', panels: 1, stores: 0 });
    expect(out.versions[0]!.members).toEqual([
      { kind: 'panel', id: 1, name: 'Urban Threads HO', environment: null, schemaVersion: null, lastHeartbeatAt: expect.any(String) },
    ]);
    expect(out.totals).toMatchObject({ panels: 1, panelsReporting: 1 });
  });
});
