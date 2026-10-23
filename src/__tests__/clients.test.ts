import request from 'supertest';
import { createApp } from '../app.js';
import {
  createCompany,
  createStore,
  listStores,
  resetRegistryDb,
  setStoreCompany,
} from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

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
    if (s.endsWith('/api/internal/status') || s.endsWith('/api/internal/control/status')) {
      return jsonResponse(200, { ok: true, version: '0.3.0', terminalCount: 2 });
    }
    if (s.endsWith('/api/internal/licence') || s.endsWith('/api/internal/control/licence')) {
      return jsonResponse(200, { ok: true, licenceSequence: 1 });
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

/** The seeded multi-store plan id — multi-store topology is a plan feature (L4). */
const multiStorePlanId = (): Promise<number> => planIdByCode('vula-network');

describe('Client-Centric Management & Orchestration (§1, §5, §6, §7)', () => {
  it('creates and deploys a single-store client via onboarding wizard (§5)', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Gardens Pharmacy',
        slug: 'gardens-pharmacy',
        billingEmail: 'billing@gardenspharmacy.co.za',
        deploymentType: 'single_store',
        stores: [
          {
            name: 'Gardens Pharmacy Main',
            slug: 'gardens-pharmacy-main',
            baseUrl: 'http://localhost:3245',
            terminalCount: 2,
            adminEmail: 'manager@gardenspharmacy.co.za',
          },
        ],
        autoDeploy: false, // Don't attempt real Coolify API in unit test
      })
      .expect(201);

    expect(res.body.client.name).toBe('Gardens Pharmacy');
    expect(res.body.client.slug).toBe('gardens-pharmacy');
    expect(res.body.client.topology).toBe('single_store');
    expect(res.body.client.storesCount).toBe(1);
    expect(res.body.client.headOffice).toBeNull();

    expect(res.body.job.id).toBeDefined();
    expect(res.body.job.type).toBe('new_single_store_client');
    expect(res.body.steps.length).toBeGreaterThanOrEqual(3);

    // Verify client detail endpoint
    const detail = await request(app)
      .get(`/api/clients/${res.body.client.id}`)
      .set(auth())
      .expect(200);

    expect(detail.body.client.name).toBe('Gardens Pharmacy');
    // The client LIST carries light store rows so the client card can link
    // straight into each store (stores are reached through the client).
    const list = await request(app).get('/api/clients').set(auth()).expect(200);
    const listed = (
      list.body as Array<{ slug: string; stores: Array<{ slug: string; healthState: string }> }>
    ).find((c) => c.slug === 'gardens-pharmacy');
    expect(listed?.stores.map((st) => st.slug)).toEqual(['gardens-pharmacy-main']);
    expect(listed?.stores[0].healthState).toBeDefined();

    expect(detail.body.stores.length).toBe(1);
    expect(detail.body.stores[0].slug).toBe('gardens-pharmacy-main');
    // Full SPOG shape embedded (same as GET /api/stores) so the client's
    // Stores tab renders the shared store cards.
    expect(detail.body.stores[0].healthState).toBeDefined();
    expect(detail.body.stores[0].configState).toBeDefined();
    expect(detail.body.stores[0].terminalNames).toBeDefined();
    expect(detail.body.headOffice).toBeNull();
  });

  it('preserves the requested deploymentName through onboarding', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Naming Client',
        slug: 'naming-client',
        deploymentType: 'single_store',
        autoDeploy: false,
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

    const store = listStores().find((s) => s.slug === 'naming-store');
    expect(store?.deployment_name).toBe('m4-store-a');
    const step = (res.body.steps as Array<{ step_key: string; metadata_json: string | null }>).find(
      (s) => s.step_key === 'store_deploy_naming-store',
    );
    expect(step).toBeDefined();
    expect(JSON.parse(step!.metadata_json!).deploymentName).toBe('m4-store-a');
  });

  it('creates and deploys a multi-store client with Head Office and multiple branches (§6)', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Urban Threads Group',
        slug: 'urban-threads',
        billingEmail: 'accounts@urbanthreads.co.za',
        planId: await multiStorePlanId(),
        deploymentType: 'multi_store',
        headOffice: {
          name: 'Urban Threads Head Office',
          slug: 'urban-threads-ho',
          baseUrl: 'http://localhost:3260',
          adminEmail: 'executive@urbanthreads.co.za',
        },
        stores: [
          {
            name: 'Cape Town Store',
            slug: 'urban-threads-cpt',
            baseUrl: 'http://localhost:3245',
            terminalCount: 3,
          },
          {
            name: 'Durban Store',
            slug: 'urban-threads-dbn',
            baseUrl: 'http://localhost:3246',
            terminalCount: 2,
          },
        ],
        autoDeploy: false,
      })
      .expect(201);

    expect(res.body.client.name).toBe('Urban Threads Group');
    expect(res.body.client.topology).toBe('multi_store');
    expect(res.body.client.storesCount).toBe(2);
    expect(res.body.client.totalTills).toBe(5);
    expect(res.body.client.headOffice).not.toBeNull();
    expect(res.body.client.headOffice.slug).toBe('urban-threads-ho');

    expect(res.body.job.type).toBe('new_multi_store_client');

    // List clients verifies aggregate listing
    const listRes = await request(app).get('/api/clients').set(auth()).expect(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].topology).toBe('multi_store');
  });

  it('upgrades a single-store client to multi-store preserving existing store (§7)', async () => {
    // 1. Create single-store client first
    const createRes = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'MotoSpares',
        slug: 'motospares',
        deploymentType: 'single_store',
        stores: [
          {
            name: 'MotoSpares Central',
            slug: 'motospares-central',
            baseUrl: 'http://localhost:3245',
            terminalCount: 2,
          },
        ],
        autoDeploy: false,
      })
      .expect(201);

    const clientId = createRes.body.client.id;
    expect(createRes.body.client.topology).toBe('single_store');

    // 2. Upgrade to multi-store — the plan rides along, since multi-store
    // topology is gated on the plan feature (L4) and this client started on no plan.
    const upgradeRes = await request(app)
      .post(`/api/clients/${clientId}/upgrade-to-multistore`)
      .set(auth())
      .send({
        planId: await multiStorePlanId(),
        headOffice: {
          name: 'MotoSpares Head Office',
          slug: 'motospares-ho',
          baseUrl: 'http://localhost:3260',
        },
        newStore: {
          name: 'MotoSpares North',
          slug: 'motospares-north',
          baseUrl: 'http://localhost:3246',
          terminalCount: 3,
        },
      })
      .expect(200);

    expect(upgradeRes.body.ok).toBe(true);
    expect(upgradeRes.body.client.topology).toBe('multi_store');
    expect(upgradeRes.body.client.storesCount).toBe(2);
    expect(upgradeRes.body.client.headOffice).not.toBeNull();
    expect(upgradeRes.body.job.type).toBe('upgrade_to_multistore');

    // Verify existing store still exists and new store was added
    const detail = await request(app).get(`/api/clients/${clientId}`).set(auth()).expect(200);

    expect(detail.body.stores.length).toBe(2);
    const storeSlugs = detail.body.stores.map((s: any) => s.slug);
    expect(storeSlugs).toContain('motospares-central'); // preserved existing!
    expect(storeSlugs).toContain('motospares-north'); // newly added!
    expect(detail.body.headOffice.slug).toBe('motospares-ho');
  });

  it('retries a deployment job without duplicating already completed resources (§12)', async () => {
    // Create single-store client
    const createRes = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'QuickRetail',
        slug: 'quick-retail',
        deploymentType: 'single_store',
        stores: [
          {
            name: 'QuickRetail Main',
            slug: 'quick-retail-main',
            baseUrl: 'http://localhost:3245',
            terminalCount: 1,
          },
        ],
        autoDeploy: false,
      })
      .expect(201);

    const jobId = createRes.body.job.id;

    // Retry job
    const retryRes = await request(app)
      .post(`/api/clients/jobs/${jobId}/retry`)
      .set(auth())
      .expect(200);

    expect(retryRes.body.ok).toBe(true);
    expect(retryRes.body.job.id).toBe(jobId);

    // Verify no duplicate companies or stores were created
    const clients = await request(app).get('/api/clients').set(auth()).expect(200);
    expect(clients.body.filter((c: any) => c.slug === 'quick-retail').length).toBe(1);

    const detail = await request(app)
      .get(`/api/clients/${createRes.body.client.id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.stores.length).toBe(1);
  });

  it('updates client name and details via PUT /api/clients/:id', async () => {
    const createRes = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Kloof Autu Spares',
        slug: 'kloof-auto-spares',
        billingEmail: 'accounts@kloof.co.za',
        deploymentType: 'single_store',
        autoDeploy: false,
      })
      .expect(201);

    const clientId = createRes.body.client.id;

    // Update typo in client name
    const updateRes = await request(app)
      .put(`/api/clients/${clientId}`)
      .set(auth())
      .send({
        name: 'Kloof Auto Spares',
        billingEmail: 'billing@kloofautospares.co.za',
      })
      .expect(200);

    expect(updateRes.body.name).toBe('Kloof Auto Spares');
    expect(updateRes.body.billingEmail).toBe('billing@kloofautospares.co.za');

    // Verify detail reflects the updated name
    const detail = await request(app).get(`/api/clients/${clientId}`).set(auth()).expect(200);
    expect(detail.body.client.name).toBe('Kloof Auto Spares');
  });
});

describe('client store order', () => {
  it('lists a client stores by name, on the card and on the client detail', async () => {
    // Created deliberately out of alphabetical order, so newest-first (which is how
    // `listStores()` answers) and name order give visibly different answers.
    const company = createCompany({ name: 'Order Test Group', slug: 'order-test' });
    for (const [name, slug] of [
      ['Zebra Crossing', 'order-zebra'],
      ['Alpha Foods', 'order-alpha'],
      ['Middle Market', 'order-middle'],
    ] as const) {
      const store = createStore(
        { name, slug, terminalCount: 1, baseUrl: `http://${slug}.localhost:3245` },
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      );
      setStoreCompany(store.id, company.id);
    }

    const list = await request(app).get('/api/clients').set(auth()).expect(200);
    const card = (list.body as Array<{ id: number; stores: Array<{ name: string }> }>).find(
      (c) => c.id === company.id,
    );
    expect(card?.stores.map((s) => s.name)).toEqual([
      'Alpha Foods',
      'Middle Market',
      'Zebra Crossing',
    ]);

    const detail = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect((detail.body as { stores: Array<{ name: string }> }).stores.map((s) => s.name)).toEqual([
      'Alpha Foods',
      'Middle Market',
      'Zebra Crossing',
    ]);
  });
});

describe('per-store audit trail', () => {
  it('returns audited actions for a single store, newest first', async () => {
    const createRes = await request(app).post('/api/stores').set(auth()).send({
      name: 'Audit Trail Store',
      slug: 'audit-trail',
      terminalCount: 1,
      baseUrl: 'http://localhost:3245',
    });
    expect(createRes.status).toBe(201);
    const storeId = (createRes.body as { store: { id: number } }).store.id;

    // A privileged action that records an audit entry.
    await request(app)
      .post(`/api/stores/${storeId}/support`)
      .set(auth())
      .send({ reason: 'test session' });

    const res = await request(app).get(`/api/stores/${storeId}/audit`).set(auth()).expect(200);
    const logs = res.body.logs as Array<{ target_type: string; target_id: number; action: string }>;
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.every((l) => l.target_type === 'store' && l.target_id === storeId)).toBe(true);
    expect(logs.some((l) => l.action === 'support_session_started')).toBe(true);
  });
});

describe('panel token reveal', () => {
  it('reveals a panel token to the office user and audits it', async () => {
    // Multi-store onboarding creates the client's Head Office panel.
    const planId = await (async () => {
      const res = await request(app).get('/api/plans').set(auth()).expect(200);
      const plan = (res.body as Array<{ id: number; code: string }>).find(
        (p) => p.code === 'vula-network',
      );
      return plan!.id;
    })();
    const created = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Token Reveal Group',
        slug: 'token-reveal',
        planId,
        deploymentType: 'multi_store',
        headOffice: {
          name: 'Token Reveal HO',
          slug: 'token-reveal-ho',
          baseUrl: 'http://localhost:3261',
        },
        stores: [
          {
            name: 'Token Reveal Branch',
            slug: 'token-reveal-main',
            baseUrl: 'http://localhost:3247',
            terminalCount: 1,
          },
        ],
        autoDeploy: false,
      })
      .expect(201);

    const detail = await request(app)
      .get(`/api/clients/${created.body.client.id}`)
      .set(auth())
      .expect(200);
    const panelId = detail.body.headOffice.id;

    const res = await request(app).get(`/api/panels/${panelId}/token`).set(auth()).expect(200);
    expect((res.body as { token: string }).token).toMatch(/^[0-9a-f]{64}$/);

    // The reveal is attributable in the audit trail.
    const logs = await request(app).get('/api/stores/audit-logs').set(auth()).expect(200);
    expect(
      ((logs.body as { logs: Array<{ action: string }> }).logs ?? []).some(
        (l) => l.action === 'reveal_panel_token',
      ),
    ).toBe(true);
  });
});

describe('onboarding payload validation (§19)', () => {
  const wizard = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Payload Pharmacy',
    slug: 'payload-pharmacy',
    deploymentType: 'single_store',
    stores: [
      {
        name: 'Payload Main',
        slug: 'payload-main',
        baseUrl: 'http://localhost:3245',
        terminalCount: 2,
      },
    ],
    autoDeploy: false,
    ...over,
  });

  it('refuses a stores value that is not an array, as a 400 rather than a crash', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send(wizard({ stores: 'payload-main' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stores must be an array/i);
  });

  it('refuses a nested slug that could never be a store slug', async () => {
    // The slug becomes a deployment hostname; the single-store route validates
    // it and the wizard used to take whatever it was handed.
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send(
        wizard({
          stores: [{ name: 'Bad', slug: 'Not A Slug!', baseUrl: 'http://localhost:3245' }],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slug/i);
  });

  it('refuses nested terminal counts that are not whole numbers in range', async () => {
    for (const terminalCount of [-3, 2.5, 400]) {
      const res = await request(app)
        .post('/api/clients')
        .set(auth())
        .send(
          wizard({
            slug: `payload-${String(terminalCount).replace(/[^a-z0-9]/gi, '')}`,
            stores: [{ name: 'Bad', slug: 'bad-count', terminalCount }],
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/terminalCount/i);
    }
  });

  it('refuses a nested base URL with no scheme', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send(
        wizard({
          stores: [{ name: 'Bad', slug: 'bad-url', baseUrl: 'localhost:3245' }],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/i);
  });

  it('refuses a malformed nested admin email', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send(
        wizard({
          stores: [
            {
              name: 'Bad',
              slug: 'bad-email',
              baseUrl: 'http://localhost:3245',
              adminEmail: 'not-an-email',
            },
          ],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/adminEmail/i);
  });

  it('refuses a nested Head Office URL with no scheme on a multi-store onboarding', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send(
        wizard({
          deploymentType: 'multi_store',
          // Multi-store topology is a plan feature (L4), so the fixture has to
          // buy a plan that grants it before the payload is even validated.
          planId: await multiStorePlanId(),
          stores: [
            { name: 'A', slug: 'payload-a', baseUrl: 'http://localhost:3245' },
            { name: 'B', slug: 'payload-b', baseUrl: 'http://localhost:3246' },
          ],
          headOffice: { name: 'HO', slug: 'payload-ho', baseUrl: 'localhost:3260' },
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/i);
  });

  it('still accepts a well-formed payload, Head Office URL included', async () => {
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send(
        wizard({
          slug: 'payload-good',
          deploymentType: 'multi_store',
          planId: await multiStorePlanId(),
          stores: [
            { name: 'Good A', slug: 'payload-good-a', baseUrl: 'http://localhost:3245' },
            { name: 'Good B', slug: 'payload-good-b', baseUrl: 'http://localhost:3246' },
          ],
          headOffice: {
            name: 'Good HO',
            slug: 'payload-good-ho',
            baseUrl: 'http://localhost:3260',
          },
        }),
      )
      .expect(201);
    expect(res.body.client.headOffice).not.toBeNull();
    expect(res.body.client.storesCount).toBe(2);
  });
});

describe('the wizard checks the plan before writing anything', () => {
  const countClients = async (): Promise<number> => {
    const res = await request(app).get('/api/clients').set(auth()).expect(200);
    return (res.body as unknown[]).length;
  };

  it('refuses more tills than the plan allows per store, and leaves no client behind', async () => {
    const planId = await planIdByCode('vula-start'); // 1 store, 1 till
    const before = await countClients();
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Over Ceiling',
        slug: 'over-ceiling',
        planId,
        deploymentType: 'single_store',
        stores: [
          {
            slug: 'over-ceiling-main',
            baseUrl: 'http://localhost:3245',
            terminalCount: 2,
            licensedTerminalCount: 2,
          },
        ],
        autoDeploy: false,
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/allows 1 per store/i);
    expect(await countClients()).toBe(before);
  });

  it('refuses more stores than the plan allows, and leaves no client behind', async () => {
    const planId = await planIdByCode('vula-grow'); // 1 store, 3 tills
    const before = await countClients();
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Too Many Stores',
        slug: 'too-many-stores',
        planId,
        deploymentType: 'single_store',
        stores: [
          { slug: 'too-many-a', baseUrl: 'http://localhost:3245', terminalCount: 1 },
          { slug: 'too-many-b', baseUrl: 'http://localhost:3246', terminalCount: 1 },
        ],
        autoDeploy: false,
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/allows 1 store/i);
    expect(await countClients()).toBe(before);
  });

  it('does not buy Head Office when an upgrade is refused', async () => {
    const planId = await planIdByCode('vula-branch'); // 3 stores, 2 tills/store
    const created = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'No Panel Yet',
        slug: 'no-panel-yet',
        planId,
        deploymentType: 'single_store',
        stores: [{ slug: 'no-panel-main', baseUrl: 'http://localhost:3245', terminalCount: 1 }],
        autoDeploy: false,
      })
      .expect(201);
    const clientId = created.body.client.id as number;

    // The new branch is above the plan's per-store ceiling, so the upgrade is
    // refused before the client is charged for a Head Office.
    const refused = await request(app)
      .post(`/api/clients/${clientId}/upgrade-to-multistore`)
      .set(auth())
      .send({
        planId,
        newStore: {
          name: 'Too Big',
          slug: 'no-panel-big',
          baseUrl: 'http://localhost:3246',
          terminalCount: 3,
          licensedTerminalCount: 3,
        },
        autoDeploy: false,
      });
    expect(refused.status).toBe(402);
    expect(String(refused.body.error)).toMatch(/allows 2 licensed terminals per store/i);

    const detail = await request(app).get(`/api/clients/${clientId}`).set(auth()).expect(200);
    expect(detail.body.headOffice).toBeNull();
    const subscription = detail.body.subscription as { addons?: Array<{ key: string }> };
    expect(subscription.addons?.some((a) => a.key === 'multi_store')).toBeFalsy();
    // The purchased quantity did not move either.
    expect(detail.body.subscription.licensedTerminalCount).toBe(1);
  });

  it('refuses Head Office on a single-store deployment', async () => {
    const planId = await planIdByCode('vula-grow');
    const before = await countClients();
    const res = await request(app)
      .post('/api/clients')
      .set(auth())
      .send({
        name: 'Lonely Panel',
        slug: 'lonely-panel',
        planId,
        deploymentType: 'single_store',
        features: ['multi_store'],
        stores: [{ slug: 'lonely-panel-main', baseUrl: 'http://localhost:3245', terminalCount: 1 }],
        autoDeploy: false,
      });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/needs two or more stores/i);
    expect(await countClients()).toBe(before);
  });
});
