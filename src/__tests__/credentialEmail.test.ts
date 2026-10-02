import request from 'supertest';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

const app = createApp();

/**
 * The outlet's durable copy of its one-time login arrives by email: when the
 * admin account is bootstrapped or the Admin-password action is used, the
 * temporary password is delivered to the store's admin address — and never
 * stored. Only the transport is stubbed, so these tests cover the control
 * plane's own behaviour: deliver when SMTP works and the row knows its
 * address, degrade to the reveal-once modal when it does not.
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

interface StoreBody {
  store: { id: number };
}

let fetchMock: jest.SpyInstance;
let token = '';

const configureSmtp = async (): Promise<void> => {
  await request(app)
    .put('/api/settings')
    .set(authHeader(token))
    .send({
      smtpHost: 'smtp.example.co.za',
      smtpPort: 587,
      smtpUser: 'office@vula.app',
      smtpPass: 'relay-secret',
      smtpFrom: 'office@vula.app',
    })
    .expect(200);
};

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  transport.sendMail.mockReset();
  transport.sendMail.mockImplementation(async () => ({ messageId: '<mock@vula.local>' }));
  transport.createTransport.mockClear();
  // The store generates the temp password and answers the reset proxied to it.
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/api/internal/admin/reset')) {
      return jsonResponse(200, { ok: true, tempPassword: 'STORE-TEMP-PW' });
    }
    return jsonResponse(200, { ok: true });
  });
});

afterEach(() => {
  fetchMock.mockRestore();
});

const createStore = async (adminEmail?: string): Promise<number> => {
  const created = await request(app)
    .post('/api/stores')
    .set(authHeader(token))
    .send({
      name: 'Rehearsal North',
      slug: `rehearsal-north-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      baseUrl: 'http://localhost:3299',
      terminalCount: 2,
      ...(adminEmail ? { adminEmail } : {}),
    })
    .expect(201);
  return (created.body as StoreBody).store.id;
};

describe('store admin credentials by email', () => {
  it('emails the one-time password to the store admin address and says so', async () => {
    await configureSmtp();
    const id = await createStore('manager@north.test');

    const res = await request(app).post(`/api/stores/${id}/reset-admin`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toBe('STORE-TEMP-PW');
    expect(res.body.emailedTo).toBe('manager@north.test');

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    const message = transport.sendMail.mock.calls[0][0] as { to: string; html: string };
    expect(message.to).toBe('manager@north.test');
    expect(message.html).toContain('STORE-TEMP-PW');
  });

  it('degrades to the reveal-once modal when SMTP is unconfigured', async () => {
    const id = await createStore('manager@north.test');

    const res = await request(app).post(`/api/stores/${id}/reset-admin`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toBe('STORE-TEMP-PW');
    expect(res.body.emailedTo).toBeUndefined();
    expect(res.body.emailError).toContain('SMTP is not configured');
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('sends nothing when the row carries no admin address', async () => {
    await configureSmtp();
    const id = await createStore();

    const res = await request(app).post(`/api/stores/${id}/reset-admin`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toBe('STORE-TEMP-PW');
    expect(res.body.emailedTo).toBeUndefined();
    expect(res.body.emailError).toBeUndefined();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});
