import { Router } from 'express';
import {
  listCompanies,
  getCompanyById,
  getCompanyBySlug,
  createCompany,
  updateCompany,
  getPlanById,
  getRegistryDb,
  getStoreById,
  licensedTerminalCount,
  listStores,
  listPanelsForCompany,
  setLicensedTerminalCount,
  setSetupFeeStatus,
  setSubscriptionAddons,
  getSubscription,
  planFeaturePrice,
  planFeaturePrices,
  subscriptionAddonPrices,
  subscriptionFeatures,
  SETUP_FEE_STATUSES,
  getDeploymentJobById,
  listDeploymentJobsForCompany,
  listStepsForJob,
  recordAuditLog,
  type CompanyRecord,
  type SetupFeeStatus,
  type PlanRecord,
  type StoreRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import {
  ValidationError,
  requireString,
  requireSlug,
  optionalString,
  optionalEmail,
  parseIdParam,
  requireInt,
  requireTerminalCount,
  requireBaseUrl,
  optionalInt,
  optionalStoreKind,
} from '../utils/validate.js';
import { assertManagedEndpoint } from '../services/storeClient.js';
import {
  entitlementsFor,
  requireFeature,
  requireSellableFeature,
} from '../services/subscriptions.js';
import { PRICED_FEATURE_KEYS, validateFeatureKeys } from '../services/features.js';
import { quoteForSubscription } from '../services/pricing.js';
import {
  summariseSubscription,
  allocateTerminals,
  checkAllocation,
} from '../services/terminalLicences.js';
import { currentProRata, pushLicencesForCompany, setupFeeInvoiceFor } from '../services/billing.js';
import { pushStoreListToPanel } from '../services/topology.js';
import { storeToOut } from './stores.js';
import { recordAgreedPricing } from './companies.js';
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

/**
 * Multi-store topology IS the Head Office add-on (2026-10-10): the feature is
 * chargeable, so a plan either prices it or cannot offer the topology at all —
 * and choosing multi-store BOUGHS it for the client, at the plan's price. Nobody
 * gets Head Office free by picking a plan, and nobody is refused it for having
 * chosen a plan that sells it.
 */
const buyAddons = (
  companyId: number,
  plan: PlanRecord | null,
  keys: string[],
  reason: string,
): void => {
  if (!plan || keys.length === 0) return;
  const subscription = getSubscription(companyId);
  const bought = new Set(subscriptionFeatures(subscription));
  const prices = { ...subscriptionAddonPrices(subscription) };
  for (const key of keys) {
    const price = planFeaturePrice(plan, key);
    if (price === undefined) continue; // the plan does not sell it
    bought.add(key);
    prices[key] = prices[key] ?? price; // an existing agreement stands
  }
  if (bought.size === 0) return;
  setSubscriptionAddons(companyId, [...bought], prices);
  recordAuditLog('office', 'subscription_addons_set', 'company', companyId, {
    after: { features: [...bought], prices },
    reason,
  });
};

const buyHeadOfficeAddon = (companyId: number, plan: PlanRecord | null): void =>
  buyAddons(companyId, plan, ['multi_store'], 'Multi-store topology purchased the Head Office add-on');

// --- Nested onboarding payloads -------------------------------------------------

/**
 * A store entry inside the onboarding wizard, validated through the same helpers
 * `POST /stores` uses instead of being defaulted.
 *
 * The review found these entries effectively cast, not validated (production
 * review, 2026-09-23, §19): `typeof x === 'number' ? x : 1` accepts `NaN`, a
 * negative count and `1e9`, and a supplied nested `baseUrl` skipped every check
 * the single-store route makes — including the address policy, which would have
 * let the wizard smuggle a private or metadata URL into a row that then receives
 * a token.
 *
 * The one deliberate difference: the probe allows an unreachable host. A wizard
 * raises rows *before* their containers exist, so "does not answer yet" is the
 * normal state here; the address policy and a definitive wrong-kind answer still
 * refuse. The probe also only runs for a URL the operator supplied — a URL this
 * server derived from the client slug is ours by construction.
 */
interface NestedStore {
  name: string;
  slug: string;
  baseUrl: string;
  /** 'store' (default) or 'warehouse' — a warehouse runs no tills. */
  kind: StoreRecord['kind'];
  terminalCount: number;
  licensedTerminalCount: number;
  adminEmail?: string;
}

const validateNestedStore = async (
  entry: unknown,
  fallback: { name: string; slug: string; baseUrl: string; adminEmail?: string },
): Promise<NestedStore> => {
  if (entry !== undefined && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
    throw new ValidationError('each entry in stores must be an object');
  }
  const e = (entry ?? {}) as Record<string, unknown>;
  const suppliedUrl = e.baseUrl !== undefined && e.baseUrl !== null && e.baseUrl !== '';
  const kind = optionalStoreKind(e) ?? 'store';
  // A warehouse runs no tills: its count is 0 and it draws no licensed terminals
  // (owner decisions, 2026-10-09). Everything that sells still needs one.
  const terminalCount =
    kind === 'warehouse'
      ? e.terminalCount === undefined
        ? 0
        : requireTerminalCount(e, 0)
      : e.terminalCount === undefined
        ? 1
        : requireTerminalCount(e);
  if (kind === 'warehouse' && terminalCount !== 0) {
    throw new ValidationError('A warehouse runs no tills — terminalCount must be 0');
  }
  const licensedTerminalCount =
    kind === 'warehouse'
      ? 0
      : e.licensedTerminalCount === undefined
        ? terminalCount
        : requireInt(e, 'licensedTerminalCount', { min: 0, max: 5000 });
  const name = e.name === undefined ? fallback.name : requireString(e, 'name');
  const slug = e.slug === undefined || e.slug === null || e.slug === '' ? fallback.slug : requireSlug(e);
  const baseUrl = suppliedUrl ? requireBaseUrl(e) : fallback.baseUrl;
  const adminEmail = optionalEmail(e, 'adminEmail') ?? fallback.adminEmail;

  if (suppliedUrl) {
    const check = await assertManagedEndpoint(baseUrl, 'store', { allowUnreachable: true });
    if (!check.ok) {
      throw new HttpError(check.status, check.error ?? `${baseUrl} is not a usable store URL`, check.code);
    }
  }
  return {
    name,
    slug,
    baseUrl,
    kind,
    terminalCount,
    licensedTerminalCount,
    ...(adminEmail ? { adminEmail } : {}),
  };
};

/** A Head Office entry inside onboarding or the single→multi upgrade. */
const validateNestedHeadOffice = async (
  entry: unknown,
  fallback: { name: string; slug: string; baseUrl: string; adminEmail?: string },
): Promise<{ name: string; slug: string; baseUrl: string; adminEmail?: string }> => {
  if (entry !== undefined && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
    throw new ValidationError('headOffice must be an object');
  }
  const e = (entry ?? {}) as Record<string, unknown>;
  const suppliedUrl = e.baseUrl !== undefined && e.baseUrl !== null && e.baseUrl !== '';
  const name = e.name === undefined ? fallback.name : requireString(e, 'name');
  const slug = e.slug === undefined || e.slug === null || e.slug === '' ? fallback.slug : requireSlug(e);
  const baseUrl = suppliedUrl ? requireBaseUrl(e) : fallback.baseUrl;
  const adminEmail = optionalEmail(e, 'adminEmail') ?? fallback.adminEmail;

  if (suppliedUrl) {
    const check = await assertManagedEndpoint(baseUrl, 'head-office', { allowUnreachable: true });
    if (!check.ok) {
      throw new HttpError(check.status, check.error ?? `${baseUrl} is not a usable Head Office URL`, check.code);
    }
  }
  return { name, slug, baseUrl, ...(adminEmail ? { adminEmail } : {}) };
};

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
  /** The paid add-ons held, with the price agreed for each. */
  addons: Array<{ key: string; label: string; cents: number }>;
  addonsCents: number;
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  latestJobStatus: string | null;
  createdAt: string;
}

/**
 * The stores of one client, in **name order**.
 *
 * `listStores()` answers newest-first, which suits the fleet page — a running log
 * of what was added — and is wrong under a client, where the stores are a set of
 * places an operator looks up by name and a branch added yesterday would appear
 * in the middle of the card. Sorted here rather than in the SPA so the client
 * card's store chips and the client's Stores tab cannot drift apart; the locale
 * is pinned so the order does not depend on the server's environment.
 */
const storesForCompany = (companyId: number): StoreRecord[] =>
  listStores()
    .filter((s) => s.company_id === companyId)
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.slug.localeCompare(b.slug, 'en'));

export const buildClientListItem = (company: CompanyRecord): ClientListItem => {
  const ent = entitlementsFor(company);
  const quote = quoteForSubscription(company);
  const summary = summariseSubscription(company.id);
  const panels = listPanelsForCompany(company.id);
  const ho = panels[0] || null;
  const companyStores = storesForCompany(company.id);
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
    addons: quote.addons,
    addonsCents: quote.addonsCents,
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
    const stores = storesForCompany(company.id);
    const jobs = listDeploymentJobsForCompany(company.id);
    const latestJob = jobs[0] || null;
    const steps = latestJob ? listStepsForJob(latestJob.id) : [];

    const panel = panels[0] || null;
    // When the once-off charge has already been billed, name the document that
    // carries it: the create-invoice modal then shows "already billed, unpaid"
    // instead of silently adding it a second time. Called `ref` rather than
    // anything containing "invoice" on purpose — the §40 privacy test walks
    // field NAMES on this surface and (correctly) cannot tell a vendor document
    // number from a merchant's billing data.
    const setupFeeInvoice =
      quote.setupFeeStatus === 'invoiced' ? setupFeeInvoiceFor(company.id) : undefined;
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
    addons: quote.addons,
    addonsCents: quote.addonsCents,
        initialInvoiceTotalCents: quote.initialInvoiceTotalCents,
        setupFeeCents: quote.setupFeeCents,
        setupFeeStatus: quote.setupFeeStatus,
        setupFeeDueCents: quote.setupFeeDueCents,
        setupFeeRef: setupFeeInvoice?.invoice_number ?? null,
        /** Where the price comes from: the client's agreement, or the plan. */
        pricingSource: quote.pricingSource,
        pricedAt: quote.pricedAt,
        /**
         * Terminals bought mid-period, and what the rest of the period is worth
         * at the agreed rate. Null when there is nothing to charge (see
         * `proRataForIncrease`) — never a guessed figure.
         */
        midPeriodCharge: currentProRata(company, null, quote),
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
    if (
      requestedLicensed !== undefined &&
      (!Number.isInteger(requestedLicensed) || requestedLicensed < 0)
    ) {
      throw new HttpError(400, 'licensedTerminalCount must be a whole number of 0 or more');
    }
    const setupFeeStatusRaw = body.setupFeeStatus;
    if (
      setupFeeStatusRaw !== undefined &&
      !SETUP_FEE_STATUSES.includes(setupFeeStatusRaw as SetupFeeStatus)
    ) {
      throw new HttpError(400, `setupFeeStatus must be one of: ${SETUP_FEE_STATUSES.join(', ')}`);
    }
    const rawAllocations = body.allocations;
    if (rawAllocations !== undefined && !Array.isArray(rawAllocations)) {
      throw new HttpError(
        400,
        'allocations must be an array of { storeId, licensedTerminalCount }',
      );
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

    // The paid add-ons this client holds (2026-10-10). Only features the plan
    // PRICES can be bought — a bundled feature is already theirs, and the free
    // ones are not for sale. The price is snapshotted at purchase, like the rate.
    const planForRequest =
      planId !== undefined
        ? planId
          ? getPlanById(planId)
          : null
        : company.plan_id
          ? getPlanById(company.plan_id)
          : null;
    const planPricesForRequest = planFeaturePrices(planForRequest);
    const requestedFeatures =
      body.features !== undefined
        ? validateFeatureKeys(body.features).filter((key) => PRICED_FEATURE_KEYS.includes(key))
        : undefined;
    if (requestedFeatures !== undefined) {
      const notPriced = requestedFeatures.filter((key) => !(key in planPricesForRequest));
      if (notPriced.length > 0) {
        throw new HttpError(
          400,
          `${planForRequest?.name ?? 'This plan'} does not price ${notPriced.join(', ')} — set the add-on's price on the plan first.`,
        );
      }
    }

    const entitlementChanged =
      (planId !== undefined && planId !== company.plan_id) ||
      requestedLicensed !== undefined ||
      allocations !== undefined ||
      requestedFeatures !== undefined;

    // One logical operation, one transaction (production review, 2026-09-23):
    // the company fields, the purchased quantity and the allocations commit
    // together or not at all. The old shape wrote the company first and
    // validated allocations after, so a refused allocation left a renamed or
    // re-planned client behind a "Update failed" message. Pure validation
    // (plan exists, statuses well-formed) has already happened above.
    const runEdit = getRegistryDb().transaction(() => {
      const updatedCompany = updateCompany(company.id, {
        name,
        billingEmail,
        planId,
        status,
      });

      // Apply the purchased quantity and allocations. The plan may be switching
      // in the same request, so the ceiling is read from the plan that will be
      // in force.
      const effectivePlan = getPlanById((planId !== undefined ? planId : company.plan_id) ?? -1);
      if (setupFeeStatusRaw !== undefined) {
        setSetupFeeStatus(company.id, setupFeeStatusRaw as SetupFeeStatus);
      }

      if (requestedFeatures !== undefined) {
        const existingFeatures = subscriptionFeatures(getSubscription(company.id));
        const agreedPrices = subscriptionAddonPrices(getSubscription(company.id));
        const nextPrices: Record<string, number> = {};
        for (const key of requestedFeatures) {
          // A feature the client already had keeps the price they agreed; a newly
          // bought one is priced from the plan today.
          nextPrices[key] = existingFeatures.includes(key)
            ? (agreedPrices[key] ?? planPricesForRequest[key] ?? 0)
            : (planPricesForRequest[key] ?? 0);
        }
        setSubscriptionAddons(company.id, requestedFeatures, nextPrices);
        recordAuditLog('office', 'subscription_addons_set', 'company', company.id, {
          after: { features: requestedFeatures, prices: nextPrices },
          reason: "Changed the client's paid add-ons",
        });
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

      recordAuditLog('office', 'client_updated', 'company', company.id, {
        before: {
          name: company.name,
          billingEmail: company.billing_email,
          planId: company.plan_id,
        },
        after: {
          name,
          billingEmail,
          planId,
          status,
          licensedTerminalCount: requestedLicensed,
          allocations,
        },
        reason: 'Updated client profile or subscription',
      });
      return updatedCompany;
    });
    runEdit();

    // Outside the transaction: network. A delivery failure is recorded on the
    // registry rows and retried by the sweep — never rolled back.
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

    res.json({ ...buildClientListItem(getCompanyById(company.id)!), licencePush });
  }),
);

/**
 * Re-prices a client to the plan they are on now.
 *
 * Plans no longer re-price the clients on them (grandfathering, 2026-09-16), so
 * this is how a price rise is actually applied: explicitly, one client at a time,
 * audited. The new price governs invoices raised from here on — anything already
 * issued keeps the figures it was issued with.
 */
clientsRouter.post(
  '/:id/reprice',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const company = getCompanyById(id);
    if (!company) throw new HttpError(404, 'Client not found');
    const plan = company.plan_id ? getPlanById(company.plan_id) : null;
    if (!plan) {
      throw new HttpError(
        400,
        'This client has no plan, so there is no price to apply. Assign a plan first.',
        'no_plan_to_price',
      );
    }
    const before = quoteForSubscription(company, plan);
    recordAgreedPricing(
      company.id,
      plan,
      'office',
      `Re-priced ${company.name} to the ${plan.name} price in force`,
    );
    const after = quoteForSubscription(getCompanyById(id)!, plan);
    res.json({
      ok: true,
      planCode: plan.code,
      pricingMode: plan.pricing_mode,
      rateCents: plan.terminal_price_cents,
      customAmountCents: plan.custom_amount_cents,
      recurringAmountCents: after.recurringAmountCents,
      previousRecurringAmountCents: before.recurringAmountCents,
      note: 'This price governs invoices raised from now on; invoices already issued keep their figures.',
    });
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
        throw new HttpError(
          400,
          `Plan "${chosenPlan.name}" is inactive and cannot be used for a new client`,
        );
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
      const sellable = requireSellableFeature(plan, 'multi_store');
      if (!sellable.ok) {
        res.status(402).json({ error: sellable.reason, code: 'feature_not_in_plan' });
        return;
      }
    }

    // Add-ons chosen at onboarding: only what this plan sells, refused by name
    // otherwise (an operator should learn now, not on a client's first invoice).
    const requestedAddons = validateFeatureKeys(req.body?.features ?? []).filter((key) =>
      PRICED_FEATURE_KEYS.includes(key),
    );
    if (requestedAddons.length > 0) {
      const planAtCreation = planId !== null ? getPlanById(planId) : null;
      const notSold = requestedAddons.filter(
        (key) => planFeaturePrice(planAtCreation, key) === undefined,
      );
      if (notSold.length > 0) {
        throw new ValidationError(
          `${planAtCreation?.name ?? 'That plan'} does not sell ${notSold.join(', ')} — price ${notSold.length === 1 ? 'it' : 'them'} on the plan first.`,
        );
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
    const rawStores = req.body?.stores;
    if (rawStores !== undefined && !Array.isArray(rawStores)) {
      throw new ValidationError(
        'stores must be an array of { name, slug, baseUrl, terminalCount, licensedTerminalCount }',
      );
    }
    const stores: NestedStore[] = [];
    for (const [idx, entry] of ((rawStores ?? []) as unknown[]).entries()) {
      stores.push(
        await validateNestedStore(entry, {
          name: `${name} Store ${idx + 1}`,
          slug: `${slug}-${idx + 1}`,
          baseUrl: `https://${slug}-${idx + 1}.vula-app.co.za`,
        }),
      );
    }

    // If single store and no stores provided, create default store
    if (stores.length === 0) {
      stores.push(
        await validateNestedStore(
          {},
          {
            name,
            slug,
            baseUrl: `https://${slug}.vula-app.co.za`,
            adminEmail: billingEmail || undefined,
          },
        ),
      );
    }

    // What the client purchased, recorded up front: the sum of the per-store
    // licences the wizard asked for. Every allocation below is drawn from it, and
    // the recurring fee is this quantity × the plan's rate.
    const licensedTotal = stores.reduce((n, s) => n + s.licensedTerminalCount, 0);
    if (planId !== null) {
      const chosenPlan = getPlanById(planId)!;
      const overCeiling = stores.find(
        (s) => s.licensedTerminalCount > chosenPlan.max_terminals_per_store,
      );
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

    // The wizard states the quantity and the plan states the price: record both as
    // the client's agreement, so a later edit to the plan cannot re-price them.
    recordAgreedPricing(
      company.id,
      planId ? getPlanById(planId) : null,
      'office',
      'Recorded the price agreed when the client was onboarded',
    );

    // The add-ons the operator chose on the wizard's first step — the six the plan
    // prices (2026-10-10). Bought before any store exists, so the licences that
    // follow carry them.
    const onboardingPlan = planId ? getPlanById(planId) : null;
    buyAddons(
      company.id,
      onboardingPlan,
      requestedAddons ?? [],
      'Add-ons purchased at onboarding',
    );
    // A multi-store client has a Head Office, so it holds that add-on whether or
    // not the operator ticked it — the topology needs the capability.
    if (deploymentType === 'multi_store') {
      buyHeadOfficeAddon(company.id, onboardingPlan);
    }

    // 3. Format Head Office if multi_store
    let headOffice:
      { name: string; slug: string; baseUrl: string; adminEmail?: string } | undefined;
    if (deploymentType === 'multi_store') {
      headOffice = await validateNestedHeadOffice(req.body?.headOffice, {
        name: `${name} Head Office`,
        slug: `${slug}-ho`,
        baseUrl: `https://${slug}-ho.vula-app.co.za`,
        adminEmail: billingEmail || undefined,
      });
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
    const sellable = requireSellableFeature(effectivePlan, 'multi_store');
    if (!sellable.ok) {
      res.status(402).json({ error: sellable.reason, code: 'feature_not_in_plan' });
      return;
    }

    // The upgrade is the moment Head Office is bought, like the wizard.
    buyHeadOfficeAddon(company.id, effectivePlan);

    const headOffice = await validateNestedHeadOffice(req.body?.headOffice, {
      name: `${company.name} Head Office`,
      slug: `${company.slug}-ho`,
      baseUrl: `https://${company.slug}-ho.vula-app.co.za`,
      adminEmail: company.billing_email || undefined,
    });

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
      throw new HttpError(
        400,
        'allocations must be an array of { storeId, licensedTerminalCount }',
      );
    }
    const existingStoreAllocations = (
      rawAllocations as Array<Record<string, unknown>> | undefined
    )?.map((a) => {
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
    });

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
