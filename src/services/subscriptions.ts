import { env } from '../config/env.js';
import {
  getCompanyById,
  getPlanById,
  planFeatures,
  countStoresForCompany,
  type CompanyRecord,
  type PlanRecord,
} from '../config/registryDb.js';

/**
 * Subscription state and entitlement resolution.
 *
 * Billing state is DERIVED from `paid_through` rather than stored, so nothing has
 * to run on a schedule: an unpaid subscription becomes overdue by the passage of
 * time alone. A manual `suspended` status on the company stays a separate operator
 * override, because cutting a customer off and a customer being late are different
 * events.
 */
export type BillingState = 'active' | 'past_due' | 'suspended' | 'trial' | 'unlicensed';

export interface Entitlements {
  companyId: number | null;
  companyName: string;
  planCode: string;
  planName: string;
  features: string[];
  maxStores: number;
  maxTerminalsPerStore: number;
  paidThrough: string | null;
  billingState: BillingState;
  /** Stores used vs allowed, for cap messaging. */
  storesUsed: number;
  /** Human sentence for the operator when something is over cap or overdue; '' when healthy. */
  note: string;
}

/** What a store with no company/plan gets: it still trades, but unentitled. */
export const UNASSIGNED: Entitlements = {
  companyId: null,
  companyName: '',
  planCode: 'unassigned',
  planName: 'Unassigned',
  features: [],
  maxStores: 1,
  maxTerminalsPerStore: 1,
  paidThrough: null,
  billingState: 'unlicensed',
  storesUsed: 0,
  note: 'No company or plan assigned — assign one so this store receives its entitlements.',
};

const dayString = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Billing state from the paid-through date plus the configured grace window.
 * Order matters: a manual suspension outranks an overdue date, and a trial
 * outranks both while it is still running.
 */
export function deriveBillingState(company: CompanyRecord, now: Date = new Date()): BillingState {
  if (company.status === 'suspended') return 'suspended';

  if (company.trial_ends_at) {
    const trialEnd = new Date(`${company.trial_ends_at}T23:59:59.000Z`);
    if (now.getTime() <= trialEnd.getTime() && !company.paid_through) return 'trial';
  }

  if (!company.paid_through) return 'active';

  const paid = new Date(`${company.paid_through}T23:59:59.000Z`);
  if (now.getTime() <= paid.getTime()) return 'active';

  const graceEnd = new Date(paid.getTime());
  graceEnd.setUTCDate(graceEnd.getUTCDate() + env.licenceGraceDays);
  return now.getTime() <= graceEnd.getTime() ? 'past_due' : 'suspended';
}

/** Resolve a company's plan into a full entitlement set. */
export function entitlementsFor(
  company: CompanyRecord | null,
  now: Date = new Date(),
): Entitlements {
  if (!company) return { ...UNASSIGNED };

  const plan: PlanRecord | null = company.plan_id ? getPlanById(company.plan_id) : null;
  const billingState = deriveBillingState(company, now);
  const storesUsed = countStoresForCompany(company.id);

  const notes: string[] = [];
  if (billingState === 'past_due') {
    notes.push(
      `Subscription is past due (paid to ${company.paid_through}) — inside the ${env.licenceGraceDays}-day grace window.`,
    );
  } else if (billingState === 'suspended') {
    notes.push(
      `Subscription lapsed on ${company.paid_through ?? 'an unpaid invoice'} and grace has ended — new sales are refused on this company's stores.`,
    );
  } else if (billingState === 'trial') {
    notes.push(`Trial ends ${company.trial_ends_at}.`);
  }
  if (!plan) {
    notes.push('No plan assigned — the store falls back to the Starter caps.');
  } else if (storesUsed > plan.max_stores) {
    notes.push(
      `Over the plan limit: ${storesUsed} stores on a ${plan.max_stores}-store plan. Upgrade to add more.`,
    );
  }

  return {
    companyId: company.id,
    companyName: company.name,
    planCode: plan?.code ?? 'unassigned',
    planName: plan?.name ?? 'Unassigned',
    features: planFeatures(plan),
    maxStores: plan?.max_stores ?? 1,
    maxTerminalsPerStore: plan?.max_terminals_per_store ?? 1,
    paidThrough: company.paid_through,
    billingState,
    storesUsed,
    note: notes.join(' '),
  };
}

export interface CapCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Cap checks run at the point of action, so an over-cap attempt fails loudly with
 * an upgrade prompt rather than quietly succeeding and being billed later.
 */
export function canAddStore(company: CompanyRecord | null): CapCheck {
  if (!company) return { ok: true }; // unassigned stores are not cap-policed
  const plan = company.plan_id ? getPlanById(company.plan_id) : null;
  const max = plan?.max_stores ?? 1;
  const used = countStoresForCompany(company.id);
  if (used >= max) {
    return {
      ok: false,
      reason: `${company.name} already has ${used} of ${max} stores on the ${plan?.name ?? 'assigned'} plan. Upgrade the plan to add another store.`,
    };
  }
  return { ok: true };
}

export function canUseTerminals(company: CompanyRecord | null, terminalCount: number): CapCheck {
  if (!company) return { ok: true };
  const plan = company.plan_id ? getPlanById(company.plan_id) : null;
  const max = plan?.max_terminals_per_store ?? 1;
  if (terminalCount > max) {
    return {
      ok: false,
      reason: `${company.name}'s ${plan?.name ?? 'assigned'} plan allows ${max} terminals per store; ${terminalCount} requested. Upgrade the plan to add tills.`,
    };
  }
  return { ok: true };
}

/** Today, as the CP measures it — used by tests and cap messages. */
export const today = (): string => dayString(new Date());

// --- L4 enforcement -----------------------------------------------------------

/**
 * How the register will present the subscription, derived from the same inputs
 * the licence carries. The CP surfaces it so the office sees which stores will
 * warn or refuse sales without having to decode billing states; the register
 * derives the same states from its licence (za-pos `licence.ts` mirrors the
 * windows — keep the two sides in step).
 *
 *  - `ok`         — paid up with more than the warn window to run
 *  - `warn`       — paid up, but the subscription ends within REGISTER_WARN_DAYS
 *  - `grace`      — past paid_through, inside the grace window; trading continues
 *  - `suspended`  — grace over (or manually suspended); the register refuses new sales
 *  - `trial` / `unlicensed` — passed through from the billing state
 */
export type RegisterState = 'ok' | 'warn' | 'grace' | 'suspended' | 'trial' | 'unlicensed';

/** Warn the register (and the office) this many days before paid_through ends. */
export const REGISTER_WARN_DAYS = 7;

export interface RegisterEnforcement {
  registerState: RegisterState;
  /** True when the store's register refuses new sales (never for reads/returns/cash-ups). */
  tradingBlocked: boolean;
}

export const registerEnforcementFor = (
  ent: Entitlements,
  now: Date = new Date(),
): RegisterEnforcement => {
  switch (ent.billingState) {
    case 'suspended':
      return { registerState: 'suspended', tradingBlocked: true };
    case 'past_due':
      return { registerState: 'grace', tradingBlocked: false };
    case 'trial':
      return { registerState: 'trial', tradingBlocked: false };
    case 'unlicensed':
      return { registerState: 'unlicensed', tradingBlocked: false };
    case 'active': {
      if (ent.paidThrough) {
        const paid = new Date(`${ent.paidThrough}T23:59:59.000Z`);
        paid.setUTCDate(paid.getUTCDate() - REGISTER_WARN_DAYS);
        if (now.getTime() >= paid.getTime())
          return { registerState: 'warn', tradingBlocked: false };
      }
      return { registerState: 'ok', tradingBlocked: false };
    }
  }
};

/**
 * Feature gate for the control plane's own capability grants. The plan feature
 * set is written into every licence; this is the CP-side half of the same
 * contract — where the CP itself grants a capability (multi-store
 * orchestration today), a plan without the feature is refused with the same
 * 402 shape the applications use. Pass the plan that will be in force when the
 * capability lands: the company's current plan, or the one an action upgrades to.
 */
export function requireFeature(plan: PlanRecord | null, key: string): CapCheck {
  const features = planFeatures(plan);
  if (!features.includes(key)) {
    return {
      ok: false,
      reason: `The ${plan?.name ?? 'assigned'} plan does not include "${key}". Upgrade the plan to use it.`,
    };
  }
  return { ok: true };
}
