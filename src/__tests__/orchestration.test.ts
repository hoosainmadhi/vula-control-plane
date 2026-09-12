import request from 'supertest';
import { createApp } from '../app.js';
import {
  getPanelById,
  getStoreBySlug,
  resetRegistryDb,
} from '../config/registryDb.js';
import { jsonResponse, loginAsOffice, authHeader } from './helpers.js';

/**
 * Deployment-job truthfulness regression (production-readiness review,
 * 2026-09-12). The old orchestrator swallowed Coolify/config/licence failures
 * and marked steps complete anyway, discarded the Coolify UUID (so a retry
 * could create a duplicate application), and pushed the panel's vendor CP
 * token to branches as their Head Office credential.
 */

const app = createApp();

const COOLIFY_URL = 'http://coolify.test';

let fetchMock: jest.SpyInstance;
let token = '';
let coolifyCreateCalls = 0;

const configureCoolify = (): void => {
  process.env.COOLIFY_API_URL = COOLIFY_URL;
  process.env.COOLIFY_API_TOKEN = 'coolify-token';
  process.env.COOLIFY_PROJECT_UUID = 'proj';
  process.env.COOLIFY_SERVER_UUID = 'srv';
  process.env.COOLIFY_GITHUB_APP_UUID = 'app';
};

const tearDownCoolify = (): void => {
  for (const k of [
    'COOLIFY_API_URL',
    'COOLIFY_API_TOKEN',
    'COOLIFY_PROJECT_UUID',
    'COOLIFY_SERVER_UUID',
    'COOLIFY_GITHUB_APP_UUID',
  ]) {
    delete process.env[k];
  }
};

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  configureCoolify();
  coolifyCreateCalls = 0;
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const s = String(url);

    // Coolify API
    if (s.startsWith(COOLIFY_URL)) {
      if (s.endsWith('/applications/private-github-app')) {
        coolifyCreateCalls++;
        if (process.env.COOLIFY_FAIL_CREATE === 'true') {
          return jsonResponse(500, { message: 'Coolify exploded' });
        }
        const isHo = String(init?.body ?? '').includes('"name":"vula-ho-');
        return jsonResponse(201, { uuid: isHo ? 'uuid-ho-1' : `uuid-store-${coolifyCreateCalls}` });
      }
      return jsonResponse(200, { ok: true });
    }

    // Panel internal API (Head Office)
    if (s.includes('/api/internal/branches')) {
      return jsonResponse(201, { ok: true });
    }
    if (s.endsWith('/api/internal/admin/init')) {
      return jsonResponse(201, { ok: true });
    }
    if (s.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, version: '0.3.0', branchCount: 2 });
    }
    if (s.endsWith('/api/internal/licence')) {
      return jsonResponse(200, { ok: true, licenceSequence: 1 });
    }
    // Store internal API
    return jsonResponse(200, { ok: true, applied: { terminalCount: 2 } });
  });
});

afterEach(() => {
  delete process.env.COOLIFY_FAIL_CREATE;
  tearDownCoolify();
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

const multiStorePlanId = async (): Promise<number> => {
  const res = await request(app).get('/api/plans').set(auth()).expect(200);
  const plan = (res.body as Array<{ id: number; code: string }>).find(
    (p) => p.code === 'multi-store',
  );
  expect(plan).toBeDefined();
  return plan!.id;
};

const createMultiStoreClient = async (
  adminEmail?: string,
): Promise<{ jobId: number; clientId: number }> => {
  const planId = await multiStorePlanId();
  const res = await request(app)
    .post('/api/clients')
    .set(auth())
    .send({
      name: 'Urban Threads',
      slug: 'urban-threads',
      planId,
      deploymentType: 'multi_store',
      headOffice: {
        name: 'Urban Threads HO',
        slug: 'urban-threads-ho',
        baseUrl: 'http://localhost:3260',
      },
      stores: [
        {
          name: 'Urban Threads Sandton',
          slug: 'urban-threads-sandton',
          baseUrl: 'http://localhost:3246',
          terminalCount: 2,
          adminEmail,
        },
      ],
    })
    .expect(201);
  return { jobId: res.body.job.id, clientId: res.body.client.id };
};

type StepOut = { step_key: string; status: string; error: string | null; warnings_json: string | null };

const clientDetail = async (clientId: number) => {
  const res = await request(app).get(`/api/clients/${clientId}`).set(auth()).expect(200);
  return res.body as {
    latestDeployment: { job: { id: number; status: string; error: string | null }; steps: StepOut[] } | null;
    headOffice: { id: number } | null;
  };
};

const latestOf = (detail: Awaited<ReturnType<typeof clientDetail>>) => {
  expect(detail.latestDeployment).not.toBeNull();
  return detail.latestDeployment!;
};

describe('deployment job truthfulness', () => {
  it('fails the job when the required Coolify deployment fails', async () => {
    process.env.COOLIFY_FAIL_CREATE = 'true';

    const { jobId, clientId } = await createMultiStoreClient();
    const latest = latestOf(await clientDetail(clientId));

    expect(latest.job.id).toBe(jobId);
    expect(latest.job.status).toBe('failed');
    const hoStep = latest.steps.find((s) => s.step_key === 'head_office_deploy');
    expect(hoStep?.status).toBe('failed');
    expect(hoStep?.error).toContain('Coolify');
  });

  it('persists the Coolify UUID and never creates a duplicate application on retry', async () => {
    const { clientId } = await createMultiStoreClient();

    const store = getStoreBySlug('urban-threads-sandton');
    expect(store?.coolify_uuid).toMatch(/^uuid-store-/);
    expect(store?.volume_name).toContain('za-pos-urban-threads-sandton');

    // One create per resource: the Head Office and the store.
    expect(coolifyCreateCalls).toBe(2);

    const detail = await clientDetail(clientId);
    const panel = getPanelById(detail.headOffice!.id);
    expect(panel?.coolify_uuid).toBe('uuid-ho-1');

    // Retry the job: existing resources are never re-created.
    const jobId = detail.latestDeployment!.job.id;
    await request(app)
      .post(`/api/clients/jobs/${jobId}/retry`)
      .set(auth())
      .expect(200);

    expect(coolifyCreateCalls).toBe(2);
    expect(getStoreBySlug('urban-threads-sandton')?.coolify_uuid).toBe(store?.coolify_uuid);
  });

  it('wires the topology in both directions with a per-branch Head Office token', async () => {
    await createMultiStoreClient();

    const store = getStoreBySlug('urban-threads-sandton');
    expect(store?.head_office_token).toBeTruthy();

    // Direction 1: the branch was told where its Head Office is, with its OWN
    // credential — never the panel's vendor CP token.
    const configureCall = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u).endsWith('/api/internal/configure') &&
        String((init as { body?: string })?.body ?? '').includes('headOffice'),
    );
    expect(configureCall).toBeDefined();
    const configureBody = JSON.parse(
      (configureCall![1] as { body: string }).body,
    ) as { headOffice: { enabled: boolean; url: string; token: string } };
    expect(configureBody.headOffice.enabled).toBe(true);
    expect(configureBody.headOffice.url).toBe('http://localhost:3260');
    expect(configureBody.headOffice.token).toBe(store?.head_office_token);

    // Direction 2: the branch was registered in the Head Office roster with the
    // same credential.
    const branchCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/api/internal/branches'),
    );
    expect(branchCall).toBeDefined();
    const branchBody = JSON.parse((branchCall![1] as { body: string }).body) as {
      slug: string;
      headOfficeToken: string;
    };
    expect(branchBody.slug).toBe('urban-threads-sandton');
    expect(branchBody.headOfficeToken).toBe(store?.head_office_token);
    expect(branchBody.headOfficeToken).not.toBe(store?.control_plane_token);
  });

  it('records best-effort failures as warnings while still completing the step', async () => {
    // Admin init and licence delivery fail; the store deploy itself succeeded.
    fetchMock.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.startsWith(COOLIFY_URL)) {
        if (s.endsWith('/applications/private-github-app')) {
          coolifyCreateCalls++;
          return jsonResponse(201, { uuid: `uuid-${coolifyCreateCalls}` });
        }
        return jsonResponse(200, { ok: true });
      }
      if (s.endsWith('/api/internal/licence')) {
        return jsonResponse(500, { error: 'store unreachable' });
      }
      if (s.endsWith('/api/internal/admin/init')) {
        return jsonResponse(500, { error: 'still building' });
      }
      return jsonResponse(200, { ok: true, applied: {} });
    });

    const { clientId } = await createMultiStoreClient('manager@urban-threads.co.za');
    const latest = latestOf(await clientDetail(clientId));

    expect(latest.job.status).toBe('complete');
    const storeStep = latest.steps.find((s) => s.step_key.startsWith('store_deploy'));
    expect(storeStep?.status).toBe('complete');
    const warnings = JSON.parse(storeStep?.warnings_json ?? '[]') as string[];
    expect(warnings.length).toBeGreaterThan(0);
  });
});
