import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse } from './helpers.js';
import { resetRateLimits } from '../utils/rateLimiter.js';

const app = createApp();

/**
 * The marketing site's quote request — the only unauthenticated surface on the
 * control plane, and the one place a stranger can cause an email to leave our
 * domain. These tests are therefore about the guards as much as the message:
 * who the mail can be sent to, what happens to a bot, and what a refusal looks
 * like to the page.
 */

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

let fetchMock: jest.SpyInstance;

const validQuote = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  business: 'Corner Motors',
  name: 'Thandi',
  email: 'thandi@cornermotors.co.za',
  phone: '082 123 4567',
  vertical: 'spares',
  note: 'We open in November.',
  stores: 3,
  tills: 2,
  lines: [
    { label: '6 tills (3 stores × 2)', amount: 'R 594,00' },
    { label: 'Head Office', amount: 'R 99,00' },
  ],
  // The page sends the bare amount; the endpoint is what words it as "per month".
  monthlyTotal: 'R 693,00',
  setupLabel: 'Set-up, once off (assisted, includes provisioning all 3 stores)',
  setupAmount: 'R 5 000,00',
  ...over,
});

const lastCall = (): [string, FetchInit | undefined] => {
  const calls = fetchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return [String(calls[calls.length - 1][0]), calls[calls.length - 1][1] as FetchInit];
};

const sentPayload = (): Record<string, any> => {
  const [url, init] = lastCall();
  expect(url).toBe('https://api.resend.com/emails');
  return JSON.parse(String(init?.body)) as Record<string, any>;
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

describe('POST /api/public/quote-request', () => {
  it('mails the office and the visitor, answering the visitor', async () => {
    const res = await request(app).post('/api/public/quote-request').send(validQuote());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const payload = sentPayload();
    expect(payload.from).toBe('Vula <hello@vula-app.co.za>');
    // Both addresses on one message: that IS the "copy to you" the page promises.
    expect(payload.to).toEqual(['hello@vula-app.co.za', 'thandi@cornermotors.co.za']);
    expect(payload.reply_to).toBe('thandi@cornermotors.co.za');
    expect(String(payload.subject)).toContain('Corner Motors');
    expect(String(payload.subject)).toContain('R 693,00 / month');
    expect(String(payload.text)).toContain('• 6 tills (3 stores × 2): R 594,00');
    expect(String(payload.text)).toContain('Mobile: 082 123 4567');
    expect(String(payload.text)).toContain('Trade: spares');
    expect(String(payload.text)).toContain('Their note:');
    expect(String(payload.html)).toContain('thandi@cornermotors.co.za');
  });

  it('takes QUOTE_TO as the office address, so it can move without a rebuild', async () => {
    process.env.QUOTE_TO = 'sales@vula-app.co.za';
    await request(app).post('/api/public/quote-request').send(validQuote()).expect(200);
    expect(sentPayload().to[0]).toBe('sales@vula-app.co.za');
  });

  it('cannot be pointed at a third party — there is no recipient field on the wire', async () => {
    await request(app)
      .post('/api/public/quote-request')
      .send({ ...validQuote(), to: 'victim@example.com', cc: 'victim2@example.com' })
      .expect(200);
    const payload = sentPayload();
    expect(JSON.stringify(payload)).not.toContain('victim@example.com');
    expect(JSON.stringify(payload)).not.toContain('victim2@example.com');
  });

  it('says ok to a bot and sends nothing when the honeypot is filled', async () => {
    const res = await request(app)
      .post('/api/public/quote-request')
      .send({ ...validQuote(), website: 'http://cheap-pills.example' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed address, an empty quote and an implausible amount', async () => {
    const badEmail = await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ email: 'not-an-address' }));
    expect(badEmail.status).toBe(400);

    const noLines = await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ lines: [] }));
    expect(noLines.status).toBe(400);

    const oddAmount = await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ monthlyTotal: '<script>alert(1)</script>' }));
    expect(oddAmount.status).toBe(400);

    const wildStores = await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ stores: 500 }));
    expect(wildStores.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a mobile number that could actually ring', async () => {
    // No way to answer them is no lead — and a phone-shaped string is all this
    // checks, deliberately: the office reads it, the form is what enforces more.
    const missing = await request(app)
      .post('/api/public/quote-request')
      .send(validQuote({ phone: '' }));
    expect(missing.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a transport refusal as 502 with a message the page can show', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(422, { message: 'domain not verified' }));
    const res = await request(app).post('/api/public/quote-request').send(validQuote());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('quote_send_failed');
    expect(String(res.body.error)).toMatch(/email us directly/i);
  });

  it('answers a visitor with the same message when no transport is configured', async () => {
    // A public endpoint does not say whether our mail is set up: a stranger gets
    // the one sentence the page knows how to show, and the operator gets the
    // reason in the log (the authenticated routes keep their specific 400s).
    process.env.RESEND_API_KEY = '';
    const res = await request(app).post('/api/public/quote-request').send(validQuote());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('quote_send_failed');
  });

  it('allows the site’s origin only', async () => {
    const preflight = await request(app)
      .options('/api/public/quote-request')
      .set('Origin', 'https://vula-app.co.za')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('https://vula-app.co.za');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');

    const foreign = await request(app)
      .post('/api/public/quote-request')
      .set('Origin', 'https://not-our-site.example')
      .send(validQuote());
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    fetchMock.mockClear();
  });

  it('rate-limits a source address, so the form cannot be a mail cannon', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app).post('/api/public/quote-request').send(validQuote());
      statuses.push(res.status);
    }
    // Five in the hour, then a refusal — and the refusal is not a send.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
