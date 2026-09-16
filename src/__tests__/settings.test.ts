import request from 'supertest';
import { createApp } from '../app.js';
import { getRegistryDb, resetRegistryDb, listAuditLogs } from '../config/registryDb.js';
import { authHeader, loginAsOffice } from './helpers.js';

const app = createApp();

/**
 * The mailer is stubbed at the nodemailer boundary, not at our service: these
 * tests are about what the control plane does with a transport — records a
 * send, stamps the invoice, audits the outcome — and never about SMTP itself.
 * `mockSendMail` is the handle the assertions reach for; a rejection is how a
 * relay refusing a message is simulated.
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

let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  transport.sendMail.mockReset();
  transport.sendMail.mockImplementation(async () => ({ messageId: '<mock@vula.local>' }));
  transport.createTransport.mockClear();
});

const auth = (): Record<string, string> => authHeader(token);

/** Puts a working SMTP block into the singleton. */
const configureSmtp = async (over: Record<string, unknown> = {}): Promise<void> => {
  await request(app)
    .put('/api/settings')
    .set(auth())
    .send({
      smtpHost: 'smtp.example.co.za',
      smtpPort: 587,
      smtpUser: 'billing@vula.app',
      smtpPass: 'relay-secret',
      smtpFrom: 'billing@vula.app',
      ...over,
    })
    .expect(200);
};

describe('control-plane settings', () => {
  it('starts from the seeded singleton: office identity, 14-day terms, no SMTP', async () => {
    const res = await request(app).get('/api/settings').set(auth()).expect(200);
    const s = res.body.settings;
    expect(s.officeName).toBe('Vula');
    expect(s.invoiceDueDays).toBe(14);
    expect(s.smtpConfigured).toBe(false);
    expect(s.smtpPass).toBe('');
  });

  it('requires an office session', async () => {
    await request(app).get('/api/settings').expect(401);
    await request(app).put('/api/settings').send({ officeName: 'Vula' }).expect(401);
  });

  it('stores the office identity and returns it on GET', async () => {
    await request(app)
      .put('/api/settings')
      .set(auth())
      .send({
        officeName: 'Vula Software',
        officeEmail: 'accounts@vula.app',
        officePhone: '+27 11 555 0100',
        officeAddress: '1 Main Road, Johannesburg',
        invoiceDueDays: 30,
        invoiceFooter: 'Bank: FNB · Acct 12345',
      })
      .expect(200);

    const res = await request(app).get('/api/settings').set(auth()).expect(200);
    expect(res.body.settings.officeEmail).toBe('accounts@vula.app');
    expect(res.body.settings.invoiceDueDays).toBe(30);
    expect(res.body.settings.invoiceFooter).toBe('Bank: FNB · Acct 12345');
  });

  it('never returns the SMTP password — the mask means "unchanged" on the way back', async () => {
    await configureSmtp();
    const stored = await request(app).get('/api/settings').set(auth()).expect(200);
    expect(stored.body.settings.smtpPass).toBe('••••••••');
    expect(JSON.stringify(stored.body)).not.toContain('relay-secret');

    // Round-tripping the mask (what a form does) must not blank the credential.
    await request(app)
      .put('/api/settings')
      .set(auth())
      .send({ smtpPass: '••••••••', smtpUser: 'billing@vula.app' })
      .expect(200);
    const row = getRegistryDb()
      .prepare('SELECT smtp_pass FROM office_settings WHERE id = 1')
      .get() as { smtp_pass: string };
    expect(row.smtp_pass).toBe('relay-secret');
  });

  it('clears the whole SMTP block when the host is cleared', async () => {
    await configureSmtp();
    await request(app).put('/api/settings').set(auth()).send({ smtpHost: '' }).expect(200);

    const res = await request(app).get('/api/settings').set(auth()).expect(200);
    expect(res.body.settings.smtpConfigured).toBe(false);
    expect(res.body.settings.smtpUser).toBe('');
    expect(res.body.settings.smtpFrom).toBe('');
    const row = getRegistryDb()
      .prepare('SELECT smtp_pass FROM office_settings WHERE id = 1')
      .get() as { smtp_pass: string };
    expect(row.smtp_pass).toBe('');
  });

  it('rejects an empty office name, a malformed address and an out-of-range port', async () => {
    await request(app).put('/api/settings').set(auth()).send({ officeName: '  ' }).expect(400);
    await request(app)
      .put('/api/settings')
      .set(auth())
      .send({ officeEmail: 'not-an-email' })
      .expect(400);
    await request(app).put('/api/settings').set(auth()).send({ smtpFrom: 'billing@' }).expect(400);
    await request(app).put('/api/settings').set(auth()).send({ smtpPort: 0 }).expect(400);
    await request(app).put('/api/settings').set(auth()).send({ smtpPort: 70000 }).expect(400);
    await request(app).put('/api/settings').set(auth()).send({ invoiceDueDays: 0 }).expect(400);
  });

  it('audits the change, and the audit carries no password', async () => {
    await configureSmtp();
    const entry = listAuditLogs(10).find((l) => l.action === 'settings_updated');
    expect(entry).toBeDefined();
    expect(`${entry!.before_json}${entry!.after_json}`).not.toContain('relay-secret');
    expect(entry!.after_json).toContain('smtpHost');
  });
});

describe('SMTP test email', () => {
  it('refuses to pretend: no SMTP configured is a 400, not a silent success', async () => {
    // No recipient either — the missing mail server is what it must name first,
    // or the operator goes off to fix the wrong field.
    const res = await request(app)
      .post('/api/settings/test-email')
      .set(auth())
      .send({})
      .expect(400);
    expect(res.body.code).toBe('smtp_not_configured');
    expect(res.body.error).toContain('mail server');
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('sends to the office address by default and reports the recipient', async () => {
    await request(app)
      .put('/api/settings')
      .set(auth())
      .send({ officeEmail: 'accounts@vula.app' })
      .expect(200);
    await configureSmtp();

    const res = await request(app)
      .post('/api/settings/test-email')
      .set(auth())
      .send({})
      .expect(200);
    expect(res.body.to).toBe('accounts@vula.app');
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    const sent = transport.sendMail.mock.calls[0][0] as { from: string; to: string };
    expect(sent.to).toBe('accounts@vula.app');
    expect(sent.from).toBe('billing@vula.app');
  });

  it('reports a refused relay as a 502 with the reason', async () => {
    await configureSmtp();
    transport.sendMail.mockImplementation(async () => {
      throw new Error('Invalid login: 535 Authentication failed');
    });

    const res = await request(app)
      .post('/api/settings/test-email')
      .set(auth())
      .send({ to: 'accounts@vula.app' })
      .expect(502);
    expect(res.body.code).toBe('mailer_failed');
    expect(res.body.error).toContain('535 Authentication failed');
  });

  it('sends with implicit TLS on port 465 and STARTTLS elsewhere', async () => {
    await configureSmtp({ smtpPort: 465 });
    await request(app)
      .post('/api/settings/test-email')
      .set(auth())
      .send({ to: 'accounts@vula.app' })
      .expect(200);
    expect(transport.createTransport.mock.calls[0][0]).toMatchObject({ port: 465, secure: true });

    transport.createTransport.mockClear();
    await configureSmtp({ smtpPort: 587 });
    await request(app)
      .post('/api/settings/test-email')
      .set(auth())
      .send({ to: 'accounts@vula.app' })
      .expect(200);
    expect(transport.createTransport.mock.calls[0][0]).toMatchObject({ port: 587, secure: false });
  });
});
