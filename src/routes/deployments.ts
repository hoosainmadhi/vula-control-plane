import { Router } from 'express';
import {
  deploymentStepCounts,
  getDeploymentJobById,
  listAllDeploymentJobs,
  listCompanies,
  listStepsForJob,
  type DeploymentJobRecord,
  type DeploymentJobStepRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import { parseIdParam } from '../utils/validate.js';

export const deploymentsRouter = Router();
deploymentsRouter.use(requireOffice);

export interface DeploymentStepOut {
  id: number;
  stepKey: string;
  resourceType: string;
  resourceId: number | null;
  status: DeploymentJobStepRecord['status'];
  attempts: number;
  error: string | null;
  /** Best-effort operations that did not succeed while the step still completed. */
  warnings: string[];
  startedAt: string | null;
  completedAt: string | null;
}

const parseWarnings = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
};

const stepToOut = (step: DeploymentJobStepRecord): DeploymentStepOut => ({
  id: step.id,
  stepKey: step.step_key,
  resourceType: step.resource_type,
  resourceId: step.resource_id,
  status: step.status,
  attempts: step.attempts,
  error: step.error,
  warnings: parseWarnings(step.warnings_json),
  startedAt: step.started_at,
  completedAt: step.completed_at,
});

const jobToOut = (
  job: DeploymentJobRecord,
  companyName: string,
  counts: { total: number; failed: number; complete: number; skipped: number },
) => ({
  id: job.id,
  type: job.type,
  status: job.status,
  error: job.error,
  companyId: job.company_id,
  companyName,
  startedAt: job.started_at,
  completedAt: job.completed_at,
  // Named `stepCounts`, not `steps`, because the detail route's `steps` is the
  // array of step rows — one key cannot mean both.
  stepCounts: counts,
});

/**
 * Every orchestrated deployment across the fleet (§33), newest first —
 * read-only, as the spec's initial implementation allows. The step tally is
 * computed in one grouped query rather than per job.
 */
deploymentsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const names = new Map(listCompanies().map((c) => [c.id, c.name]));
    const counts = deploymentStepCounts();
    res.json(
      listAllDeploymentJobs().map((job) =>
        jobToOut(job, names.get(job.company_id) ?? `Client #${job.company_id}`, counts.get(job.id) ?? {
          total: 0,
          failed: 0,
          complete: 0,
          skipped: 0,
        }),
      ),
    );
  }),
);

/** One job with its steps — what actually ran, and what failed. */
deploymentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const job = getDeploymentJobById(parseIdParam(req.params.id));
    if (!job) throw new HttpError(404, 'Deployment job not found');
    const names = new Map(listCompanies().map((c) => [c.id, c.name]));
    const steps = listStepsForJob(job.id).map(stepToOut);
    res.json({
      ok: true,
      job: jobToOut(job, names.get(job.company_id) ?? `Client #${job.company_id}`, {
        total: steps.length,
        failed: steps.filter((s) => s.status === 'failed').length,
        complete: steps.filter((s) => s.status === 'complete').length,
        skipped: steps.filter((s) => s.status === 'skipped').length,
      }),
      steps,
    });
  }),
);
