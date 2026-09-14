import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

/**
 * The subscription model (2026-09-13): what a client purchased, where those
 * licences sit, and the four terminal quantities that must never be confused.
 *
 *   licensed   — purchased; the ONLY basis for the recurring fee
 *   configured — terminal slots the POS is told to run (≤ licensed)
 *   claimed    — device bindings at the register
 *   open       — trading sessions running now
 *
 * The independence assertions matter most: device state changes minute to
 * minute, and what a client pays must not.
 */
const app = createApp();

let fetchMock: jest.SpyInstance;
let token = '';

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string) => {
    const s = String(url);
    if (s.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, version: '9.9.9' });
    }
    if (s.endsWith('/api/internal/telemetry')) {
      return jsonResponse(200, {
        ok: true,
        app: 'vula',
        version: '9.9.9',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        sync: { lastSyncAt: new Date().toISOString(), pendingEvents: 0, failedEvents: 0 },
        terminals: [
          { till: 1, name: 'Till 1', claimed: true, deviceId: 'dev-a', sessionOpen: true, lastSeenAt: new Date().toISOString() },
          { till: 2, name: 'Till 2', claimed: true, deviceId: 'dev-b', sessionOpen: false, lastSeenAt: new Date().toISOString() },
        ],
      });
    }
    if (s.endsWith('/api/internal/licence')) {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(200, { ok: true, applied: { terminalCount: 2 } });
  });
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

const planIdByCode = async (code: string): Promise<number> => {
  const res = await request(app).get('/api/plans').set(auth()).expect(200);
  const plan = (res.body as Array<{ id: number; code: string }>).find((p) => p.code === code);
  expect(plan).toBeDefined();
  return plan!.id;
};

let seq = 0;
const makeCompany = async (over: Record<string, unknown> = {}) => {
  const planId = (over.planId as number | undefined) ?? (await planIdByCode('multi-store'));
  const slug = typeof over.slug === 'string' ? over.slug : `client-${++seq}`;
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Urban Threads',
      slug,
      planId,
      paidThrough: '2027-01-31',
      licensedTerminalCount: 9,
      ...over,
    })
    .expect(201);
  return res.body as {
    id: number;
    name: string;
    subscription: {
      licensedTerminalCount: number;
      allocatedTerminals: number;
      unallocatedTerminals: number;
      recurringAmountCents: number | null;
      rateCents: number;
      setupFeeStatus: string;
      allocations: Array<{ storeId: number; licensedTerminalCount: number }>;
    };
  };
};

const makeStore = (over: Record<string, unknown> = {}) => {
  const slug = typeof over.slug === 'string' ? over.slug : `store-${++seq}`;
  return request(app)
    .post('/api/stores')
    .set(auth())
    .send({
      name: `Store ${seq}`,
      slug,
      terminalCount: 2,
      baseUrl: `http://localhost:3299/${slug}`,
      ...over,
    });
};

const decodedLicenceClaims = (): {
  maxTerminals?: number;
  maxTerminalsPerStore: number;
  planCode: string;
} => {
  const call = fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith('/api/internal/licence'))
    .pop();
  expect(call).toBeDefined();
  const sent = JSON.parse((call![1] as FetchInit).body as string) as { token: string };
  return JSON.parse(Buffer.from(sent.token.split('.')[0]!, 'base64url').toString('utf-8'));
};

describe('a client purchases terminal licences', () => {
  it('allocates the terminals a store is created with, and reports licensed vs allocated', async () => {
    const company = await makeCompany({ licensedTerminalCount: 9 });
    const cape = await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then(
      (r) => r.body.store as { id: number; licensedTerminalCount: number },
    );
    const durban = await makeStore({ slug: 'durban', terminalCount: 2, companyId: company.id }).then(
      (r) => r.body.store as { id: number; licensedTerminalCount: number },
    );
    expect(cape.licensedTerminalCount).toBe(3);
    expect(durban.licensedTerminalCount).toBe(2);

    const detail = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.licensedTerminalCount).toBe(9);
    expect(detail.body.subscription.allocatedTerminals).toBe(5);
    expect(detail.body.subscription.unallocatedTerminals).toBe(4);
    expect(detail.body.subscription.rateCents).toBe(50_000);
    expect(detail.body.subscription.recurringAmountCents).toBe(9 * 50_000);
    // The allocation list names the stores, so the office can see 3 / 2 / 4.
    const bySlug = new Map(
      (detail.body.subscription.allocations as Array<{
        storeSlug: string;
        licensedTerminalCount: number;
      }>).map((a) => [a.storeSlug, a.licensedTerminalCount]),
    );
    expect(bySlug.get('cape-town')).toBe(3);
    expect(bySlug.get('durban')).toBe(2);
  });

  it('refuses an allocation the client has not bought, naming the shortfall', async () => {
    const company = await makeCompany({ licensedTerminalCount: 4 });
    await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then((r) =>
      expect(r.status).toBe(201),
    );

    const res = await makeStore({ slug: 'durban', terminalCount: 3, companyId: company.id });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('terminal_allocation_exceeded');
    expect(res.body.error).toMatch(/licensed for 4 terminals/i);
    expect(res.body.error).toMatch(/only 1 free/i);
  });

  it('refuses an allocation above the plan ceiling even when the licence total would allow it', async () => {
    const planId = await planIdByCode('multi-store'); // ceiling 10 per store
    const company = await makeCompany({ planId, licensedTerminalCount: 40 });
    const res = await makeStore({ slug: 'mega', terminalCount: 11, companyId: company.id });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('terminal_cap_exceeded');
    expect(res.body.error).toMatch(/allows 10 terminals per store/i);
  });

  it('lets the office reallocate between branches, and refuses a total it did not buy', async () => {
    const company = await makeCompany({ licensedTerminalCount: 6 });
    const cape = await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then(
      (r) => r.body.store as { id: number },
    );
    const durban = await makeStore({ slug: 'durban', terminalCount: 2, companyId: company.id }).then(
      (r) => r.body.store as { id: number },
    );

    // Cape Town gives one to Durban: 2 / 3, still 5 of 6 allocated.
    const ok = await request(app)
      .put(`/api/clients/${company.id}`)
      .set(auth())
      .send({
        allocations: [
          { storeId: cape.id, licensedTerminalCount: 2 },
          { storeId: durban.id, licensedTerminalCount: 3 },
        ],
      })
      .expect(200);
    expect(ok.body.allocatedTerminals).toBe(5);

    const tooBig = await request(app)
      .put(`/api/clients/${company.id}`)
      .set(auth())
      .send({
        allocations: [
          { storeId: cape.id, licensedTerminalCount: 5 },
          { storeId: durban.id, licensedTerminalCount: 4 },
        ],
      })
      .expect(402);
    expect(tooBig.body.code).toBe('terminal_allocation_exceeded');
  });

  it('sends each branch a licence with its own allowance', async () => {
    const company = await makeCompany({ licensedTerminalCount: 9 });
    await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).expect(201);
    await makeStore({ slug: 'durban', terminalCount: 2, companyId: company.id }).expect(201);

    // Cape Town's licence (the last push for the store created before Durban).
    const claims = decodedLicenceClaims();
    expect(claims.maxTerminals).toBe(2);
    // The plan's ceiling is still carried, and is not the same thing.
    expect(claims.maxTerminalsPerStore).toBe(10);
  });
});

describe('the fee follows the purchased quantity, not device state', () => {
  it('does not move when the store is configured for a different number of tills', async () => {
    const company = await makeCompany({ licensedTerminalCount: 9 });
    const store = await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then(
      (r) => r.body.store as { id: number },
    );
    const before = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(before.body.subscription.recurringAmountCents).toBe(9 * 50_000);

    // One fewer configured till — a service change, not a commercial one.
    await request(app)
      .put(`/api/stores/${store.id}`)
      .set(auth())
      .send({ terminalCount: 2 })
      .expect(200);

    const after = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(after.body.subscription.recurringAmountCents).toBe(9 * 50_000);
    expect(after.body.subscription.licensedTerminalCount).toBe(9);
  });

  it('does not move when devices are claimed and tills are opened', async () => {
    const company = await makeCompany({ licensedTerminalCount: 3 });
    const store = await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then(
      (r) => r.body.store as { id: number },
    );
    // The telemetry mock reports two claimed devices and one open till.
    const health = await request(app)
      .post(`/api/stores/${store.id}/health`)
      .set(auth())
      .expect(200);
    expect(health.body.ok).toBe(true);

    const storeOut = await request(app).get(`/api/stores/${store.id}`).set(auth()).expect(200);
    expect(storeOut.body.telemetry.terminals.claimed).toBeGreaterThanOrEqual(1);
    expect(storeOut.body.telemetry.terminals.open).toBeGreaterThanOrEqual(1);

    const client = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(client.body.subscription.recurringAmountCents).toBe(3 * 50_000);
    expect(client.body.subscription.licenceQuantitySource).toBeUndefined();
  });

  it('re-pushes licences with a new allowance when the purchased quantity changes', async () => {
    const company = await makeCompany({ licensedTerminalCount: 3 });
    const store = await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then(
      (r) => r.body.store as { id: number },
    );
    expect(decodedLicenceClaims().maxTerminals).toBe(3);

    await request(app)
      .put(`/api/clients/${company.id}`)
      .set(auth())
      .send({ licensedTerminalCount: 5, allocations: [{ storeId: store.id, licensedTerminalCount: 5 }] })
      .expect(200);

    // The store now holds a licence that permits five terminals.
    expect(decodedLicenceClaims().maxTerminals).toBe(5);
    const out = await request(app).get(`/api/stores/${store.id}`).set(auth()).expect(200);
    expect(out.body.licensedTerminalCount).toBe(5);
  });

  it('keeps an unassigned store on its configured count rather than blocking it', async () => {
    const created = await makeStore({ slug: 'lonely', terminalCount: 4 }).expect(201);
    const storeId = created.body.store.id;
    await request(app).post(`/api/stores/${storeId}/licence`).set(auth()).expect(200);
    const claims = decodedLicenceClaims();
    expect(claims.planCode).toBe('unassigned');
    expect(claims.maxTerminals).toBe(4);
  });
});

describe('single store to multi-store upgrade keeps the subscription coherent', () => {
  it('adds the new branch to the purchased total without touching the original store', async () => {
    const company = await makeCompany({ licensedTerminalCount: 3 });
    const cape = await makeStore({ slug: 'cape-town', terminalCount: 3, companyId: company.id }).then(
      (r) => r.body.store as { id: number; baseUrl: string },
    );

    // Add a branch: the client buys 2 more licences (3 + 2 = 5).
    const res = await request(app)
      .post(`/api/clients/${company.id}/upgrade-to-multistore`)
      .set(auth())
      .send({
        headOffice: { name: 'Urban Threads HO', baseUrl: 'http://localhost:3260' },
        newStore: {
          name: 'Durban',
          slug: 'durban',
          baseUrl: 'http://localhost:3299/durban',
          terminalCount: 2,
          licensedTerminalCount: 2,
        },
        planId: await planIdByCode('multi-store'),
        allocations: [{ storeId: cape.id, licensedTerminalCount: 3 }],
      })
      .expect(200);

    expect(res.body.client.licensedTerminalCount).toBe(5);
    expect(res.body.client.allocatedTerminals).toBe(5);

    // Cape Town is untouched: same URL, same database, same licence allowance.
    const original = await request(app).get(`/api/stores/${cape.id}`).set(auth()).expect(200);
    expect(original.body.baseUrl).toBe(cape.baseUrl);
    expect(original.body.licensedTerminalCount).toBe(3);

    const durban = (res.body.steps as Array<{ step_key: string; resource_id: number | null }>).find(
      (s) => s.step_key === 'store_deploy_durban',
    );
    expect(durban).toBeDefined();
  });
});
