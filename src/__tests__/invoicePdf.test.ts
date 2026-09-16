import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import {
  AMOUNT_LEFT,
  AMOUNT_WIDTH,
  DESCRIPTION_WIDTH,
  PAGE_RIGHT,
  moneyColumnFits,
  moneyWidth,
} from '../services/invoicePdf.js';
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

const makeCompany = async (over: Record<string, unknown> = {}) => {
  const plans = await request(app).get('/api/plans').set(auth()).expect(200);
  const plan = (plans.body as Array<{ id: number; code: string }>).find(
    (p) => p.code === 'vula-network',
  )!;
  const res = await request(app)
    .post('/api/companies')
    .set(auth())
    .send({
      name: 'Urban Threads Retail Group',
      slug: 'urban-threads',
      billingEmail: 'ap@urban-threads.co.za',
      planId: plan.id,
      licensedTerminalCount: 9,
      ...over,
    })
    .expect(201);
  return res.body as { id: number };
};

/**
 * The PDF is checked structurally rather than by scraping its text: pdfkit writes
 * literal strings with kerning numbers interleaved (`[V 60 ula 0] TJ`), so a
 * naive decode cannot tell a kerning value from a digit in the content, and an
 * assertion built on it would be fiction. What is asserted here is the part a
 * change can actually break — the geometry, measured with pdfkit's own metrics.
 */
describe('the invoice PDF', () => {
  it('fits the largest realistic amount in the money column, on one line', () => {
    // The regression: the first cut used a 57pt column, narrow even for
    // R14 500,00 at 11pt bold — so pdfkit drew "R 14 500,0" / "0".
    expect(moneyWidth('R 14 500,00')).toBeGreaterThan(57);
    expect(moneyColumnFits('R 14 500,00')).toBe(true);
    // Seven figures is the widest a ZAR subscription invoice realistically gets.
    expect(moneyColumnFits('R 1 234 567,89')).toBe(true);
    // And the check has teeth: a figure past the column really does not fit.
    expect(moneyColumnFits('R 1 234 567 890 123,45')).toBe(false);
  });

  it('keeps the description clear of the money column, inside the margins', () => {
    expect(48 + DESCRIPTION_WIDTH).toBeLessThan(AMOUNT_LEFT);
    expect(AMOUNT_LEFT + AMOUNT_WIDTH).toBe(PAGE_RIGHT);
    // A4 is 595.28pt wide; the content box must sit inside the 48pt margins.
    expect(PAGE_RIGHT).toBeLessThanOrEqual(595.28 - 48);
  });

  it('renders a real document for every shape of invoice', async () => {
    const company = await makeCompany();
    const shapes: Array<Record<string, unknown>> = [
      { purpose: 'initial' }, // subscription + once-off onboarding
      { purpose: 'renewal' }, // recurring only
      { amountCents: 123_456_789, description: 'Installation and training' }, // hand-priced
    ];

    for (const body of shapes) {
      const created = await request(app)
        .post('/api/billing/invoices')
        .set(auth())
        .send({ companyId: company.id, ...body })
        .expect(201);
      const pdf = await request(app)
        .get(`/api/billing/invoices/${created.body.id}/pdf`)
        .set(auth())
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain(`${created.body.invoiceNumber}.pdf`);
      // A real one-page PDF, not an empty buffer.
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
    }
  });

  it('names the download after the invoice and refuses what it cannot serve', async () => {
    const company = await makeCompany();
    const created = await request(app)
      .post('/api/billing/invoices')
      .set(auth())
      .send({ companyId: company.id, amountCents: 250000, description: 'Installation' })
      .expect(201);

    await request(app).get('/api/billing/invoices/424242/pdf').set(auth()).expect(404);
    await request(app).get(`/api/billing/invoices/${created.body.id}/pdf`).expect(401);
  });
});
