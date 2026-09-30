import { probeCoolify } from '../services/coolify.js';

/**
 * The connectivity probe is the deployment's first check: it answers "will
 * provisioning work at all?" before an operator onboards a client into a
 * broken Coolify integration. Cheap, and it fails with the variable that is
 * missing rather than a stack trace.
 */
describe('probeCoolify', () => {
  const KEYS = [
    'COOLIFY_API_URL',
    'COOLIFY_API_TOKEN',
    'COOLIFY_PROJECT_UUID',
    'COOLIFY_SERVER_UUID',
    'COOLIFY_GITHUB_APP_UUID',
  ];
  const savedEnv: Record<string, string | undefined> = {};
  let fetchMock: jest.SpyInstance;

  beforeAll(() => {
    for (const key of KEYS) savedEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(() => {
    // Restored by afterEach, so the "missing configuration" test can delete the
    // variables without poisoning the tests after it.
    process.env.COOLIFY_API_URL = 'https://coolify.example';
    process.env.COOLIFY_API_TOKEN = 'tok-123';
    process.env.COOLIFY_PROJECT_UUID = 'proj';
    process.env.COOLIFY_SERVER_UUID = 'srv';
    process.env.COOLIFY_GITHUB_APP_UUID = 'gh';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('reports missing configuration and never dials', async () => {
    for (const key of KEYS) delete process.env[key];
    const { version, message } = await probeCoolify();
    expect(version).toBeNull();
    expect(message).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the plain-text version endpoint', async () => {
    // /api/v1/version returns plain text (e.g. "4.3.10"), not JSON — a JSON
    // parse here would be the bug.
    fetchMock.mockResolvedValue(new Response('4.3.10', { status: 200 }));
    const { version, message } = await probeCoolify();
    expect(version).toBe('4.3.10');
    expect(message).toBe('Connected');
    expect(fetchMock.mock.calls[0][0]).toBe('https://coolify.example/api/v1/version');
  });

  it('surfaces an HTTP refusal as a message', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const { version, message } = await probeCoolify();
    expect(version).toBeNull();
    expect(message).toBe('HTTP 401');
  });

  it('surfaces a network failure as a message', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { version, message } = await probeCoolify();
    expect(version).toBeNull();
    expect(message).toMatch(/ECONNREFUSED/);
  });
});
