import request from 'supertest';
import { createApp } from '../app.js';
import { errorFingerprint, resetRegistryDb } from '../config/registryDb.js';
import { authHeader, jsonResponse, loginAsOffice } from './helpers.js';

const app = createApp();

let fetchMock: jest.SpyInstance;
let token = '';

// One office login for the whole suite: the login route is rate-limited to
// 20 attempts per 15 min per app instance, and the token is stateless.
beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  fetchMock = jest.spyOn(globalThis, 'fetch');
  // Everything the control plane calls a store for succeeds unless a test says
  // otherwise, so store creation and its first push are out of the way.
  fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, applied: { terminalCount: 2 } }));
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

interface StoreOut {
  id: number;
  slug: string;
}

/** One deployment per URL is the house rule, so each store gets its own port. */
const createStore = async (slug: string, port: number): Promise<StoreOut> => {
  const res = await request(app)
    .post('/api/stores')
    .set(auth())
    .send({ name: slug, slug, terminalCount: 2, baseUrl: `http://localhost:${port}/` });
  expect(res.status).toBe(201);
  return (res.body as { store: StoreOut }).store;
};

/** Only one internal path fails; every other call still behaves. */
const failPath = (path: string, message = 'ECONNREFUSED'): void => {
  fetchMock.mockImplementation(async (url) => {
    if (String(url).endsWith(path)) throw new Error(message);
    return jsonResponse(200, { ok: true, applied: { terminalCount: 2 } });
  });
};

interface GroupOut {
  fingerprint: string;
  message: string;
  sources: string[];
  occurrences: number;
  entityCount: number;
  storeCount: number;
  panelCount: number;
  firstSeen: string;
  lastSeen: string;
}

const listGroups = async (): Promise<GroupOut[]> => {
  const res = await request(app).get('/api/errors').set(auth());
  expect(res.status).toBe(200);
  return res.body as GroupOut[];
};

const failHealth = async (store: StoreOut): Promise<void> => {
  const res = await request(app).post(`/api/stores/${store.id}/health`).set(auth());
  expect(res.status).toBe(200);
  expect(res.body.healthStatus).toBe('down');
};

describe('GET /api/errors', () => {
  it('requires an office session', async () => {
    const res = await request(app).get('/api/errors');
    expect(res.status).toBe(401);
  });

  it('is empty before anything has failed', async () => {
    await createStore('quiet-mall', 3291);
    expect(await listGroups()).toEqual([]);
  });
});

describe('recording failures', () => {
  it('turns a failed health check into a group carrying the reason', async () => {
    const store = await createStore('gardens-mall', 3292);
    failPath('/api/internal/status');
    await failHealth(store);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      sources: ['health'],
      occurrences: 1,
      storeCount: 1,
      panelCount: 0,
      entityCount: 1,
    });
    expect(groups[0]!.message).toContain('ECONNREFUSED');
  });

  it('counts repeats of one fault instead of duplicating the row', async () => {
    const store = await createStore('umhlanga', 3293);
    failPath('/api/internal/status');
    await failHealth(store);
    await failHealth(store);
    await failHealth(store);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.occurrences).toBe(3);
    expect(groups[0]!.entityCount).toBe(1);
  });

  it('reports the same fault across two stores as one group with two stores', async () => {
    const jhb = await createStore('jhb', 3294);
    const cpt = await createStore('cpt', 3295);
    failPath('/api/internal/status');
    await failHealth(jhb);
    await failHealth(cpt);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ occurrences: 2, storeCount: 2, entityCount: 2 });
  });

  it('keeps different faults in different groups', async () => {
    const store = await createStore('soweto', 3296);

    failPath('/api/internal/status', 'ECONNREFUSED');
    await failHealth(store);
    failPath('/api/internal/status', 'socket hang up');
    await failHealth(store);

    const groups = await listGroups();
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.message))).toEqual(
      new Set(['Store unreachable (GET /api/internal/status): ECONNREFUSED', 'Store unreachable (GET /api/internal/status): socket hang up']),
    );
  });

  it('records a failed config push against the config source', async () => {
    const store = await createStore('pretoria', 3297);
    failPath('/api/internal/configure', 'Vertical must be one of: general, clothing');

    const res = await request(app).post(`/api/stores/${store.id}/push`).set(auth());
    expect(res.status).toBe(200);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sources).toEqual(['config']);
    expect(groups[0]!.message).toContain('Vertical must be one of');
  });

  it('records a failed licence push, which used to discard its reason', async () => {
    const store = await createStore('durban', 3298);
    failPath('/api/internal/licence', 'Store POST /api/internal/licence failed: bad signature');

    const res = await request(app).post(`/api/stores/${store.id}/licence`).set(auth());
    expect(res.status).toBe(502);
    expect((res.body as { ok: boolean }).ok).toBe(false);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sources).toEqual(['licence']);
    expect(groups[0]!.message).toContain('bad signature');
  });

  it('keeps the history when the store recovers', async () => {
    const store = await createStore('rustenburg', 3299);
    failPath('/api/internal/status');
    await failHealth(store);
    const before = await listGroups();

    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));
    const recovered = await request(app).post(`/api/stores/${store.id}/health`).set(auth());
    expect(recovered.body.healthStatus).toBe('up');

    const after = await listGroups();
    expect(after).toEqual(before);
  });
});

describe('GET /api/errors/:fingerprint', () => {
  it('returns the group and every occurrence behind it', async () => {
    const store = await createStore('nelspruit', 3290);
    failPath('/api/internal/status');
    await failHealth(store);
    await failHealth(store);
    const [group] = await listGroups();

    const res = await request(app).get(`/api/errors/${group!.fingerprint}`).set(auth());
    expect(res.status).toBe(200);
    const body = res.body as { group: GroupOut; events: Array<{ entityType: string; source: string }> };
    expect(body.group.fingerprint).toBe(group!.fingerprint);
    expect(body.group.occurrences).toBe(2);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ entityType: 'store', source: 'health' });
  });

  it('404s an unknown fingerprint', async () => {
    const res = await request(app).get('/api/errors/deadbeefdeadbeef').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('errorFingerprint', () => {
  it('groups a fault whose volatile details differ', () => {
    const first = errorFingerprint('Store call timed out after 5000ms (GET /api/internal/status)');
    const second = errorFingerprint('Store call timed out after 100ms (GET /api/internal/status)');
    expect(first).toBe(second);
  });

  it('separates faults that differ in substance', () => {
    expect(errorFingerprint('Store unreachable (GET /api/internal/status): ECONNREFUSED')).not.toBe(
      errorFingerprint('Store unreachable (POST /api/internal/configure): ECONNREFUSED'),
    );
  });
});
