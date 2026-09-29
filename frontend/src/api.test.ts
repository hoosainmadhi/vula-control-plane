import { ApiError, api, getToken, setToken } from './api';

/**
 * Every screen reaches the API through this one function, so its contract is
 * worth pinning: the credential travels in the header (never in a URL or body),
 * the token store is the only place it lives, and a refusal arrives as an
 * ApiError carrying the server's own message — which is what every toast and
 * banner in the SPA displays.
 *
 * jsdom provides neither `fetch` nor `Response`, so the mock is assigned rather
 * than spied on, and the canned responses are minimal stand-ins exposing the
 * three things `api()` touches: `ok`, `status` and `json()`.
 */
let fetchMock: jest.Mock;

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const json = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const notJson = (status: number, raw: string): Response =>
  ({
    ok: false,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => raw,
  }) as unknown as Response;

const lastCall = (): [string, FetchInit] => {
  const calls = fetchMock.mock.calls;
  return [String(calls[calls.length - 1][0]), calls[calls.length - 1][1] as FetchInit];
};

beforeEach(() => {
  localStorage.clear();
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('the token store', () => {
  it('round-trips through localStorage and can be cleared', () => {
    expect(getToken()).toBeNull();
    setToken('jwt-123');
    expect(getToken()).toBe('jwt-123');
    setToken(null);
    expect(getToken()).toBeNull();
  });
});

describe('api', () => {
  it('sends the stored token as a bearer header, and prefixes /api', async () => {
    setToken('jwt-123');
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await api('/stores');

    const [url, init] = lastCall();
    expect(url).toBe('/api/stores');
    expect(init.headers?.Authorization).toBe('Bearer jwt-123');
    // A GET carries no content-type and no body.
    expect(init.headers?.['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('omits the header when no token is stored', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await api('/health');

    const [, init] = lastCall();
    expect(init.headers?.Authorization).toBeUndefined();
  });

  it('accepts an explicit token, so a caller can override the stored one', async () => {
    setToken('stored');
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await api('/stores', { token: 'explicit' });

    const [, init] = lastCall();
    expect(init.headers?.Authorization).toBe('Bearer explicit');
  });

  it('serialises a body and declares it as JSON', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));

    await api('/stores', { method: 'POST', body: { name: 'Gardens Mall' } });

    const [, init] = lastCall();
    expect(init.method).toBe('POST');
    expect(init.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Gardens Mall' });
  });

  it('throws an ApiError carrying the server message and status', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: 'payment_amount_mismatch', code: 'payment_amount_mismatch' }),
    );

    await expect(api('/billing/invoices/1/pay', { method: 'POST' })).rejects.toMatchObject({
      name: 'Error',
      message: 'payment_amount_mismatch',
      status: 400,
    });
    await expect(api('/billing/invoices/1/pay', { method: 'POST' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('falls back to a readable message when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(notJson(502, 'gateway blew up'));

    await expect(api('/stores')).rejects.toMatchObject({
      message: 'Request failed (502)',
      status: 502,
    });
  });

  it('returns the parsed body on success', async () => {
    fetchMock.mockResolvedValue(json(200, { token: 'abc', user: { email: 'office@x' } }));

    await expect(api('/auth/login', { method: 'POST' })).resolves.toEqual({
      token: 'abc',
      user: { email: 'office@x' },
    });
  });
});
