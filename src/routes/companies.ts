import { Router } from 'express';
import {
  companyBlockers,
  countStoresForCompany,
  createCompany,
  deleteCompany,
  getCompanyById,
  getCompanyBySlug,
  getPlanById,
  listCompanies,
  listPanelsForCompany,
  listPlans,
  createPlan,
  updatePlan,
  planFeatures,
  PLAN_PERIODS,
  updateCompany,
  type CompanyRecord,
  type PlanRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import {
  ValidationError,
  optionalString,
  parseIdParam,
  requireSlug,
  requireString,
} from '../utils/validate.js';
import { entitlementsFor, type Entitlements } from '../services/subscriptions.js';

export const companiesRouter = Router();
companiesRouter.use(requireOffice);
export const plansRouter = Router();
plansRouter.use(requireOffice);

// --- Wire types (mirrored in frontend/src/types.ts) ---------------------------

export interface PlanOut {
  id: number;
  code: string;
  name: string;
  maxStores: number;
  maxTerminalsPerStore: number;
  features: string[];
  priceCents: number;
  billingPeriod: 'monthly' | 'annual' | 'once-off';
  isActive: boolean;
  createdAt: string;
}

export interface CompanyOut {
  id: number;
  name: string;
  slug: string;
  billingEmail: string;
  planId: number | null;
  planCode: string;
  planName: string;
  paidThrough: string | null;
  trialEndsAt: string | null;
  status: 'active' | 'suspended';
  billingState: Entitlements['billingState'];
  storesUsed: number;
  maxStores: number;
  maxTerminalsPerStore: number;
  features: string[];
  panels: number;
  /** Operator-facing sentence when something needs attention; '' when healthy. */
  note: string;
  createdAt: string;
}

const planToOut = (plan: PlanRecord): PlanOut => ({
  id: plan.id,
  code: plan.code,
  name: plan.name,
  maxStores: plan.max_stores,
  maxTerminalsPerStore: plan.max_terminals_per_store,
  features: planFeatures(plan),
  priceCents: plan.price_cents,
  billingPeriod: plan.billing_period,
  isActive: Boolean(plan.is_active),
  createdAt: plan.created_at,
});

const companyToOut = (company: CompanyRecord): CompanyOut => {
  const ent = entitlementsFor(company);
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    billingEmail: company.billing_email,
    planId: company.plan_id,
    planCode: ent.planCode,
    planName: ent.planName,
    paidThrough: company.paid_through,
    trialEndsAt: company.trial_ends_at,
    status: company.status,
    billingState: ent.billingState,
    storesUsed: countStoresForCompany(company.id),
    maxStores: ent.maxStores,
    maxTerminalsPerStore: ent.maxTerminalsPerStore,
    features: ent.features,
    panels: listPanelsForCompany(company.id).length,
    note: ent.note,
    createdAt: company.created_at,
  };
};

const companyFromParams = (raw: string): CompanyRecord => {
  const company = getCompanyById(parseIdParam(raw));
  if (!company) throw new HttpError(404, 'Company not found');
  return company;
};

// --- Plans -------------------------------------------------------------------

plansRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listPlans().map(planToOut));
  }),
);

plansRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const code = requireString(req.body, 'code');
    const name = requireString(req.body, 'name');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(code)) {
      throw new ValidationError('code must be lowercase letters, digits and dashes');
    }
    const maxStores = Number(req.body?.maxStores ?? 1);
    const maxTerminalsPerStore = Number(req.body?.maxTerminalsPerStore ?? 1);
    if (!Number.isInteger(maxStores) || maxStores < 1 || maxStores > 500) {
      throw new ValidationError('maxStores must be an integer between 1 and 500');
    }
    if (!Number.isInteger(maxTerminalsPerStore) || maxTerminalsPerStore < 1 || maxTerminalsPerStore > 99) {
      throw new ValidationError('maxTerminalsPerStore must be an integer between 1 and 99');
    }
    const rawFeatures = req.body?.features;
    if (rawFeatures !== undefined && !Array.isArray(rawFeatures)) {
      throw new ValidationError('features must be an array of strings');
    }
    const billingPeriod = (req.body?.billingPeriod ?? 'monthly') as string;
    if (!PLAN_PERIODS.includes(billingPeriod as never)) {
      throw new ValidationError(`billingPeriod must be one of: ${PLAN_PERIODS.join(', ')}`);
    }
    res.status(201).json(
      planToOut(
        createPlan({
          code,
          name,
          maxStores,
          maxTerminalsPerStore,
          features: (rawFeatures as string[] | undefined) ?? [],
          priceCents: Number(req.body?.priceCents ?? 0),
          billingPeriod: billingPeriod as 'monthly' | 'annual' | 'once-off',
        }),
      ),
    );
  }),
);

plansRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (!getPlanById(id)) throw new HttpError(404, 'Plan not found');
    const body = req.body ?? {};
    const rawFeatures = body.features;
    if (rawFeatures !== undefined && !Array.isArray(rawFeatures)) {
      throw new ValidationError('features must be an array of strings');
    }
    const updated = updatePlan(id, {
      ...(body.name !== undefined ? { name: requireString(body, 'name') } : {}),
      ...(body.maxStores !== undefined ? { maxStores: Number(body.maxStores) } : {}),
      ...(body.maxTerminalsPerStore !== undefined
        ? { maxTerminalsPerStore: Number(body.maxTerminalsPerStore) }
        : {}),
      ...(rawFeatures !== undefined ? { features: rawFeatures as string[] } : {}),
      ...(body.priceCents !== undefined ? { priceCents: Number(body.priceCents) } : {}),
      ...(body.billingPeriod !== undefined
        ? { billingPeriod: body.billingPeriod as 'monthly' | 'annual' | 'once-off' }
        : {}),
      ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
    });
    res.json(planToOut(updated!));
  }),
);

// --- Companies ---------------------------------------------------------------

companiesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listCompanies().map(companyToOut));
  }),
);

companiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body, 'name');
    const slug = requireSlug(req.body);
    if (getCompanyBySlug(slug)) {
      res.status(409).json({ error: `A company with slug "${slug}" already exists` });
      return;
    }
    const billingEmail = optionalString(req.body, 'billingEmail', 200) ?? '';
    if (billingEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail)) {
      throw new ValidationError('billingEmail is not a valid address');
    }
    const planIdRaw = req.body?.planId;
    const planId = planIdRaw === undefined || planIdRaw === null ? null : Number(planIdRaw);
    if (planId !== null && !getPlanById(planId)) {
      throw new ValidationError('planId does not match a known plan');
    }
    res.status(201).json(
      companyToOut(
        createCompany({
          name,
          slug,
          billingEmail,
          planId,
          paidThrough: optionalString(req.body, 'paidThrough', 10) ?? null,
          trialEndsAt: optionalString(req.body, 'trialEndsAt', 10) ?? null,
        }),
      ),
    );
  }),
);

companiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(companyToOut(companyFromParams(req.params.id)));
  }),
);

/**
 * Delete a company — only a mistake or a duplicate, never a trading merchant.
 * Refused while it still owns stores or a Head Office, because the schema would
 * otherwise cascade the panel away and orphan the branches.
 */
companiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = companyFromParams(req.params.id);
    const blockers = companyBlockers(company.id);

    if (blockers.stores > 0 || blockers.panels > 0) {
      const parts: string[] = [];
      if (blockers.stores > 0) {
        parts.push(`${blockers.stores} store${blockers.stores === 1 ? '' : 's'}`);
      }
      if (blockers.panels > 0) {
        parts.push(`${blockers.panels} Head Office${blockers.panels === 1 ? '' : 's'}`);
      }
      res.status(409).json({
        error: `${company.name} still owns ${parts.join(' and ')}. Reassign or remove those first — deleting the company would strip their plan and licence. To stop trading without losing history, suspend it instead.`,
        code: 'company_in_use',
        blockers,
      });
      return;
    }

    deleteCompany(company.id);
    res.json({ ok: true, message: `${company.name} deleted` });
  }),
);

companiesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const company = companyFromParams(req.params.id);
    const body = req.body ?? {};
    if (body.planId !== undefined && body.planId !== null && !getPlanById(Number(body.planId))) {
      throw new ValidationError('planId does not match a known plan');
    }
    if (body.status !== undefined && !['active', 'suspended'].includes(String(body.status))) {
      throw new ValidationError('status must be active or suspended');
    }
    const updated = updateCompany(company.id, {
      ...(body.name !== undefined ? { name: requireString(body, 'name') } : {}),
      ...(body.billingEmail !== undefined
        ? { billingEmail: optionalString(body, 'billingEmail', 200) ?? '' }
        : {}),
      ...(body.planId !== undefined ? { planId: body.planId === null ? null : Number(body.planId) } : {}),
      ...(body.paidThrough !== undefined
        ? { paidThrough: optionalString(body, 'paidThrough', 10) ?? null }
        : {}),
      ...(body.trialEndsAt !== undefined
        ? { trialEndsAt: optionalString(body, 'trialEndsAt', 10) ?? null }
        : {}),
      ...(body.status !== undefined ? { status: body.status as 'active' | 'suspended' } : {}),
    });
    res.json(companyToOut(updated!));
  }),
);
