import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../app.js';
import { loginAsOffice, authHeader } from './helpers.js';

const app = createApp();
const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';

describe('office auth guard on /api/stores', () => {
  it('401s without a token', async () => {
    const res = await request(app).get('/api/stores');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('401s on a garbage token', async () => {
    const res = await request(app).get('/api/stores').set(authHeader('not-a-jwt'));
    expect(res.status).toBe(401);
  });

  it('401s on a non-office token kind', async () => {
    const customer = jwt.sign({ kind: 'customer', sub: 1 }, JWT_SECRET);
    const res = await request(app).get('/api/stores').set(authHeader(customer));
    expect(res.status).toBe(401);
  });

  it('401s on an expired office token', async () => {
    const expired = jwt.sign({ kind: 'office', email: 'office@test.local' }, JWT_SECRET, {
      expiresIn: '-10s',
    });
    const res = await request(app).get('/api/stores').set(authHeader(expired));
    expect(res.status).toBe(401);
  });

  it('allows a freshly logged-in office token', async () => {
    const token = await loginAsOffice(app);
    const res = await request(app).get('/api/stores').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
