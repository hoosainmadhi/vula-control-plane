import request from 'supertest';
import { promises as dns } from 'node:dns';
import { createApp } from '../app.js';
import { resetRegistryDb } from '../config/registryDb.js';
import { isReservedAddress, requireBaseUrl, ValidationError } from '../utils/validate.js';
import { assertManagedEndpoint } from '../services/storeClient.js';
import { resetRateLimits } from '../utils/rateLimiter.js';
import { authHeader, jsonResponse, loginAsOffice } from './helpers.js';

const app = createApp();
let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

const HEAD_OFFICE_HEALTH = { status: 'ok', service: 'vula-head-office' };
const STORE_HEALTH = { status: 'ok', app: 'vula' };
const PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }];
const PRIVATE_DNS = [{ address: '10.0.0.5', family: 4 }];

let fetchMock: jest.SpyInstance;
let lookupMock: jest.SpyInstance;

/**
 * Every fetch in this suite answers with a fresh Response: a Response body can
 * be read once, so handing the same object to several calls makes the later
 * ones throw "Body is unusable" and turns a passing test into confusing noise.
 */
const respondWith = (body: unknown, status = 200): void => {
  fetchMock.mockImplementation(async () => jsonResponse(status, body));
};

beforeEach(() => {
  // The registry is shared module state, not per-test: without this, a store
  // registered at http://localhost:3260 in one test clashes with the next.
  resetRegistryDb();
  resetRateLimits();
  fetchMock = jest.spyOn(globalThis, 'fetch');
  // Nothing in this suite should depend on real DNS: default every name to a
  // public address so the production-only resolution check is a no-op unless a
  // test overrides it. Cast because dns.lookup is overloaded and the spy
  // resolves the non-`all` signature.
  lookupMock = jest.spyOn(dns, 'lookup').mockResolvedValue(PUBLIC_DNS as never);
});

afterEach(() => {
  fetchMock?.mockRestore();
  lookupMock?.mockRestore();
});

describe('the address policy', () => {
  it('classifies every range that is not the public internet', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.53',
      '10.0.0.1',
      '10.255.255.254',
      '192.168.1.10',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      // An IPv4 written in IPv6 notation is the same address.
      '::ffff:10.0.0.1',
      '[::1]',
    ]) {
      expect(isReservedAddress(host)).toBe(true);
    }
  });

  it('leaves public addresses alone, including the awkward boundaries', () => {
    for (const host of [
      '93.184.216.34',
      '8.8.8.8',
      // 172.16/12 ends at 172.31.x — 172.32 is public.
      '172.32.0.1',
      // 100.64/10 ends at 100.127.x — 100.128 is public.
      '100.128.0.1',
      '2001:4860:4860::8888',
      'example.com',
    ]) {
      expect(isReservedAddress(host)).toBe(false);
    }
  });
});

describe('requireBaseUrl', () => {
  it('accepts a public https URL in production', () => {
    expect(requireBaseUrl({ baseUrl: 'https://branch.example.co.za/' }, true)).toBe(
      'https://branch.example.co.za',
    );
  });

  it('refuses plaintext in production, because every push carries a secret', () => {
    expect(() => requireBaseUrl({ baseUrl: 'http://branch.example.co.za' }, true)).toThrow(
      ValidationError,
    );
  });

  it('refuses a literal private or metadata address in production', () => {
    for (const baseUrl of [
      'https://127.0.0.1:3260',
      'https://10.0.0.7',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal',
      'https://shop.internal',
    ]) {
      expect(() => requireBaseUrl({ baseUrl }, true)).toThrow(ValidationError);
    }
  });

  it('refuses credentials embedded in the URL, in any environment', () => {
    for (const production of [true, false]) {
      expect(() => requireBaseUrl({ baseUrl: 'https://user:pass@host.example' }, production)).toThrow(
        ValidationError,
      );
    }
  });

  describe('with an approved deployment domain configured', () => {
    beforeEach(() => {
      process.env.MANAGED_ENDPOINT_SUFFIXES = '.vula-app.co.za';
    });

    afterEach(() => {
      delete process.env.MANAGED_ENDPOINT_SUFFIXES;
    });

    it('refuses a host outside the deployment domain in production', () => {
      expect(() => requireBaseUrl({ baseUrl: 'https://attacker.example' }, true)).toThrow(
        /approved deployment domain/,
      );
    });

    it('allows hosts on the deployment domain, subdomain or bare', () => {
      expect(requireBaseUrl({ baseUrl: 'https://branch.vula-app.co.za' }, true)).toBe(
        'https://branch.vula-app.co.za',
      );
      expect(requireBaseUrl({ baseUrl: 'https://vula-cp-mzsza-2026.vula-app.co.za' }, true)).toBe(
        'https://vula-cp-mzsza-2026.vula-app.co.za',
      );
      expect(requireBaseUrl({ baseUrl: 'https://vula-app.co.za' }, true)).toBe(
        'https://vula-app.co.za',
      );
    });

    it('does not apply the allowlist in development', () => {
      expect(requireBaseUrl({ baseUrl: 'http://localhost:3260' }, false)).toBe(
        'http://localhost:3260',
      );
    });
  });

  it('leaves development alone — the fleet and the suite run on loopback', () => {
    expect(requireBaseUrl({ baseUrl: 'http://localhost:3260' }, false)).toBe('http://localhost:3260');
    expect(requireBaseUrl({ baseUrl: 'http://127.0.0.1:3261' }, false)).toBe('http://127.0.0.1:3261');
  });
});

describe('assertManagedEndpoint', () => {
  it('refuses a public hostname that resolves to a private address', async () => {
    lookupMock.mockResolvedValue(PRIVATE_DNS as never);
    const check = await assertManagedEndpoint('https://branch.example.co.za', 'store', { production: true });
    expect(check.ok).toBe(false);
    expect(check.code).toBe('endpoint_private');
    expect(check.status).toBe(400);
    expect(check.error).toMatch(/resolves to 10\.0\.0\.5/);
    // Refused before dialling: the token never leaves for a host that cannot
    // be the customer's server.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unreachable URL in production, but allows it in development', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const prod = await assertManagedEndpoint('https://branch.example.co.za', 'store', { production: true });
    expect(prod.ok).toBe(false);
    expect(prod.code).toBe('endpoint_unreachable');

    const dev = await assertManagedEndpoint('http://localhost:9999', 'store', { production: false });
    expect(dev.ok).toBe(true);
  });

  it('refuses the wrong kind of application with one message shape', async () => {
    respondWith(HEAD_OFFICE_HEALTH);
    const asStore = await assertManagedEndpoint('https://ho.example.co.za', 'store', { production: true });
    expect(asStore.code).toBe('wrong_app_kind');
    expect(asStore.status).toBe(409);
    expect(asStore.error).toBe(
      'https://ho.example.co.za is a Head Office deployment, not a store. Register it on the Head Offices page instead.',
    );

    respondWith(STORE_HEALTH);
    const asPanel = await assertManagedEndpoint('https://branch.example.co.za', 'head-office', { production: true });
    expect(asPanel.code).toBe('wrong_app_kind');
    expect(asPanel.error).toMatch(/is a store deployment, not a Head Office/);
  });

  it('accepts the right kind, and accepts an unidentified one', async () => {
    respondWith(STORE_HEALTH);
    const ok = await assertManagedEndpoint('https://branch.example.co.za', 'store', { production: true });
    expect(ok).toMatchObject({ ok: true, kind: 'store' });

    // A deployment that answers but does not identify itself is not refused:
    // the row may point at a proxy or an older build, and refusing would block
    // registration with nothing to show the operator.
    respondWith({ status: 'ok' });
    const unknown = await assertManagedEndpoint('https://branch.example.co.za', 'store', { production: true });
    expect(unknown.ok).toBe(true);
    expect(unknown.kind).toBe('unknown');
  });
});

describe('the registry refuses to be repointed at something else', () => {
  const makeCompany = async (): Promise<number> => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(app)
      .post('/api/companies')
      .set(authHeader(token))
      .send({
        name: `Repoint ${suffix}`,
        slug: `repoint-${suffix}`,
        // A client fixture is a paying client that has bought terminals: a
        // never-paid company derives suspended and cannot take a store, and a
        // company with no licensed terminals is refused as well.
        paidThrough: '2030-01-01',
        licensedTerminalCount: 5,
      })
      .expect(201);
    return (res.body as { id: number }).id;
  };

  it('store edit: a new URL that answers as a Head Office is refused, and the row keeps its old URL', async () => {
    const companyId = await makeCompany();
    respondWith(STORE_HEALTH);
    const created = await request(app)
      .post('/api/stores')
      .set(authHeader(token))
      .send({
        name: 'Original branch',
        slug: `orig-${companyId}`,
        terminalCount: 1,
        baseUrl: 'http://localhost:3260',
        companyId,
      })
      .expect(201);
    const storeId = (created.body as { store: { id: number } }).store.id;

    // The attack the review describes: repoint the row, and the next licence
    // push carries this store's token to the new host.
    respondWith(HEAD_OFFICE_HEALTH);
    const res = await request(app)
      .put(`/api/stores/${storeId}`)
      .set(authHeader(token))
      .send({ baseUrl: 'https://attacker.example' })
      .expect(409);
    expect(res.body.code).toBe('wrong_app_kind');

    const after = await request(app)
      .get(`/api/stores/${storeId}`)
      .set(authHeader(token))
      .expect(200);
    expect(after.body.baseUrl).toBe('http://localhost:3260');
  });

  it('store edit: leaving the URL alone does not trigger a probe', async () => {
    const companyId = await makeCompany();
    respondWith(STORE_HEALTH);
    const created = await request(app)
      .post('/api/stores')
      .set(authHeader(token))
      .send({
        name: 'Quiet branch',
        slug: `quiet-${companyId}`,
        terminalCount: 1,
        baseUrl: 'http://localhost:3260',
        companyId,
      })
      .expect(201);
    const storeId = (created.body as { store: { id: number } }).store.id;

    fetchMock.mockClear();
    await request(app)
      .put(`/api/stores/${storeId}`)
      .set(authHeader(token))
      .send({ name: 'Renamed branch' })
      .expect(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('panel edit: a URL with no scheme is refused before anything is dialled', async () => {
    const companyId = await makeCompany();
    respondWith(HEAD_OFFICE_HEALTH);
    const created = await request(app)
      .post('/api/panels')
      .set(authHeader(token))
      .send({
        companyId,
        name: 'Panel',
        slug: `panel-${companyId}`,
        baseUrl: 'http://localhost:3260',
      })
      .expect(201);
    const panelId = (created.body as { panel: { id: number } }).panel.id;

    fetchMock.mockClear();
    const res = await request(app)
      .put(`/api/panels/${panelId}`)
      .set(authHeader(token))
      .send({ baseUrl: 'ftp://nope' })
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('panel edit: a repoint to a store deployment is refused', async () => {
    const companyId = await makeCompany();
    respondWith(HEAD_OFFICE_HEALTH);
    const created = await request(app)
      .post('/api/panels')
      .set(authHeader(token))
      .send({
        companyId,
        name: 'Panel two',
        slug: `panel2-${companyId}`,
        baseUrl: 'http://localhost:3261',
      })
      .expect(201);
    const panelId = (created.body as { panel: { id: number } }).panel.id;

    respondWith(STORE_HEALTH);
    const res = await request(app)
      .put(`/api/panels/${panelId}`)
      .set(authHeader(token))
      .send({ baseUrl: 'https://branch.example.co.za' })
      .expect(409);
    expect(res.body.code).toBe('wrong_app_kind');
  });
});

describe('the office login limiter', () => {
  it('keys on the account as well as the address, so one IP cannot spray accounts', async () => {
    // Driven as a unit: supertest always presents the same socket address, so
    // the account dimension is only observable by controlling req.ip.
    const { rateLimiter } = await import('../utils/rateLimiter.js');
    const middleware = rateLimiter({
      windowMs: 60_000,
      max: 3,
      label: 'unit-login',
      accountKey: (req) => String((req.body as { email?: string }).email ?? '').toLowerCase(),
    });

    const attempt = (ip: string, email: string): { status: number | null; allowed: boolean } => {
      let status: number | null = null;
      let allowed = false;
      middleware(
        { ip, body: { email } } as never,
        {
          status: (code: number) => ({
            json: () => {
              status = code;
            },
          }),
        } as never,
        () => {
          allowed = true;
        },
      );
      return { status, allowed };
    };

    // Five different accounts from one address: the address bucket caps it.
    const fromOneIp = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'].map((email) =>
      attempt('203.0.113.9', email),
    );
    expect(fromOneIp.filter((r) => r.allowed).length).toBe(3);
    expect(fromOneIp.filter((r) => r.status === 429).length).toBe(2);

    // The same account from five addresses: the account bucket caps it, which
    // is what stops a distributed attempt against one admin account.
    const fromManyIps = ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4', '198.51.100.5'].map(
      (ip) => attempt(ip, 'admin@za-pos.local'),
    );
    expect(fromManyIps.filter((r) => r.allowed).length).toBe(3);
    expect(fromManyIps.filter((r) => r.status === 429).length).toBe(2);
  });

  it('does not extend the window with a request it just refused', async () => {
    const { rateLimiter } = await import('../utils/rateLimiter.js');
    const middleware = rateLimiter({ windowMs: 60_000, max: 2, label: 'unit-nofill' });
    const attempt = (ip: string): boolean => {
      let allowed = false;
      middleware(
        { ip, body: {} } as never,
        { status: () => ({ json: () => {} }) } as never,
        () => {
          allowed = true;
        },
      );
      return allowed;
    };
    expect(attempt('203.0.113.50')).toBe(true);
    expect(attempt('203.0.113.50')).toBe(true);
    // Refused, repeatedly, without pushing the bucket further out.
    expect(attempt('203.0.113.50')).toBe(false);
    expect(attempt('203.0.113.50')).toBe(false);
  });
});

describe('the login page', () => {
  it('shows the development hint only in a development build', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../frontend/src/pages/LoginPage.tsx'),
      'utf8',
    );
    const hint = source.indexOf('Dev default:');
    expect(hint).toBeGreaterThan(-1);
    // The hint must sit inside an import.meta.env.DEV guard, not at page level.
    const before = source.slice(Math.max(0, hint - 200), hint);
    expect(before).toContain('import.meta.env.DEV');
  });

  // The bundle itself is checked by the build, not here: `npm run build` runs
  // scripts/check-dist.mjs, which fails if the hint survives minification. A
  // unit test reading frontend/dist can only ever report on the last build, and
  // reports a false failure the moment the source is newer than the artifact.
});