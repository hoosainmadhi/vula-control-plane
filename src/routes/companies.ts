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
  licensedTerminalCount,
  setLicensedTerminalCount,
  setSetupFeeStatus,
  setSubscriptionPricing,
  recordAuditLog,
  PLAN_PERIODS,
  PLAN_PRICING_MODES,
  SETUP_FEE_STATUSES,
  updateCompany,
  type CompanyRecord,
  type PlanPeriod,
  type PlanPricingMode,
  type PlanRecord,
  type SetupFeeStatus,
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
import { quoteForSubscription } from '../services/pricing.js';
import { setupFeeInvoiceFor } from '../services/billing.js';
import { summariseSubscription } from '../services/terminalLicences.js';
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
  /** `per_terminal` bills rate × licensed terminals; `custom` is negotiated. */
  pricingMode: PlanPricingMode;
  /** Rate per licensed terminal per billing period (0 on a custom plan). */
  terminalPriceCents: number;
  /**
   * A `custom` plan's agreed charge per billing period. 0 means "negotiated per
   * client" — the control plane then refuses to invoice without an explicit amount.
   */
  customAmountCents: number;
  /** Once-off onboarding charge for the client. */
  setupFeeCents: number;
  billingPeriod: 'monthly' | 'annual' | 'once-off';
  isActive: boolean;
  createdAt: string;
}

/** What the client purchased, priced — the subscription as the office sees it. */
export interface SubscriptionOut {
  licensedTerminalCount: number;
  allocatedTerminals: number;
  unallocatedTerminals: number;
  /** null when the plan is custom-priced or absent — never a guessed figure. */
  recurringAmountCents: number | null;
  rateCents: number;
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  /** The charge still to be raised (0 once invoiced, paid or waived). */
  setupFeeDueCents: number;
  /** The document carrying the charge, when it has been billed (see §40: "ref"). */
  setupFeeRef: string | null;
  allocations: Array<{ storeId: number; licensedTerminalCount: number }>;
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
  /** The purchased quantity and what it costs. */
  subscription: SubscriptionOut;
  createdAt: string;
}

const planToOut = (plan: PlanRecord): PlanOut => ({
  id: plan.id,
  code: plan.code,
  name: plan.name,
  maxStores: plan.max_stores,
  maxTerminalsPerStore: plan.max_terminals_per_store,
  features: planFeatures(plan),
  pricingMode: plan.pricing_mode,
  terminalPriceCents: plan.terminal_price_cents,
  customAmountCents: plan.custom_amount_cents,
  setupFeeCents: plan.setup_fee_cents,
  billingPeriod: plan.billing_period,
  isActive: Boolean(plan.is_active),
  createdAt: plan.created_at,
});

/**
 * Records the price a client has agreed to, copied from the plan they are on.
 *
 * The three moments a price is agreed: onboarding, moving a client to another
 * plan, and the office explicitly re-pricing them. Everywhere else, editing a plan
 * must not touch what an existing client pays — see `services/pricing.ts` and
 * CONTEXT §5e.
 */
export const recordAgreedPricing = (
  companyId: number,
  plan: PlanRecord | null,
  actor = 'office',
  reason = 'Recorded the price agreed with this client',
): void => {
  if (!plan) return;
  setSubscriptionPricing(companyId, {
    pricingMode: plan.pricing_mode,
    rateCents: plan.terminal_price_cents,
    customAmountCents: plan.custom_amount_cents,
    setupFeeCents: plan.setup_fee_cents,
    billingPeriod: plan.billing_period,
  });
  recordAuditLog(actor, 'subscription_priced', 'company', companyId, {
    after: {
      planCode: plan.code,
      pricingMode: plan.pricing_mode,
      rateCents: plan.terminal_price_cents,
      customAmountCents: plan.custom_amount_cents,
      setupFeeCents: plan.setup_fee_cents,
    },
    reason,
  });
};

const companyToOut = (company: CompanyRecord): CompanyOut => {
  const ent = entitlementsFor(company);
  const quote = quoteForSubscription(company);
  const summary = summariseSubscription(company.id);
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
    subscription: {
      licensedTerminalCount: quote.licensedTerminalCount,
      allocatedTerminals: summary.allocatedTerminalCount,
      unallocatedTerminals: summary.unallocatedTerminalCount,
      recurringAmountCents: quote.recurringAmountCents,
      rateCents: quote.rateCents,
      setupFeeCents: quote.setupFeeCents,
      setupFeeStatus: quote.setupFeeStatus,
      setupFeeDueCents: quote.setupFeeDueCents,
      setupFeeRef:
        quote.setupFeeStatus === 'invoiced'
          ? (setupFeeInvoiceFor(company.id)?.invoice_number ?? null)
          : null,
      allocations: summary.allocations,
    },
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

/**
 * Money is integer cents, never a float (§31). An absent field keeps the current
 * value on edit; on create it defaults to 0.
 */
const moneyCents = (value: unknown, field: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ValidationError(`${field} must be a whole number of cents (0 or more)`);
  }
  return n;
};

const pricingModeOf = (value: unknown, fallback: PlanPricingMode): PlanPricingMode => {
  if (value === undefined) return fallback;
  if (!PLAN_PRICING_MODES.includes(value as PlanPricingMode)) {
    throw new ValidationError(`pricingMode must be one of: ${PLAN_PRICING_MODES.join(', ')}`);
  }
  return value as PlanPricingMode;
};

/**
 * The pricing fields as they will stand after the write, validated as a set:
 * a per-terminal plan must carry a rate above zero (a rate of 0 would bill
 * nothing while claiming to be a rate), and `custom` plans carry no rate.
 */
const resolvePlanPricing = (
  body: Record<string, unknown>,
  existing?: PlanRecord,
): {
  pricingMode: PlanPricingMode;
  terminalPriceCents: number;
  customAmountCents: number;
  setupFeeCents: number;
} => {
  const pricingMode = pricingModeOf(body['pricingMode'], existing?.pricing_mode ?? 'per_terminal');
  const terminalPriceCents =
    body['terminalPriceCents'] !== undefined
      ? moneyCents(body['terminalPriceCents'], 'terminalPriceCents')
      : (existing?.terminal_price_cents ?? 0);
  const customAmountCents =
    body['customAmountCents'] !== undefined
      ? moneyCents(body['customAmountCents'], 'customAmountCents')
      : (existing?.custom_amount_cents ?? 0);
  const setupFeeCents =
    body['setupFeeCents'] !== undefined
      ? moneyCents(body['setupFeeCents'], 'setupFeeCents')
      : (existing?.setup_fee_cents ?? 0);

  if (pricingMode === 'per_terminal' && terminalPriceCents <= 0) {
    throw new ValidationError(
      'A per-terminal plan needs a price above zero — set the rate per licensed terminal, or switch the plan to custom pricing.',
    );
  }
  // Both figures are stored whichever mode is active (so toggling the mode never
  // loses a value); only the one the mode names is ever read or billed.
  return { pricingMode, terminalPriceCents, customAmountCents, setupFeeCents };
};

const periodOf = (value: unknown, fallback: PlanPeriod): PlanPeriod => {
  if (value === undefined) return fallback;
  if (!PLAN_PERIODS.includes(value as PlanPeriod)) {
    throw new ValidationError(`billingPeriod must be one of: ${PLAN_PERIODS.join(', ')}`);
  }
  return value as PlanPeriod;
};

const boundedInt = (value: unknown, field: string, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}`);
  }
  return n;
};

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
    const maxStores = boundedInt(req.body?.maxStores ?? 1, 'maxStores', 1, 500);
    const maxTerminalsPerStore = boundedInt(
      req.body?.maxTerminalsPerStore ?? 1,
      'maxTerminalsPerStore',
      1,
      99,
    );
    const features = validateFeatureKeys(req.body?.features ?? []);
    const billingPeriod = periodOf(req.body?.billingPeriod, 'monthly');
    const pricing = resolvePlanPricing((req.body ?? {}) as Record<string, unknown>);
    res.status(201).json(
      planToOut(
        createPlan({
          code,
          name,
          maxStores,
          maxTerminalsPerStore,
          features,
          pricingMode: pricing.pricingMode,
          terminalPriceCents: pricing.terminalPriceCents,
          customAmountCents: pricing.customAmountCents,
          setupFeeCents: pricing.setupFeeCents,
          billingPeriod,
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
    const body = (req.body ?? {}) as Record<string, unknown>;

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
    const pricing = resolvePlanPricing(body, existingPlan);
    const updated = updatePlan(id, {
      ...(body.name !== undefined ? { name: requireString(body, 'name') } : {}),
      ...(body.maxStores !== undefined
        ? { maxStores: boundedInt(body.maxStores, 'maxStores', 1, 500) }
        : {}),
      ...(body.maxTerminalsPerStore !== undefined
        ? {
            maxTerminalsPerStore: boundedInt(
              body.maxTerminalsPerStore,
              'maxTerminalsPerStore',
              1,
              99,
            ),
          }
        : {}),
      ...(rawFeatures !== undefined ? { features: validateFeatureKeys(rawFeatures) } : {}),
      ...pricing,
      ...(body.billingPeriod !== undefined
        ? { billingPeriod: periodOf(body.billingPeriod, existingPlan.billing_period) }
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
        (() => {
          const company = createCompany({
            name,
            slug,
            billingEmail,
            planId,
            paidThrough: optionalString(req.body, 'paidThrough', 10) ?? null,
            trialEndsAt: optionalString(req.body, 'trialEndsAt', 10) ?? null,
          });
          // What the client purchased. Omitted (or 0) means "not set yet": no
          // store can join the client until the quantity is stated, so a
          // subscription is never invented on the client's behalf.
          if (req.body?.licensedTerminalCount !== undefined) {
            setLicensedTerminalCount(
              company.id,
              boundedInt(req.body.licensedTerminalCount, 'licensedTerminalCount', 0, 5000),
            );
          }
          // And the price they agreed to, copied onto the subscription so a later
          // edit to the plan cannot quietly re-price them.
          recordAgreedPricing(
            company.id,
            planId ? getPlanById(planId) : null,
            'office',
            'Recorded the price agreed when the client was onboarded',
          );
          return getCompanyById(company.id)!;
        })(),
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

    // Moving a client to another plan IS agreeing a new price (one of the three
    // moments a price is agreed), so the plan's terms are recorded on the
    // subscription here. Editing the plan itself never does this — that is what
    // keeps an existing client's price stable.
    const planChanged = planId !== undefined && planId !== company.plan_id;

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

    if (planChanged) {
      recordAgreedPricing(
        company.id,
        planId ? getPlanById(planId) : null,
        'office',
        `Moved ${company.name} to ${planId ? getPlanById(planId)?.name : 'no plan'} — priced at that plan's terms`,
      );
    }

    // The purchased quantity and the state of the once-off onboarding charge.
    // Lowering the quantity is allowed even when stores hold more licences than
    // that: the allowance gates NEW device claims, and an operator reducing a
    // subscription must not be blocked by tills already running. `note` on the
    // response reports the mismatch.
    const requestedLicensedCount =
      body.licensedTerminalCount !== undefined
        ? boundedInt(body.licensedTerminalCount, 'licensedTerminalCount', 0, 5000)
        : undefined;
    let licensedChanged = false;
    if (requestedLicensedCount !== undefined) {
      licensedChanged = requestedLicensedCount !== licensedTerminalCount(company.id);
      setLicensedTerminalCount(company.id, requestedLicensedCount);
    }

    const setupFeeStatusRaw = body.setupFeeStatus;
    if (setupFeeStatusRaw !== undefined) {
      if (!SETUP_FEE_STATUSES.includes(setupFeeStatusRaw as SetupFeeStatus)) {
        throw new ValidationError(
          `setupFeeStatus must be one of: ${SETUP_FEE_STATUSES.join(', ')}`,
        );
      }
      setSetupFeeStatus(company.id, setupFeeStatusRaw as SetupFeeStatus);
    }

    // An entitlement change (plan, paid-through, trial, suspension, licensed
    // quantity) is only real once the stores and Head Office hold licences that
    // say so. Re-push immediately rather than waiting for the next health check —
    // a manual suspension must reach the registers in seconds, and a payment must
    // lift the block just as fast. Failures are reported, never fail the edit: the
    // registry row is already correct and the next sweep retries delivery.
    const entitlementChanged =
      (planId !== undefined && planId !== company.plan_id) ||
      (paidThrough !== undefined && paidThrough !== company.paid_through) ||
      (trialEndsAt !== undefined && trialEndsAt !== company.trial_ends_at) ||
      (status !== undefined && status !== company.status) ||
      licensedChanged;
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

    res.json({ ...companyToOut(getCompanyById(company.id)!), licencePush });
  }),
);
