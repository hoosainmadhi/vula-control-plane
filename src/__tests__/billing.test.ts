import request from 'supertest';
import { createApp } from '../app.js';
import { getRegistryDb, listAuditLogs, resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

const app = createApp();

/**
 * Emailing an invoice goes through the real mailer; only the transport is
 * stubbed, so these tests cover the control plane's own behaviour — refuse when
 * SMTP is unconfigured, and stamp/audit a send only when the relay accepted it.
 */
jest.mock('nodemailer', () => {
  const sendMail = jest.fn(async () => ({ messageId: '<mock@vula.local>' }));
  const createTransport = jest.fn(() => ({ sendMail }));
  return {
    __esModule: true,
    default: { createTransport },
    createTransport,
    __transport: { sendMail, createTransport },
  };
});

const transport = (
  jest.requireMock('nodemailer') as {
    __transport: { sendMail: jest.Mock; createTransport: jest.Mock };
  }
).__transport;

let fetchMock: jest.SpyInstance;
let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  transport.sendMail.mockReset();
  transport.sendMail.mockImplementation(async () => ({ messageId: '<mock@vula.local>' }));
  transport.createTransport.mockClear();
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
      setupFeeDueCents: number;
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
        description: 'Agreed amount',
        // This test is about the invoice itself; the once-off capture has its
        // own tests below.
        includeOnboarding: false,
      })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.companyId).toBe(company.id);
    expect(res.body.amountCents).toBe(49900);
    expect(res.body.status).toBe('pending');
    expect(res.body.dueDate).toBe('2026-09-30');
    // A monotonic per-year sequence, not a date plus random digits.
    expect(res.body.invoiceNumber).toMatch(/^VULA-\d{4}-\d{6}$/);

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
    // A paid-through a few days out, so the renewal anchors on it rather than on
    // "now" — a hard-coded past date made this test pass only until the clock
    // passed noon on that day, then fail with a date one day out.
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 5);
    const paidThrough = base.toISOString().slice(0, 10);
    const nextMonth = new Date(base);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const paidThroughPlusMonth = nextMonth.toISOString().slice(0, 10);

    const company = await makeCompany({ paidThrough });
    await makeStoreForCompany(company.id, 'sandton-store');

    // Create an invoice
    const invRes = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 75000,
        description: 'Agreed amount',
        includeOnboarding: false,
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

    // Advanced one month from the existing paid_through.
    expect(payRes.body.newPaidThrough).toBe(paidThroughPlusMonth);

    // Check company record in DB
    const compRes = await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(200);
    expect(compRes.body.paidThrough).toBe(paidThroughPlusMonth);

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
      .send({ companyId: company.id, amountCents: 15000, description: 'Agreed amount' })
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
    const renewRes = await request(app).post('/api/billing/renew-check').set(auth()).expect(200);

    expect(renewRes.body.ok).toBe(true);
    expect(renewRes.body.summary.companiesEvaluated).toBeGreaterThanOrEqual(1);
    // The invoice is generated but NOT paid: no synthetic settlement.
    expect(renewRes.body.summary.invoicesCreated).toBeGreaterThanOrEqual(1);
    expect(renewRes.body.summary.renewalsProcessed).toBe(0);

    const invoices = await request(app).get('/api/billing/invoices').set(auth()).expect(200);
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

      const renewRes = await request(app).post('/api/billing/renew-check').set(auth()).expect(200);

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
      .send({ companyId: company.id, purpose: 'renewal', includeOnboarding: false })
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
      .send({ companyId: company.id, purpose: 'renewal', includeOnboarding: false })
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

    const after = await request(app).get(`/api/companies/${company.id}`).set(auth()).expect(200);
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
      .send({ companyId: decided.id, purpose: 'renewal', includeOnboarding: false })
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
    const invoices = await request(app).get('/api/billing/invoices').set(auth()).expect(200);
    const forDecided = (invoices.body as Array<{ companyId: number; amountCents: number }>).filter(
      (inv) => inv.companyId === decided.id,
    );
    expect(forDecided.length).toBeGreaterThanOrEqual(1);
    // Every invoice for this client is the agreed amount — the referral carries
    // no terminal arithmetic and, once the once-off has been captured, no
    // onboarding either.
    expect(forDecided.every((inv) => inv.amountCents >= 750_000)).toBe(true);
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
      .send({
        companyId: company.id,
        amountCents: 1_250_000,
        description: 'Agreed amount',
        includeOnboarding: false,
      })
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
      .send({ companyId: company.id, amountCents: 50000, description: 'Agreed amount' })
      .expect(201);
    const paid = await request(app)
      .post(`/api/billing/invoices/${created.body.id}/pay`)
      .set(auth())
      .send({ method: 'bank_transfer', transactionId: 'EFT-1' })
      .expect(200);
    expect(paid.body.payment.status).toBe('completed');
  });
});

describe('emailing a subscription invoice', () => {
  /** Puts a working SMTP account in the office settings singleton. */
  const configureSmtp = async (): Promise<void> => {
    await request(app)
      .put('/api/settings')
      .set(auth())
      .send({
        officeName: 'Vula Software',
        smtpHost: 'smtp.example.co.za',
        smtpPort: 587,
        smtpUser: 'billing@vula.app',
        smtpPass: 'relay-secret',
        smtpFrom: 'billing@vula.app',
        invoiceFooter: 'Bank: FNB · Acct 12345',
      })
      .expect(200);
  };

  const makeInvoice = async (): Promise<{ id: number; invoiceNumber: string }> => {
    const company = await makeCompany({ billingEmail: 'ap@urban-threads.co.za' });
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 150000,
        description: 'Agreed amount for the period',
      })
      .expect(201);
    return { id: res.body.id as number, invoiceNumber: res.body.invoiceNumber as string };
  };

  it('refuses with a pointer to Settings when SMTP is not configured — and stamps nothing', async () => {
    const invoice = await makeInvoice();
    const res = await request(app)
      .post(`/api/billing/invoices/${invoice.id}/email`)
      .set(auth())
      .send({})
      .expect(400);
    expect(res.body.code).toBe('smtp_not_configured');
    expect(transport.sendMail).not.toHaveBeenCalled();

    const after = await request(app)
      .get(`/api/billing/invoices/${invoice.id}`)
      .set(auth())
      .expect(200);
    expect(after.body.emailedAt).toBeNull();
    expect(after.body.emailedTo).toBeNull();

    // A refused send is on the record as a failure, not as an email.
    const entry = listAuditLogs(20).find((l) => l.action === 'invoice_emailed');
    expect(entry?.result).toBe('failed');
  });

  it('sends to the client, stamps the invoice and audits the send', async () => {
    await configureSmtp();
    const invoice = await makeInvoice();

    const res = await request(app)
      .post(`/api/billing/invoices/${invoice.id}/email`)
      .set(auth())
      .send({})
      .expect(200);
    expect(res.body.recipient).toBe('ap@urban-threads.co.za');
    expect(res.body.invoice.emailedAt).toBeTruthy();
    expect(res.body.invoice.emailedTo).toBe('ap@urban-threads.co.za');

    const sent = transport.sendMail.mock.calls[0][0] as {
      to: string;
      html: string;
      subject: string;
    };
    expect(sent.to).toBe('ap@urban-threads.co.za');
    expect(sent.subject).toContain(invoice.invoiceNumber);
    // The office identity and the agreed footer are in the body; the client's
    // own name is on it, and nothing else about the account.
    expect(sent.html).toContain('Vula Software');
    expect(sent.html).toContain('Bank: FNB');

    const entry = listAuditLogs(20).find((l) => l.action === 'invoice_emailed');
    expect(entry?.result).toBe('ok');
    expect(entry?.reason).toContain('ap@urban-threads.co.za');
  });

  it('prefers an explicitly named recipient over the client billing address', async () => {
    await configureSmtp();
    const invoice = await makeInvoice();
    await request(app)
      .post(`/api/billing/invoices/${invoice.id}/email`)
      .set(auth())
      .send({ email: 'finance@vula.app' })
      .expect(200);
    expect(transport.sendMail.mock.calls[0][0]).toMatchObject({ to: 'finance@vula.app' });
  });

  it('reports a refused relay as a 502 and does not stamp the invoice as sent', async () => {
    await configureSmtp();
    const invoice = await makeInvoice();
    transport.sendMail.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:587');
    });

    const res = await request(app)
      .post(`/api/billing/invoices/${invoice.id}/email`)
      .set(auth())
      .send({})
      .expect(502);
    expect(res.body.code).toBe('mailer_failed');

    const after = await request(app)
      .get(`/api/billing/invoices/${invoice.id}`)
      .set(auth())
      .expect(200);
    expect(after.body.emailedAt).toBeNull();
    expect(listAuditLogs(20).find((l) => l.action === 'invoice_emailed')?.result).toBe('failed');
  });

  it('invoices raised later use the office payment terms, not a hard-coded 14 days', async () => {
    await request(app).put('/api/settings').set(auth()).send({ invoiceDueDays: 30 }).expect(200);
    const company = await makeCompany();
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 100000, description: 'Agreed amount' })
      .expect(201);
    const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(res.body.dueDate).toBe(expected);
  });

  it('attaches the invoice PDF, and every mail signs off with the office name', async () => {
    await configureSmtp();
    const invoice = await makeInvoice();

    await request(app)
      .post(`/api/billing/invoices/${invoice.id}/email`)
      .set(auth())
      .send({})
      .expect(200);

    const sent = transport.sendMail.mock.calls[0][0] as {
      html: string;
      text: string;
      attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
    };
    expect(sent.attachments).toHaveLength(1);
    const [attachment] = sent.attachments!;
    expect(attachment.filename).toBe(`${invoice.invoiceNumber}.pdf`);
    expect(attachment.contentType).toBe('application/pdf');
    // A real PDF, not an empty buffer: pdfkit writes the %PDF- magic.
    expect(attachment.content.subarray(0, 5).toString()).toBe('%PDF-');

    // The invoice says what it is for, and no internal vocabulary reaches a client.
    expect(sent.html).toContain('Agreed amount for the period');
    expect(sent.html).toContain('Sent by Vula Software');
    expect(sent.html).not.toContain('control plane');
    expect(sent.text).not.toContain('control plane');
  });

  it('lists the once-off first, ahead of the subscription lines', async () => {
    // Owner, 2026-09-16: the once-off is the first line item whenever it applies.
    // Asserted on the email, where the order is readable as text; the PDF draws
    // the same sequence, from the same constant.
    await configureSmtp();
    const company = await makeCompany({
      licensedTerminalCount: 3,
      billingEmail: 'ap@urban-threads.co.za',
    });
    const both = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'initial' })
      .expect(201);
    expect(both.body.setupFeeCents).toBe(1_000_000);
    expect(both.body.terminalCount).toBe(3);

    await request(app)
      .post(`/api/billing/invoices/${both.body.id}/email`)
      .set(auth())
      .send({})
      .expect(200);

    const html = (transport.sendMail.mock.calls[0][0] as { html: string }).html;
    const onceOff = html.indexOf('Vula onboarding and deployment');
    const recurring = html.indexOf('Licensed terminals');
    expect(onceOff).toBeGreaterThan(-1);
    expect(recurring).toBeGreaterThan(-1);
    expect(onceOff).toBeLessThan(recurring);
  });
});

describe('the invoice PDF', () => {
  it('is served as a downloadable document named after the invoice', async () => {
    const company = await makeCompany();
    const created = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 250000,
        description: 'Installation and training',
      })
      .expect(201);

    const pdf = await request(app)
      .get(`/api/billing/invoices/${created.body.id}/pdf`)
      .set(auth())
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`${created.body.invoiceNumber}.pdf`);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.body.length).toBeGreaterThan(1000);

    await request(app).get('/api/billing/invoices/9999/pdf').set(auth()).expect(404);
  });
});

describe('once-off charges', () => {
  it('refuses a hand-priced invoice with no description — it must say what it is for', async () => {
    const company = await makeCompany();
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 250000 })
      .expect(400);
    expect(res.body.code).toBe('invoice_description_required');
  });

  it('bills an ad-hoc once-off charge, and the subscription is untouched', async () => {
    const company = await makeCompany();
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 250000,
        description: 'Installation and on-site training',
        // An invoice about one thing, not the moment to capture the onboarding.
        includeOnboarding: false,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      amountCents: 250000,
      description: 'Installation and on-site training',
      // No subscription line: this invoice bills the once-off, nothing recurring.
      terminalCount: null,
      setupFeeCents: null,
    });
    // It never advances or renews anything — settled by hand like any invoice.
    expect(res.body.status).toBe('pending');
  });

  it('carries an unbilled once-off on the next invoice of any kind', async () => {
    // The rule the office asked for: don't wait to be told to bill the once-off —
    // capture it on whichever invoice is raised next.
    const company = await makeCompany();
    const before = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(before.body.subscription.setupFeeDueCents).toBe(1_000_000);

    const handPriced = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 250000, description: 'Installation' })
      .expect(201);
    // The hand-priced charge plus the once-off, itemised separately.
    expect(handPriced.body.amountCents).toBe(1_250_000);
    expect(handPriced.body.setupFeeCents).toBe(1_000_000);
    expect(handPriced.body.description).toBe('Installation');

    // Captured once: the next invoice for the same client does not repeat it.
    const next = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 250000, description: 'Installation again' })
      .expect(201);
    expect(next.body.amountCents).toBe(250000);
    expect(next.body.setupFeeCents).toBeNull();

    const detail = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.setupFeeStatus).toBe('invoiced');
    // And the operator can see which invoice carries it.
    expect(detail.body.subscription.setupFeeRef).toBe(handPriced.body.invoiceNumber);
  });

  it('a renewal catches an unbilled once-off, and does not repeat it', async () => {
    const company = await makeCompany({ licensedTerminalCount: 3 });
    const first = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(first.body.amountCents).toBe(1_150_000); // R1 500 recurring + R10 000
    expect(first.body.setupFeeCents).toBe(1_000_000);
    // The invoice names the charge the way the client reads it on the document.
    expect(first.body.description).toContain('Vula onboarding and deployment');

    const second = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(second.body.amountCents).toBe(150_000);
    expect(second.body.setupFeeCents).toBeNull();
    expect(second.body.description).not.toContain('onboarding');
  });

  it('leaves the once-off for later when the invoice says no — but never re-bills a settled one', async () => {
    const company = await makeCompany();
    const skipped = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 250000,
        description: 'Installation',
        includeOnboarding: false,
      })
      .expect(201);
    expect(skipped.body.amountCents).toBe(250000);

    const detail = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.setupFeeStatus).toBe('not_invoiced');
    expect(detail.body.subscription.setupFeeDueCents).toBe(1_000_000);

    // Bill it on its own and settle it; after that no invoice picks it up again.
    const onboarding = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(201);
    await request(app)
      .post(`/api/billing/invoices/${onboarding.body.id}/pay`)
      .set(auth())
      .send({ method: 'manual' })
      .expect(200);

    for (const body of [{ purpose: 'renewal' }, { amountCents: 100000, description: 'Hardware' }]) {
      const later = await request(app)
        .post('/api/billing/invoices')
        .set(auth())
        .send({ companyId: company.id, ...body })
        .expect(201);
      expect(later.body.setupFeeCents).toBeNull();
    }
    const after = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(after.body.subscription.setupFeeStatus).toBe('paid');
    expect(after.body.subscription.setupFeeDueCents).toBe(0);
  });

  it('bills the plan`s onboarding charge on its own, then refuses to bill it twice', async () => {
    const company = await makeCompany();
    expect(company.subscription.setupFeeStatus).toBe('not_invoiced');
    const setupFee = company.subscription.setupFeeCents;
    expect(setupFee).toBeGreaterThan(0);

    const billed = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(201);
    // The onboarding charge alone — NOT the recurring line as well, which is
    // what billing `initial` here would have done.
    expect(billed.body.amountCents).toBe(setupFee);
    expect(billed.body.setupFeeCents).toBe(setupFee);
    expect(billed.body.description).toBe('Vula onboarding and deployment');

    const again = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(409);
    expect(again.body.code).toBe('setup_fee_not_due');
  });

  it('leaves the onboarding charge on the first invoice and out of a renewal', async () => {
    const company = await makeCompany();
    const initial = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'initial' })
      .expect(201);
    expect(initial.body.setupFeeCents).toBe(company.subscription.setupFeeCents);
    expect(initial.body.description).toContain('Vula onboarding and deployment');

    const renewal = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(renewal.body.setupFeeCents).toBeNull();
    expect(renewal.body.description).toContain('Subscription');
  });

  it('frees the onboarding charge when the invoice carrying it is cancelled', async () => {
    // Otherwise the charge is stranded: no standing invoice carries it, and the
    // client is marked as if it had been billed, so it can never be raised.
    const company = await makeCompany();
    const billed = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(201);

    // While it stands, it cannot be billed twice.
    await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(409);

    const cancelled = await request(app)
      .post(`/api/billing/invoices/${billed.body.id}/cancel`)
      .set(auth())
      .send({})
      .expect(200);
    expect(cancelled.body.setupFeeReleased).toBe(true);

    const detail = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.setupFeeStatus).toBe('not_invoiced');
    expect(detail.body.subscription.setupFeeDueCents).toBe(company.subscription.setupFeeCents);

    // And it can be raised again.
    await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(201);
  });

  it('cancelling an invoice that carries no onboarding charge releases nothing', async () => {
    const company = await makeCompany();
    await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'initial' })
      .expect(201);
    const handPriced = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 5000, description: 'A consumable' })
      .expect(201);
    expect(handPriced.body.setupFeeCents).toBeNull();

    const cancelled = await request(app)
      .post(`/api/billing/invoices/${handPriced.body.id}/cancel`)
      .set(auth())
      .send({})
      .expect(200);
    expect(cancelled.body.setupFeeReleased).toBeUndefined();
    const detail = await request(app).get(`/api/clients/${company.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.setupFeeStatus).toBe('invoiced');
  });
});

describe('invoice numbering', () => {
  let seq = 0;
  const makeInvoice = async (): Promise<string> => {
    // A distinct client per invoice: the slug is unique, and each raise must be
    // an ordinary invoice, not a repeat on one company.
    const company = await makeCompany({ name: `Sequence Co ${++seq}`, slug: `sequence-co-${seq}` });
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    return res.body.invoiceNumber as string;
  };

  it('issues a monotonic per-year sequence, one number per invoice', async () => {
    const year = new Date().getUTCFullYear();
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) numbers.push(await makeInvoice());

    expect(numbers[0]).toBe(`VULA-${year}-000001`);
    expect(numbers[1]).toBe(`VULA-${year}-000002`);
    expect(numbers[2]).toBe(`VULA-${year}-000003`);
    // Ascending, unique, and the same width — what an auditor reads off a list.
    expect([...numbers].sort()).toEqual(numbers);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('continues from the highest number already issued for the year', async () => {
    const year = new Date().getUTCFullYear();
    // A registry that has already written documents under this scheme (or a
    // restored backup) must not hand the next invoice a number already used.
    const company = await makeCompany({ name: 'Historic Co', slug: 'historic-co' });
    getRegistryDb()
      .prepare(
        `INSERT INTO invoices (company_id, invoice_number, amount_cents, due_date, status)
         VALUES (?, ?, 1000, '2026-01-01', 'pending')`,
      )
      .run(company.id, `VULA-${year}-000042`);

    const next = await makeInvoice();
    expect(next).toBe(`VULA-${year}-000043`);
  });

  it('does not reuse a number across separate raises in the same second', async () => {
    // The old scheme was date + four random digits, so this was a real collision
    // and the UNIQUE index turned it into a raw database error.
    const batch = await Promise.all([makeInvoice(), makeInvoice(), makeInvoice()]);
    expect(new Set(batch).size).toBe(3);
  });
});

describe('VAT on a VAT-inclusive invoice', () => {
  it('splits the inclusive total, and the parts add back to what is charged', async () => {
    const company = await makeCompany();
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 115000,
        description: 'Installation',
        includeOnboarding: false,
      })
      .expect(201);

    // R1 150,00 inclusive at 15% → R1 000,00 + R150,00.
    expect(res.body.amountCents).toBe(115000);
    expect(res.body.subtotalCents).toBe(100000);
    expect(res.body.vatCents).toBe(15000);
    expect(res.body.vatRate).toBe(15);
    expect(res.body.subtotalCents + res.body.vatCents).toBe(res.body.amountCents);
  });

  it('never drifts a cent, whatever the amount', async () => {
    const company = await makeCompany();
    // Amounts that do not divide cleanly by 1.15 are where a float implementation
    // loses a cent; the split must always sum back exactly.
    for (const amountCents of [1, 7, 99, 1234, 49999, 1234567, 115000_01]) {
      const res = await request(app)
        .post('/api/billing/invoices')
        .set(auth())
        .send({
          companyId: company.id,
          amountCents,
          description: `Charge ${amountCents}`,
          includeOnboarding: false,
        })
        .expect(201);
      expect(res.body.subtotalCents + res.body.vatCents).toBe(amountCents);
      expect(Number.isInteger(res.body.subtotalCents)).toBe(true);
      expect(Number.isInteger(res.body.vatCents)).toBe(true);
    }
  });

  it('uses the office rate, and stores it with the invoice', async () => {
    await request(app).put('/api/settings').set(auth()).send({ vatRate: 0 }).expect(200);
    const company = await makeCompany();
    const zeroRated = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 50000,
        description: 'Zero-rated export',
        includeOnboarding: false,
      })
      .expect(201);
    expect(zeroRated.body.vatCents).toBe(0);
    expect(zeroRated.body.subtotalCents).toBe(50000);
    expect(zeroRated.body.vatRate).toBe(0);

    await request(app).put('/api/settings').set(auth()).send({ vatRate: 20 }).expect(200);
    const raised = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 120000,
        description: 'At 20%',
        includeOnboarding: false,
      })
      .expect(201);
    expect(raised.body.vatCents).toBe(20000);
    // The earlier invoice keeps the rate it was issued at — a rate change never
    // restates an issued document.
    const earlier = await request(app)
      .get(`/api/billing/invoices/${zeroRated.body.id}`)
      .set(auth())
      .expect(200);
    expect(earlier.body.vatRate).toBe(0);
    expect(earlier.body.subtotalCents).toBe(50000);
  });

  it('rejects an impossible rate', async () => {
    await request(app).put('/api/settings').set(auth()).send({ vatRate: 101 }).expect(400);
    await request(app).put('/api/settings').set(auth()).send({ vatRate: -1 }).expect(400);
    await request(app).put('/api/settings').set(auth()).send({ vatRate: 15.5 }).expect(400);
  });

  it('leaves invoices raised before the split without one, rather than inventing it', async () => {
    // A document already issued has no breakdown; back-filling one would state
    // tax figures that were never on it.
    const company = await makeCompany();
    const legacy = getRegistryDb()
      .prepare(
        `INSERT INTO invoices (company_id, invoice_number, amount_cents, due_date, status)
         VALUES (?, 'INV-20260915-1234', 100000, '2026-09-30', 'pending')`,
      )
      .run(company.id);
    const res = await request(app)
      .get(`/api/billing/invoices/${Number(legacy.lastInsertRowid)}`)
      .set(auth())
      .expect(200);
    expect(res.body.subtotalCents).toBeNull();
    expect(res.body.vatCents).toBeNull();
    expect(res.body.vatRate).toBeNull();
  });
});

describe('the plan on an invoice', () => {
  it('is recorded when the invoice is raised, and survives a plan rename', async () => {
    const company = await makeCompany();
    const plans = await request(app).get('/api/plans').set(auth()).expect(200);
    const plan = (plans.body as Array<{ id: number; name: string; code: string }>).find(
      (p) => p.code === 'vula-grow',
    )!;

    const raised = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(raised.body.planCode).toBe('vula-grow');
    expect(raised.body.planName).toBe(plan.name);

    // The catalogue entry is renamed. An issued invoice is a document: it keeps
    // the name it was written with, rather than adopting today's.
    await request(app)
      .put(`/api/plans/${plan.id}`)
      .set(auth())
      .send({ name: 'Vula Grow Plus' })
      .expect(200);

    const after = await request(app)
      .get(`/api/billing/invoices/${raised.body.id}`)
      .set(auth())
      .expect(200);
    expect(after.body.planName).toBe(plan.name);
    expect(after.body.planName).not.toBe('Vula Grow Plus');

    // A new invoice does carry the new name — the snapshot is per document.
    const next = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'renewal' })
      .expect(201);
    expect(next.body.planName).toBe('Vula Grow Plus');
  });

  it('names the plan on a hand-priced invoice too, and on an onboarding one', async () => {
    const company = await makeCompany();
    const handPriced = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 250000,
        description: 'Installation',
        includeOnboarding: false,
      })
      .expect(201);
    expect(handPriced.body.planCode).toBe('vula-grow');

    const onboarding = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, purpose: 'onboarding' })
      .expect(201);
    expect(onboarding.body.planName).toBeTruthy();
  });

  it('reports no plan rather than guessing one', async () => {
    // A client with no plan: the invoice must say nothing, not invent a tier.
    // (Created without one — the company PUT cannot clear a plan.)
    const company = await makeCompany({
      name: 'No Plan Co',
      slug: 'no-plan-co',
      planId: null,
    });
    const res = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({
        companyId: company.id,
        amountCents: 100000,
        description: 'Ad hoc',
        includeOnboarding: false,
      })
      .expect(201);
    expect(res.body.planCode).toBeNull();
    expect(res.body.planName).toBeNull();
  });
});
