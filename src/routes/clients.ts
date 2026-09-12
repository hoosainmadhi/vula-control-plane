import { Router } from 'express';
import {
  listCompanies,
  getCompanyById,
  getCompanyBySlug,
  createCompany,
  updateCompany,
  getPlanById,
  listStores,
  listPanelsForCompany,
  getDeploymentJobById,
  listDeploymentJobsForCompany,
  listStepsForJob,
  recordAuditLog,
  type CompanyRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import {
  requireString,
  requireSlug,
  optionalString,
  parseIdParam,
  requireInt,
  optionalInt,
} from '../utils/validate.js';
import { entitlementsFor, requireFeature } from '../services/subscriptions.js';
import {
  orchestrateClientDeployment,
  orchestrateUpgradeToMultiStore,
  retryDeploymentJob,
} from '../services/clientOrchestrator.js';

export const clientsRouter = Router();
clientsRouter.use(requireOffice);

// --- Wire Types ---

export interface ClientListItem {
  id: number;
  name: string;
  slug: string;
  billingEmail: string;
  topology: 'single_store' | 'multi_store';
  planId: number | null;
  planCode: string;
  planName: string;
  billingState: string;
  paidThrough: string | null;
  trialEndsAt: string | null;
  status: 'active' | 'suspended';
  headOffice: {
    id: number;
    name: string;
    slug: string;
    baseUrl: string;
    health: string;
    appVersion: string | null;
  } | null;
  storesCount: number;
  healthyStoresCount: number;
  totalTills: number;
  latestJobStatus: string | null;
  createdAt: string;
}

export const buildClientListItem = (company: CompanyRecord): ClientListItem => {
  const ent = entitlementsFor(company);
  const panels = listPanelsForCompany(company.id);
  const ho = panels[0] || null;
  const companyStores = listStores().filter((s) => s.company_id === company.id);
  const healthyStoresCount = companyStores.filter((s) => s.last_health_status === 'up').length;
  const totalTills = companyStores.reduce((acc, s) => acc + (s.terminal_count || 1), 0);
  const jobs = listDeploymentJobsForCompany(company.id);
  const latestJob = jobs[0] || null;

  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    billingEmail: company.billing_email,
    topology: ho || companyStores.length > 1 ? 'multi_store' : 'single_store',
    planId: company.plan_id,
    planCode: ent.planCode,
    planName: ent.planName,
    billingState: ent.billingState,
    paidThrough: company.paid_through,
    trialEndsAt: company.trial_ends_at,
    status: company.status,
    headOffice: ho
      ? {
          id: ho.id,
          name: ho.name,
          slug: ho.slug,
          baseUrl: ho.base_url,
          health: ho.last_health_status,
          appVersion: ho.app_version,
        }
      : null,
    storesCount: companyStores.length,
    healthyStoresCount,
    totalTills,
    latestJobStatus: latestJob?.status ?? null,
    createdAt: company.created_at,
  };
};

// --- Endpoints ---

clientsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const companies = listCompanies();
    res.json(companies.map(buildClientListItem));
  }),
);

clientsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const company = getCompanyById(id);
    if (!company) throw new HttpError(404, 'Client not found');

    const summary = buildClientListItem(company);
    const panels = listPanelsForCompany(company.id);
    const stores = listStores().filter((s) => s.company_id === company.id);
    const jobs = listDeploymentJobsForCompany(company.id);
    const latestJob = jobs[0] || null;
    const steps = latestJob ? listStepsForJob(latestJob.id) : [];

    const panel = panels[0] || null;
    res.json({
      client: summary,
      headOffice: panel
        ? {
            id: panel.id,
            companyId: panel.company_id,
            name: panel.name,
            slug: panel.slug,
            baseUrl: panel.base_url,
            status: panel.status,
            health: panel.last_health_status,
            lastHealthAt: panel.last_health_at,
            appVersion: panel.app_version,
          }
        : null,
      stores: stores.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        baseUrl: s.base_url,
        terminalCount: s.terminal_count,
        vertical: s.vertical,
        health: s.last_health_status,
        lastHealthAt: s.last_health_at,
        deployStatus: s.deploy_status,
        coolifyUuid: s.coolify_uuid,
        adminEmail: s.admin_email,
      })),
      latestDeployment: latestJob
        ? {
            job: latestJob,
            steps,
          }
        : null,
    });
  }),
);

clientsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const company = getCompanyById(id);
    if (!company) throw new HttpError(404, 'Client not found');

    const body = req.body ?? {};
    if (body.planId !== undefined && body.planId !== null && !getPlanById(Number(body.planId))) {
      throw new HttpError(400, 'planId does not match a known plan');
    }
    if (body.status !== undefined && !['active', 'suspended'].includes(String(body.status))) {
      throw new HttpError(400, 'status must be active or suspended');
    }

    const name = body.name !== undefined ? requireString(body, 'name') : undefined;
    const billingEmail =
      body.billingEmail !== undefined
        ? (optionalString(body, 'billingEmail', 200) ?? '')
        : undefined;
    const planId =
      body.planId !== undefined ? (body.planId === null ? null : Number(body.planId)) : undefined;
    const status = body.status !== undefined ? (body.status as 'active' | 'suspended') : undefined;

    const updated = updateCompany(company.id, {
      name,
      billingEmail,
      planId,
      status,
    });

    recordAuditLog('office', 'client_updated', 'company', company.id, {
      before: { name: company.name, billingEmail: company.billing_email, planId: company.plan_id },
      after: { name, billingEmail, planId, status },
      reason: 'Updated client profile',
    });

    res.json(buildClientListItem(updated!));
  }),
);

clientsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body, 'name');
    const slug = requireSlug(req.body);
    const billingEmail = optionalString(req.body, 'billingEmail') ?? '';
    const planId = optionalInt(req.body, 'planId') ?? null;
    const deploymentType =
      req.body?.deploymentType === 'multi_store' ? 'multi_store' : 'single_store';
    const autoDeploy = req.body?.autoDeploy !== false;

    // Inactive (archived) plans stay visible on existing subscriptions but are
    // not offered to new clients.
    if (planId !== null) {
      const chosenPlan = getPlanById(planId);
      if (!chosenPlan) throw new HttpError(400, 'planId does not match a known plan');
      if (!chosenPlan.is_active) {
        throw new HttpError(400, `Plan "${chosenPlan.name}" is inactive and cannot be used for a new client`);
      }
    }

    // Check slug uniqueness
    if (getCompanyBySlug(slug)) {
      throw new HttpError(409, `A client with slug '${slug}' already exists`);
    }

    // A Head Office with branches is the `multi_store` plan feature (L4): a plan
    // without it cannot have the topology orchestrated, whatever the wizard says.
    if (deploymentType === 'multi_store') {
      const plan = planId !== null ? getPlanById(planId) : null;
      const feature = requireFeature(plan, 'multi_store');
      if (!feature.ok) {
        res.status(402).json({ error: feature.reason, code: 'feature_not_in_plan' });
        return;
      }
    }

    // 1. Create company record
    const company = createCompany({
      name,
      slug,
      billingEmail,
      planId,
    });

    recordAuditLog('office', 'client_created', 'company', company.id, {
      after: { name, slug, deploymentType },
      reason: 'Created new client via onboarding wizard',
    });

    // 2. Format stores list
    const rawStores = (req.body?.stores ?? []) as Array<Record<string, unknown>>;
    const stores = rawStores.map((s, idx) => ({
      name:
        typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `${name} Store ${idx + 1}`,
      slug: typeof s.slug === 'string' && s.slug.trim() ? s.slug.trim() : `${slug}-${idx + 1}`,
      baseUrl:
        typeof s.baseUrl === 'string' && s.baseUrl.trim()
          ? s.baseUrl.trim()
          : `https://${slug}-${idx + 1}.vula-app.co.za`,
      terminalCount: typeof s.terminalCount === 'number' ? s.terminalCount : 1,
      adminEmail: typeof s.adminEmail === 'string' ? s.adminEmail.trim() : undefined,
    }));

    // If single store and no stores provided, create default store
    if (stores.length === 0) {
      stores.push({
        name,
        slug,
        baseUrl: `https://${slug}.vula-app.co.za`,
        terminalCount: 1,
        adminEmail: billingEmail || undefined,
      });
    }

    // 3. Format Head Office if multi_store
    let headOffice:
      { name: string; slug: string; baseUrl: string; adminEmail?: string } | undefined;
    if (deploymentType === 'multi_store') {
      const rawHo = req.body?.headOffice as Record<string, unknown> | undefined;
      headOffice = {
        name:
          typeof rawHo?.name === 'string' && rawHo.name.trim()
            ? rawHo.name.trim()
            : `${name} Head Office`,
        slug:
          typeof rawHo?.slug === 'string' && rawHo.slug.trim() ? rawHo.slug.trim() : `${slug}-ho`,
        baseUrl:
          typeof rawHo?.baseUrl === 'string' && rawHo.baseUrl.trim()
            ? rawHo.baseUrl.trim()
            : `https://${slug}-ho.vula-app.co.za`,
        adminEmail:
          typeof rawHo?.adminEmail === 'string'
            ? rawHo.adminEmail.trim()
            : billingEmail || undefined,
      };
    }

    // 4. Trigger orchestration
    const { job, steps } = await orchestrateClientDeployment({
      companyId: company.id,
      deploymentType,
      stores,
      headOffice,
      autoDeploy,
    });

    res.status(201).json({
      client: buildClientListItem(company),
      job,
      steps,
    });
  }),
);

clientsRouter.post(
  '/:id/upgrade-to-multistore',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const company = getCompanyById(id);
    if (!company) throw new HttpError(404, 'Client not found');

    const panels = listPanelsForCompany(company.id);
    if (panels.length > 0) {
      throw new HttpError(409, 'Client is already configured as Multi-Store');
    }

    // Gate on the plan that will be in force when the topology lands: the one
    // being upgraded to when supplied, otherwise the company's current plan.
    const requestedPlanId = optionalInt(req.body, 'planId');
    if (requestedPlanId) {
      const requestedPlan = getPlanById(requestedPlanId);
      if (!requestedPlan) {
        throw new HttpError(400, 'planId does not match a known plan');
      }
      if (!requestedPlan.is_active) {
        throw new HttpError(400, `Plan "${requestedPlan.name}" is inactive and cannot be selected`);
      }
    }
    const effectivePlan = requestedPlanId
      ? getPlanById(requestedPlanId)
      : company.plan_id
        ? getPlanById(company.plan_id)
        : null;
    const feature = requireFeature(effectivePlan, 'multi_store');
    if (!feature.ok) {
      res.status(402).json({ error: feature.reason, code: 'feature_not_in_plan' });
      return;
    }

    const rawHo = (req.body?.headOffice ?? {}) as Record<string, unknown>;
    const headOffice = {
      name:
        typeof rawHo.name === 'string' && rawHo.name.trim()
          ? rawHo.name.trim()
          : `${company.name} Head Office`,
      slug:
        typeof rawHo.slug === 'string' && rawHo.slug.trim()
          ? rawHo.slug.trim()
          : `${company.slug}-ho`,
      baseUrl:
        typeof rawHo.baseUrl === 'string' && rawHo.baseUrl.trim()
          ? rawHo.baseUrl.trim()
          : `https://${company.slug}-ho.vula-app.co.za`,
      adminEmail:
        typeof rawHo.adminEmail === 'string'
          ? rawHo.adminEmail.trim()
          : company.billing_email || undefined,
    };

    let newStore:
      | { name: string; slug: string; baseUrl: string; terminalCount: number; adminEmail?: string }
      | undefined;
    const rawNewStore = req.body?.newStore as Record<string, unknown> | undefined;
    if (rawNewStore) {
      newStore = {
        name:
          typeof rawNewStore.name === 'string'
            ? rawNewStore.name.trim()
            : `${company.name} Branch 2`,
        slug: typeof rawNewStore.slug === 'string' ? rawNewStore.slug.trim() : `${company.slug}-2`,
        baseUrl:
          typeof rawNewStore.baseUrl === 'string'
            ? rawNewStore.baseUrl.trim()
            : `https://${company.slug}-2.vula-app.co.za`,
        terminalCount:
          typeof rawNewStore.terminalCount === 'number' ? rawNewStore.terminalCount : 1,
        adminEmail:
          typeof rawNewStore.adminEmail === 'string' ? rawNewStore.adminEmail.trim() : undefined,
      };
    }

    const planId = optionalInt(req.body, 'planId');

    const { job, steps } = await orchestrateUpgradeToMultiStore({
      companyId: company.id,
      headOffice,
      newStore,
      planId: planId ?? undefined,
    });

    recordAuditLog('office', 'upgrade_to_multistore', 'company', company.id, {
      after: { headOffice, newStore, planId },
      reason: 'Upgraded client topology from Single-Store to Multi-Store',
    });

    res.json({
      ok: true,
      client: buildClientListItem(getCompanyById(company.id)!),
      job,
      steps,
    });
  }),
);

clientsRouter.get(
  '/:id/jobs',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const company = getCompanyById(id);
    if (!company) throw new HttpError(404, 'Client not found');

    const jobs = listDeploymentJobsForCompany(company.id);
    const jobsWithSteps = jobs.map((j) => ({
      ...j,
      steps: listStepsForJob(j.id),
    }));

    res.json(jobsWithSteps);
  }),
);

clientsRouter.post(
  '/jobs/:jobId/retry',
  asyncHandler(async (req, res) => {
    const jobId = parseIdParam(req.params.jobId);
    const job = getDeploymentJobById(jobId);
    if (!job) throw new HttpError(404, 'Deployment job not found');

    const retriedJob = await retryDeploymentJob(jobId);
    res.json({
      ok: true,
      job: retriedJob,
      steps: listStepsForJob(jobId),
    });
  }),
);
