import request from 'supertest';
import { createApp } from '../app.js';
import {
  createInvoice,
  getCompanyById,
  getRegistryDb,
  listInvoices,
  markOverdueInvoices,
  resetRegistryDb,
} from '../config/registryDb.js';
import { runBillingTick } from '../services/billing.js';
import { authHeader, loginAsOffice } from './helpers.js';

/**
 * The billing tick is the half of "automatic renewal" that was missing: the
 * `overdue` status had no writer and the renewal sweep had no caller, while the
 * Billing page's copy implied both happened on their own (production review,
 * 2026-09-23, §22).
 *
 * The invariant these tests protect above all: a tick raises documents and
 * marks them late — it never records a settlement, because only an explicit
 * settlement may move a client's paid-through date.
 */

const app = createApp();
let token = '';

const DAY = 24 * 60 * 60 * 1000;
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
});

const makeCompany = async (over: { paidThrough?: string | null } = {}): Promise<number> => {
  const plans = await request(app).get('/api/plans').set(authHeader(token)).expect(200);
  const planId = (plans.body as Array<{ id: number; code: string }>).find(
    (p) => p.code === 'vula-grow',
  )!.id;
  const res = await request(app)
    .post('/api/companies')
    .set(authHeader(token))
    .send({
      name: `Tick client ${Math.random().toString(36).slice(2, 7)}`,
      slug: `tick-${Math.random().toString(36).slice(2, 9)}`,
      planId,
      licensedTerminalCount: 4,
      ...(over.paidThrough ? { paidThrough: over.paidThrough } : {}),
    })
    .expect(201);
  return (res.body as { id: number }).id;
};

const invoiceWithDue = (companyId: number, dueInDays: number): number =>
  createInvoice(companyId, 48000, new Date(Date.now() + dueInDays * DAY)).id;

const statusOf = (invoiceId: number): string =>
  listInvoices().find((i) => i.id === invoiceId)!.status;

describe('markOverdueInvoices', () => {
  it('marks a lapsed pending invoice overdue, and leaves the rest alone', async () => {
    const companyId = await makeCompany();
    const lapsed = invoiceWithDue(companyId, -2);
    const dueToday = invoiceWithDue(companyId, 0);
    const future = invoiceWithDue(companyId, 5);

    const marked = markOverdueInvoices(day(0));

    expect(marked).toBe(1);
    expect(statusOf(lapsed)).toBe('overdue');
    // Due today is not yet late — the office has the whole day.
    expect(statusOf(dueToday)).toBe('pending');
    expect(statusOf(future)).toBe('pending');
  });

  it('never restates a paid or voided invoice', async () => {
    const companyId = await makeCompany();
    const paid = invoiceWithDue(companyId, -10);
    const voided = invoiceWithDue(companyId, -10);
    getRegistryDb().prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).run(paid);
    getRegistryDb().prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`).run(voided);

    const marked = markOverdueInvoices(day(0));

    expect(marked).toBe(0);
    expect(statusOf(paid)).toBe('paid');
    expect(statusOf(voided)).toBe('cancelled');
  });

  it('is idempotent — a second run the same day changes nothing', async () => {
    const companyId = await makeCompany();
    const lapsed = invoiceWithDue(companyId, -1);

    expect(markOverdueInvoices(day(0))).toBe(1);
    expect(markOverdueInvoices(day(0))).toBe(0);
    expect(statusOf(lapsed)).toBe('overdue');
  });
});

describe('runBillingTick', () => {
  it('marks lapsed invoices overdue and raises the renewal for a due client', async () => {
    // Two clients, because a client with an open invoice is a different case
    // (below): the sweep reuses that invoice rather than raising a second one.
    const lapsedClient = await makeCompany();
    const lapsed = invoiceWithDue(lapsedClient, -3);
    const renewingClient = await makeCompany({ paidThrough: day(2) });

    const summary = await runBillingTick();

    expect(summary.overdueMarked).toBe(1);
    expect(statusOf(lapsed)).toBe('overdue');
    // Paid through in 2 days is inside the 3-day window, so the sweep raises the
    // next period's invoice.
    expect(summary.renewals.invoicesCreated).toBe(1);
    const created = listInvoices(renewingClient).filter((i) => i.status === 'pending');
    expect(created).toHaveLength(1);
  });

  it('reuses an open invoice instead of raising a second one', async () => {
    const companyId = await makeCompany({ paidThrough: day(2) });
    const open = invoiceWithDue(companyId, 5);

    const summary = await runBillingTick();

    expect(summary.renewals.invoicesCreated).toBe(0);
    expect(listInvoices(companyId)).toHaveLength(1);
    expect(statusOf(open)).toBe('pending');
  });

  it('does not raise a second invoice on the next run', async () => {
    const companyId = await makeCompany({ paidThrough: day(1) });

    const first = await runBillingTick();
    const second = await runBillingTick();

    expect(first.renewals.invoicesCreated).toBe(1);
    expect(second.renewals.invoicesCreated).toBe(0);
    expect(listInvoices(companyId)).toHaveLength(1);
  });

  it('never settles anything: no payment, no period moved', async () => {
    // The whole point of settlement being explicit. If this ever fails, an
    // automatic job has started recording money nobody received — the defect the
    // 2026-09-12 review removed from the sweep in the first place.
    const companyId = await makeCompany({ paidThrough: day(1) });
    const before = getCompanyById(companyId)!.paid_through;

    await runBillingTick();

    const payments = getRegistryDb().prepare('SELECT COUNT(*) AS n FROM payments').get() as {
      n: number;
    };
    expect(payments.n).toBe(0);
    expect(getCompanyById(companyId)!.paid_through).toBe(before);
    expect(listInvoices(companyId)[0].paid_date).toBeNull();
  });

  it('leaves a client whose period is not near its end alone', async () => {
    const companyId = await makeCompany({ paidThrough: day(20) });

    const summary = await runBillingTick();

    expect(summary.renewals.invoicesCreated).toBe(0);
    expect(listInvoices(companyId)).toHaveLength(0);
  });
});
