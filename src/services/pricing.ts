import {
  allocatedTerminalCount,
  countStoresForCompany,
  getPlanById,
  getSubscription,
  licensedTerminalCount,
  planFeaturePrices,
  planFeatures,
  subscriptionAddonPrices,
  subscriptionFeatures,
  type CompanyRecord,
  type CompanySubscriptionRecord,
  type PlanPeriod,
  type PlanPricingMode,
  type PlanRecord,
  type SetupFeeStatus,
} from '../config/registryDb.js';
import { FEATURE_LABELS, PER_COMPANY_FEATURE_KEYS } from './features.js';

/**
 * The once-off onboarding charge a client owes: THEIR agreed figure when one is
 * on record, the plan's only as a fallback.
 *
 * The plan carries a default (R1 500, the site's self-setup price); the client's
 * row is where an assisted setup's R5 000 lives, so the two variants of one offer
 * coexist on a single plan. NULL — never agreed — is the only case that reads the
 * plan, which is how every row that predates this field keeps behaving.
 */
export const agreedSetupFeeCents = (
  plan: PlanRecord | null,
  subscription: CompanySubscriptionRecord | null | undefined,
): number =>
  subscription?.setup_fee_cents !== null && subscription?.setup_fee_cents !== undefined
    ? subscription.setup_fee_cents
    : (plan?.setup_fee_cents ?? 0);

/**
 * A client's price terms in one shape, whoever they came from — their recorded
 * agreement or the plan currently in force.
 */
export interface RecurringTerms {
  pricingMode: PlanPricingMode;
  /** `per_store` only: the rate per trading store, its first till included. */
  storeRateCents: number;
  /** `per_terminal`: the rate per licensed till. `per_store`: the rate per
   *  ADDITIONAL till (everything past each store's included first one). */
  terminalRateCents: number;
  /** `custom`: the agreed charge per period (0 = nothing agreed yet). */
  customAmountCents: number;
}

export const termsFromPlan = (plan: PlanRecord | null): RecurringTerms | null =>
  plan
    ? {
        pricingMode: plan.pricing_mode,
        storeRateCents: plan.store_price_cents,
        terminalRateCents: plan.terminal_price_cents,
        customAmountCents: plan.custom_amount_cents,
      }
    : null;

const wholeCount = (n: number): number => (Number.isInteger(n) && n > 0 ? n : 0);

/**
 * How many times a paid add-on is charged: once per TRADING STORE (owner,
 * 2026-10-14: "the addons must be charge per store, no? so if three stores -
 * laybuy must be charged per store") — except the per-COMPANY ones
 * (`PER_COMPANY_FEATURE_KEYS`): Head Office (one panel), AI Copilot (one
 * executive copilot, Head Office only), the e-commerce bridges (one storefront)
 * and WhatsApp messaging (one business sender).
 *
 * A client that has bought an add-on always pays at least one store's worth, even
 * before its first store is provisioned — an add-on never becomes free by having
 * nothing to attach to.
 */
export const addonQuantity = (key: string, tradingStores: number): number =>
  PER_COMPANY_FEATURE_KEYS.includes(key) ? 1 : Math.max(1, wholeCount(tradingStores));

/**
 * The one canonical recurring arithmetic (2026-10-14 model).
 *
 *   per_terminal → licensed terminals × rate per licensed terminal
 *   per_store    → trading stores × store rate + max(0, licensed − stores)
 *                  × the additional-till rate
 *   custom       → the agreed amount, or `null` when nothing is agreed
 *
 * The quantities are the LICENSED count from the client's subscription and the
 * stores the client actually RUNS (`kind = 'store'` rows — a warehouse is not a
 * trading store and carries no line). Never the configured tills, claimed
 * devices, online terminals, open till sessions or heartbeats: device state
 * changes minute to minute; what a client pays must not.
 *
 * A `custom` plan with no agreed amount returns `null`, never a number: the
 * control plane does not invent a figure for a negotiated deal, and an accidental
 * zero would be worse than an explicit "no automatic amount". That figure is
 * stated once on the plan (or typed on the invoice); it is never derived.
 */
export function calculateRecurringAmount(
  terms: RecurringTerms,
  licensedTerminals: number,
  tradingStores = 0,
): number | null {
  if (terms.pricingMode === 'custom') {
    return terms.customAmountCents > 0 ? terms.customAmountCents : null;
  }
  const tills = wholeCount(licensedTerminals);
  if (terms.pricingMode === 'per_store') {
    const stores = wholeCount(tradingStores);
    const additional = Math.max(0, tills - stores);
    return stores * terms.storeRateCents + additional * terms.terminalRateCents;
  }
  return tills * terms.terminalRateCents;
}

/**
 * The plan-shaped reader of the same arithmetic — kept beside the terms form so
 * nothing has to remember which mode it is on.
 */
export function calculateRecurringSubscriptionAmount(
  plan: PlanRecord | null,
  licensedTerminals: number,
  tradingStores = 0,
): number | null {
  const terms = termsFromPlan(plan);
  if (!terms) return null;
  return calculateRecurringAmount(terms, licensedTerminals, tradingStores);
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
  /** The agreed per-terminal rate (from the subscription snapshot, not the plan).
   *  On a `per_store` deal this is the ADDITIONAL-till rate. */
  rateCents: number;
  /** The agreed per-store rate (`per_store` deals only; 0 otherwise). */
  storeRateCents?: number;
  /** What the client is licensed for now. */
  licensedTerminalCount: number;
  /** How many trading stores the client RUNS now (`per_store` deals only). */
  tradingStoreCount?: number;
  /** What they have actually been invoiced and paid for this period. */
  paidTerminalCount: number | null;
  /** The stores the settled invoice billed (`per_store` deals only). */
  paidStoreCount?: number | null;
  /** When the period they have paid for ends. */
  paidThrough: string | null;
  billingPeriod: PlanPeriod | null;
  today?: Date;
}

export interface ProRataCharge {
  /** Extra terminals bought mid-period (the whole increase on `per_terminal`). */
  extraTerminals: number;
  /** Extra stores bought mid-period (always 0 on `per_terminal`). */
  extraStores: number;
  /** What the client receives if they settle it: the increase for the rest. */
  amountCents: number;
  daysRemaining: number;
  periodDays: number;
  /** The window the charge covers, for the invoice line. */
  from: string;
  to: string;
}

/**
 * What a mid-period increase is worth — the increase, for the days left in a
 * period the client has already paid for.
 *
 * The amount is the pricing formula's OWN delta (amount now − amount as the
 * settled invoice billed it), so a store bought with its first till costs the
 * net `store − till` figure rather than a hand-written rule that could drift
 * from the formula. `extraStores`/`extraTerminals` describe the change for the
 * line's wording only.
 *
 * Returns `null` when there is nothing to charge: not a per-terminal/per-store
 * deal, no increase, no paid period to pro-rate against, or a period that has
 * already lapsed. Reductions are deliberately not credited here — a smaller
 * quantity takes effect from the next period.
 */
export const proRataForIncrease = (input: ProRataInput): ProRataCharge | null => {
  if (input.pricingMode !== 'per_terminal' && input.pricingMode !== 'per_store') return null;
  if (input.paidTerminalCount === null) return null;
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
  // period already, and the increase is not covered by it — the next invoice is
  // for the *next* period, not this one.
  if (daysRemaining <= 0) return null;

  let extraTerminals: number;
  let extraStores: number;
  let deltaCents: number;

  if (input.pricingMode === 'per_terminal') {
    if (input.rateCents <= 0) return null;
    extraTerminals = input.licensedTerminalCount - input.paidTerminalCount;
    if (extraTerminals <= 0) return null;
    extraStores = 0;
    deltaCents = extraTerminals * input.rateCents;
  } else {
    const storeRate = input.storeRateCents ?? 0;
    if (storeRate <= 0) return null;
    const terms: RecurringTerms = {
      pricingMode: 'per_store',
      storeRateCents: storeRate,
      terminalRateCents: input.rateCents,
      customAmountCents: 0,
    };
    const stores = wholeCount(input.tradingStoreCount ?? 0);
    const paidStores = wholeCount(input.paidStoreCount ?? 0);
    const now = calculateRecurringAmount(terms, input.licensedTerminalCount, stores) ?? 0;
    const paid = calculateRecurringAmount(terms, input.paidTerminalCount, paidStores) ?? 0;
    deltaCents = now - paid;
    if (deltaCents <= 0) return null;
    extraStores = Math.max(0, stores - paidStores);
    extraTerminals = Math.max(
      0,
      wholeCount(input.licensedTerminalCount) -
        stores -
        (wholeCount(input.paidTerminalCount) - paidStores),
    );
  }

  return {
    extraTerminals,
    extraStores,
    amountCents: Math.round((deltaCents * daysRemaining) / periodDays),
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
  /** The per-terminal rate in force. On a per_store deal: the ADDITIONAL-till rate. */
  rateCents: number;
  /** The per-store rate in force (0 unless per_store). */
  storeRateCents: number;
  /** A custom plan's agreed charge per billing period (0 when none is set). */
  customAmountCents: number;
  /** Purchased quantity — what the client pays for. */
  licensedTerminalCount: number;
  /** The trading stores the client runs now (kind='store'; a warehouse is not billed). */
  licensedStoreCount: number;
  /** Tills beyond the stores' included first ones (0 unless per_store). */
  additionalTerminalCount: number;
  /** How much of the purchased quantity is placed on stores. */
  allocatedTerminalCount: number;
  unallocatedTerminalCount: number;
  /** The recurring line; null when pricing is custom or no plan is assigned. */
  recurringAmountCents: number | null;
  /**
   * The paid add-ons this client holds — one per bought feature, priced at what
   * was agreed for it (or the plan's price where no agreement was recorded) and
   * multiplied by the stores it covers (see `addonQuantity`).
   */
  addons: Array<{
    key: string;
    label: string;
    /** The line total: `unitCents × quantity`. */
    cents: number;
    /** The agreed-or-plan price for ONE store (one panel, for Head Office). */
    unitCents: number;
    /** The stores the add-on is charged for (1 for Head Office). */
    quantity: number;
  }>;
  /** What those add-ons add to the month — part of the recurring line above. */
  addonsCents: number;
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
  const stores = countStoresForCompany(company.id);
  const setupFeeStatus: SetupFeeStatus = subscription?.setup_fee_status ?? 'not_invoiced';

  // The price the client AGREED to, when one is on record. Everything below reads
  // the agreement first and the plan only as a fallback — so a plan edit re-prices
  // nobody (grandfathering), while caps and features keep tracking the plan.
  const agreed = subscription?.priced_at
    ? {
        pricingMode: subscription.pricing_mode ?? 'per_terminal',
        rateCents: subscription.rate_cents ?? 0,
        storeRateCents: subscription.store_rate_cents ?? 0,
        customAmountCents: subscription.custom_amount_cents ?? 0,
        setupFeeCents: subscription.setup_fee_cents ?? 0,
        billingPeriod: subscription.billing_period ?? null,
      }
    : null;
  const pricingMode: PlanPricingMode | 'none' = agreed
    ? agreed.pricingMode
    : (plan?.pricing_mode ?? 'none');
  const terms: RecurringTerms | null = agreed
    ? {
        pricingMode: pricingMode as PlanPricingMode,
        storeRateCents: agreed.storeRateCents,
        terminalRateCents: agreed.rateCents,
        customAmountCents: agreed.customAmountCents,
      }
    : termsFromPlan(plan);
  const rateCents = terms?.terminalRateCents ?? 0;
  const storeRateCents = terms?.storeRateCents ?? 0;
  const customAmountCents = terms?.customAmountCents ?? 0;
  // The once-off onboarding charge is the client's OWN figure, not the plan's:
  // READ from their subscription when one has been agreed there, so assisted
  // and self setup can coexist on one plan (2026-10-12). NULL — never agreed —
  // falls back to the plan, which is how rows that predate the field behave.
  const setupFeeCents = agreedSetupFeeCents(plan, subscription);
  // The add-ons the client bought, priced at what was agreed when they bought
  // them (falling back to the plan's price for a feature recorded before prices
  // existed). Agreed terms, like the rate: editing a plan does not move them.
  const agreedAddonPrices = subscriptionAddonPrices(subscription);
  const planPrices = planFeaturePrices(plan);
  const planIncluded = planFeatures(plan);
  const addons = subscriptionFeatures(subscription)
    .filter((key) => !planIncluded.includes(key))
    .map((key) => {
      const unitCents = agreedAddonPrices[key] ?? planPrices[key] ?? 0;
      const quantity = addonQuantity(key, stores);
      return {
        key,
        label: FEATURE_LABELS[key] ?? key,
        cents: unitCents * quantity,
        unitCents,
        quantity,
      };
    });
  const addonsCents = addons.reduce((sum, a) => sum + a.cents, 0);

  const recurringAmountCents =
    pricingMode === 'none' || !terms
      ? null
      : pricingMode === 'custom'
        ? calculateRecurringAmount(terms, licensed, stores)
        : (calculateRecurringAmount(terms, licensed, stores) ?? 0) + addonsCents;
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
  } else if (licensed === 0) {
    notes.push('No licensed terminals — set the quantity the client has purchased.');
  }
  if (pricingMode === 'per_store' && stores === 0 && licensed > 0) {
    notes.push(
      'No trading stores yet — the first till of each store is included in its store rate, so the bill currently prices every till as an additional one.',
    );
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
    plan &&
    plan.pricing_mode !== 'custom'
  ) {
    notes.push('The plan carries no once-off onboarding charge.');
  }

  return {
    pricingMode,
    pricingSource: agreed ? 'agreed' : plan ? 'plan' : 'none',
    addons,
    addonsCents,
    pricedAt: subscription?.priced_at ?? null,
    planCode: plan?.code ?? 'unassigned',
    planName: plan?.name ?? 'Unassigned',
    billingPeriod: agreed?.billingPeriod ?? plan?.billing_period ?? null,
    // `rateCents`/`storeRateCents` are the rates in force; a custom deal's agreed
    // amount is carried as the recurring amount instead, so the UI never presents
    // it as a rate.
    rateCents: pricingMode === 'per_terminal' || pricingMode === 'per_store' ? rateCents : 0,
    storeRateCents: pricingMode === 'per_store' ? storeRateCents : 0,
    customAmountCents: pricingMode === 'custom' ? customAmountCents : 0,
    licensedTerminalCount: licensed,
    licensedStoreCount: stores,
    additionalTerminalCount: pricingMode === 'per_store' ? Math.max(0, licensed - stores) : 0,
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
