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
  const count =
    Number.isInteger(licensedTerminals) && licensedTerminals > 0 ? licensedTerminals : 0;
  return count * plan.terminal_price_cents;
}

/**
 * Days in a billing period, for pro-rating a mid-period change.
 *
 * A flat convention rather than calendar months: "a month counts as 30 days, a
 * year as 365" is explainable on an invoice, and it does not change the figure
 * depending on which month the client upgraded. It is a convention, not a law —
 * change it here and every pro-rata figure follows.
 */
export const PERIOD_DAYS: Record<PlanPeriod, number> = {
  monthly: 30,
  annual: 365,
  'once-off': 0,
};

export interface ProRataInput {
  pricingMode: PlanPricingMode | 'none';
  /** The agreed per-terminal rate (from the subscription snapshot, not the plan). */
  rateCents: number;
  /** What the client is licensed for now. */
  licensedTerminalCount: number;
  /** What they have actually been invoiced and paid for this period. */
  paidTerminalCount: number | null;
  /** When the period they have paid for ends. */
  paidThrough: string | null;
  billingPeriod: PlanPeriod | null;
  today?: Date;
}

export interface ProRataCharge {
  /** Extra terminals bought mid-period. */
  extraTerminals: number;
  /** What the client receives if they settle it: the extra terminals for the rest. */
  amountCents: number;
  daysRemaining: number;
  periodDays: number;
  /** The window the charge covers, for the invoice line. */
  from: string;
  to: string;
}

/**
 * What a mid-period increase is worth — the extra terminals, for the days left in
 * a period the client has already paid for.
 *
 * Returns `null` when there is nothing to charge: not a per-terminal deal, no
 * increase, no paid period to pro-rate against, or a period that has already
 * lapsed. Reductions are deliberately not credited here — a smaller quantity
 * takes effect from the next period.
 */
export const proRataForIncrease = (input: ProRataInput): ProRataCharge | null => {
  if (input.pricingMode !== 'per_terminal' || input.rateCents <= 0) return null;
  if (input.paidTerminalCount === null) return null;
  const extra = input.licensedTerminalCount - input.paidTerminalCount;
  if (extra <= 0) return null;
  if (!input.paidThrough || !input.billingPeriod || input.billingPeriod === 'once-off') return null;

  const periodDays = PERIOD_DAYS[input.billingPeriod];
  if (periodDays <= 0) return null;

  const today = input.today ?? new Date();
  const startOfDay = (d: Date): Date =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const end = new Date(`${input.paidThrough}T00:00:00.000Z`);
  const daysRemaining = Math.floor(
    (end.getTime() - startOfDay(today).getTime()) / (24 * 60 * 60 * 1000),
  );
  // A period that has ended (or ends today) has nothing left to charge for. A
  // period with its whole length still to run DOES: the client has paid for this
  // period already, and the extra terminals are not covered by it — the next
  // invoice is for the *next* period, not this one.
  if (daysRemaining <= 0) return null;

  return {
    extraTerminals: extra,
    amountCents: Math.round((extra * input.rateCents * daysRemaining) / periodDays),
    daysRemaining,
    periodDays,
    from: startOfDay(today).toISOString().slice(0, 10),
    to: input.paidThrough,
  };
};

export interface SubscriptionQuote {
  /** `none` when the client has no plan at all. */
  pricingMode: PlanPricingMode | 'none';
  /** Where the price came from: the client's agreement, or the plan in force. */
  pricingSource: 'agreed' | 'plan' | 'none';
  /** When the office last recorded the price (null when never). */
  pricedAt: string | null;
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

  // The price the client AGREED to, when one is on record. Everything below reads
  // the agreement first and the plan only as a fallback — so a plan edit re-prices
  // nobody (grandfathering), while caps and features keep tracking the plan.
  const agreed = subscription?.priced_at
    ? {
        pricingMode: subscription.pricing_mode ?? 'per_terminal',
        rateCents: subscription.rate_cents ?? 0,
        customAmountCents: subscription.custom_amount_cents ?? 0,
        setupFeeCents: subscription.setup_fee_cents ?? 0,
        billingPeriod: subscription.billing_period ?? null,
      }
    : null;
  const pricingMode: PlanPricingMode | 'none' = agreed
    ? agreed.pricingMode
    : (plan?.pricing_mode ?? 'none');
  const rateCents = agreed
    ? agreed.rateCents
    : plan?.pricing_mode === 'per_terminal'
      ? plan.terminal_price_cents
      : 0;
  const customAmountCents = agreed
    ? agreed.customAmountCents
    : plan?.pricing_mode === 'custom'
      ? plan.custom_amount_cents
      : 0;
  const recurringAmountCents =
    pricingMode === 'none'
      ? null
      : pricingMode === 'custom'
        ? customAmountCents > 0
          ? customAmountCents
          : null
        : licensed * rateCents;
  const setupFeeCents = agreed ? agreed.setupFeeCents : (plan?.setup_fee_cents ?? 0);
  const setupFeeDueCents = setupFeeStatus === 'not_invoiced' ? setupFeeCents : 0;

  const notes: string[] = [];
  if (!agreed && plan) {
    notes.push(
      'Priced from the plan — no agreed price recorded for this client yet, so an edit to the plan would change what they pay. Set the agreed price on the subscription.',
    );
  }
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
    notes.push(
      `${licensed - allocated} licensed terminal${licensed - allocated === 1 ? '' : 's'} not yet allocated to a store.`,
    );
  }
  if (
    setupFeeStatus === 'not_invoiced' &&
    setupFeeCents === 0 &&
    plan?.pricing_mode === 'per_terminal'
  ) {
    notes.push('The plan carries no once-off onboarding charge.');
  }

  return {
    pricingMode,
    pricingSource: agreed ? 'agreed' : plan ? 'plan' : 'none',
    pricedAt: subscription?.priced_at ?? null,
    planCode: plan?.code ?? 'unassigned',
    planName: plan?.name ?? 'Unassigned',
    billingPeriod: agreed?.billingPeriod ?? plan?.billing_period ?? null,
    // `rateCents` is the per-terminal rate; a custom deal's agreed amount is
    // carried as the recurring amount instead, so the UI never presents it as a
    // per-terminal figure.
    rateCents: pricingMode === 'per_terminal' ? rateCents : 0,
    customAmountCents: pricingMode === 'custom' ? customAmountCents : 0,
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
