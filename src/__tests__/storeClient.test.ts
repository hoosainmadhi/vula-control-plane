import {
  StoreClientError,
  pushTerminals,
  resetAdmin,
  ping,
  resolveBase,
  terminalNames,
} from '../services/storeClient.js';
import { jsonResponse } from './helpers.js';

const store = {
  base_url: 'http://store.example.com/',
  control_plane_token: 'tok-123',
  terminal_count: 2,
  vertical: 'general',
  terminal_names_json: null,
} as const;

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

const lastFetch = (): [string, FetchInit | undefined] => {
  const calls = fetchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return [
    calls[calls.length - 1][0] as string,
    calls[calls.length - 1][1] as FetchInit | undefined,
  ];
};

let fetchMock: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock?.mockRestore();
});

describe('terminalNames', () => {
  it('generates Till 1..N', () => {
    expect(terminalNames(3)).toEqual([
      { till: 1, name: 'Till 1' },
      { till: 2, name: 'Till 2' },
      { till: 3, name: 'Till 3' },
    ]);
  });
});

describe('resolveBase', () => {
  it('strips trailing slashes', () => {
    expect(resolveBase('http://x.example.com///')).toBe('http://x.example.com');
  });
});

describe('pushTerminals', () => {
  it('POSTs the configure body to /api/internal/configure with the token header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, applied: { terminalCount: 2 } }));
    const result = await pushTerminals(store);
    expect(result).toEqual({ ok: true, applied: { terminalCount: 2 } });
    const [url, init] = lastFetch();
    expect(url).toBe('http://store.example.com/api/internal/configure');
    expect(init?.headers?.['X-Control-Plane-Token']).toBe('tok-123');
    expect(init?.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({
      terminalCount: 2,
      vertical: 'general',
      terminals: [
        { till: 1, name: 'Till 1' },
        { till: 2, name: 'Till 2' },
      ],
    });
  });

  it('throws a typed 502 error on a JSON error response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: 'maintenance window' }));
    await expect(pushTerminals(store)).rejects.toMatchObject({
      name: 'StoreClientError',
      status: 502,
      message: expect.stringMatching(/maintenance window/),
    });
  });

  it('throws a typed 502 error on a non-JSON response', async () => {
    fetchMock.mockResolvedValue(new Response('oops plain text', { status: 500 }));
    const err = await pushTerminals(store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreClientError);
    expect((err as Error).message).toMatch(/oops plain text/);
  });

  it('reports an unreachable store', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(pushTerminals(store)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/unreachable/),
    });
  });

  it('fails fast with a timeout error when the store is silent', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (init as FetchInit).signal;
          const abortErr = (): DOMException => new DOMException('aborted', 'AbortError');
          if (signal?.aborted) reject(abortErr());
          else signal?.addEventListener('abort', () => reject(abortErr()));
        }),
    );
    await expect(pushTerminals(store, { timeoutMs: 5 })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/timed out after 5ms/),
    });
  });
});

describe('ping', () => {
  it('GETs /api/internal/status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { storeName: 'Demo', version: '1.0.0' }));
    const result = await ping(store);
    expect(result).toEqual({ storeName: 'Demo', version: '1.0.0' });
    const [url, init] = lastFetch();
    expect(url).toBe('http://store.example.com/api/internal/status');
    expect(init?.method).toBe('GET');
  });
});

describe('resetAdmin', () => {
  it('POSTs /api/internal/admin/reset and returns the temp password', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, tempPassword: 'Ab1!xyz' }));
    const result = await resetAdmin(store);
    expect(result).toEqual({ tempPassword: 'Ab1!xyz' });
    const [url, init] = lastFetch();
    expect(url).toBe('http://store.example.com/api/internal/admin/reset');
    expect(init?.method).toBe('POST');
  });

  it('throws when the store response lacks a tempPassword', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await expect(resetAdmin(store)).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/tempPassword/),
    });
  });
});
