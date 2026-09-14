import {
  allocatedTerminalCount,
  getPlanById,
  getSubscription,
  licensedTerminalCount,
  type CompanyRecord,
  type PlanPeriod,
  type PlanPricingMode,
  type PlanRecord,
  type SetupFeeStatus,
} from '../config/registryDb.js';

/**
 * The one canonical recurring-subscription calculator (2026-09-13 model).
 *
 *   per_terminal → licensed terminals × rate per licensed terminal
 *   custom       → the plan's agreed amount, or `null` when nothing is agreed
 *
 * The quantity is the LICENSED count from the client's subscription — never the
 * configured tills, claimed devices, online terminals, open till sessions or
 * heartbeats. Device state changes minute to minute; what a client pays must not.
 *
 * A `custom` plan with no agreed amount returns `null`, never a number: the
 * control plane does not invent a figure for a negotiated deal, and an accidental
 * zero would be worse than an explicit "no automatic amount". That figure is
 * stated once on the plan (or typed on the invoice); it is never derived.
 */
export function calculateRecurringSubscriptionAmount(
  plan: PlanRecord | null,
  licensedTerminals: number,
): number | null {
  if (!plan) return null;
  if (plan.pricing_mode === 'custom') {
    return plan.custom_amount_cents > 0 ? plan.custom_amount_cents : null;
  }
  const count = Number.isInteger(licensedTerminals) && licensedTerminals > 0 ? licensedTerminals : 0;
  return count * plan.terminal_price_cents;
}

export interface SubscriptionQuote {
  /** `none` when the client has no plan at all. */
  pricingMode: PlanPricingMode | 'none';
  planCode: string;
  planName: string;
  billingPeriod: PlanPeriod | null;
  rateCents: number;
  /** A custom plan's agreed charge per billing period (0 when none is set). */
  customAmountCents: number;
  /** Purchased quantity — what the client pays for. */
  licensedTerminalCount: number;
  /** How much of the purchased quantity is placed on stores. */
  allocatedTerminalCount: number;
  unallocatedTerminalCount: number;
  /** The recurring line; null when pricing is custom or no plan is assigned. */
  recurringAmountCents: number | null;
  /** Once-off onboarding charge on the plan. */
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  /** The onboarding charge still to be raised (0 once invoiced, paid or waived). */
  setupFeeDueCents: number;
  /** Recurring + onboarding due — null when the recurring line is custom. */
  initialInvoiceTotalCents: number | null;
  /** Operator-facing sentence when the subscription needs attention; '' when healthy. */
  note: string;
}

/**
 * Everything the office (and an invoice) needs to know about what a client pays,
 * assembled from the plan and the purchased quantity.
 */
export function quoteForSubscription(
  company: CompanyRecord,
  plan: PlanRecord | null = company.plan_id ? getPlanById(company.plan_id) : null,
): SubscriptionQuote {
  const subscription = getSubscription(company.id);
  const licensed = subscription?.licensed_terminal_count ?? licensedTerminalCount(company.id);
  const allocated = allocatedTerminalCount(company.id);
  const setupFeeStatus: SetupFeeStatus = subscription?.setup_fee_status ?? 'not_invoiced';
  const recurringAmountCents = calculateRecurringSubscriptionAmount(plan, licensed);
  const setupFeeCents = plan?.setup_fee_cents ?? 0;
  const setupFeeDueCents = setupFeeStatus === 'not_invoiced' ? setupFeeCents : 0;

  const notes: string[] = [];
  if (!plan) {
    notes.push('No plan assigned — the subscription has no rate.');
  } else if (plan.pricing_mode === 'custom' && recurringAmountCents === null) {
    notes.push(
      'Custom pricing with no agreed amount — invoices are raised with the amount you agree with the client.',
    );
  } else if (licensed === 0 && plan.pricing_mode === 'per_terminal') {
    notes.push('No licensed terminals — set the quantity the client has purchased.');
  }
  if (allocated > licensed) {
    notes.push(
      `Over-allocated: ${allocated} terminals placed across stores but only ${licensed} licensed.`,
    );
  } else if (allocated < licensed) {
    notes.push(`${licensed - allocated} licensed terminal${licensed - allocated === 1 ? '' : 's'} not yet allocated to a store.`);
  }
  if (setupFeeStatus === 'not_invoiced' && setupFeeCents === 0 && plan?.pricing_mode === 'per_terminal') {
    notes.push('The plan carries no once-off onboarding charge.');
  }

  return {
    pricingMode: plan?.pricing_mode ?? 'none',
    planCode: plan?.code ?? 'unassigned',
    planName: plan?.name ?? 'Unassigned',
    billingPeriod: plan?.billing_period ?? null,
    // `rateCents` is the per-terminal rate; a custom plan's agreed amount is
    // carried as the recurring amount instead, so the UI never presents it as a
    // per-terminal figure.
    rateCents: plan?.pricing_mode === 'per_terminal' ? plan.terminal_price_cents : 0,
    customAmountCents: plan?.pricing_mode === 'custom' ? plan.custom_amount_cents : 0,
    licensedTerminalCount: licensed,
    allocatedTerminalCount: allocated,
    unallocatedTerminalCount: licensed - allocated,
    recurringAmountCents,
    setupFeeCents,
    setupFeeStatus,
    setupFeeDueCents,
    initialInvoiceTotalCents:
      recurringAmountCents === null ? null : recurringAmountCents + setupFeeDueCents,
    note: notes.join(' '),
  };
}
