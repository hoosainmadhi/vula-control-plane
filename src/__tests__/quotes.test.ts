import request from 'supertest';
import { createApp } from '../app.js';
import { getRegistryDb, resetRegistryDb } from '../config/registryDb.js';
import { authHeader, jsonResponse, loginAsOffice } from './helpers.js';
import { resetRateLimits } from '../utils/rateLimiter.js';

/**
 * The quote desk records. The public endpoint is the door (§45): a request must
 * become a numbered, priced record before it becomes an email — the tests here
 * are about what lands in the registry, what a bot or a bad payload leaves
 * behind (nothing), and what a failed send keeps (the lead).
 */

const app = createApp();

let fetchMock: jest.SpyInstance;

const validQuote = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  business: 'Corner Motors',
  name: 'Thandi',
  email: 'thandi@cornermotors.co.za',
  phone: '082 123 4567',
  vertical: 'spares',
  note: 'We open in November.',
  stores: 3,
  tills: 6,
  addons: ['multi_store'],
  setup: 'assisted',
  lines: [
    { label: '3 stores (first till included)', amount: 'R 597,00' },
    { label: '3 additional tills', amount: 'R 147,00' },
    { label: 'Head Office', amount: 'R 199,00' },
  ],
  monthlyTotal: 'R 943,00',
  setupLabel: 'Set-up, once off (assisted, includes provisioning all 3 stores)',
  setupAmount: 'R 5 000,00',
  ...over,
});

const quoteRows = (): Array<Record<string, any>> =>
  getRegistryDb().prepare('SELECT * FROM quotes ORDER BY id').all() as Array<Record<string, any>>;

const payloadAt = (index: number): Record<string, any> => {
  const call = fetchMock.mock.calls[index];
  expect(call).toBeTruthy();
  expect(String(call[0])).toBe('https://api.resend.com/emails');
  return JSON.parse(String((call[1] as { body?: string })?.body)) as Record<string, any>;
};

beforeEach(() => {
  resetRegistryDb();
  // The endpoint's buckets are per-process; each test starts from zero.
  resetRateLimits();
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM = 'Vula <hello@vula-app.co.za>';
  delete process.env.QUOTE_TO;
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async () => jsonResponse(200, { id: 'resend-msg-1' }));
});

afterEach(() => {
  fetchMock.mockRestore();
  process.env.RESEND_API_KEY = '';
  process.env.RESEND_FROM = '';
});

describe('a request becomes a numbered, priced record', () => {
  it('records the quote with the catalogue’s own figures', async () => {
    const res = await request(app).post('/api/public/quote-request').send(validQuote());
    expect(res.status).toBe(200);

    const rows = quoteRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.quote_number).toMatch(/^VULA-Q-\d{4}-000001$/);
    expect(row.status).toBe('new');
    expect(row.monthly_total_cents).toBe(94300);
    expect(row.setup_cents).toBe(500000);
    expect(row.drift).toBe(0);
    expect(row.addons_json).toBe('["multi_store"]');
    expect(JSON.parse(row.priced_lines_json)).toEqual([
      {
        label: '3 stores',
        detail: 'first till included · (2 tills per store)',
        cents: 59700,
        rateCents: 19_900,
        quantity: 3,
      },
      { label: '3 additional tills', detail: '', cents: 14700, rateCents: 4_900, quantity: 3 },
      { label: 'Head Office', detail: '', cents: 19_900, rateCents: 19_900, quantity: 1 },
    ]);
    // The email went out and the record says so.
    expect(row.emailed_at).toBeTruthy();
    expect(row.email_error).toBeNull();
    // The desk's subject carries the number; the visitor's copy does not.
    expect(String(payloadAt(0).subject)).toContain(row.quote_number);
    expect(String(payloadAt(1).subject)).not.toContain('VULA-Q-');
  });

  it('flags a drifted page figure but keeps the catalogue’s own', async () => {
    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ monthlyTotal: 'R 1,00' }))
      .expect(200);
    const row = quoteRows()[0];
    expect(row.drift).toBe(1);
    expect(row.monthly_total_cents).toBe(94300);
    expect(row.requested_monthly_cents).toBe(100);
    // The desk's copy names both figures; the visitor's copy keeps their own.
    const deskText = String(payloadAt(0).text);
    expect(deskText).toContain('1,00');
    expect(deskText).toMatch(/943,00/);
    expect(String(payloadAt(1).text)).toContain('R 1,00');
  });

  it('prices the set-up from Office Settings, not a constant (2026-10-14)', async () => {
    // The once-off pair has one home: the office's own settings. A price change
    // must follow through to the quote the desk records AND to the list the
    // marketing page hydrates from — without a deploy.
    const token = await loginAsOffice(app);
    await request(app)
      .put('/api/settings')
      .set(authHeader(token))
      .send({ setupFeeAssistedCents: 750_000, setupFeeSelfCents: 200_000 })
      .expect(200);

    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ setupAmount: 'R 7 500,00' }))
      .expect(200);
    expect(quoteRows()[0].setup_cents).toBe(750_000);

    const list = await request(app).get('/api/public/pricing').expect(200);
    expect(list.body.pricing.setup).toEqual({ assisted: 750_000, self: 200_000 });

    // And the desk's own drafts price from the same pair.
    const draft = await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({
        business: 'Settings Co',
        email: 'x@example.com',
        stores: 1,
        tills: 1,
        addons: [],
        setup: 'self',
      })
      .expect(201);
    expect(draft.body.quote.priced.setupCents).toBe(200_000);
  });

  it('a honeypot fill records nothing and sends nothing', async () => {
    const res = await request(app)
      .post('/api/public/quote-request')
      .send({ ...validQuote(), website: 'http://cheap-pills.example' });
    expect(res.status).toBe(200);
    expect(quoteRows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown add-on, a bad setup choice, and Head Office on one store', async () => {
    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ addons: ['free_lunch'] }))
      .expect(400);
    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ setup: 'free' }))
      .expect(400);
    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ stores: 1, tills: 2, addons: ['multi_store'] }))
      .expect(400);
    // 3 stores at 1 till total: the typo the desk's own create form used to allow.
    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ stores: 3, tills: 1 }))
      .expect(400);
    expect(quoteRows()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a transport failure keeps the lead, stamped with the reason', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(422, { message: 'domain not verified' }));
    const res = await request(app).post('/api/public/quote-request').send(validQuote());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('quote_send_failed');

    const rows = quoteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].emailed_at).toBeNull();
    expect(rows[0].email_error).toBeTruthy();
  });
});

describe('numbering', () => {
  it('is sequential, and continues from the highest number already written', async () => {
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    let rows = quoteRows();
    expect(rows.map((row) => row.quote_number.slice(-6))).toEqual(['000001', '000002']);

    // A restored backup (or an imported desk) holding higher numbers must not be
    // re-issued: the counter heals from what is already written.
    const db = getRegistryDb();
    const year = new Date().getUTCFullYear();
    db.prepare(
      `INSERT INTO quotes (quote_number, email, phone, stores, tills, setup_variant,
                           monthly_total_cents, setup_cents, vat_rate,
                           monthly_vat_cents, setup_vat_cents)
       VALUES (?, 'stale@example.com', '000 000 0000', 1, 1, 'self', 9900, 150000, 15, 1291, 19565)`,
    ).run(`VULA-Q-${year}-000042`);
    db.prepare('UPDATE quote_sequences SET last_value = 0 WHERE year = ?').run(year);

    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    rows = quoteRows();
    expect(rows[rows.length - 1].quote_number).toBe(`VULA-Q-${year}-000043`);
  });
});

describe('the desk is office-only', () => {
  it('refuses a stranger and serves the office the list and the detail', async () => {
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);

    await request(app).get('/api/quotes').expect(401);

    const token = await loginAsOffice(app);
    const list = await request(app).get('/api/quotes').set(authHeader(token)).expect(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.quotes).toHaveLength(1);
    const quote = list.body.quotes[0];
    expect(quote.number).toMatch(/^VULA-Q-/);
    expect(quote.drift).toBe(false);
    expect(quote.priced.monthlyTotalCents).toBe(94300);
    expect(quote.requested.monthlyCents).toBe(94300);

    const detail = await request(app)
      .get(`/api/quotes/${quote.id}`)
      .set(authHeader(token))
      .expect(200);
    expect(detail.body.quote.number).toBe(quote.number);

    await request(app).get('/api/quotes/999').set(authHeader(token)).expect(404);
  });

  it('filters by status and refuses an unknown one', async () => {
    const token = await loginAsOffice(app);
    await request(app).get('/api/quotes?status=new').set(authHeader(token)).expect(200);
    await request(app).get('/api/quotes?status=melted').set(authHeader(token)).expect(400);
  });
});

describe('sending the quotation', () => {
  it('emails the PDF, answers the office, and stamps the record', async () => {
    const token = await loginAsOffice(app);
    await request(app)
      .put('/api/settings')
      .set(authHeader(token))
      .send({ officeName: 'Vula', officeEmail: 'hello@vula-app.co.za' })
      .expect(200);

    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;
    fetchMock.mockClear();

    const sent = await request(app)
      .post(`/api/quotes/${id}/send`)
      .set(authHeader(token))
      .send({})
      .expect(200);

    expect(sent.body.quote.status).toBe('quoted');
    expect(sent.body.quote.sentAt).toBeTruthy();
    const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(sent.body.quote.validUntil).toBe(expected);

    const payload = payloadAt(0);
    expect(payload.to).toEqual(['thandi@cornermotors.co.za']);
    expect(payload.reply_to).toBe('hello@vula-app.co.za');
    expect(String(payload.subject)).toContain('VULA-Q-');
    const attachment = payload.attachments[0] as { filename: string; content: string };
    expect(attachment.filename).toMatch(/^VULA-Q-\d{4}-000001\.pdf$/);
    expect(Buffer.from(attachment.content, 'base64').subarray(0, 5).toString()).toBe('%PDF-');

    const row = quoteRows()[0];
    expect(row.status).toBe('quoted');
    expect(row.sent_at).toBeTruthy();
  });

  it('re-prices when the office corrects the configuration, never the visitor’s snapshot', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    const sent = await request(app)
      .post(`/api/quotes/${id}/send`)
      .set(authHeader(token))
      .send({ stores: 2, tills: 4, addons: [], setup: 'self' })
      .expect(200);

    expect(sent.body.quote.addons).toEqual([]);
    expect(sent.body.quote.priced.monthlyTotalCents).toBe(49600);
    expect(sent.body.quote.priced.setupCents).toBe(150000);
    const row = quoteRows()[0];
    expect(row.requested_monthly_cents).toBe(94300);
    expect(row.requested_setup_cents).toBe(500000);
  });

  it('takes the validity window from Settings', async () => {
    const token = await loginAsOffice(app);
    await request(app)
      .put('/api/settings')
      .set(authHeader(token))
      .send({ quoteValidDays: 14 })
      .expect(200);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    const sent = await request(app)
      .post(`/api/quotes/${id}/send`)
      .set(authHeader(token))
      .send({})
      .expect(200);
    const expected = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(sent.body.quote.validUntil).toBe(expected);

    await request(app)
      .put('/api/settings')
      .set(authHeader(token))
      .send({ quoteValidDays: 999 })
      .expect(400);
  });

  it('refuses to re-send a settled quote', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;
    getRegistryDb().prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(id);

    const res = await request(app)
      .post(`/api/quotes/${id}/send`)
      .set(authHeader(token))
      .send({})
      .expect(409);
    expect(String(res.body.error)).toMatch(/already accepted/i);
  });

  it('stamps nothing when there is no transport', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;
    process.env.RESEND_API_KEY = '';

    const res = await request(app)
      .post(`/api/quotes/${id}/send`)
      .set(authHeader(token))
      .send({})
      .expect(400);
    expect(res.body.code).toBe('smtp_not_configured');
    const row = quoteRows()[0];
    expect(row.status).toBe('new');
    expect(row.sent_at).toBeNull();
  });
});

describe('the pipeline', () => {
  it('records the acceptance, the audit trail says so, and settled stays settled', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    const res = await request(app)
      .post(`/api/quotes/${id}/accept`)
      .set(authHeader(token))
      .send({})
      .expect(200);
    expect(res.body.quote.status).toBe('accepted');
    expect(res.body.quote.acceptedAt).toBeTruthy();

    const audit = getRegistryDb()
      .prepare("SELECT * FROM audit_logs WHERE action = 'quote_accepted'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);

    const again = await request(app)
      .post(`/api/quotes/${id}/accept`)
      .set(authHeader(token))
      .send({})
      .expect(409);
    expect(String(again.body.error)).toMatch(/already accepted/i);
  });

  it('records a decline', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    const res = await request(app)
      .post(`/api/quotes/${id}/decline`)
      .set(authHeader(token))
      .send({})
      .expect(200);
    expect(res.body.quote.status).toBe('declined');
    expect(res.body.quote.declinedAt).toBeTruthy();
  });

  it('reads a sent quote as expired once its validity has passed', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    // Not expired before it is sent — there is no validity yet.
    let detail = await request(app).get(`/api/quotes/${id}`).set(authHeader(token)).expect(200);
    expect(detail.body.quote.expired).toBe(false);

    await request(app).post(`/api/quotes/${id}/send`).set(authHeader(token)).send({}).expect(200);
    detail = await request(app).get(`/api/quotes/${id}`).set(authHeader(token)).expect(200);
    expect(detail.body.quote.expired).toBe(false);

    // Expired once the validity date is behind us — derived, never stored: the
    // record keeps saying `quoted`, because that is what happened.
    getRegistryDb()
      .prepare("UPDATE quotes SET valid_until = date('now', '-1 day') WHERE id = ?")
      .run(id);
    detail = await request(app).get(`/api/quotes/${id}`).set(authHeader(token)).expect(200);
    expect(detail.body.quote.expired).toBe(true);
    expect(detail.body.quote.status).toBe('quoted');
  });

  it('creates the client from the quote, priced from the quote’s own figures', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    // Acceptance first: the client a quote becomes follows a recorded yes.
    await request(app)
      .post(`/api/quotes/${id}/create-client`)
      .set(authHeader(token))
      .send({})
      .expect(409);
    await request(app).post(`/api/quotes/${id}/accept`).set(authHeader(token)).send({}).expect(200);

    const plansRes = await request(app).get('/api/plans').set(authHeader(token)).expect(200);
    const plan = (plansRes.body as Array<{ id: number; code: string }>).find(
      (p) => p.code === 'vula-network',
    );
    expect(plan).toBeTruthy();

    const created = await request(app)
      .post(`/api/quotes/${id}/create-client`)
      .set(authHeader(token))
      .send({ planId: plan!.id })
      .expect(201);
    expect(created.body.company.id).toBeGreaterThan(0);
    expect(created.body.quote.companyId).toBe(created.body.company.id);

    const company = getRegistryDb()
      .prepare('SELECT * FROM companies WHERE id = ?')
      .get(created.body.company.id) as Record<string, unknown>;
    expect(company.name).toBe('Corner Motors');
    expect(company.slug).toBe('corner-motors');
    expect(company.billing_email).toBe('thandi@cornermotors.co.za');

    const subscription = getRegistryDb()
      .prepare('SELECT * FROM company_subscriptions WHERE company_id = ?')
      .get(created.body.company.id) as Record<string, unknown>;
    expect(subscription.licensed_terminal_count).toBe(6);
    expect(subscription.rate_cents).toBe(4900);
    expect(subscription.setup_fee_cents).toBe(500000);
    expect(JSON.parse(String(subscription.addon_prices_json))).toEqual({ multi_store: 19_900 });

    // One client per quote.
    await request(app)
      .post(`/api/quotes/${id}/create-client`)
      .set(authHeader(token))
      .send({})
      .expect(409);
  });

  it('needs a name for the client — a visitor who gave none must be given one', async () => {
    const token = await loginAsOffice(app);
    await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ business: '' }))
      .expect(200);
    const id = quoteRows()[0].id;
    await request(app).post(`/api/quotes/${id}/accept`).set(authHeader(token)).send({}).expect(200);

    const res = await request(app)
      .post(`/api/quotes/${id}/create-client`)
      .set(authHeader(token))
      .send({})
      .expect(400);
    expect(String(res.body.error)).toMatch(/needs a name/i);

    // … and the typed one goes through.
    const created = await request(app)
      .post(`/api/quotes/${id}/create-client`)
      .set(authHeader(token))
      .send({ name: 'Walker Spares' })
      .expect(201);
    expect(created.body.company.slug).toBe('walker-spares');
  });
});

describe('the office drafts its own quote', () => {
  it('records it priced by the catalogue, with no request email', async () => {
    const token = await loginAsOffice(app);
    fetchMock.mockClear();

    const res = await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({
        business: 'Kloof Auto',
        contactName: 'Sipho',
        email: 'sipho@example.com',
        phone: '082 000 1111',
        stores: 2,
        tills: 3,
        addons: ['multi_store', 'layby'],
        setup: 'self',
      })
      .expect(201);
    expect(res.body.quote.source).toBe('office');
    expect(res.body.quote.status).toBe('new');
    // 2 stores × R199 + 1 additional till × R49 + Head Office R199 + 2 stores ×
    // Lay-by R49, self set-up (2026-10-14: stores, and per-store add-ons).
    expect(res.body.quote.priced.monthlyTotalCents).toBe(74400);
    expect(res.body.quote.priced.setupCents).toBe(150000);
    // No page, so nothing to disagree with — and no request email to send.
    expect(res.body.quote.requested.monthlyCents).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const row = quoteRows()[0];
    expect(row.source).toBe('office');
    expect(row.emailed_at).toBeNull();
    const audit = getRegistryDb()
      .prepare("SELECT * FROM audit_logs WHERE action = 'quote_created'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
  });

  it('refuses a nameless draft, a bad address and an unknown add-on', async () => {
    const token = await loginAsOffice(app);
    const base = {
      business: 'X',
      email: 'x@example.com',
      stores: 1,
      tills: 1,
      addons: [],
      setup: 'self',
    };
    await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({ ...base, business: ' ' })
      .expect(400);
    await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({ ...base, email: 'nope' })
      .expect(400);
    await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({ ...base, addons: ['free_lunch'] })
      .expect(400);
    expect(quoteRows()).toHaveLength(0);
  });

  it('sends through the same pipeline from a draft', async () => {
    const token = await loginAsOffice(app);
    const created = await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({
        business: 'Kloof Auto',
        email: 'sipho@example.com',
        stores: 1,
        tills: 1,
        addons: [],
        setup: 'self',
      })
      .expect(201);
    await request(app)
      .post(`/api/quotes/${created.body.quote.id}/send`)
      .set(authHeader(token))
      .send({})
      .expect(200);
    const row = quoteRows()[0];
    expect(row.status).toBe('quoted');
    expect(row.sent_at).toBeTruthy();
    expect(row.source).toBe('office');
  });
});

describe('editing and deleting a quote', () => {
  it('re-prices an edited configuration and never rewrites the visitor’s snapshot', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    const res = await request(app)
      .put(`/api/quotes/${id}`)
      .set(authHeader(token))
      .send({ business: 'Corner Motors (Pty) Ltd', stores: 3, tills: 3, addons: [], setup: 'self' })
      .expect(200);
    expect(res.body.quote.business).toBe('Corner Motors (Pty) Ltd');
    expect(res.body.quote.priced.monthlyTotalCents).toBe(59700);
    expect(res.body.quote.priced.setupCents).toBe(150000);
    const row = quoteRows()[0];
    expect(row.requested_monthly_cents).toBe(94300);
  });

  it('refuses a nameless edit, the fewer-tills-than-stores typo, and a settled quote', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    await request(app)
      .put(`/api/quotes/${id}`)
      .set(authHeader(token))
      .send({ business: ' ' })
      .expect(400);
    await request(app)
      .put(`/api/quotes/${id}`)
      .set(authHeader(token))
      .send({ stores: 3, tills: 1 })
      .expect(400);

    getRegistryDb().prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(id);
    await request(app)
      .put(`/api/quotes/${id}`)
      .set(authHeader(token))
      .send({ business: 'Nope' })
      .expect(409);
  });

  it('deletes a quote that never became a client, and audits it', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    await request(app).delete(`/api/quotes/${id}`).set(authHeader(token)).expect(200);
    expect(quoteRows()).toHaveLength(0);
    await request(app).get(`/api/quotes/${id}`).set(authHeader(token)).expect(404);
    const audit = getRegistryDb()
      .prepare("SELECT * FROM audit_logs WHERE action = 'quote_deleted'")
      .all() as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
  });

  it('refuses to delete the quote a client came from', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;
    await request(app).post(`/api/quotes/${id}/accept`).set(authHeader(token)).send({}).expect(200);
    await request(app)
      .post(`/api/quotes/${id}/create-client`)
      .set(authHeader(token))
      .send({})
      .expect(201);

    const res = await request(app).delete(`/api/quotes/${id}`).set(authHeader(token)).expect(409);
    expect(String(res.body.error)).toMatch(/client/i);
  });
});

describe('the real per-store split', () => {
  it('drafts a quote from the split, and the record reads as the estate is', async () => {
    const token = await loginAsOffice(app);
    const res = await request(app)
      .post('/api/quotes')
      .set(authHeader(token))
      .send({
        business: 'Kloof Auto',
        email: 'sipho@example.com',
        addons: [],
        setup: 'self',
        tillsSplit: [2, 3, 1],
      })
      .expect(201);
    expect(res.body.quote.stores).toBe(3);
    expect(res.body.quote.tills).toBe(6);
    expect(res.body.quote.priced.monthlyTotalCents).toBe(74400);
    expect(res.body.quote.priced.lines[0]).toEqual({
      label: '3 stores',
      detail: 'first till included · (2 + 3 + 1 across 3 stores)',
      cents: 59700,
      rateCents: 19_900,
      quantity: 3,
      split: [2, 3, 1],
    });
    expect(res.body.quote.priced.lines[1]).toEqual({
      label: '3 additional tills',
      detail: '(1 + 2 + 0 extra across 3 stores)',
      cents: 14700,
      rateCents: 4_900,
      quantity: 3,
    });
  });

  it('lets an edit state the split on a request that came in even', async () => {
    const token = await loginAsOffice(app);
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    const id = quoteRows()[0].id;

    const res = await request(app)
      .put(`/api/quotes/${id}`)
      .set(authHeader(token))
      .send({ tillsSplit: [2, 3, 1] })
      .expect(200);
    expect(res.body.quote.stores).toBe(3);
    expect(res.body.quote.tills).toBe(6);
    // The visitor's snapshot is untouched — they saw the even builder.
    const row = quoteRows()[0];
    expect(row.requested_monthly_cents).toBe(94300);
    expect(JSON.parse(row.priced_lines_json)[0].detail).toBe(
      'first till included · (2 + 3 + 1 across 3 stores)',
    );
  });

  it('refuses a malformed split, and the even path still needs its pair', async () => {
    const token = await loginAsOffice(app);
    const base = {
      business: 'X',
      email: 'x@example.com',
      addons: [],
      setup: 'self',
    };
    for (const bad of [[0, 3], [], [1.5], Array(51).fill(1), Array(11).fill(50), '2,3']) {
      await request(app)
        .post('/api/quotes')
        .set(authHeader(token))
        .send({ ...base, tillsSplit: bad })
        .expect(400);
    }
    await request(app).post('/api/quotes').set(authHeader(token)).send(base).expect(400);
    expect(quoteRows()).toHaveLength(0);
  });
});
