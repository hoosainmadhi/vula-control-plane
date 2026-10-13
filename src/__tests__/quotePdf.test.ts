import request from 'supertest';
import { createApp } from '../app.js';
import { createQuote, resetRegistryDb, type QuoteInput } from '../config/registryDb.js';
import { moneyColumnFits, moneyWidth } from '../services/invoicePdf.js';
import { brandMarkPng } from '../services/brandMark.js';
import { authHeader, loginAsOffice } from './helpers.js';

const app = createApp();

let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
});

const seedQuote = (over: Partial<QuoteInput> = {}) =>
  createQuote({
    source: 'website',
    business: 'Corner Motors',
    contactName: 'Thandi',
    email: 'thandi@cornermotors.co.za',
    phone: '082 123 4567',
    vertical: 'spares',
    note: 'We open in November.',
    stores: 3,
    tills: 6,
    addons: ['multi_store'],
    setupVariant: 'assisted',
    requestedLines: [{ label: '6 tills (2 tills per store × 3 stores)', amount: 'R 594,00' }],
    requestedMonthlyCents: 69300,
    requestedSetupCents: 500000,
    pricedLines: [
      { label: '6 tills', detail: '(2 tills per store × 3 stores)', cents: 59400 },
      { label: 'Head Office', detail: '', cents: 9900 },
    ],
    monthlyTotalCents: 69300,
    setupCents: 500000,
    vatRate: 15,
    monthlyVatCents: 9039,
    setupVatCents: 65217,
    drift: 0,
    ...over,
  });

/**
 * Checked structurally rather than by scraping text (pdfkit interleaves kerning
 * numbers with literal strings — see `invoicePdf.test.ts`): what is asserted is
 * the geometry, measured with pdfkit's own metrics, and that a real document
 * comes out for every shape a quote can have.
 */
describe('the quotation PDF', () => {
  it("keeps its money column as honest as the invoice's", () => {
    // The geometry constants are shared with invoicePdf; the assertion lives
    // here too, so a change to either document has to face both tests.
    expect(moneyWidth('R 14 500,00')).toBeGreaterThan(57);
    expect(moneyColumnFits('R 1 234 567,89')).toBe(true);
    expect(moneyColumnFits('R 1 234 567 890 123,45')).toBe(false);
  });

  it('carries the Vula mark — a real PNG, so pdfkit can draw it', () => {
    const mark = brandMarkPng();
    expect(mark).toBeTruthy();
    // PNG magic bytes: not an SVG, not an empty file. (The render tests above
    // exercise doc.image with whatever this returns, so a broken asset fails
    // there too — a document must degrade to text-only, never to an error.)
    expect((mark as Buffer).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('renders a real document for every shape of quote', async () => {
    const shapes: Array<Partial<QuoteInput>> = [
      {}, // assisted, one add-on, a named contact
      { addons: [], setupVariant: 'self', stores: 1, tills: 1, business: '', contactName: '' },
      {
        addons: [
          'multi_store',
          'ai_assistant',
          'invoice_import',
          'customer_credit',
          'layby',
          'ecommerce_bridges',
        ],
        business: 'A Very Long Retail Business Name That Wraps Across The Prepared-For Block Ltd',
      },
    ];
    for (const over of shapes) {
      const quote = seedQuote(over);
      const pdf = await request(app)
        .get(`/api/quotes/${quote.id}/pdf`)
        .set(authHeader(token))
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain(`${quote.quote_number}.pdf`);
      // A real one-page PDF, not an empty buffer.
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
    }
  });

  it('is office-only, and 404s what it cannot serve', async () => {
    const quote = seedQuote();
    await request(app).get(`/api/quotes/${quote.id}/pdf`).expect(401);
    await request(app).get('/api/quotes/424242/pdf').set(authHeader(token)).expect(404);
  });
});
