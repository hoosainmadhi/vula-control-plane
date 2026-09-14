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
  const planId = await planIdByCode('vula-grow');
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Urban Threads Sandton',
      slug: 'urban-threads',
      planId,
      paidThrough: '2026-09-10',
      // What the client pays for — 8 licensed terminals at R500/terminal.
      licensedTerminalCount: 8,
      ...over,
    })
    .expect(201);
  return res.body as {
    id: number;
    name: string;
    planCode: string;
    paidThrough: string;
    subscription: {
      licensedTerminalCount: number;
      recurringAmountCents: number | null;
      rateCents: number;
      customAmountCents: number;
      setupFeeCents: number;
      setupFeeStatus: string;
    };
  };
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

  it('bills the licensed terminal quantity: 3 × R500 = R1,500 (and 9 × R500 = R4,500)', async () => {
    const company = await makeCompany({ licensedTerminalCount: 3 });
    expect(company.subscription.recurringAmountCents).toBe(150_000);

    const invoice = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    // 3 licensed terminals × R500, integer cents, and the breakdown is evidence.
    expect(invoice.body.amountCents).toBe(150_000);
    expect(invoice.body.terminalCount).toBe(3);
    expect(invoice.body.terminalPriceCents).toBe(50_000);
    expect(Number.isInteger(invoice.body.amountCents)).toBe(true);

    // Buying more terminals moves the fee without touching any device state.
    await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ licensedTerminalCount: 9 })
      .expect(200);
    const bigger = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(bigger.body.amountCents).toBe(450_000);
    expect(bigger.body.terminalCount).toBe(9);
  });

  it('charges the once-off onboarding fee once — never on a renewal', async () => {
    const company = await makeCompany({ licensedTerminalCount: 4 });
    expect(company.subscription.setupFeeCents).toBe(1_000_000);
    expect(company.subscription.setupFeeStatus).toBe('not_invoiced');

    // The first (initial) invoice carries onboarding + the recurring line.
    const first = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'initial' })
      .expect(201);
    expect(first.body.setupFeeCents).toBe(1_000_000);
    expect(first.body.amountCents).toBe(4 * 50_000 + 1_000_000);

    const afterFirst = await request(app)
      .get(`/api/companies/${company.id}`)
      .set(auth())
      .expect(200);
    expect(afterFirst.body.subscription.setupFeeStatus).toBe('invoiced');

    // Reinvoice: recurring only. The renewal sweep is the same code path.
    const second = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'initial' })
      .expect(201);
    expect(second.body.setupFeeCents).toBeNull();
    expect(second.body.amountCents).toBe(4 * 50_000);

    const renew = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(renew.body.setupFeeCents).toBeNull();
    expect(renew.body.amountCents).toBe(4 * 50_000);
  });

  it('marks the onboarding charge paid when the invoice that carried it settles', async () => {
    const company = await makeCompany({ licensedTerminalCount: 4 });
    const created = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'initial' })
      .expect(201);
    expect(created.body.setupFeeCents).toBe(1_000_000);

    await request(app)
      .post(`/api/billing/invoices/${created.body.id}/pay`)
      .set(auth())
      .send({ method: 'manual' })
      .expect(200);

    const after = await request(app)
      .get(`/api/companies/${company.id}`)
      .set(auth())
      .expect(200);
    expect(after.body.subscription.setupFeeStatus).toBe('paid');
  });

  it('bills a custom plan`s agreed amount, but only when one is stated', async () => {
    const planId = await planIdByCode('vula-market-enterprise');

    // 0. The office marks the tier as negotiated but states no amount yet.
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ pricingMode: 'custom', customAmountCents: 0 })
      .expect(200);

    // 1. No agreed amount: strictly per-invoice, and the sweep leaves it alone.
    const undecided = await makeCompany({
      name: 'Undecided Co',
      slug: 'undecided-co',
      planId,
      licensedTerminalCount: 6,
    });
    expect(undecided.subscription.recurringAmountCents).toBeNull();

    // 2. The office states the negotiated amount once, on the plan.
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ pricingMode: 'custom', customAmountCents: 750_000, setupFeeCents: 1_000_000 })
      .expect(200);

    const decided = await makeCompany({
      name: 'Decided Co',
      slug: 'decided-co',
      planId,
      licensedTerminalCount: 6,
      paidThrough: new Date().toISOString().slice(0, 10),
    });
    expect(decided.subscription.recurringAmountCents).toBe(750_000);
    expect(decided.subscription.rateCents).toBe(0);

    // The invoice is the agreed amount — no terminal arithmetic anywhere.
    const invoice = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: decided.id, purpose: 'renewal' })
      .expect(201);
    expect(invoice.body.amountCents).toBe(750_000);
    expect(invoice.body.terminalCount).toBeNull();
    expect(invoice.body.terminalPriceCents).toBeNull();

    // Its first invoice may still carry the once-off onboarding charge.
    const renewCheck = await request(app)
      .put(`/api/companies/${decided.id}`)
      .set(auth())
      .send({ paidThrough: new Date().toISOString().slice(0, 10) })
      .expect(200);
    expect(renewCheck.body.subscription.recurringAmountCents).toBe(750_000);

    // 3. The sweep no longer skips it: the agreed amount renews, and the
    //    client with nothing agreed is still left for the office.
    const sweep = await request(app).post('/api/billing/renew-check').set(auth()).expect(200);
    expect(sweep.body.summary.invoicesCreated).toBeGreaterThanOrEqual(1);
    const invoices = await request(app)
      .get('/api/billing/invoices')
      .set(auth())
      .expect(200);
    const forDecided = (invoices.body as Array<{ companyId: number; amountCents: number }>).filter(
      (inv) => inv.companyId === decided.id,
    );
    expect(forDecided.length).toBeGreaterThanOrEqual(1);
    expect(forDecided.every((inv) => inv.amountCents === 750_000)).toBe(true);
  });

  it('never invents an amount for a custom-priced client — the office supplies it', async () => {
    const planId = await planIdByCode('vula-market-enterprise');
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ pricingMode: 'custom', customAmountCents: 0 })
      .expect(200);
    const company = await makeCompany({
      name: 'Custom Co',
      slug: 'custom-co',
      planId,
      licensedTerminalCount: 12,
    });
    expect(company.subscription.recurringAmountCents).toBeNull();

    const refused = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(400);
    expect(refused.body.code).toBe('custom_pricing_requires_amount');
    expect(refused.body.error).toMatch(/custom pricing/i);

    // An explicitly agreed amount is accepted.
    const agreed = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 1_250_000 })
      .expect(201);
    expect(agreed.body.amountCents).toBe(1_250_000);

    // And the sweep leaves custom-priced clients alone rather than guessing.
    const todayStr = new Date().toISOString().slice(0, 10);
    await request(app)
      .put(`/api/companies/${company.id}`)
      .set(auth())
      .send({ paidThrough: todayStr })
      .expect(200);
    const renew = await request(app).post('/api/billing/renew-check').set(auth()).expect(200);
    expect(renew.body.summary.customPricingSkipped).toBeGreaterThanOrEqual(1);
    const invoices = await request(app).get('/api/billing/invoices').set(auth()).expect(200);
    const forCustom = (invoices.body as Array<{ companyId: number; amountCents: number }>).filter(
      (inv) => inv.companyId === company.id,
    );
    // Only the manual invoice above exists — the sweep created none.
    expect(forCustom).toHaveLength(1);
  });

  it('records a settled payment as completed, not processing', async () => {
    const company = await makeCompany();
    const created = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 50000 })
      .expect(201);
    const paid = await request(app)
      .post(`/api/billing/invoices/${created.body.id}/pay`)
      .set(auth())
      .send({ method: 'bank_transfer', transactionId: 'EFT-1' })
      .expect(200);
    expect(paid.body.payment.status).toBe('completed');
  });
});
