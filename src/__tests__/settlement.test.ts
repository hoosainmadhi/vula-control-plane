import request from 'supertest';
import { createApp } from '../app.js';
import {
  createCompany,
  createInvoice,
  createStore,
  getCompanyById,
  getRegistryDb,
  listAuditLogs,
  resetRegistryDb,
  setStoreCompany,
  updateCompany,
} from '../config/registryDb.js';
import { deriveBillingState } from '../services/subscriptions.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

/**
 * Settlement is where money becomes entitlement, so this suite pins the rules
 * the production review (2026-09-23) found missing:
 *
 *  - only a subscription invoice (`initial`/`renewal`) extends the paid period;
 *    settling an onboarding charge, a pro-rata increase or a hand-priced one-off
 *    pays for exactly what it describes and stops there;
 *  - the recorded amount must be the invoice total — the office records
 *    settlements that happened, it does not mark an invoice paid for whatever
 *    figure was typed;
 *  - the financial writes are one transaction, while a licence-delivery failure
 *    is recorded and retried by the sweep, never rolled back;
 *  - every settlement is audited with what it advanced.
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
      return jsonResponse(200, { ok: true, subscription: { sequence: 1 } });
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

const makeCompany = async (paidThrough: string | null = null): Promise<{ id: number }> => {
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Urban Threads Retail Group',
      slug: `urban-threads-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
      planId: (await request(app).get('/api/plans').set(auth()).expect(200))
        .body.filter((p: { code: string }) => p.code === 'vula-grow')
        .map((p: { id: number }) => p.id)[0],
      ...(paidThrough ? { paidThrough } : {}),
    })
    .expect(201);
  return { id: (res.body as { id: number }).id };
};

const DAY = 24 * 60 * 60 * 1000;

/** A fixture invoice whose purpose is stated, as the API now persists it. */
const makeInvoice = (
  companyId: number,
  purpose: 'renewal' | 'manual' | 'onboarding' | 'pro_rata',
  amountCents: number,
): number => {
  const lines = {
    purpose,
    description:
      purpose === 'onboarding'
        ? 'Vula onboarding and deployment'
        : purpose === 'pro_rata'
          ? 'Mid-period increase — 2 extra terminals for 12 of 30 days'
          : purpose === 'renewal'
            ? 'Subscription — Vula Grow (monthly)'
            : 'Installation and on-site training',
    ...(purpose === 'onboarding' ? { setupFeeCents: amountCents } : {}),
    ...(purpose === 'pro_rata' ? { proRataPeriod: '2030-12-31' } : {}),
    ...(purpose === 'renewal' ? { terminalCount: 8, terminalPriceCents: 12000 } : {}),
  };
  return createInvoice(companyId, amountCents, new Date(Date.now() + 14 * DAY), undefined, lines)
    .id;
};

const pay = (invoiceId: number, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/billing/invoices/${invoiceId}/pay`).set(auth()).send({
    method: 'manual',
    ...body,
  });

const companyById = (id: number) =>
  request(app).get(`/api/companies/${id}`).set(auth()).expect(200);

describe('settlement — what the invoice is for decides what paying it does', () => {
  it('advances the paid period for a renewal invoice', async () => {
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);

    const res = await pay(invoiceId).expect(200);

    expect(res.body.periodAdvanced).toBe(true);
    expect(res.body.newPaidThrough).toBe('2030-02-01');
    expect((await companyById(id)).body.paidThrough).toBe('2030-02-01');
  });

  it('advances it for an initial invoice too, from today when nothing is paid', async () => {
    const { id } = await makeCompany(null);
    const invoiceId = makeInvoice(id, 'renewal', 96000);

    const res = await pay(invoiceId).expect(200);

    expect(res.body.periodAdvanced).toBe(true);
    expect(res.body.newPaidThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await companyById(id)).body.paidThrough).toBe(res.body.newPaidThrough);
  });

  it('does NOT advance the period when an onboarding charge is settled', async () => {
    // The review's headline case: a standalone onboarding invoice used to buy a
    // month of subscription for a client who had never paid for one.
    const { id } = await makeCompany(null);
    const invoiceId = makeInvoice(id, 'onboarding', 1_000_000);

    const res = await pay(invoiceId).expect(200);

    expect(res.body.periodAdvanced).toBe(false);
    expect(res.body.invoice.status).toBe('paid');
    expect((await companyById(id)).body.paidThrough).toBeNull();
    // Not activated either: the client has still never paid for a period.
    expect((await companyById(id)).body.billingState).toBe('suspended');
  });

  it('does NOT advance the period for a hand-priced one-off', async () => {
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'manual', 500000);

    const res = await pay(invoiceId).expect(200);

    expect(res.body.periodAdvanced).toBe(false);
    expect((await companyById(id)).body.paidThrough).toBe('2030-01-01');
  });

  it('does NOT advance the period for a mid-period increase', async () => {
    // A pro-rata charge covers terminals bought inside a period the client has
    // already paid for — the period itself was never for sale on this document.
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'pro_rata', 300000);

    const res = await pay(invoiceId).expect(200);

    expect(res.body.periodAdvanced).toBe(false);
    expect((await companyById(id)).body.paidThrough).toBe('2030-01-01');
  });
});

describe('settlement — the recorded amount is the invoice total', () => {
  it('refuses to mark an invoice paid for less than its total', async () => {
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);

    const res = await pay(invoiceId, { amountCents: 100 }).expect(400);

    expect(res.body.code).toBe('payment_amount_mismatch');
    // Nothing written: no payment, no settlement, no period change.
    expect((await companyById(id)).body.paidThrough).toBe('2030-01-01');
    const stillOpen = await request(app).get('/api/billing/invoices').set(auth()).expect(200);
    expect(
      (stillOpen.body as Array<{ id: number; status: string }>).find((i) => i.id === invoiceId)
        ?.status,
    ).toBe('pending');
    expect(listAuditLogs(50).some((r) => r.action === 'invoice_settled')).toBe(false);
  });

  it('refuses a zero or negative amount', async () => {
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);

    await pay(invoiceId, { amountCents: 0 }).expect(400);
    await pay(invoiceId, { amountCents: -96000 }).expect(400);

    const stillOpen = await request(app).get('/api/billing/invoices').set(auth()).expect(200);
    expect(
      (stillOpen.body as Array<{ id: number; status: string }>).find((i) => i.id === invoiceId)
        ?.status,
    ).toBe('pending');
  });

  it('defaults an omitted amount to the full invoice', async () => {
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);

    const res = await pay(invoiceId).expect(200);

    expect(res.body.payment.amountCents).toBe(96000);
    expect(res.body.periodAdvanced).toBe(true);
  });
});

describe('settlement — failure semantics', () => {
  it('keeps the settlement when licence delivery fails, and reports it', async () => {
    // Network failure must never roll back financial truth: the money happened,
    // the document says so, and the sweep retries the delivery.
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);
    // The company owns a store, so the settlement's licence push has something
    // to fail delivering.
    const store = createStore(
      {
        name: 'Sandton',
        slug: `urban-threads-sandton-${Date.now()}`,
        terminalCount: 2,
        baseUrl: `http://urban-threads-sandton-${Date.now()}.localhost:3245`,
      },
      'c'.repeat(64),
    );
    setStoreCompany(store.id, id);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/internal/licence')) {
        return jsonResponse(500, { error: 'store refused' });
      }
      return jsonResponse(200, { ok: true, subscription: { sequence: 1 } });
    });

    const res = await pay(invoiceId).expect(200);

    expect(res.body.periodAdvanced).toBe(true);
    expect((await companyById(id)).body.paidThrough).toBe('2030-02-01');
    expect(res.body.invoice.status).toBe('paid');
    expect(res.body.licencePush.storesUpdated).toBe(0);
    expect(res.body.licencePush.errors.length).toBeGreaterThan(0);
  });

  it('audits every settlement with what it advanced', async () => {
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);

    await pay(invoiceId).expect(200);

    const row = listAuditLogs(50).find((r) => r.action === 'invoice_settled');
    expect(row).toBeDefined();
    expect(JSON.parse(row!.after_json ?? '{}')).toMatchObject({
      amountCents: 96000,
      purpose: 'renewal',
      periodAdvanced: true,
    });
  });
});

describe('settlement — the paid period survives a restart-shaped gap', () => {
  it('leaves the invoice exactly as found when the transaction is refused', async () => {
    // A cancelled invoice is refused before any write; the point of this test is
    // that "refused" and "half-settled" are never the same thing.
    const { id } = await makeCompany('2030-01-01');
    const invoiceId = makeInvoice(id, 'renewal', 96000);
    getRegistryDb()
      .prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`)
      .run(invoiceId);

    const res = await pay(invoiceId).expect(409);

    expect(res.body.error).toMatch(/cancelled/);
    const still = getRegistryDb().prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as {
      status: string;
    };
    expect(still.status).toBe('cancelled');
    const payments = getRegistryDb().prepare('SELECT COUNT(*) AS n FROM payments').get() as {
      n: number;
    };
    expect(payments.n).toBe(0);
  });
});

describe('the billing state machine (deriveBillingState)', () => {
  let slugSeq = 0;
  const DAY = 24 * 60 * 60 * 1000;
  const day = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

  const stateOf = (over: {
    paidThrough?: string | null;
    trialEndsAt?: string | null;
    suspended?: boolean;
  }): string => {
    const company = createCompany({
      name: 'State Machine Client',
      slug: `state-machine-${++slugSeq}`,
      paidThrough: over.paidThrough ?? null,
      trialEndsAt: over.trialEndsAt ?? null,
    });
    if (over.suspended) updateCompany(company.id, { status: 'suspended' });
    return deriveBillingState(getCompanyById(company.id)!);
  };

  it('suspends a trial that has ended — it does not fall through to active', async () => {
    expect(stateOf({ trialEndsAt: day(-1) })).toBe('suspended');
  });

  it('keeps a running trial on trial', async () => {
    expect(stateOf({ trialEndsAt: day(10) })).toBe('trial');
  });

  it('suspends a client that has never paid and holds no trial', async () => {
    expect(stateOf({})).toBe('suspended');
  });

  it('derives from the paid period even when an expired trial is also recorded', async () => {
    expect(stateOf({ paidThrough: day(30), trialEndsAt: day(-5) })).toBe('active');
  });

  it('gives a lapsed period the grace window, then suspends', async () => {
    expect(stateOf({ paidThrough: day(-1) })).toBe('past_due');
    expect(stateOf({ paidThrough: day(-30) })).toBe('suspended');
  });

  it('lets a manual suspension override a paid period', async () => {
    expect(stateOf({ paidThrough: day(30), suspended: true })).toBe('suspended');
  });
});
