import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

/**
 * L4 enforcement — plans stop being informational.
 *
 * Three layers are pinned here, all on the control-plane (authority) side:
 *  1. the curated feature vocabulary — a plan may only grant the six known keys;
 *  2. the CP-side gates — multi-store orchestration needs `multi_store`, and a
 *     suspended subscription buys no new capacity;
 *  3. propagation — an entitlement change re-pushes licences immediately, so a
 *     suspension reaches the registers in seconds instead of at the next sweep.
 * The register states (ok/warn/grace/suspended) are surfaced alongside.
 */
const app = createApp();

let fetchMock: jest.SpyInstance;
let token = '';

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
    if (s.endsWith('/api/internal/licence')) {
      return jsonResponse(200, { ok: true });
    }
    if (s.endsWith('/health')) {
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(200, { ok: true, applied: { terminalCount: 3 } });
  });
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

const licenceCalls = (): number =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/internal/licence')).length;

const planIdByCode = async (code: string): Promise<number> => {
  const res = await request(app).get('/api/plans').set(auth()).expect(200);
  const plan = (res.body as Array<{ id: number; code: string }>).find((p) => p.code === code);
  expect(plan).toBeDefined();
  return plan!.id;
};

const daysFromToday = (n: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let companySeq = 0;

const makeCompany = async (over: Record<string, unknown> = {}) => {
  const planId = over.planId !== undefined ? over.planId : await planIdByCode('multi-store');
  const slug = typeof over.slug === 'string' ? over.slug : `urban-threads-${++companySeq}`;
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({ name: 'Urban Threads Retail Group', slug, planId, ...over })
    .expect(201);
  return res.body as {
    id: number;
    registerState: string;
    tradingBlocked: boolean;
    billingState: string;
  };
};

const makeStore = (over: Record<string, unknown> = {}) => {
  const slug = typeof over.slug === 'string' ? over.slug : 'gardens-mall';
  return request(app)
    .post('/api/stores')
    .set(auth())
    .send({
      name: 'Gardens Mall',
      slug,
      terminalCount: 3,
      baseUrl: `http://localhost:3299/${slug}`,
      ...over,
    });
};

describe('feature vocabulary', () => {
  it('serves the six curated keys with labels', async () => {
    const res = await request(app).get('/api/plans/features').set(auth()).expect(200);
    const keys = (res.body as Array<{ key: string }>).map((f) => f.key);
    expect(keys).toEqual([
      'customer_credit',
      'advanced_reports',
      'multi_store',
      'stock_transfers',
      'ecommerce_bridges',
      'ai_assistant',
    ]);
    expect(res.body[0]).toMatchObject({ label: expect.any(String), enforcedBy: expect.any(Array) });
  });

  it('refuses a plan granting an unknown feature key, naming it', async () => {
    const res = await request(app)
      .post('/api/plans')
      .set(auth())
      .send({
        code: 'wild-west',
        name: 'Wild West',
        features: ['customer_credit', 'unlimited_cash'],
      })
      .expect(400);
    expect(res.body.error).toContain('unlimited_cash');
    expect(res.body.error).toContain('multi_store');
  });

  it('refuses an unknown key on edit but accepts the known ones', async () => {
    const planId = await planIdByCode('starter');
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ features: ['loyalty_points'] })
      .expect(400);
    const res = await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ features: ['advanced_reports', 'customer_credit'] })
      .expect(200);
    // Stored in vocabulary order, so licences carry a deterministic feature list.
    expect(res.body.features).toEqual(['customer_credit', 'advanced_reports']);
  });
});

describe('multi-store feature gate', () => {
  it('refuses multi-store onboarding for a plan without multi_store (402 feature_not_in_plan)', async () => {
    const starterId = await planIdByCode('starter');
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Tiny Shop',
        slug: 'tiny-shop',
        planId: starterId,
        deploymentType: 'multi_store',
        headOffice: { name: 'Tiny HO', slug: 'tiny-shop-ho', baseUrl: 'http://localhost:3260' },
        stores: [{ slug: 'tiny-shop-1', baseUrl: 'http://localhost:3245' }],
        autoDeploy: false,
      })
      .expect(402);
    expect(res.body.code).toBe('feature_not_in_plan');
    expect(res.body.error).toContain('multi_store');

    // The refusal happens before anything is created.
    const list = await request(app).get('/api/clients').set(auth()).expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('refuses a no-plan company upgrading to multi-store, then allows it with the plan upgrade', async () => {
    const company = await makeCompany({ planId: null });
    const refused = await request(app)
      .post(`/api/clients/${company.id}/upgrade-to-multistore`)
      .set(auth())
      .send({ headOffice: { slug: 'urban-threads-ho', baseUrl: 'http://localhost:3260' } })
      .expect(402);
    expect(refused.body.code).toBe('feature_not_in_plan');

    const allowed = await request(app)
      .post(`/api/clients/${company.id}/upgrade-to-multistore`)
      .set(auth())
      .send({
        planId: await planIdByCode('multi-store'),
        headOffice: { slug: 'urban-threads-ho', baseUrl: 'http://localhost:3260' },
      })
      .expect(200);
    expect(allowed.body.ok).toBe(true);
  });
});

describe('suspended companies get no new capacity', () => {
  it('refuses creating a store for a suspended company (402 subscription_suspended)', async () => {
    const company = await makeCompany({ paidThrough: '2020-01-01' });
    const res = await makeStore({ companyId: company.id }).expect(402);
    expect(res.body.code).toBe('subscription_suspended');
  });

  it('allows store creation while only past due (grace keeps trading)', async () => {
    const company = await makeCompany({ paidThrough: daysFromToday(-1) });
    expect(company.billingState).toBe('past_due');
    await makeStore({ slug: 'grace-branch', companyId: company.id }).expect(201);
  });

  it('refuses a terminal increase but allows a same-count edit', async () => {
    const company = await makeCompany({ paidThrough: daysFromToday(30) });
    await makeStore({ slug: 'susp-branch', companyId: company.id }).expect(201);
    // Suspend by moving paid-through far into the past (also exercises propagation).
    await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ paidThrough: '2020-01-01' })
      .expect(200);

    const storeId = (await request(app).get('/api/stores').set(auth()).expect(200)).body.find(
      (s: { slug: string }) => s.slug === 'susp-branch',
    ).id;

    const refused = await request(app)
      .put(`/api/stores/${storeId}`)
      .set(auth())
      .send({ terminalCount: 5 })
      .expect(402);
    expect(refused.body.code).toBe('subscription_suspended');

    // Same-count pushes and unrelated edits stay allowed — config and licence
    // delivery is how the store learns it has been unsuspended.
    await request(app)
      .put(`/api/stores/${storeId}`)
      .set(auth())
      .send({ terminalCount: 3, name: 'Gardens Mall Renamed' })
      .expect(200);
  });
});

describe('entitlement changes propagate licences immediately', () => {
  it('re-pushes licences to stores and the panel when the entitlement changes', async () => {
    const company = await makeCompany({ paidThrough: daysFromToday(30) });
    await makeStore({ slug: 'prop-branch', companyId: company.id }).expect(201);
    await request(app)
      .post('/api/panels')
      .set(auth())
      .send({
        companyId: company.id,
        name: 'Urban Threads Head Office',
        slug: 'urban-threads-ho',
        baseUrl: 'http://localhost:3260',
      })
      .expect(201);

    const before = licenceCalls();
    const res = await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ status: 'suspended' })
      .expect(200);
    expect(res.body.licencePush).toEqual({ storesUpdated: 1, panelsUpdated: 1, errors: [] });
    expect(licenceCalls()).toBe(before + 2);
    expect(res.body.tradingBlocked).toBe(true);
  });

  it('does not push licences when nothing entitlement-bearing changed', async () => {
    const company = await makeCompany({ paidThrough: daysFromToday(30) });
    const before = licenceCalls();
    const res = await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ name: 'Urban Threads (Pty) Ltd' })
      .expect(200);
    expect(res.body.licencePush).toBeNull();
    expect(licenceCalls()).toBe(before);
  });

  it('still succeeds when a store is unreachable — delivery failures are reported, not fatal', async () => {
    const company = await makeCompany({ paidThrough: daysFromToday(30) });
    await makeStore({ slug: 'dead-branch', companyId: company.id }).expect(201);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/internal/licence')) {
        throw new TypeError('fetch failed');
      }
      return jsonResponse(200, { ok: true, applied: { terminalCount: 3 } });
    });
    const res = await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ status: 'suspended' })
      .expect(200);
    expect(res.body.licencePush.storesUpdated).toBe(0);
    expect(res.body.licencePush.errors).toHaveLength(1);
  });
});

describe('register states surfaced to the office', () => {
  interface CompanyOut {
    registerState: string;
    tradingBlocked: boolean;
  }

  const stateFor = async (over: Record<string, unknown>): Promise<CompanyOut> => {
    const company = await makeCompany(over);
    const res = await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(200);
    const { registerState, tradingBlocked } = res.body as CompanyOut;
    return { registerState, tradingBlocked };
  };

  it('maps paid-through windows to register states', async () => {
    expect(await stateFor({ paidThrough: daysFromToday(30) })).toEqual({
      registerState: 'ok',
      tradingBlocked: false,
    });
    expect(await stateFor({ paidThrough: daysFromToday(2) })).toEqual({
      registerState: 'warn',
      tradingBlocked: false,
    });
    expect(await stateFor({ paidThrough: daysFromToday(-1) })).toEqual({
      registerState: 'grace',
      tradingBlocked: false,
    });
    expect(await stateFor({ paidThrough: '2020-01-01' })).toEqual({
      registerState: 'suspended',
      tradingBlocked: true,
    });
  });

  it('passes trial companies through and keeps a no-plan company trading', async () => {
    expect(await stateFor({ trialEndsAt: daysFromToday(10), planId: null })).toEqual({
      registerState: 'trial',
      tradingBlocked: false,
    });
    // L2 doctrine: a company without a plan or paid-through date derives active
    // (Starter caps fallback) — so the register keeps trading, features empty.
    expect(await stateFor({ planId: null })).toEqual({
      registerState: 'ok',
      tradingBlocked: false,
    });
  });

  it('marks a store with no company as unlicensed', async () => {
    await makeStore({ slug: 'lone-branch' }).expect(201);
    const list = await request(app).get('/api/stores').set(auth()).expect(200);
    const store = (
      list.body as Array<{ slug: string; registerState: string; tradingBlocked: boolean }>
    ).find((s) => s.slug === 'lone-branch')!;
    expect(store.registerState).toBe('unlicensed');
    expect(store.tradingBlocked).toBe(false);
  });

  it('mirrors the register state on the store list', async () => {
    // The create is refused while suspended, so suspend a healthy one instead.
    const healthy = await makeCompany({ slug: 'healthy-co', paidThrough: daysFromToday(30) });
    await makeStore({ slug: 'mirror-branch', companyId: healthy.id }).expect(201);
    await request(app)
      .put(`/api/companies/${healthy.id}`)
      .set(auth())
      .send({ paidThrough: '2020-01-01' })
      .expect(200);

    const list = await request(app).get('/api/stores').set(auth()).expect(200);
    const store = (
      list.body as Array<{ slug: string; registerState: string; tradingBlocked: boolean }>
    ).find((s) => s.slug === 'mirror-branch')!;
    expect(store.registerState).toBe('suspended');
    expect(store.tradingBlocked).toBe(true);
  });
});
