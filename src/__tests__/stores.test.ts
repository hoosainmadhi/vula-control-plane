import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader, STATUS_OK, RESET_OK } from './helpers.js';

const app = createApp();

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

type StoreBody = Record<string, unknown>;

const createPayload = (over: StoreBody = {}): StoreBody => ({
  name: 'Gardens Mall',
  slug: 'gardens-mall',
  vatRegNo: '4530211828',
  terminalCount: 3,
  baseUrl: 'http://localhost:3299/',
  ...over,
});

const lastFetch = (): [string, FetchInit | undefined] => {
  const calls = fetchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return [
    calls[calls.length - 1][0] as string,
    calls[calls.length - 1][1] as FetchInit | undefined,
  ];
};

/** Find a store call by the internal path it targets. */
const fetchTo = (path: string): [string, FetchInit | undefined] => {
  const match = fetchMock.mock.calls.find((c) => String(c[0]).endsWith(path));
  expect(match).toBeDefined();
  return [match![0] as string, match![1] as FetchInit | undefined];
};

/** Mocked store configure endpoint that echoes back the pushed terminalCount. */
const mockConfigureOk = (): void => {
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as FetchInit).body as string) as { terminalCount: number };
    return jsonResponse(200, { ok: true, applied: { terminalCount: body.terminalCount } });
  });
};

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
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

describe('POST /api/stores — create + first push', () => {
  it('creates the store and pushes Till 1..N with the token header', async () => {
    mockConfigureOk();
    const res = await request(app).post('/api/stores').set(auth()).send(createPayload());
    expect(res.status).toBe(201);
    const { store, firstPush } = res.body as { store: StoreBody; firstPush: { ok: boolean } };
    expect(store).toMatchObject({
      slug: 'gardens-mall',
      name: 'Gardens Mall',
      vatRegNo: '4530211828',
      vertical: 'general',
      terminalCount: 3,
      baseUrl: 'http://localhost:3299',
      status: 'active',
      lastConfigStatus: 'ok',
      lastHealthStatus: 'unknown',
    });
    expect(firstPush.ok).toBe(true);
    // A generated token is revealed exactly once, so the operator can install it.
    // (`controlPlaneToken` is the store field, which is never serialised.)
    expect(JSON.stringify(res.body)).not.toContain('"controlPlaneToken"');
    expect(typeof (res.body as { generatedControlPlaneToken?: string }).generatedControlPlaneToken).toBe(
      'string',
    );

    const [url, init] = fetchTo('/api/internal/configure');
    expect(url).toBe('http://localhost:3299/api/internal/configure');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.['X-Control-Plane-Token']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      terminalCount: 3,
      vertical: 'general',
      terminals: [
        { till: 1, name: 'Till 1' },
        { till: 2, name: 'Till 2' },
        { till: 3, name: 'Till 3' },
      ],
    });

    // Creation also delivers a signed licence, so the store can verify its
    // entitlement without ever holding a signing key.
    const [licenceUrl, licenceInit] = fetchTo('/api/internal/licence');
    expect(licenceUrl).toBe('http://localhost:3299/api/internal/licence');
    const licenceBody = JSON.parse(licenceInit?.body as string) as { token: string };
    expect(licenceBody.token.split('.')).toHaveLength(2);
    expect((res.body as { firstLicence: { ok: boolean } }).firstLicence.ok).toBe(true);
  });

  it('pushes an explicit vertical with the store and surfaces it on the store', async () => {
    mockConfigureOk();
    const res = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ vertical: 'hardware' }));
    expect(res.status).toBe(201);
    expect((res.body as { store: StoreBody }).store.vertical).toBe('hardware');

    const [, init] = fetchTo('/api/internal/configure');
    expect(JSON.parse(init?.body as string)).toMatchObject({ vertical: 'hardware' });
  });

  it('uses a supplied controlPlaneToken for pushes and rejects malformed ones', async () => {
    mockConfigureOk();
    const token = 'ab'.repeat(32);
    const res = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ controlPlaneToken: token }));
    expect(res.status).toBe(201);
    const [, init] = fetchTo('/api/internal/configure');
    expect(init?.headers?.['X-Control-Plane-Token']).toBe(token);
    // A supplied token is not echoed back — only a generated one is shown, once.
    expect((res.body as { generatedControlPlaneToken?: string }).generatedControlPlaneToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('"controlPlaneToken"');

    const bad = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 'another', controlPlaneToken: 'not-hex-enough' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/controlPlaneToken/i);
  });

  it('strips the trailing slash from baseUrl', async () => {
    mockConfigureOk();
    const res = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ baseUrl: 'http://x:1//' }));
    expect(res.status).toBe(201);
    expect((res.body as { store: StoreBody }).store.baseUrl).toBe('http://x:1');
  });

  it('keeps the row (lastConfigStatus failed) when the first push fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await request(app).post('/api/stores').set(auth()).send(createPayload());
    expect(res.status).toBe(201);
    const { store, firstPush } = res.body as {
      store: StoreBody;
      firstPush: { ok: boolean; error: string };
    };
    expect(store.lastConfigStatus).toBe('failed');
    expect(firstPush.ok).toBe(false);
    expect(firstPush.error).toMatch(/unreachable/i);

    const list = await request(app).get('/api/stores').set(auth());
    expect(list.body).toHaveLength(1);
    expect(list.body[0].lastConfigStatus).toBe('failed');
  });

  it('records a config snapshot on success and serves it in the detail endpoint', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    const detail = await request(app).get(`/api/stores/${id}`).set(auth());
    expect(detail.status).toBe(200);
    const body = detail.body as {
      lastConfigSnapshot: { applied: { terminalCount: number } };
      terminals: Array<{ till: number; configured: boolean }>;
    };
    expect(body.lastConfigSnapshot).toEqual({ ok: true, applied: { terminalCount: 3 } });
    expect(body.terminals).toEqual([
      { till: 1, name: 'Till 1', configured: true },
      { till: 2, name: 'Till 2', configured: true },
      { till: 3, name: 'Till 3', configured: true },
    ]);
  });
});

describe('POST /api/stores — validation', () => {
  it('rejects bad slugs', async () => {
    mockConfigureOk();
    // Per the approved contract regex ^[a-z0-9][a-z0-9-]*$ a trailing dash is
    // technically allowed; leading dash, uppercase, spaces and length are not.
    for (const slug of ['Bad-Slug', '-leading-dash', 'has space', 'UPPER', 'x'.repeat(41)]) {
      const res = await request(app).post('/api/stores').set(auth()).send(createPayload({ slug }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/slug/i);
    }
  });

  it('rejects terminalCount outside 1..99 and non-integers', async () => {
    mockConfigureOk();
    for (const terminalCount of [0, 100, 1.5, '3', null, undefined]) {
      const payload = createPayload();
      if (terminalCount === undefined) delete payload.terminalCount;
      else payload.terminalCount = terminalCount as number;
      const res = await request(app).post('/api/stores').set(auth()).send(payload);
      expect(res.status).toBe(400);
    }
  });

  it('rejects non-http(s) base URLs and missing fields', async () => {
    mockConfigureOk();
    const ftp = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ baseUrl: 'ftp://x' }));
    expect(ftp.status).toBe(400);
    const noName = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ name: '  ' }));
    expect(noName.status).toBe(400);
  });

  it('rejects unknown verticals and never calls the store', async () => {
    mockConfigureOk();
    for (const vertical of ['bakery', '', null, 3]) {
      const res = await request(app)
        .post('/api/stores')
        .set(auth())
        .send(createPayload({ slug: `store-${String(vertical).length}`, vertical }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(
        /vertical must be one of: general, clothing, spares, hardware, pharmacy/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409s on a duplicate slug without calling the store', async () => {
    mockConfigureOk();
    await request(app).post('/api/stores').set(auth()).send(createPayload());
    // The successful create makes two store calls (configure + licence); the
    // rejected duplicate must add none.
    const callsAfterCreate = fetchMock.mock.calls.length;
    expect(callsAfterCreate).toBeGreaterThan(0);

    const dup = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ name: 'Other' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already exists/i);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterCreate);
  });
});

describe('PUT /api/stores/:id — edit', () => {
  it('updates editable fields and never auto-pushes', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    const callsAfterCreate = fetchMock.mock.calls.length;

    const res = await request(app)
      .put(`/api/stores/${id}`)
      .set(auth())
      .send({ name: 'Gardens Mall East', vatRegNo: '', vertical: 'clothing', terminalCount: 4 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Gardens Mall East',
      vatRegNo: null,
      vertical: 'clothing',
      terminalCount: 4,
      slug: 'gardens-mall',
    });
    // Edits alone never hit the store — only create-time calls happened.
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterCreate);
  });

  it('rejects an unknown vertical on edit', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    const bad = await request(app)
      .put(`/api/stores/${id}`)
      .set(auth())
      .send({ vertical: 'bakery' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/vertical must be one of/);
  });

  it('ignores slug changes and validates edited fields', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    const slugTry = await request(app)
      .put(`/api/stores/${id}`)
      .set(auth())
      .send({ slug: 'renamed' });
    expect(slugTry.status).toBe(200);
    expect((slugTry.body as StoreBody).slug).toBe('gardens-mall');
    const badCount = await request(app)
      .put(`/api/stores/${id}`)
      .set(auth())
      .send({ terminalCount: 500 });
    expect(badCount.status).toBe(400);
  });

  it('404s for an unknown store', async () => {
    const res = await request(app).put('/api/stores/9999').set(auth()).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/stores/:id/push — retry', () => {
  it('marks failed then ok across retries', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;

    // Simulate the store going away after creation, then coming back.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const failed = await request(app).post(`/api/stores/${id}/push`).set(auth());
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ ok: false, lastConfigStatus: 'failed' });

    const afterFail = await request(app).get(`/api/stores/${id}`).set(auth());
    expect((afterFail.body as { lastConfigStatus: string }).lastConfigStatus).toBe('failed');

    mockConfigureOk();
    const retried = await request(app).post(`/api/stores/${id}/push`).set(auth());
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      ok: true,
      lastConfigStatus: 'ok',
      pushedAt: expect.any(String),
    });
  });
});

describe('pause / resume', () => {
  it('blocks push and reset-admin while paused, allows health, then resumes', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;

    const paused = await request(app).patch(`/api/stores/${id}/pause`).set(auth());
    expect(paused.status).toBe(200);
    expect((paused.body as StoreBody).status).toBe('paused');

    const push = await request(app).post(`/api/stores/${id}/push`).set(auth());
    expect(push.status).toBe(409);
    const reset = await request(app).post(`/api/stores/${id}/reset-admin`).set(auth());
    expect(reset.status).toBe(409);

    fetchMock.mockResolvedValue(jsonResponse(200, STATUS_OK));
    const health = await request(app).post(`/api/stores/${id}/health`).set(auth());
    expect(health.status).toBe(200);
    expect((health.body as { healthStatus: string }).healthStatus).toBe('up');

    const resumed = await request(app).patch(`/api/stores/${id}/resume`).set(auth());
    expect(resumed.status).toBe(200);
    expect((resumed.body as StoreBody).status).toBe('active');
  });
});

describe('POST /api/stores/:id/health', () => {
  it('records up with the status body on success', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    fetchMock.mockResolvedValue(jsonResponse(200, STATUS_OK));
    const res = await request(app).post(`/api/stores/${id}/health`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, healthStatus: 'up', checkedAt: expect.any(String) });
    expect((res.body as { detail: unknown }).detail).toEqual(STATUS_OK);

    const list = await request(app).get('/api/stores').set(auth());
    expect((list.body as Array<{ lastHealthStatus: string }>)[0].lastHealthStatus).toBe('up');
  });

  it('records down on failure', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await request(app).post(`/api/stores/${id}/health`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, healthStatus: 'down', error: expect.any(String) });
  });
});

describe('POST /api/stores/:id/reset-admin', () => {
  it('proxies the store and returns the one-time temp password', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    fetchMock.mockResolvedValue(jsonResponse(200, RESET_OK));
    const res = await request(app).post(`/api/stores/${id}/reset-admin`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tempPassword: RESET_OK.tempPassword });

    const [url, init] = lastFetch();
    expect(url).toBe('http://localhost:3299/api/internal/admin/reset');
    expect(init?.method).toBe('POST');
    expect(init?.headers?.['X-Control-Plane-Token']).toMatch(/^[0-9a-f]{64}$/);

    // Never persisted: the detail/list responses contain no temp password.
    const detail = await request(app).get(`/api/stores/${id}`).set(auth());
    expect(JSON.stringify(detail.body)).not.toContain('tempPassword');
  });

  it('fails with 502 when the store reset fails upstream', async () => {
    mockConfigureOk();
    const created = await request(app).post('/api/stores').set(auth()).send(createPayload());
    const id = (created.body as { store: { id: number } }).store.id;
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'store exploded' }));
    const res = await request(app).post(`/api/stores/${id}/reset-admin`).set(auth());
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/store exploded/i);
  });

describe('one deployment, one registry row', () => {
  it('refuses a second store on a URL that is already registered', async () => {
    const first = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 'first', baseUrl: 'http://localhost:3297' }));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 'duplicate-port', baseUrl: 'http://localhost:3297/' }));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('base_url_in_use');
    // The message names the store that already owns the URL, so the operator can act.
    expect(second.body.error).toMatch(/already registered as "first"/i);
    expect(second.body.existing).toMatchObject({ slug: 'first' });
  });
});

describe('store teardown', () => {
  it('refuses to remove an active store, pointing at pause first', async () => {
    const created = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 'live-site', baseUrl: 'http://localhost:3296' }));
    const id = created.body.store.id;

    const res = await request(app).delete(`/api/stores/${id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('store_active');
    expect(res.body.error).toMatch(/pause it first/i);

    // Still present.
    await request(app).get(`/api/stores/${id}`).set(auth()).expect(200);
  });

  it('removes a paused store and says the deployment is untouched', async () => {
    const created = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 'old-site', baseUrl: 'http://localhost:3295' }));
    const id = created.body.store.id;

    await request(app).patch(`/api/stores/${id}/pause`).set(auth()).expect(200);

    const res = await request(app).delete(`/api/stores/${id}`).set(auth()).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/deployment and data are untouched/i);

    await request(app).get(`/api/stores/${id}`).set(auth()).expect(404);
  });

  it('frees the URL for re-registration after removal', async () => {
    const created = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 'temp-site', baseUrl: 'http://localhost:3294' }));
    await request(app).patch(`/api/stores/${created.body.store.id}/pause`).set(auth()).expect(200);
    await request(app).delete(`/api/stores/${created.body.store.id}`).set(auth()).expect(200);

    // The one-deployment-one-row guard must not keep blocking a URL that is gone.
    const again = await request(app)
      .post('/api/stores')
      .set(auth())
      .send(createPayload({ slug: 're-registered', baseUrl: 'http://localhost:3294' }));
    expect(again.status).toBe(201);
  });

  it('404s for an unknown store', async () => {
    await request(app).delete('/api/stores/9999').set(auth()).expect(404);
  });
});

});
