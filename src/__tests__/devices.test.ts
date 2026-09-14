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
  fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, applied: { terminalCount: 2 } }));
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

interface StoreOut {
  id: number;
}

const createStore = async (
  slug: string,
  port: number,
  over: Record<string, unknown> = {},
): Promise<StoreOut> => {
  const res = await request(app)
    .post('/api/stores')
    .set(auth())
    .send({ name: slug, slug, terminalCount: 2, baseUrl: `http://localhost:${port}/`, ...over });
  expect(res.status).toBe(201);
  return (res.body as { store: StoreOut }).store;
};

interface TerminalFixture {
  till: number;
  name?: string;
  claimed?: boolean;
  deviceId?: string | null;
  sessionOpen?: boolean;
  lastSeenAt?: string | null;
}

/** Serves telemetry with the given till state, then probes health to record it. */
const recordTelemetry = async (storeId: number, terminals: TerminalFixture[]): Promise<void> => {
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, storeName: 'Demo', version: '1.2.3' });
    }
    if (u.endsWith('/api/internal/telemetry')) {
      return jsonResponse(200, {
        ok: true,
        app: 'vula',
        version: '1.2.3',
        schemaVersion: 7,
        generatedAt: new Date().toISOString(),
        sync: { lastSyncAt: null, pendingEvents: null, failedEvents: null },
        terminals,
      });
    }
    if (u.endsWith('/api/internal/licence')) return jsonResponse(200, { ok: true });
    return jsonResponse(200, { ok: true, applied: { terminalCount: 2 } });
  });
  const res = await request(app).post(`/api/stores/${storeId}/health`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.healthStatus).toBe('up');
};

const probeDown = async (storeId: number): Promise<void> => {
  fetchMock.mockImplementation(async (url) => {
    if (String(url).endsWith('/api/internal/status')) throw new Error('ECONNREFUSED');
    return jsonResponse(200, { ok: true });
  });
  const res = await request(app).post(`/api/stores/${storeId}/health`).set(auth());
  expect(res.body.healthStatus).toBe('down');
};

interface DeviceOut {
  id: string;
  name: string;
  type: 'pos' | 'office';
  storeId: number | null;
  storeName: string;
  companyName: string | null;
  version: string | null;
  claimed: boolean;
  sessionOpen: boolean;
  deviceId: string | null;
  lastSeenAt: string | null;
  status: string;
  configState: string;
}

const listDevices = async (): Promise<DeviceOut[]> => {
  const res = await request(app).get('/api/devices').set(auth());
  expect(res.status).toBe(200);
  return res.body as DeviceOut[];
};

describe('GET /api/devices', () => {
  it('requires an office session', async () => {
    const res = await request(app).get('/api/devices');
    expect(res.status).toBe(401);
  });

  it('is empty before any store is registered', async () => {
    expect(await listDevices()).toEqual([]);
  });

  it('lists every configured till, claimed or not', async () => {
    await createStore('gardens-mall', 3291);
    const devices = await listDevices();
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.name)).toEqual(['Till 1', 'Till 2']);
    expect(devices.every((d) => d.type === 'pos')).toBe(true);
    // No register has bound to these tills yet.
    expect(devices.every((d) => d.status === 'unclaimed')).toBe(true);
    expect(devices.every((d) => d.claimed === false)).toBe(true);
    // Nothing has answered telemetry, so there is no build to report.
    expect(devices.every((d) => d.version === null)).toBe(true);
  });

  it('uses the operator’s custom till names', async () => {
    const store = await createStore('umhlanga', 3292);
    // Names are an update, not a create field — POST /stores ignores unknown
    // keys silently, so sending them at create would fail this test quietly.
    const named = await request(app)
      .put(`/api/stores/${store.id}`)
      .set(auth())
      .send({ terminalNames: ['Front counter', 'Bakery'] });
    expect(named.status).toBe(200);
    expect((await listDevices()).map((d) => d.name)).toEqual(['Front counter', 'Bakery']);
  });

  it('reports a claimed till with its device id, and leaves the rest unclaimed', async () => {
    const store = await createStore('jhb', 3293);
    await recordTelemetry(store.id, [
      { till: 1, name: 'Till 1', claimed: true, deviceId: 'dev-abc', sessionOpen: true },
      { till: 2, name: 'Till 2', claimed: false },
    ]);

    const [first, second] = await listDevices();
    expect(first).toMatchObject({
      name: 'Till 1',
      claimed: true,
      sessionOpen: true,
      deviceId: 'dev-abc',
      // Bound, but the register reports no per-device heartbeat yet.
      status: 'claimed',
      version: '1.2.3',
    });
    expect(second).toMatchObject({ claimed: false, deviceId: null, status: 'unclaimed' });
  });

  it('marks a till online only on a fresh device heartbeat', async () => {
    const store = await createStore('cpt', 3294);
    await recordTelemetry(store.id, [
      { till: 1, claimed: true, deviceId: 'dev-fresh', lastSeenAt: new Date().toISOString() },
      { till: 2, claimed: true, deviceId: 'dev-stale', lastSeenAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    ]);

    const [fresh, stale] = await listDevices();
    expect(fresh!.status).toBe('online');
    expect(stale!.status).toBe('offline');
  });

  it('calls every claimed till offline when the store itself is unreachable', async () => {
    const store = await createStore('soweto', 3295);
    await recordTelemetry(store.id, [
      { till: 1, claimed: true, deviceId: 'dev-a', lastSeenAt: new Date().toISOString() },
      { till: 2, claimed: true, deviceId: 'dev-b' },
    ]);
    await probeDown(store.id);

    const devices = await listDevices();
    expect(devices.map((d) => d.status)).toEqual(['offline', 'offline']);
    // The last known telemetry is kept — the fleet page shows the bound device
    // ids even while the store is down.
    expect(devices.map((d) => d.deviceId)).toEqual(['dev-a', 'dev-b']);
  });

  it('lists a Head Office as an office device under its company', async () => {
    const company = await request(app)
      .post('/api/companies')
      .set(auth())
      .send({ name: 'Urban Threads Retail Group', slug: 'urban-threads' });
    expect(company.status).toBe(201);
    const companyId = (company.body as { id: number }).id;

    const panel = await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ name: 'Urban Threads Head Office', slug: 'urban-threads-ho', companyId, baseUrl: 'http://localhost:3260/' });
    expect(panel.status).toBe(201);

    const devices = await listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      type: 'office',
      name: 'Urban Threads Head Office',
      storeName: 'Urban Threads Head Office',
      companyName: 'Urban Threads Retail Group',
      storeId: null,
      // Never probed, so its state is honestly unknown rather than "offline".
      status: 'unknown',
    });
  });
});
