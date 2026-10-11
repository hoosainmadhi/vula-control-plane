// Real-server regression for the outbound redirect policy. Every privileged
// fetch carries a credential (the control-plane token, a temp admin password,
// or the Coolify API token), and Node's fetch follows redirects by default —
// so a misdirected or hostile URL could otherwise forward a secret to a host
// the managed-endpoint policy never validated. With `redirect: 'error'` the
// request must fail LOUDLY and the redirect target must see nothing at all.
//
// These tests use real HTTP servers rather than a mocked fetch: the whole point
// is what undici does with a genuine 3xx (it throws TypeError "fetch failed"
// with "unexpected redirect" in cause.message — checked empirically, which is
// why the error classification inspects the cause chain).

import http, { type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ping, probeAppKind } from '../services/storeClient.js';
import { bootstrapStoreAdmin } from '../services/storeProvisioning.js';
import { probeCoolify } from '../services/coolify.js';
import type { StoreRecord } from '../config/registryDb.js';

const REDIRECT_STATUSES = [301, 302, 307, 308];

let origin: Server;
let target: Server;
let originUrl = '';
let targetUrl = '';
// How many requests reached the redirect TARGET — must stay 0 in every case.
let targetHits = 0;
let originLastHeaders: Record<string, string> = {};
let redirectStatus = 302;

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

beforeAll(async () => {
  target = await listen((req, res) => {
    targetHits += 1;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"leaked":true}');
  });
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/stolen`;
  origin = await listen((req, res) => {
    req.resume();
    originLastHeaders = req.headers as Record<string, string>;
    // The control-plane client appends its own path (/api/internal/status), so
    // the non-redirecting control URL is matched anywhere in the path.
    if (req.url?.includes('/ok')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(redirectStatus, { Location: targetUrl });
    res.end();
  });
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

afterAll(() => {
  origin?.close();
  target?.close();
});

beforeEach(() => {
  targetHits = 0;
  originLastHeaders = {};
});

describe('credential-bearing store calls refuse redirects', () => {
  for (const status of REDIRECT_STATUSES) {
    it(`ping() refuses HTTP ${status} and the credential never reaches the target`, async () => {
      redirectStatus = status;
      await expect(
        ping({ base_url: originUrl, control_plane_token: 'tok-secret' }),
      ).rejects.toMatchObject({
        name: 'StoreClientError',
        message: expect.stringMatching(/redirect/i),
      });
      // The call did go out (with the credential), but nothing followed it.
      expect(originLastHeaders['x-control-plane-token']).toBe('tok-secret');
      expect(targetHits).toBe(0);
    });
  }

  it('bootstrapStoreAdmin refuses a redirect and the temp password never leaves the path', async () => {
    redirectStatus = 302;
    const store = {
      base_url: originUrl,
      control_plane_token: 'tok-secret',
      slug: 'redirect-test',
    } as StoreRecord;
    await expect(bootstrapStoreAdmin(store, 'admin@store.test', 'temp-pass-123')).resolves.toBe(
      false,
    );
    expect(originLastHeaders['x-control-plane-token']).toBe('tok-secret');
    expect(targetHits).toBe(0);
  });

  it('a normal (non-redirecting) endpoint still works — the policy does not break the happy path', async () => {
    redirectStatus = 302;
    const body = await ping({ base_url: `${originUrl}/ok`, control_plane_token: 'tok-secret' });
    expect(body).toEqual({ ok: true });
  });
});

describe('the managed-endpoint probe refuses redirects', () => {
  it('probeAppKind reports a redirecting host as unreachable', async () => {
    redirectStatus = 307;
    const probe = await probeAppKind(originUrl);
    expect(probe.reachable).toBe(false);
    expect(probe.kind).toBe('unknown');
    expect(targetHits).toBe(0);
  });
});

describe('the Coolify client refuses redirects', () => {
  it('probeCoolify refuses HTTP 302 and the API token never reaches the target', async () => {
    redirectStatus = 302;
    process.env.COOLIFY_API_URL = originUrl;
    process.env.COOLIFY_API_TOKEN = 'coolify-secret';
    process.env.COOLIFY_PROJECT_UUID = 'proj';
    process.env.COOLIFY_SERVER_UUID = 'srv';
    process.env.COOLIFY_GITHUB_APP_UUID = 'app';
    const result = await probeCoolify();
    expect(result.version).toBeNull();
    expect(result.message).toMatch(/redirect/i);
    expect(originLastHeaders.authorization).toBe('Bearer coolify-secret');
    expect(targetHits).toBe(0);
  });
});
