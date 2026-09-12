import request from 'supertest';
import type { Express } from 'express';

export const OFFICE_EMAIL = process.env.OFFICE_ADMIN_EMAIL ?? 'office@test.local';
export const OFFICE_PASSWORD = process.env.OFFICE_ADMIN_PASSWORD ?? 'office-pass-123';

export const loginAsOffice = async (app: Express): Promise<string> => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: OFFICE_EMAIL, password: OFFICE_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`Login helper failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token as string;
};

export const authHeader = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

export interface JsonResponse {
  body: unknown;
  bodyText?: string;
}

/** Builds a canned store response for mocked fetch. */
export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const CONFIGURE_OK = { ok: true, applied: { terminalCount: 2 } };
export const STATUS_OK = { storeName: 'Demo Store', version: '1.0.0' };
export const RESET_OK = { ok: true, tempPassword: 'Kx9!mQ2z-abc' };
