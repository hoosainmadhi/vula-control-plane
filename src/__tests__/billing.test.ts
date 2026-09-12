import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
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
    if (s.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, version: '1.0.0', branchCount: 2 });
    }
    if (s.endsWith('/api/internal/licence')) {
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

const makeCompany = async (over: Record<string, unknown> = {}) => {
  const planId = await planIdByCode('business');
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Urban Threads Sandton',
      slug: 'urban-threads',
      planId,
      paidThrough: '2026-09-10',
      ...over,
    })
    .expect(201);
  return res.body as { id: number; name: string; planCode: string; paidThrough: string };
};

const makeStoreForCompany = async (companyId: number, slug = 'sandton') => {
  const res = await request(app)
    .post('/api/stores')
    .set(auth())
    .send({
      name: 'Urban Threads Sandton Store',
      slug,
      baseUrl: 'http://localhost:3245',
      terminalCount: 2,
      companyId,
    })
    .expect(201);
  return res.body.id;
};

describe('L3 Billing & Invoicing', () => {
  it('creates an invoice for a company with default or custom amounts', async () => {
    const company = await makeCompany();

    // 1. Create with custom amount
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 49900,
        dueDate: '2026-09-30',
      })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.amountCents).toBe(49900);
    expect(res.body.status).toBe('pending');
    expect(res.body.dueDate).toBe('2026-09-30');
    expect(res.body.invoiceNumber).toMatch(/^INV-\d{8}-\d{4}$/);

    // 2. Fetch single invoice
    const getRes = await request(app)
      .get(`/api/billing/invoices/${res.body.id}`)
      .set(auth())
      .expect(200);
    expect(getRes.body.amountCents).toBe(49900);

    // 3. List invoices filtered by company
    const listRes = await request(app)
      .get(`/api/billing/invoices?companyId=${company.id}`)
      .set(auth())
      .expect(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].id).toBe(res.body.id);
  });

  it('records payment, marks invoice paid, advances paid_through and pushes licence', async () => {
    const company = await makeCompany({ paidThrough: '2026-09-15' });
    await makeStoreForCompany(company.id, 'sandton-store');

    // Create an invoice
    const invRes = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 75000,
      })
      .expect(201);

    const invoiceId = invRes.body.id;

    // Process payment
    const payRes = await request(app)
      .post(`/api/billing/invoices/${invoiceId}/pay`)
      .set(auth())
      .send({
        method: 'stripe',
        transactionId: 'ch_1234567890',
      })
      .expect(200);

    expect(payRes.body.ok).toBe(true);
    expect(payRes.body.invoice.status).toBe('paid');
    expect(payRes.body.payment.method).toBe('stripe');
    expect(payRes.body.payment.amountCents).toBe(75000);
    expect(payRes.body.payment.transactionId).toBe('ch_1234567890');

    // Advanced 1 month from existing paid_through (2026-09-15 -> 2026-10-15)
    expect(payRes.body.newPaidThrough).toBe('2026-10-15');

    // Check company record in DB
    const compRes = await request(app)
      .get(`/api/companies/${company.id}`)
      .set(auth())
      .expect(200);
    expect(compRes.body.paidThrough).toBe('2026-10-15');

    // Licence push was attempted
    expect(payRes.body.licencePush.storesUpdated).toBeGreaterThanOrEqual(1);

    // Cannot pay again
    await request(app)
      .post(`/api/billing/invoices/${invoiceId}/pay`)
      .set(auth())
      .send({ method: 'manual' })
      .expect(409);
  });

  it('cancels an invoice and blocks payment on cancelled invoices', async () => {
    const company = await makeCompany();
    const invRes = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 15000 })
      .expect(201);

    const invoiceId = invRes.body.id;

    const cancelRes = await request(app)
      .post(`/api/billing/invoices/${invoiceId}/cancel`)
      .set(auth())
      .expect(200);
    expect(cancelRes.body.invoice.status).toBe('cancelled');

    // Attempting to pay cancelled invoice returns 409
    await request(app)
      .post(`/api/billing/invoices/${invoiceId}/pay`)
      .set(auth())
      .send({ method: 'manual' })
      .expect(409);
  });

  it('manages billing settings for auto-renewal', async () => {
    const company = await makeCompany();

    // Default settings
    const getRes = await request(app)
      .get(`/api/billing/settings/${company.id}`)
      .set(auth())
      .expect(200);
    expect(getRes.body.autoRenew).toBe(true);

    // Update settings
    const putRes = await request(app)
      .put(`/api/billing/settings/${company.id}`)
      .set(auth())
      .send({
        autoRenew: false,
        emailInvoice: true,
        invoiceEmail: 'accounts@urban-threads.co.za',
      })
      .expect(200);
    expect(putRes.body.autoRenew).toBe(false);
    expect(putRes.body.invoiceEmail).toBe('accounts@urban-threads.co.za');
  });

  it('generates a renewal invoice without settling it — entitlement never extends on the sweep alone', async () => {
    // Set paid_through to today so renewal is due
    const todayStr = new Date().toISOString().slice(0, 10);
    const company = await makeCompany({
      paidThrough: todayStr,
    });

    // Run automated renewal check
    const renewRes = await request(app)
      .post('/api/billing/renew-check')
      .set(auth())
      .expect(200);

    expect(renewRes.body.ok).toBe(true);
    expect(renewRes.body.summary.companiesEvaluated).toBeGreaterThanOrEqual(1);
    // The invoice is generated but NOT paid: no synthetic settlement.
    expect(renewRes.body.summary.invoicesCreated).toBeGreaterThanOrEqual(1);
    expect(renewRes.body.summary.renewalsProcessed).toBe(0);

    const invoices = await request(app)
      .get('/api/billing/invoices')
      .set(auth())
      .expect(200);
    const allInvoices = (invoices.body.invoices ?? invoices.body) as Array<{
      companyId: number;
      status: string;
    }>;
    const pending = allInvoices.filter((inv) => inv.companyId === company.id);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.every((inv) => inv.status !== 'paid')).toBe(true);

    // paid_through untouched — the subscription was not extended.
    const updatedComp = await request(app)
      .get(`/api/companies/${company.id}`)
      .set(auth())
      .expect(200);
    expect(updatedComp.body.paidThrough).toBe(todayStr);
  });

  it('settles automatically only when BILLING_SIMULATE_RENEWAL_SETTLEMENT is enabled (demo mode)', async () => {
    process.env.BILLING_SIMULATE_RENEWAL_SETTLEMENT = 'true';
    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const company = await makeCompany({ paidThrough: todayStr });

      const renewRes = await request(app)
        .post('/api/billing/renew-check')
        .set(auth())
        .expect(200);

      expect(renewRes.body.summary.renewalsProcessed).toBeGreaterThanOrEqual(1);
      const updatedComp = await request(app)
        .get(`/api/companies/${company.id}`)
        .set(auth())
        .expect(200);
      expect(updatedComp.body.paidThrough).not.toBe(todayStr);
    } finally {
      delete process.env.BILLING_SIMULATE_RENEWAL_SETTLEMENT;
    }
  });
});
