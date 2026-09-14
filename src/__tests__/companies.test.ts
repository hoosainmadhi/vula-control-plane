import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

/**
 * Companies, plans, panels and the privacy boundary.
 *
 * The last suite is the important one: the control plane may know whether an app
 * is functioning, and must never learn how much money it is making. That rule is
 * asserted, not commented.
 */
const app = createApp();

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

let fetchMock: jest.SpyInstance;
let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith('/api/internal/status')
      ? jsonResponse(200, { ok: true, version: '9.9.9', branchCount: 3 })
      : jsonResponse(200, { ok: true, applied: { terminalCount: 1 } }),
  );
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

const makeCompany = async (over: Record<string, unknown> = {}) => {
  const planId = await planIdByCode('vula-network');
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Urban Threads Retail Group',
      slug: 'urban-threads',
      planId,
      // What the client purchased. A client with no licensed terminals cannot
      // take stores, so every fixture states the quantity up front.
      licensedTerminalCount: 25,
      ...over,
    })
    .expect(201);
  return res.body as {
    id: number;
    name: string;
    planCode: string;
    maxStores: number;
    subscription: { licensedTerminalCount: number; recurringAmountCents: number | null };
  };
};

const makeStore = async (over: Record<string, unknown> = {}) => {
  // Each store is its own deployment, so it gets its own URL — one deployment has
  // one registry row, and the API now enforces that.
  const slug = typeof over.slug === 'string' ? over.slug : 'gardens-mall';
  const res = await request(app)
    .post('/api/stores')
    .set(auth())
    .send({
      name: 'Gardens Mall',
      slug,
      terminalCount: 3,
      baseUrl: `http://localhost:3299/${slug}`,
      ...over,
    });
  return res;
};

describe('plans', () => {
  it('seeds eight editable tiers, ordered, with codes derived from their names', async () => {
    const res = await request(app).get('/api/plans').set(auth()).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((p) => p.code);
    expect(codes).toEqual([
      'vula-start',
      'vula-grow',
      'vula-branch',
      'vula-network',
      'vula-market',
      'vula-market-plus',
      'vula-market-enterprise',
      'vula-spares-network',
    ]);
  });

  it('carries the per-store terminal ceiling, feature set and per-terminal pricing', async () => {
    const res = await request(app).get('/api/plans').set(auth()).expect(200);
    const multi = (
      res.body as Array<{
        code: string;
        maxStores: number;
        maxTerminalsPerStore: number;
        features: string[];
        pricingMode: string;
        terminalPriceCents: number;
        setupFeeCents: number;
        billingPeriod: string;
      }>
    ).find((p) => p.code === 'vula-network')!;
    expect(multi.maxStores).toBe(5);
    expect(multi.maxTerminalsPerStore).toBe(3);
    expect(multi.features).toContain('multi_store');
    expect(multi.features).toContain('stock_transfers');
    // R500 per licensed terminal per month, R10,000 once-off onboarding.
    expect(multi.pricingMode).toBe('per_terminal');
    expect(multi.terminalPriceCents).toBe(50_000);
    expect(multi.setupFeeCents).toBe(1_000_000);
    expect(multi.billingPeriod).toBe('monthly');
  });

  it('prices every seeded tier per terminal — no tier is left without a rate', async () => {
    const res = await request(app).get('/api/plans').set(auth()).expect(200);
    const seeded = res.body as Array<{ code: string; pricingMode: string; terminalPriceCents: number }>;
    expect(seeded).toHaveLength(8);
    for (const plan of seeded) {
      expect({ code: plan.code, mode: plan.pricingMode }).toEqual({
        code: plan.code,
        mode: 'per_terminal',
      });
      expect(plan.terminalPriceCents).toBeGreaterThan(0);
    }
  });

  it('lets the operator edit a tier', async () => {
    const planId = await planIdByCode('vula-start');
    const res = await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ maxTerminalsPerStore: 4, features: ['advanced_reports'] })
      .expect(200);
    expect(res.body.maxTerminalsPerStore).toBe(4);
    expect(res.body.features).toEqual(['advanced_reports']);
  });

  it('creates a plan with the per-terminal model', async () => {
    const res = await request(app)
      .post('/api/plans')
      .set(auth())
      .send({
        code: 'business-plus',
        name: 'Business Plus',
        maxStores: 2,
        maxTerminalsPerStore: 6,
        pricingMode: 'per_terminal',
        terminalPriceCents: 65_000,
        setupFeeCents: 1_500_000,
        billingPeriod: 'monthly',
        features: ['customer_credit'],
      })
      .expect(201);
    expect(res.body.terminalPriceCents).toBe(65_000);
    expect(res.body.setupFeeCents).toBe(1_500_000);
    expect(res.body.pricingMode).toBe('per_terminal');
  });

  it('refuses a per-terminal plan with no rate, and non-integer money', async () => {
    const noRate = await request(app)
      .post('/api/plans')
      .set(auth())
      .send({ code: 'free-tier', name: 'Free', pricingMode: 'per_terminal', terminalPriceCents: 0 })
      .expect(400);
    expect(noRate.body.error).toMatch(/above zero/i);

    const floatMoney = await request(app)
      .post('/api/plans')
      .set(auth())
      .send({ code: 'float-tier', name: 'Float', terminalPriceCents: 499.5 })
      .expect(400);
    expect(floatMoney.body.error).toMatch(/whole number of cents/i);

    // A custom plan carries no rate at all — a negotiated deal has no formula.
    const custom = await request(app)
      .post('/api/plans')
      .set(auth())
      .send({ code: 'bespoke', name: 'Bespoke', pricingMode: 'custom', maxStores: 3 })
      .expect(201);
    expect(custom.body.pricingMode).toBe('custom');
    expect(custom.body.terminalPriceCents).toBe(0);
  });

  it('refuses to change a plan code — it is immutable after creation', async () => {
    const planId = await planIdByCode('vula-grow');
    const res = await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ code: 'renamed-tier' })
      .expect(400);
    expect(res.body.error).toContain('immutable');
  });

  it('refuses assigning an inactive (archived) plan to a new company', async () => {
    const planId = await planIdByCode('vula-start');
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ isActive: false })
      .expect(200);
    const res = await request(app)
      .post('/api/companies')
      .set(auth())
      .send({ name: 'Frozen Foods', slug: 'frozen-foods', planId })
      .expect(400);
    expect(res.body.error).toContain('inactive');
  });
});

describe('companies', () => {
  it('creates a company and reports its plan entitlement', async () => {
    const company = await makeCompany({ paidThrough: '2026-12-31' });
    expect(company.planCode).toBe('vula-network');
    expect(company.maxStores).toBe(5);
  });

  it('counts the stores it owns', async () => {
    const company = await makeCompany();
    await makeStore({ slug: 'branch-a', companyId: company.id });
    await makeStore({ slug: 'branch-b', companyId: company.id });

    const res = await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(200);
    expect(res.body.storesUsed).toBe(2);
  });

  it('derives billing state from paid-through rather than storing it', async () => {
    const company = await makeCompany({ paidThrough: '2020-01-01' });
    const res = await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(200);
    // Long overdue: past the 3-day grace, so suspended.
    expect(res.body.billingState).toBe('suspended');
    expect(res.body.note).toMatch(/grace has ended/i);
  });

  it('treats a manual suspension as an override', async () => {
    const company = await makeCompany({ paidThrough: '2030-01-01' });
    await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ status: 'suspended' })
      .expect(200);
    const res = await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(200);
    expect(res.body.billingState).toBe('suspended');
  });

  it('rejects a duplicate slug and an unknown plan', async () => {
    await makeCompany();
    const dup = await request(app)
      .post('/api/companies')
      .set(auth())
      .send({ name: 'Other', slug: 'urban-threads' })
      .expect(409);
    expect(dup.body.error).toMatch(/already exists/i);

    await request(app)
      .post('/api/companies')
      .set(auth())
      .send({ name: 'Bad', slug: 'bad', planId: 9999 })
      .expect(400);
  });
});

describe('store caps', () => {
  it('refuses a store beyond the plan cap with an upgrade message', async () => {
    const planId = await planIdByCode('vula-grow'); // 1 store, 3 tills
    const company = await makeCompany({ name: 'Spaza', slug: 'spaza', planId, licensedTerminalCount: 4 });
    // Vula Grow allows one store of up to 3 tills, so this store fits both caps.
    const first = await makeStore({ slug: 'first-store', terminalCount: 2, companyId: company.id });
    expect(first.status).toBe(201);

    const res = await makeStore({ slug: 'second-store', terminalCount: 2, companyId: company.id });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('store_cap_reached');
    expect(res.body.error).toMatch(/upgrade the plan/i);
  });

  it('refuses terminals beyond the per-store ceiling on create', async () => {
    const planId = await planIdByCode('vula-start'); // 1 terminal
    const company = await makeCompany({ name: 'Spaza', slug: 'spaza', planId, licensedTerminalCount: 20 });

    const res = await makeStore({ slug: 'big-store', terminalCount: 9, companyId: company.id });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('terminal_cap_exceeded');
    expect(res.body.error).toMatch(/allows 1 terminal/i);
  });

  it('refuses a store the client has not licensed — the purchased quantity gates capacity', async () => {
    const company = await makeCompany({ licensedTerminalCount: 2 });
    const first = await makeStore({ slug: 'licensed-store', terminalCount: 2, companyId: company.id });
    expect(first.status).toBe(201);

    const res = await makeStore({ slug: 'unlicensed-store', terminalCount: 1, companyId: company.id });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('terminal_allocation_exceeded');
    expect(res.body.error).toMatch(/licensed for 2 terminals/i);
  });

  it('refuses adding a store to a client with no licensed terminals at all', async () => {
    const company = await makeCompany({ name: 'Empty Co', slug: 'empty-co', licensedTerminalCount: 0 });
    const res = await makeStore({ slug: 'hopeful', terminalCount: 1, companyId: company.id });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('terminal_allocation_exceeded');
    expect(res.body.error).toMatch(/no licensed terminals yet/i);
  });

  it('refuses configuring more tills than the store is licensed for', async () => {
    // Vula Market: one store, up to 10 tills, so the ceiling is not what refuses here.
    const planId = await planIdByCode('vula-market');
    const company = await makeCompany({ name: 'Grocer', slug: 'grocer', planId, licensedTerminalCount: 6 });
    const created = await makeStore({ slug: 'shop', terminalCount: 2, companyId: company.id });
    const storeId = created.body.store.id;
    expect(created.body.store.licensedTerminalCount).toBe(2);

    // Raise the client's purchased quantity, then the allocation, then the
    // configured count — in that order, each step refusing what it should.
    const tooEarly = await request(app)
      .put(`/api/stores/${storeId}`)
      .set(auth())
      .send({ terminalCount: 5 })
      .expect(402);
    expect(tooEarly.body.code).toBe('terminal_allocation_exceeded');

    await request(app)
      .put(`/api/clients/${company.id}`)
      .set(auth())
      .send({ allocations: [{ storeId, licensedTerminalCount: 5 }] })
      .expect(200);

    const raised = await request(app)
      .put(`/api/stores/${storeId}`)
      .set(auth())
      .send({ terminalCount: 5 })
      .expect(200);
    expect(raised.body.terminalCount).toBe(5);
    expect(raised.body.licensedTerminalCount).toBe(5);
  });

  it('refuses a push above the store allowance even if the registry row was changed directly', async () => {
    const planId = await planIdByCode('vula-grow'); // ceiling 3
    const company = await makeCompany({ name: 'Spaza', slug: 'spaza', planId, licensedTerminalCount: 3 });
    const created = await makeStore({ slug: 'shop', terminalCount: 2, companyId: company.id });
    const storeId = created.body.store.id;

    // Simulate a row that predates the rule: raise the configured count behind
    // the API's back, exactly as a legacy registry would have it.
    const { getRegistryDb } = await import('../config/registryDb.js');
    getRegistryDb().prepare('UPDATE stores SET terminal_count = 9 WHERE id = ?').run(storeId);

    const res = await request(app).post(`/api/stores/${storeId}/push`).set(auth());
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('terminal_cap_exceeded');
  });

  it('does not cap an unassigned store', async () => {
    await makeStore({ slug: 'lonely', terminalCount: 30 });
    const res = await makeStore({ slug: 'another-lonely', terminalCount: 30 });
    expect(res.status).toBe(201);
  });
});

describe('licence claims carry the company and plan', () => {
  it('signs the company, plan and features onto the store licence', async () => {
    const company = await makeCompany({ paidThrough: '2027-01-31' });
    const created = await makeStore({ slug: 'branch', companyId: company.id });
    const storeId = created.body.store.id;

    const res = await request(app).post(`/api/stores/${storeId}/licence`).set(auth()).expect(200);
    expect(res.body.ok).toBe(true);

    // The push body is the signed token; decode it to prove the claims were filled.
    const licenceCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/internal/licence'));
    expect(licenceCall).toBeDefined();
    const sent = JSON.parse((licenceCall![1] as FetchInit).body as string) as { token: string };
    const claims = JSON.parse(Buffer.from(sent.token.split('.')[0]!, 'base64url').toString('utf-8'));

    expect(claims.companyId).toBe(company.id);
    expect(claims.companyName).toBe('Urban Threads Retail Group');
    expect(claims.planCode).toBe('vula-network');
    expect(claims.features).toContain('multi_store');
    expect(claims.maxStores).toBe(5);
    // The store's own licence: 3 terminals (the allocation created with it), and
    // the plan's per-store ceiling beside it.
    expect(claims.maxTerminals).toBe(3);
    expect(claims.maxTerminalsPerStore).toBe(3);
    expect(claims.paidThrough).toBe('2027-01-31');
    // The quantity is what the client purchased — the licence never derives it
    // from configured tills alone.
    expect(company.subscription.licensedTerminalCount).toBe(25);
    expect(company.subscription.recurringAmountCents).toBe(25 * 50_000);
  });

  it('still issues an unassigned licence when no company is set', async () => {
    const created = await makeStore({ slug: 'orphan' });
    await request(app).post(`/api/stores/${created.body.store.id}/licence`).set(auth()).expect(200);
    const licenceCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/internal/licence'));
    const sent = JSON.parse((licenceCall![1] as FetchInit).body as string) as { token: string };
    const claims = JSON.parse(Buffer.from(sent.token.split('.')[0]!, 'base64url').toString('utf-8'));
    expect(claims.planCode).toBe('unassigned');
    expect(claims.companyId).toBeNull();
  });
});

describe('panels', () => {
  const makePanel = async (companyId: number, over: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post('/api/panels')
      .set(auth())
      .send({
        companyId,
        name: 'Urban Threads Company Control Panel',
        slug: 'urban-threads-ho',
        baseUrl: 'http://localhost:3260',
        ...over,
      });
    return res;
  };

  it('registers a panel against a company and delivers its licence', async () => {
    const company = await makeCompany({ paidThrough: '2027-01-31' });
    const res = await makePanel(company.id);
    expect(res.status).toBe(201);
    expect(res.body.panel.companyName).toBe('Urban Threads Retail Group');
    expect(res.body.panel.planCode).toBe('vula-network');
    expect(res.body.firstLicence.ok).toBe(true);
  });

  it('generates the token when none is supplied and never returns it', async () => {
    const company = await makeCompany();
    const res = await makePanel(company.id);
    expect(JSON.stringify(res.body)).not.toContain('controlPlaneToken');
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/internal/licence'));
    expect((sent![1] as FetchInit).headers?.['X-Control-Plane-Token']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records health and the reported version', async () => {
    const company = await makeCompany();
    const created = await makePanel(company.id);
    const panelId = created.body.panel.id;

    const res = await request(app).post(`/api/panels/${panelId}/health`).set(auth()).expect(200);
    expect(res.body.healthStatus).toBe('up');

    const after = await request(app).get(`/api/panels/${panelId}`).set(auth()).expect(200);
    expect(after.body.lastHealthStatus).toBe('up');
    expect(after.body.appVersion).toBe('9.9.9');
  });

  it('reports a panel as down when it is unreachable', async () => {
    const company = await makeCompany();
    const created = await makePanel(company.id);
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await request(app).post(`/api/panels/${created.body.panel.id}/health`).set(auth());
    expect(res.body.healthStatus).toBe('down');
  });

  it('rejects an unknown company and a duplicate slug', async () => {
    await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ companyId: 9999, name: 'X', slug: 'x', baseUrl: 'http://localhost:3260' })
      .expect(400);

    const company = await makeCompany();
    await makePanel(company.id);
    await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ companyId: company.id, name: 'Dup', slug: 'urban-threads-ho', baseUrl: 'http://localhost:3260' })
      .expect(409);
  });
});

describe('privacy boundary', () => {
  /**
   * The control plane may know whether an application is functioning. It must
   * never learn how much money it is making. This asserts the API surface, not
   * the React tree, because §40 requires the boundary to exist server-side.
   */
  /**
   * Match field NAMES, not raw substrings: a plan legitimately has a
   * `customer_credit` feature key, and a company has a `companyName` — neither is
   * client business data. What must never appear is a field carrying the
   * merchant's trading figures.
   */
  const FORBIDDEN_KEY = /revenue|sales|profit|margin|cashup|order|customer_?count|basket|payment|invoice|stock_?value|cost|debtor|loyalty|tender|transaction/i;

  const collectKeys = (node: unknown, into: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(node)) {
      for (const item of node) collectKeys(item, into);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        into.add(key);
        collectKeys(value, into);
      }
    }
    return into;
  };

  const assertNoBusinessData = (payload: unknown): void => {
    for (const key of collectKeys(payload)) {
      expect(key).not.toMatch(FORBIDDEN_KEY);
    }
  };

  it('never returns business fields from the fleet, panel or company endpoints', async () => {
    const company = await makeCompany({ paidThrough: '2027-01-31' });
    await makeStore({ slug: 'branch', companyId: company.id });
    await request(app)
      .post('/api/panels')
      .set(auth())
      .send({
        companyId: company.id,
        name: 'Panel',
        slug: 'panel-one',
        baseUrl: 'http://localhost:3260',
      })
      .expect(201);

    for (const path of ['/api/stores', '/api/panels', '/api/companies', '/api/plans']) {
      const res = await request(app).get(path).set(auth()).expect(200);
      assertNoBusinessData(res.body);
    }
  });

  it('never leaks the control-plane token from any list or detail endpoint', async () => {
    const company = await makeCompany();
    const created = await makeStore({ slug: 'branch', companyId: company.id });
    await request(app).post(`/api/stores/${created.body.store.id}/licence`).set(auth()).expect(200);

    for (const path of ['/api/stores', `/api/stores/${created.body.store.id}`]) {
      const res = await request(app).get(path).set(auth()).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('controlPlaneToken');
      expect(JSON.stringify(res.body)).not.toContain('control_plane_token');
    }
  });
});

describe('migration compatibility', () => {
  it('keeps a pre-existing store row working after companies are introduced', async () => {
    // Simulate a registry written before companies existed: a store with no
    // company_id, created directly in the registry, must still list and licence.
    const { getRegistryDb } = await import('../config/registryDb.js');
    getRegistryDb()
      .prepare(
        `INSERT INTO stores (slug, name, vertical, terminal_count, base_url, control_plane_token, company_id)
         VALUES ('legacy-store', 'Legacy Store', 'general', 2, 'http://localhost:3298', 'ab', NULL)`,
      )
      .run();

    const list = await request(app).get('/api/stores').set(auth()).expect(200);
    const legacy = (list.body as Array<{ slug: string; companyName: string; planName: string }>).find(
      (s) => s.slug === 'legacy-store',
    );
    expect(legacy).toBeDefined();
    expect(legacy!.companyName).toBe('');
    expect(legacy!.planName).toBe('Unassigned');
  });

describe('deleting a company', () => {
  it('deletes a company that owns nothing', async () => {
    const company = await makeCompany({ name: 'Mistake Ltd', slug: 'mistake-ltd' });
    const res = await request(app).delete(`/api/companies/${company.id}`).set(auth()).expect(200);
    expect(res.body.ok).toBe(true);
    await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(404);
  });

  it('refuses while it still owns stores, naming the blocker', async () => {
    const company = await makeCompany();
    await makeStore({ slug: 'branch', companyId: company.id });

    const res = await request(app).delete(`/api/companies/${company.id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('company_in_use');
    expect(res.body.error).toMatch(/1 store/i);
    // Steering to suspend rather than delete, so history survives.
    expect(res.body.error).toMatch(/suspend it instead/i);
    expect(res.body.blockers).toEqual({ stores: 1, panels: 0 });
  });

  it('refuses while it still owns a Head Office', async () => {
    const company = await makeCompany();
    await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ companyId: company.id, name: 'Panel', slug: 'ho-one', baseUrl: 'http://localhost:3260' })
      .expect(201);

    const res = await request(app).delete(`/api/companies/${company.id}`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 Head Office/i);
  });

  it('allows deletion once the blockers are gone, without cascading anything away', async () => {
    const company = await makeCompany();
    const created = await makeStore({ slug: 'branch', companyId: company.id });
    const panel = await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ companyId: company.id, name: 'Panel', slug: 'ho-two', baseUrl: 'http://localhost:3260' })
      .expect(201);

    // Detach the store (as the store modal does) and remove the panel.
    await request(app)
      .put(`/api/stores/${created.body.store.id}`)
      .set(auth())
      .send({ companyId: null })
      .expect(200);
    await request(app).delete(`/api/panels/${panel.body.panel.id}`).set(auth()).expect(200);

    await request(app).delete(`/api/companies/${company.id}`).set(auth()).expect(200);

    // The store survives, just unassigned — nothing silently disappeared.
    const store = await request(app).get(`/api/stores/${created.body.store.id}`).set(auth()).expect(200);
    expect(store.body.companyId).toBeNull();
    expect(store.body.planName).toBe('Unassigned');
  });

  it('404s for an unknown company', async () => {
    await request(app).delete('/api/companies/9999').set(auth()).expect(404);
  });
});

describe('the fleet is self-describing', () => {
  /**
   * Both apps identify on their public /health, so the control plane refuses a
   * registration that points a row at the wrong kind of application. That mistake
   * can never authenticate and otherwise sits there showing "Down".
   */
  const mockHealth = (body: unknown): void => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/health')
        ? jsonResponse(200, body)
        : jsonResponse(200, { ok: true, applied: { terminalCount: 1 } }),
    );
  };

  it('refuses a store row pointed at a Head Office', async () => {
    mockHealth({ ok: true, service: 'vula-head-office', version: '1.0.0' });
    const res = await makeStore({ slug: 'wrong-kind-store' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('wrong_app_kind');
    expect(res.body.error).toMatch(/is a Head Office deployment, not a store/i);
  });

  it('refuses a Head Office row pointed at a store', async () => {
    const company = await makeCompany();
    mockHealth({ status: 'ok', app: 'vula', version: '0.2.0' });
    const res = await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ companyId: company.id, name: 'Misplaced HO', slug: 'misplaced', baseUrl: 'http://localhost:3250' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('wrong_app_kind');
    expect(res.body.error).toMatch(/is a store deployment, not a Head Office/i);
  });

  it('allows registration when the deployment is not up yet', async () => {
    // Creating the registry row can precede deploying the container, so an
    // unreachable URL must not block onboarding.
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await makeStore({ slug: 'not-up-yet' });
    expect(res.status).toBe(201);
  });

  it('allows a correctly identified store and Head Office', async () => {
    mockHealth({ status: 'ok', app: 'vula', version: '0.2.0' });
    const store = await makeStore({ slug: 'right-kind-store' });
    expect(store.status).toBe(201);

    const company = await makeCompany();
    mockHealth({ ok: true, service: 'vula-head-office', version: '1.0.0' });
    const panel = await request(app)
      .post('/api/panels')
      .set(auth())
      .send({ companyId: company.id, name: 'Real HO', slug: 'real-ho', baseUrl: 'http://localhost:3260' });
    expect(panel.status).toBe(201);
  });
});

});
