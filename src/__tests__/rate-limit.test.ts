import request from 'supertest';
import { createApp } from '../app.js';
import { OFFICE_EMAIL } from './helpers.js';

const app = createApp();

describe('login rate limiting', () => {
  it('blocks the 21st attempt within the window (20/15min)', async () => {
    const attempts = Array.from({ length: 21 }, () =>
      request(app)
        .post('/api/auth/login')
        .send({ email: OFFICE_EMAIL, password: 'wrong-password' }),
    );
    const results = await Promise.all(attempts);
    for (const res of results.slice(0, 20)) {
      expect(res.status).toBe(401);
    }
    expect(results[20].status).toBe(429);
    expect(results[20].body.error).toEqual(expect.any(String));
  });
});
