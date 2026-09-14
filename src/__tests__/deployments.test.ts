import request from 'supertest';
import { createApp } from '../app.js';
import {
  createCompany,
  createDeploymentJob,
  createDeploymentStep,
  resetRegistryDb,
  updateDeploymentJob,
  updateDeploymentStep,
} from '../config/registryDb.js';
import { authHeader, loginAsOffice } from './helpers.js';

const app = createApp();

let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
});

const auth = (): Record<string, string> => authHeader(token);

interface JobOut {
  id: number;
  type: string;
  status: string;
  error: string | null;
  companyId: number;
  companyName: string;
  startedAt: string;
  completedAt: string | null;
  stepCounts: { total: number; failed: number; complete: number; skipped: number };
}

interface StepOut {
  id: number;
  stepKey: string;
  resourceType: string;
  resourceId: number | null;
  status: string;
  attempts: number;
  error: string | null;
  warnings: string[];
}

const listJobs = async (): Promise<JobOut[]> => {
  const res = await request(app).get('/api/deployments').set(auth());
  expect(res.status).toBe(200);
  return res.body as JobOut[];
};

/** A company with one job and one step, the shape the orchestrator writes. */
const seedJob = (): { jobId: number; companySlug: string } => {
  const company = createCompany({ name: 'Urban Threads Retail Group', slug: 'urban-threads' });
  const job = createDeploymentJob(company.id, 'new_multistore_client');
  return { jobId: job.id, companySlug: company.slug };
};

describe('GET /api/deployments', () => {
  it('requires an office session', async () => {
    const res = await request(app).get('/api/deployments');
    expect(res.status).toBe(401);
  });

  it('is empty when nothing has been deployed', async () => {
    expect(await listJobs()).toEqual([]);
  });

  it('lists a job with its client name and a step tally', async () => {
    const { jobId } = seedJob();
    createDeploymentStep(jobId, 'create_store', 'store', 1);
    const second = createDeploymentStep(jobId, 'push_licence', 'licence', 1);
    updateDeploymentStep(second.id, { status: 'failed', error: 'bad signature', attempts: 2 });

    const jobs = await listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: jobId,
      type: 'new_multistore_client',
      status: 'running',
      companyName: 'Urban Threads Retail Group',
      stepCounts: { total: 2, failed: 1, complete: 0, skipped: 0 },
    });
  });

  it('orders jobs newest first', async () => {
    const { jobId: first } = seedJob();
    const company = createCompany({ name: 'Second Client', slug: 'second-client' });
    const second = createDeploymentJob(company.id, 'upgrade_to_multistore');
    expect(second.id).toBeGreaterThan(first);

    const jobs = await listJobs();
    expect(jobs.map((j) => j.id)).toEqual([second.id, first]);
    expect(jobs[0]!.companyName).toBe('Second Client');
  });

  it('reports a completed job with its completion time', async () => {
    const { jobId } = seedJob();
    updateDeploymentJob(jobId, { status: 'complete', completedAt: '2026-09-14 10:00:00' });
    const [job] = await listJobs();
    expect(job).toMatchObject({ status: 'complete', completedAt: '2026-09-14 10:00:00' });
  });
});

describe('GET /api/deployments/:id', () => {
  it('returns the job with its steps, warnings included', async () => {
    const { jobId } = seedJob();
    const ok = createDeploymentStep(jobId, 'create_store', 'store', 7, { slug: 'jhb' });
    updateDeploymentStep(ok.id, { status: 'complete', attempts: 1 });
    const warned = createDeploymentStep(jobId, 'wire_topology', 'wiring', null);
    updateDeploymentStep(warned.id, {
      status: 'complete',
      warnings: ['branch head-office token not verified'],
    });

    const res = await request(app).get(`/api/deployments/${jobId}`).set(auth());
    expect(res.status).toBe(200);
    const body = res.body as { job: JobOut; steps: StepOut[] };
    expect(body.job.stepCounts).toMatchObject({ total: 2, complete: 2, failed: 0 });
    expect(body.steps.map((s) => s.stepKey)).toEqual(['create_store', 'wire_topology']);
    expect(body.steps[0]).toMatchObject({ resourceType: 'store', resourceId: 7, attempts: 1 });
    expect(body.steps[1]!.warnings).toEqual(['branch head-office token not verified']);
  });

  it('404s an unknown job', async () => {
    const res = await request(app).get('/api/deployments/999').set(auth());
    expect(res.status).toBe(404);
  });
});
