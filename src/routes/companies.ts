import { Router } from 'express';
import {
  companyBlockers,
  countStoresForCompany,
  createCompany,
  deleteCompany,
  getCompanyById,
  getCompanyBySlug,
  getPlanById,
  getPlanByCode,
  listCompanies,
  listPanelsForCompany,
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
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
import {
  entitlementsFor,
  registerEnforcementFor,
  type Entitlements,
  type RegisterEnforcement,
} from '../services/subscriptions.js';
import { PLAN_FEATURES, validateFeatureKeys } from '../services/features.js';
import { pushLicencesForCompany } from '../services/billing.js';

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
  /** How the register will present the subscription (mirrors the licence the store holds). */
  registerState: RegisterEnforcement['registerState'];
  /** True when the register refuses new sales for this company. */
  tradingBlocked: boolean;
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
    ...registerEnforcementFor(ent),
    createdAt: company.created_at,
  };
};

const companyFromParams = (raw: string): CompanyRecord => {
  const company = getCompanyById(parseIdParam(raw));
  if (!company) throw new HttpError(404, 'Company not found');
  return company;
};

// --- Plans -------------------------------------------------------------------

/**
 * The curated feature vocabulary. Plans may only grant these keys, and the
 * applications gate on exactly these — the list is the cross-application
 * contract, so it is served for the Plans UI and for the store/head-office
 * workstreams to mirror.
 */
plansRouter.get(
  '/features',
  asyncHandler(async (_req, res) => {
    res.json(PLAN_FEATURES);
  }),
);

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
    if (getPlanByCode(code)) {
      throw new HttpError(409, `A plan with code "${code}" already exists`);
    }
    const maxStores = Number(req.body?.maxStores ?? 1);
    const maxTerminalsPerStore = Number(req.body?.maxTerminalsPerStore ?? 1);
    if (!Number.isInteger(maxStores) || maxStores < 1 || maxStores > 500) {
      throw new ValidationError('maxStores must be an integer between 1 and 500');
    }
    if (
      !Number.isInteger(maxTerminalsPerStore) ||
      maxTerminalsPerStore < 1 ||
      maxTerminalsPerStore > 99
    ) {
      throw new ValidationError('maxTerminalsPerStore must be an integer between 1 and 99');
    }
    const features = validateFeatureKeys(req.body?.features ?? []);
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
          features,
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
    const existingPlan = getPlanById(id);
    if (!existingPlan) throw new HttpError(404, 'Plan not found');
    const body = req.body ?? {};

    // `code` is the technical identifier licences and integrations depend on —
    // immutable after creation (2026-09-12). A provided code must match.
    if (body.code !== undefined) {
      const requested = requireString(body, 'code').toLowerCase();
      if (requested !== existingPlan.code) {
        throw new HttpError(400, 'Plan code is immutable after creation');
      }
    }

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
      ...(rawFeatures !== undefined ? { features: validateFeatureKeys(rawFeatures) } : {}),
      ...(body.priceCents !== undefined ? { priceCents: Number(body.priceCents) } : {}),
      ...(body.billingPeriod !== undefined
        ? { billingPeriod: body.billingPeriod as 'monthly' | 'annual' | 'once-off' }
        : {}),
      ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
    });
    res.json(planToOut(updated!));
  }),
);

plansRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (!getPlanById(id)) throw new HttpError(404, 'Plan not found');
    try {
      deletePlan(id);
      res.json({ ok: true });
    } catch (err: any) {
      throw new HttpError(409, err?.message || 'Cannot delete plan');
    }
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
    if (planId !== null) {
      const chosenPlan = getPlanById(planId);
      if (!chosenPlan) {
        throw new ValidationError('planId does not match a known plan');
      }
      if (!chosenPlan.is_active) {
        throw new ValidationError(
          `Plan "${chosenPlan.name}" is inactive and cannot be used for a new company`,
        );
      }
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
    if (body.planId !== undefined && body.planId !== null) {
      const chosenPlan = getPlanById(Number(body.planId));
      if (!chosenPlan) {
        throw new ValidationError('planId does not match a known plan');
      }
      // A company may stay on an archived plan, but switching onto one is refused.
      if (!chosenPlan.is_active && Number(body.planId) !== company.plan_id) {
        throw new ValidationError(
          `Plan "${chosenPlan.name}" is inactive and cannot be assigned to a company`,
        );
      }
    }
    if (body.status !== undefined && !['active', 'suspended'].includes(String(body.status))) {
      throw new ValidationError('status must be active or suspended');
    }
    const planId =
      body.planId !== undefined ? (body.planId === null ? null : Number(body.planId)) : undefined;
    const paidThrough =
      body.paidThrough !== undefined
        ? (optionalString(body, 'paidThrough', 10) ?? null)
        : undefined;
    const trialEndsAt =
      body.trialEndsAt !== undefined
        ? (optionalString(body, 'trialEndsAt', 10) ?? null)
        : undefined;
    const status = body.status !== undefined ? (body.status as 'active' | 'suspended') : undefined;

    const updated = updateCompany(company.id, {
      ...(body.name !== undefined ? { name: requireString(body, 'name') } : {}),
      ...(body.billingEmail !== undefined
        ? { billingEmail: optionalString(body, 'billingEmail', 200) ?? '' }
        : {}),
      ...(planId !== undefined ? { planId } : {}),
      ...(paidThrough !== undefined ? { paidThrough } : {}),
      ...(trialEndsAt !== undefined ? { trialEndsAt } : {}),
      ...(status !== undefined ? { status } : {}),
    });

    // An entitlement change (plan, paid-through, trial, suspension) is only real
    // once the stores and Head Office hold licences that say so. Re-push
    // immediately rather than waiting for the next health check — a manual
    // suspension must reach the registers in seconds, and a payment must lift
    // the block just as fast. Failures are reported, never fail the edit: the
    // registry row is already correct and the next sweep retries delivery.
    const entitlementChanged =
      (planId !== undefined && planId !== company.plan_id) ||
      (paidThrough !== undefined && paidThrough !== company.paid_through) ||
      (trialEndsAt !== undefined && trialEndsAt !== company.trial_ends_at) ||
      (status !== undefined && status !== company.status);
    let licencePush: Awaited<ReturnType<typeof pushLicencesForCompany>> | null = null;
    if (entitlementChanged) {
      try {
        licencePush = await pushLicencesForCompany(company.id);
      } catch (err) {
        licencePush = {
          storesUpdated: 0,
          panelsUpdated: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    }

    res.json({ ...companyToOut(updated!), licencePush });
  }),
);
