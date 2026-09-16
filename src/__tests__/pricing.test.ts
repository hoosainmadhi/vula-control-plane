import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { proRataForIncrease, PERIOD_DAYS } from '../services/pricing.js';
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
  fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true }));
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

const planIdByCode = async (code: string): Promise<number> => {
  const res = await request(app).get('/api/plans').set(auth()).expect(200);
  return (res.body as Array<{ id: number; code: string }>).find((p) => p.code === code)!.id;
};

const makeClient = async (over: Record<string, unknown> = {}) => {
  const planId = await planIdByCode('vula-grow');
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Priced Co',
      slug: 'priced-co',
      billingEmail: 'ap@priced.co.za',
      planId,
      licensedTerminalCount: 8,
      ...over,
    })
    .expect(201);
  return res.body as { id: number; subscription: { recurringAmountCents: number | null } };
};

describe('proRataForIncrease', () => {
  const today = new Date('2026-09-15T09:00:00.000Z');
  const base = {
    pricingMode: 'per_terminal' as const,
    rateCents: 50_000,
    licensedTerminalCount: 10,
    paidTerminalCount: 8,
    paidThrough: '2026-09-30',
    billingPeriod: 'monthly' as const,
    today,
  };

  it('charges the extra terminals for the days left in the paid period', () => {
    const charge = proRataForIncrease(base);
    // 2 extra terminals × R500 × 15/30 days = R500.
    expect(charge).toEqual({
      extraTerminals: 2,
      amountCents: 50_000,
      daysRemaining: 15,
      periodDays: PERIOD_DAYS.monthly,
      from: '2026-09-15',
      to: '2026-09-30',
    });
  });

  it('has nothing to charge when the quantity did not grow', () => {
    expect(proRataForIncrease({ ...base, licensedTerminalCount: 8 })).toBeNull();
    expect(proRataForIncrease({ ...base, licensedTerminalCount: 6 })).toBeNull();
  });

  it('has nothing to charge without a paid period to pro-rate against', () => {
    // No settled invoice, no paid-through date, or a period that has already ended.
    expect(proRataForIncrease({ ...base, paidTerminalCount: null })).toBeNull();
    expect(proRataForIncrease({ ...base, paidThrough: null })).toBeNull();
    expect(proRataForIncrease({ ...base, paidThrough: '2026-09-14' })).toBeNull();
    expect(proRataForIncrease({ ...base, paidThrough: '2026-09-15' })).toBeNull();
  });

  it('charges a whole period when the whole period is still ahead', () => {
    // The client paid for this period; the extra terminals are not covered by it,
    // and the next invoice is for the NEXT period. So a full-length run still
    // charges — 30 of 30 days.
    const charge = proRataForIncrease({ ...base, paidThrough: '2026-10-15' })!;
    expect(charge.daysRemaining).toBe(PERIOD_DAYS.monthly);
    expect(charge.amountCents).toBe(2 * 50_000);
  });

  it('does not pro-rate a negotiated flat deal or a once-off plan', () => {
    // There is no per-terminal figure to multiply.
    expect(proRataForIncrease({ ...base, pricingMode: 'custom' })).toBeNull();
    expect(proRataForIncrease({ ...base, rateCents: 0 })).toBeNull();
    expect(proRataForIncrease({ ...base, billingPeriod: 'once-off' })).toBeNull();
  });

  it('pro-rates an annual period over 365 days', () => {
    const charge = proRataForIncrease({
      ...base,
      billingPeriod: 'annual',
      paidThrough: '2027-09-01',
      today: new Date('2026-09-15T00:00:00.000Z'),
    })!;
    expect(charge.periodDays).toBe(365);
    expect(charge.daysRemaining).toBe(351);
    expect(charge.amountCents).toBe(Math.round((2 * 50_000 * 351) / 365));
  });
});

describe('mid-period increases', () => {
  /** A client with a settled invoice for 8 terminals, paid to the end of the month. */
  const withPaidPeriod = async (): Promise<{ id: number; paidThrough: string }> => {
    const paidThrough = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const client = await makeClient({ paidThrough });
    const invoice = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: client.id, purpose: 'initial', includeOnboarding: false })
      .expect(201);
    // 8 licensed terminals × R500 = R4 000.
    expect(invoice.body.amountCents).toBe(400_000);
    await request(app)
      .post(`/api/billing/invoices/${invoice.body.id}/pay`)
      .set(auth())
      .send({ method: 'manual' })
      .expect(200);
    return { id: client.id, paidThrough };
  };

  it('shows the charge when the client buys more terminals mid-period', async () => {
    const client = await withPaidPeriod();
    // Before the increase there is nothing to charge.
    const before = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(before.body.subscription.midPeriodCharge).toBeNull();

    await request(app)
      .put(`/api/companies/${client.id}`)
      .set(auth())
      .send({ licensedTerminalCount: 10 })
      .expect(200);

    const after = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    const charge = after.body.subscription.midPeriodCharge;
    expect(charge).not.toBeNull();
    expect(charge.extraTerminals).toBe(2);
    expect(charge.amountCents).toBeGreaterThan(0);
  });

  it('raises it as its own invoice, once per period, and refuses when there is nothing to charge', async () => {
    const client = await withPaidPeriod();
    const nothing = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: client.id, purpose: 'pro_rata' })
      .expect(409);
    expect(nothing.body.code).toBe('nothing_to_pro_rate');

    await request(app)
      .put(`/api/companies/${client.id}`)
      .set(auth())
      .send({ licensedTerminalCount: 10 })
      .expect(200);
    const detail = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    const charge = detail.body.subscription.midPeriodCharge;
    expect(charge.billedOn).toBeNull();

    const raised = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: client.id, purpose: 'pro_rata', includeOnboarding: false })
      .expect(201);
    expect(raised.body.amountCents).toBe(charge.amountCents);
    // Not `count × rate`: the line is time-based, so it must not present itself as
    // a full-period terminal charge.
    expect(raised.body.terminalCount).toBeNull();
    expect(raised.body.terminalPriceCents).toBeNull();
    expect(raised.body.description).toContain('2 extra terminals');
    expect(raised.body.description).toContain('of 30 days');

    // The increase is now billed for this period. A second attempt would charge
    // the same days twice, so it is refused and names the invoice that has it.
    const again = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: client.id, purpose: 'pro_rata' })
      .expect(409);
    expect(again.body.code).toBe('pro_rata_already_billed');
    expect(again.body.error).toContain(raised.body.invoiceNumber);

    const after = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(after.body.subscription.midPeriodCharge.billedOn).toBe(raised.body.invoiceNumber);

    // Voiding that invoice frees the period again — the same release rule the
    // once-off charge follows.
    await request(app)
      .post(`/api/billing/invoices/${raised.body.id}/cancel`)
      .set(auth())
      .send({})
      .expect(200);
    const freed = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(freed.body.subscription.midPeriodCharge.billedOn).toBeNull();
  });

  it('never credits a reduction — a smaller quantity applies from the next period', async () => {
    const client = await withPaidPeriod();
    await request(app)
      .put(`/api/companies/${client.id}`)
      .set(auth())
      .send({ licensedTerminalCount: 5 })
      .expect(200);
    const detail = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.midPeriodCharge).toBeNull();
  });
});

describe('the price a client agreed', () => {
  it('is recorded at onboarding, and a plan edit no longer re-prices them', async () => {
    const planId = await planIdByCode('vula-grow');
    const client = await makeClient({ licensedTerminalCount: 8 });
    expect(client.subscription.recurringAmountCents).toBe(400_000);

    const detail = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.pricingSource).toBe('agreed');
    expect(detail.body.subscription.pricedAt).toBeTruthy();

    // The office raises the plan's rate by 20%. The existing client keeps the
    // price they agreed — this is the whole point of the snapshot.
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ terminalPriceCents: 60_000 })
      .expect(200);

    const after = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(after.body.subscription.rateCents).toBe(50_000);
    expect(after.body.subscription.recurringAmountCents).toBe(400_000);

    // A client onboarded after the change pays the new rate.
    const fresh = await makeClient({ name: 'Fresh Co', slug: 'fresh-co' });
    expect(fresh.subscription.recurringAmountCents).toBe(8 * 60_000);
  });

  it('re-prices one client when the office says so, and attributes it', async () => {
    const planId = await planIdByCode('vula-grow');
    const client = await makeClient({ licensedTerminalCount: 8 });
    await request(app)
      .put(`/api/plans/${planId}`)
      .set(auth())
      .send({ terminalPriceCents: 60_000 })
      .expect(200);

    const repriced = await request(app)
      .post(`/api/clients/${client.id}/reprice`)
      .set(auth())
      .send({})
      .expect(200);
    expect(repriced.body.rateCents).toBe(60_000);
    expect(repriced.body.previousRecurringAmountCents).toBe(400_000);
    expect(repriced.body.recurringAmountCents).toBe(480_000);

    const entry = (await import('../config/registryDb.js'))
      .listAuditLogs(20)
      .find((l) => l.action === 'subscription_priced' && l.target_id === client.id);
    expect(entry).toBeDefined();
    expect(entry!.reason).toContain('Re-priced');
  });

  it('records the new plan terms when the office moves a client to another plan', async () => {
    const client = await makeClient({ licensedTerminalCount: 8 });
    const otherPlanId = await planIdByCode('vula-network');

    await request(app)
      .put(`/api/companies/${client.id}`)
      .set(auth())
      .send({ planId: otherPlanId })
      .expect(200);

    const detail = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.planId).toBe(otherPlanId);
    expect(detail.body.subscription.pricingSource).toBe('agreed');
    // Vula Network's rate, not the old plan's.
    expect(detail.body.subscription.rateCents).toBe(50_000);
  });

  it('says so when a client has no agreed price, rather than implying one', async () => {
    const client = await makeClient();
    // Clear the agreement behind the API's back — a legacy row from before the
    // snapshot existed.
    const { getRegistryDb } = await import('../config/registryDb.js');
    getRegistryDb()
      .prepare('UPDATE company_subscriptions SET priced_at = NULL WHERE company_id = ?')
      .run(client.id);

    const detail = await request(app).get(`/api/clients/${client.id}`).set(auth()).expect(200);
    expect(detail.body.subscription.pricingSource).toBe('plan');
    expect(detail.body.subscription.note).toContain('no agreed price recorded');
  });
});
