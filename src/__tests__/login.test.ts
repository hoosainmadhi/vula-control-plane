import request from 'supertest';
import { createApp } from '../app.js';
import { OFFICE_EMAIL, OFFICE_PASSWORD } from './helpers.js';

const app = createApp();

describe('POST /api/auth/login', () => {
  it('returns a token + office user for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: OFFICE_EMAIL, password: OFFICE_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({ email: OFFICE_EMAIL, role: 'office' });
  });

  it('accepts the email case-insensitively', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: OFFICE_EMAIL.toUpperCase(), password: OFFICE_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: OFFICE_EMAIL, password: 'not-the-password' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects an unknown email with a generic 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'stranger@test.local', password: OFFICE_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('validates email and password shape', async () => {
    const badEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nope', password: 'x' });
    expect(badEmail.status).toBe(400);
    const missing = await request(app).post('/api/auth/login').send({ email: OFFICE_EMAIL });
    expect(missing.status).toBe(400);
  });
});
