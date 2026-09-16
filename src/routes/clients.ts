import { Router } from 'express';
import {
  listCompanies,
  getCompanyById,
  getCompanyBySlug,
  createCompany,
  updateCompany,
  getPlanById,
  getStoreById,
  licensedTerminalCount,
  listStores,
  listPanelsForCompany,
  setLicensedTerminalCount,
  setSetupFeeStatus,
  SETUP_FEE_STATUSES,
  getDeploymentJobById,
  listDeploymentJobsForCompany,
  listStepsForJob,
  recordAuditLog,
  type CompanyRecord,
  type SetupFeeStatus,
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
import { quoteForSubscription } from '../services/pricing.js';
import { summariseSubscription, allocateTerminals, checkAllocation } from '../services/terminalLicences.js';
import { pushLicencesForCompany } from '../services/billing.js';
import { pushStoreListToPanel } from '../services/topology.js';
import { storeToOut } from './stores.js';
import type { StoreEnvironment } from '../config/registryDb.js';
import {
  orchestrateClientDeployment,
  orchestrateUpgradeToMultiStore,
  retryDeploymentJob,
} from '../services/clientOrchestrator.js';

export const clientsRouter = Router();
clientsRouter.use(requireOffice);

/**
 * Hand this client's intended store list to its Head Office panel, on demand.
 *
 * The panel keeps what the merchant has registered separately, so pushing this
 * never activates or removes a branch — it lets the merchant see which of their
 * stores are still to be registered. Wiring does it automatically; this is for
 * an operator who wants to reconcile without waiting for the next store change.
 */
clientsRouter.post(
  '/:id/push-stores',
  asyncHandler(async (req, res) => {
    const company = getCompanyById(parseIdParam(req.params.id));
    if (!company) throw new HttpError(404, 'Client not found');

    const outcome = await pushStoreListToPanel(company.id);
    if (outcome === 'no-panel') {
      throw new HttpError(400, 'This client has no Head Office to push to');
    }

    recordAuditLog('office', 'store_list_pushed', 'company', company.id, {
      after: { stores: outcome.pushed },
      reason: `Pushed ${outcome.pushed} store(s) to the client's Head Office`,
    });
    res.json({ ok: true, stores: outcome.pushed });
  }),
);

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
  /** Light store rows so the client card links straight into each store. */
  stores: Array<{
    id: number;
    name: string;
    slug: string;
    environment: StoreEnvironment;
    healthState: 'healthy' | 'warning' | 'degraded' | 'offline' | 'unknown';
  }>;
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
  /** Configured terminal slots across the client's stores. */
  totalTills: number;
  /** Purchased terminal licences — the billable quantity. */
  licensedTerminalCount: number;
  /** How much of the purchased quantity is placed on stores. */
  allocatedTerminals: number;
  /** Licensees' recurring fee: null when pricing is custom (never guessed). */
  recurringAmountCents: number | null;
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  latestJobStatus: string | null;
  createdAt: string;
}

export const buildClientListItem = (company: CompanyRecord): ClientListItem => {
  const ent = entitlementsFor(company);
  const quote = quoteForSubscription(company);
  const summary = summariseSubscription(company.id);
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
    // Light store rows so the client card can link straight into each store.
    stores: companyStores.map((s) => {
      const out = storeToOut(s);
      return {
        id: out.id,
        name: out.name,
        slug: out.slug,
        environment: out.environment,
        healthState: out.healthState,
      };
    }),
    healthyStoresCount,
    totalTills,
    licensedTerminalCount: quote.licensedTerminalCount,
    allocatedTerminals: summary.allocatedTerminalCount,
    recurringAmountCents: quote.recurringAmountCents,
    setupFeeCents: quote.setupFeeCents,
    setupFeeStatus: quote.setupFeeStatus,
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
    const quote = quoteForSubscription(company);
    const sum = summariseSubscription(company.id);
    const panels = listPanelsForCompany(company.id);
    const stores = listStores().filter((s) => s.company_id === company.id);
    const jobs = listDeploymentJobsForCompany(company.id);
    const latestJob = jobs[0] || null;
    const steps = latestJob ? listStepsForJob(latestJob.id) : [];

    const panel = panels[0] || null;
    res.json({
      client: summary,
      // What the client purchased, priced, with the per-store allocation — the
      // commercial facts behind the subscription card.
      subscription: {
        planId: company.plan_id,
        pricingMode: quote.pricingMode,
        rateCents: quote.rateCents,
        billingPeriod: quote.billingPeriod,
        licensedTerminalCount: quote.licensedTerminalCount,
        allocatedTerminals: sum.allocatedTerminalCount,
        unallocatedTerminals: sum.unallocatedTerminalCount,
        recurringAmountCents: quote.recurringAmountCents,
        initialInvoiceTotalCents: quote.initialInvoiceTotalCents,
        setupFeeCents: quote.setupFeeCents,
        setupFeeStatus: quote.setupFeeStatus,
        setupFeeDueCents: quote.setupFeeDueCents,
        note: quote.note,
        allocations: sum.allocations.map((a) => {
          const store = stores.find((s) => s.id === a.storeId);
          return {
            storeId: a.storeId,
            storeName: store?.name ?? `Store #${a.storeId}`,
            storeSlug: store?.slug ?? '',
            terminalCount: store?.terminal_count ?? 0,
            licensedTerminalCount: a.licensedTerminalCount,
          };
        }),
      },
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
            licenceSequence: panel.licence_sequence,
            licencePushStatus: panel.licence_push_status,
            licencePushedAt: panel.licence_pushed_at,
          }
        : null,
      // Full SPOG shape (same as GET /api/stores) so the client's Stores tab
      // renders the shared store cards without a second fetch.
      stores: stores.map(storeToOut),
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

    // The purchased quantity: a single number for a single-store client, or a
    // per-store allocation list for a multi-store one. Validated against the
    // plan ceiling and (for allocations) the purchased total before anything is
    // written — an allocation that does not fit is refused, not silently capped.
    const requestedLicensed =
      body.licensedTerminalCount !== undefined ? Number(body.licensedTerminalCount) : undefined;
    if (requestedLicensed !== undefined && (!Number.isInteger(requestedLicensed) || requestedLicensed < 0)) {
      throw new HttpError(400, 'licensedTerminalCount must be a whole number of 0 or more');
    }
    const setupFeeStatusRaw = body.setupFeeStatus;
    if (setupFeeStatusRaw !== undefined && !SETUP_FEE_STATUSES.includes(setupFeeStatusRaw as SetupFeeStatus)) {
      throw new HttpError(400, `setupFeeStatus must be one of: ${SETUP_FEE_STATUSES.join(', ')}`);
    }
    const rawAllocations = body.allocations;
    if (rawAllocations !== undefined && !Array.isArray(rawAllocations)) {
      throw new HttpError(400, 'allocations must be an array of { storeId, licensedTerminalCount }');
    }
    const allocations = (rawAllocations as Array<Record<string, unknown>> | undefined)?.map((a) => {
      const storeId = Number(a?.storeId);
      const count = Number(a?.licensedTerminalCount);
      if (!Number.isInteger(storeId) || storeId <= 0 || !Number.isInteger(count) || count < 0) {
        throw new HttpError(
          400,
          'Each allocation needs a storeId and a licensedTerminalCount of 0 or more',
        );
      }
      const store = getStoreById(storeId);
      if (!store || store.company_id !== company.id) {
        throw new HttpError(400, `Store ${storeId} does not belong to ${company.name}`);
      }
      return { storeId, count };
    });

    const updated = updateCompany(company.id, {
      name,
      billingEmail,
      planId,
      status,
    });

    // Apply the purchased quantity and allocations. The plan may be switching in
    // the same request, so the ceiling is read from the plan that will be in force.
    const effectivePlan = getPlanById(
      (planId !== undefined ? planId : company.plan_id) ?? -1,
    );
    if (setupFeeStatusRaw !== undefined) {
      setSetupFeeStatus(company.id, setupFeeStatusRaw as SetupFeeStatus);
    }
    if (requestedLicensed !== undefined || allocations) {
      const ceiling = effectivePlan?.max_terminals_per_store ?? Number.MAX_SAFE_INTEGER;
      for (const a of allocations ?? []) {
        if (a.count > ceiling) {
          throw new HttpError(
            402,
            `${effectivePlan?.name ?? 'The plan'} allows ${ceiling} licensed terminals per store; store ${a.storeId} was set to ${a.count}.`,
            'terminal_cap_exceeded',
          );
        }
      }
      if (requestedLicensed !== undefined) {
        setLicensedTerminalCount(company.id, requestedLicensed);
      }
      if (allocations) {
        // The total may be raised implicitly when the allocation list adds up to
        // more than the stored quantity — the office just described what the
        // client bought, per store.
        const total = allocations.reduce((n, a) => n + a.count, 0);
        const nextLicensed = requestedLicensed ?? licensedTerminalCount(company.id);
        if (total > nextLicensed) {
          throw new HttpError(
            402,
            `Those allocations total ${total} terminals but the subscription is for ${nextLicensed}. Raise the licensed terminal quantity first.`,
            'terminal_allocation_exceeded',
          );
        }
        for (const a of allocations) allocateTerminals(company, a.storeId, a.count);
      }
    }

    const entitlementChanged =
      (planId !== undefined && planId !== company.plan_id) ||
      requestedLicensed !== undefined ||
      allocations !== undefined;
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

    recordAuditLog('office', 'client_updated', 'company', company.id, {
      before: { name: company.name, billingEmail: company.billing_email, planId: company.plan_id },
      after: { name, billingEmail, planId, status, licensedTerminalCount: requestedLicensed, allocations },
      reason: 'Updated client profile or subscription',
    });

    res.json({ ...buildClientListItem(getCompanyById(company.id)!), licencePush });
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

    // 2. Format stores list. `terminalCount` is what the POS is configured to
    // run; `licensedTerminalCount` is what the client buys — absent means the
    // same number, which is the wizard's default.
    const rawStores = (req.body?.stores ?? []) as Array<Record<string, unknown>>;
    const stores = rawStores.map((s, idx) => {
      const terminalCount = typeof s.terminalCount === 'number' ? s.terminalCount : 1;
      const licensedTerminalCount =
        typeof s.licensedTerminalCount === 'number' ? s.licensedTerminalCount : terminalCount;
      return {
        name:
          typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `${name} Store ${idx + 1}`,
        slug: typeof s.slug === 'string' && s.slug.trim() ? s.slug.trim() : `${slug}-${idx + 1}`,
        baseUrl:
          typeof s.baseUrl === 'string' && s.baseUrl.trim()
            ? s.baseUrl.trim()
            : `https://${slug}-${idx + 1}.vula-app.co.za`,
        terminalCount,
        licensedTerminalCount,
        adminEmail: typeof s.adminEmail === 'string' ? s.adminEmail.trim() : undefined,
      };
    });

    // If single store and no stores provided, create default store
    if (stores.length === 0) {
      stores.push({
        name,
        slug,
        baseUrl: `https://${slug}.vula-app.co.za`,
        terminalCount: 1,
        licensedTerminalCount: 1,
        adminEmail: billingEmail || undefined,
      });
    }

    // What the client purchased, recorded up front: the sum of the per-store
    // licences the wizard asked for. Every allocation below is drawn from it, and
    // the recurring fee is this quantity × the plan's rate.
    const licensedTotal = stores.reduce((n, s) => n + s.licensedTerminalCount, 0);
    if (planId !== null) {
      const chosenPlan = getPlanById(planId)!;
      const overCeiling = stores.find((s) => s.licensedTerminalCount > chosenPlan.max_terminals_per_store);
      if (overCeiling) {
        throw new HttpError(
          400,
          `${overCeiling.name} is set to ${overCeiling.licensedTerminalCount} licensed terminals, but the ${chosenPlan.name} plan allows ${chosenPlan.max_terminals_per_store} per store. Use a higher plan or fewer terminals.`,
        );
      }
      const underConfigured = stores.find((s) => s.terminalCount > s.licensedTerminalCount);
      if (underConfigured) {
        throw new HttpError(
          400,
          `${underConfigured.name} is configured for ${underConfigured.terminalCount} tills but licensed for only ${underConfigured.licensedTerminalCount}. A store may not run more tills than it is licensed for.`,
        );
      }
    }
    setLicensedTerminalCount(company.id, licensedTotal);

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
      | {
          name: string;
          slug: string;
          baseUrl: string;
          terminalCount: number;
          licensedTerminalCount: number;
          adminEmail?: string;
        }
      | undefined;
    const rawNewStore = req.body?.newStore as Record<string, unknown> | undefined;
    if (rawNewStore) {
      const terminalCount =
        typeof rawNewStore.terminalCount === 'number' ? rawNewStore.terminalCount : 1;
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
        terminalCount,
        licensedTerminalCount:
          typeof rawNewStore.licensedTerminalCount === 'number'
            ? rawNewStore.licensedTerminalCount
            : terminalCount,
        adminEmail:
          typeof rawNewStore.adminEmail === 'string' ? rawNewStore.adminEmail.trim() : undefined,
      };
    }

    // Upgrading means the client buys more licences: the existing branches keep
    // theirs (unless the operator reallocates here) and the new branch draws from
    // the same purchased total. Cape Town's database is untouched by any of this.
    const effectivePlanForTerms = requestedPlanId
      ? getPlanById(requestedPlanId)
      : company.plan_id
        ? getPlanById(company.plan_id)
        : null;
    const ceiling = effectivePlanForTerms?.max_terminals_per_store ?? Number.MAX_SAFE_INTEGER;
    const rawAllocations = req.body?.allocations;
    if (rawAllocations !== undefined && !Array.isArray(rawAllocations)) {
      throw new HttpError(400, 'allocations must be an array of { storeId, licensedTerminalCount }');
    }
    const existingStoreAllocations = (rawAllocations as Array<Record<string, unknown>> | undefined)?.map(
      (a) => {
        const storeId = Number(a?.storeId);
        const count = Number(a?.licensedTerminalCount);
        const store = Number.isInteger(storeId) ? getStoreById(storeId) : null;
        if (!store || store.company_id !== company.id || !Number.isInteger(count) || count < 0) {
          throw new HttpError(
            400,
            'Each allocation needs a storeId belonging to this client and a licensedTerminalCount of 0 or more',
          );
        }
        if (count > ceiling) {
          throw new HttpError(
            402,
            `${effectivePlanForTerms?.name ?? 'The plan'} allows ${ceiling} licensed terminals per store; ${store.name} was set to ${count}.`,
            'terminal_cap_exceeded',
          );
        }
        return { storeId, count };
      },
    );

    if (existingStoreAllocations || newStore) {
      const current = summariseSubscription(company.id);
      const defaultExisting = current.allocations.map((a) => ({
        storeId: a.storeId,
        count: a.licensedTerminalCount,
      }));
      const replaced = new Map((existingStoreAllocations ?? []).map((a) => [a.storeId, a.count]));
      const finalExisting = defaultExisting.map((a) => ({
        storeId: a.storeId,
        count: replaced.get(a.storeId) ?? a.count,
      }));
      for (const a of existingStoreAllocations ?? []) {
        if (!defaultExisting.some((d) => d.storeId === a.storeId)) {
          finalExisting.push({ storeId: a.storeId, count: a.count });
        }
      }
      const total =
        finalExisting.reduce((n, a) => n + a.count, 0) + (newStore?.licensedTerminalCount ?? 0);
      if (newStore && newStore.licensedTerminalCount > ceiling) {
        throw new HttpError(
          402,
          `${effectivePlanForTerms?.name ?? 'The plan'} allows ${ceiling} licensed terminals per store; ${newStore.name} was set to ${newStore.licensedTerminalCount}.`,
          'terminal_cap_exceeded',
        );
      }
      if (newStore && newStore.terminalCount > newStore.licensedTerminalCount) {
        throw new HttpError(
          400,
          `${newStore.name} is configured for ${newStore.terminalCount} tills but licensed for only ${newStore.licensedTerminalCount}.`,
        );
      }
      setLicensedTerminalCount(company.id, total);
      for (const a of finalExisting) {
        const store = getStoreById(a.storeId)!;
        const check = checkAllocation(company, a.storeId, a.count);
        if (!check.ok) {
          throw new HttpError(402, `${store.name}: ${check.reason}`, check.code);
        }
        allocateTerminals(company, a.storeId, a.count);
      }
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
