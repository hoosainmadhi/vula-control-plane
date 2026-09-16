import {
  getCompanyById,
  getPlanById,
  listStores,
  listPanelsForCompany,
  nextLicenceSequence,
  nextPanelLicenceSequence,
  recordLicencePush,
  recordPanelLicencePush,
  createInvoice as dbCreateInvoice,
  updateInvoice as dbUpdateInvoice,
  getInvoiceById,
  listInvoices,
  createPayment as dbCreatePayment,
  getBillingSettings,
  getOfficeSettings,
  getSubscription,
  nextInvoiceNumber,
  setSetupFeeStatus,
  updateCompany,
  type CompanyRecord,
  type InvoiceLines,
  type PlanPeriod,
  type PlanRecord,
  type InvoiceRecord,
  type PaymentRecord,
} from '../config/registryDb.js';
import { issueLicence } from './licenceSigner.js';
import { pushLicence, pushLicenceToPanel } from './storeClient.js';
import { entitlementsFor, entitlementsForStore } from './subscriptions.js';
import {
  proRataForIncrease,
  quoteForSubscription,
  type ProRataCharge,
  type SubscriptionQuote,
} from './pricing.js';
import { HttpError } from '../utils/errors.js';
import { exclusiveCents, formatCents as formatCents2, vatPortionCents } from '../utils/money.js';
import { logger } from '../config/env.js';

/**
 * The label the once-off charge carries wherever it is itemised — the PDF, the
 * emailed invoice and the Billing screens. One constant, so the client reads the
 * same words the office does. (The plan-level field stays "once-off onboarding";
 * this is the line the invoice shows.)
 */
export const SETUP_FEE_LINE_LABEL = 'Vula onboarding and deployment';

/**
 * The standing invoice carrying a client's once-off onboarding charge, if it has
 * been billed and not cancelled. One helper so every surface names the same
 * invoice rather than each re-deriving "where does this charge sit".
 */
export const setupFeeInvoiceFor = (companyId: number): InvoiceRecord | undefined =>
  listInvoices(companyId).find((i) => i.status !== 'cancelled' && (i.setup_fee_cents ?? 0) > 0);

export interface RenewalResult {
  invoice: InvoiceRecord;
  payment: PaymentRecord;
  newPaidThrough: string;
  licencePush: {
    storesUpdated: number;
    panelsUpdated: number;
    errors: string[];
  };
}

export interface AutomatedRenewalSummary {
  companiesEvaluated: number;
  invoicesCreated: number;
  renewalsProcessed: number;
  /** Renewals that also captured a once-off onboarding charge never billed before. */
  onboardingCharged: number;
  /** Companies with no formula to invoice from — custom pricing with no agreed
   *  amount, or no plan at all. The sweep never invents a figure for them. */
  customPricingSkipped: number;
  /** Companies with nothing to bill: no licensed terminals purchased. */
  noLicensedTerminalsSkipped: number;
  errors: string[];
}

/**
 * What an invoice is for. `initial` bills the first period plus the once-off
 * onboarding charge; `onboarding` bills **only** that charge, for a client who
 * has already been invoiced for a period (billing `initial` again would charge
 * the recurring line a second time); `renewal` is the sweep's recurring-only
 * invoice; `manual` carries an amount the office agreed.
 */
export type InvoicePurpose = 'initial' | 'renewal' | 'manual' | 'onboarding' | 'pro_rata';

export interface CreateInvoiceOptions {
  amountCents?: number;
  dueDate?: string;
  invoiceNumber?: string;
  purpose?: InvoicePurpose;
  /** What the charge is for. Derived from the subscription when omitted. */
  description?: string;
  /**
   * Whether an unbilled once-off onboarding charge rides on this invoice.
   * Default true; `false` is the operator saying "not on this one".
   */
  includeOnboarding?: boolean;
}

/**
 * Format a Date as YYYY-MM-DD
 */
export const formatDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The next invoice number: a monotonic per-year sequence, `VULA-2026-000001`.
 *
 * It used to be `INV-<date>-<4 random digits>`, which was neither sequential (an
 * auditor cannot see a gap or a duplicate from the number) nor safe: two
 * invoices raised in the same second could draw the same digits, and the UNIQUE
 * index turned the loser into a raw database error instead of a retry. The
 * counter lives in the registry (`nextInvoiceNumber`) and increments in the
 * statement that reads it.
 */
export function generateInvoiceNumber(now: Date = new Date()): string {
  return nextInvoiceNumber(now);
}

/**
 * Calculate the next paid_through date based on billing period and current date.
 * If currently paid into the future, we extend from that future date.
 * If expired or unset, we extend from today.
 */
export function calculateRenewalDate(
  currentPaidThrough: string | null,
  billingPeriod: PlanPeriod,
  now: Date = new Date(),
): string {
  if (billingPeriod === 'once-off') {
    return '2099-12-31';
  }

  let anchor: Date;
  if (currentPaidThrough) {
    const existing = new Date(`${currentPaidThrough}T12:00:00.000Z`);
    anchor = existing.getTime() > now.getTime() ? existing : new Date(now);
  } else {
    anchor = new Date(now);
  }

  const next = new Date(anchor);
  if (billingPeriod === 'annual') {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    // monthly default
    next.setUTCMonth(next.getUTCMonth() + 1);
  }

  return formatDateOnly(next);
}

/**
 * Push updated signed licences to all stores and the Head Office panel for a company.
 */
export async function pushLicencesForCompany(companyId: number): Promise<{
  storesUpdated: number;
  panelsUpdated: number;
  errors: string[];
}> {
  const company = getCompanyById(companyId);
  if (!company) {
    return { storesUpdated: 0, panelsUpdated: 0, errors: [`Company ${companyId} not found`] };
  }

  const ent = entitlementsFor(company);
  const errors: string[] = [];
  let storesUpdated = 0;
  let panelsUpdated = 0;

  // 1. Stores — each licence carries the store's OWN terminal allowance
  // (`maxTerminals`) beside the plan ceiling, because the register gates device
  // claims on it.
  const stores = listStores().filter((s) => s.company_id === companyId);
  for (const store of stores) {
    try {
      const storeEnt = entitlementsForStore(store);
      const sequence = nextLicenceSequence(store.id);
      const signed = issueLicence({
        sequence,
        storeSlug: store.slug,
        storeName: store.name,
        companyId: storeEnt.companyId,
        companyName: storeEnt.companyName,
        planCode: storeEnt.planCode,
        planName: storeEnt.planName,
        features: storeEnt.features,
        maxStores: storeEnt.maxStores,
        maxTerminalsPerStore: storeEnt.maxTerminalsPerStore,
        maxTerminals: storeEnt.maxTerminals ?? store.terminal_count,
        paidThrough: storeEnt.paidThrough,
        billingState: storeEnt.billingState,
      });
      await pushLicence(store, signed.token);
      recordLicencePush(store.id, 'ok');
      storesUpdated++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      recordLicencePush(store.id, 'failed', reason);
      const msg = `Failed to push licence to store ${store.slug}: ${reason}`;
      logger.error(msg);
      errors.push(msg);
    }
  }

  // 2. Head Office Panels — company-wide entitlement; a panel has no terminals,
  // so no `maxTerminals` claim.
  const panels = listPanelsForCompany(companyId);
  for (const panel of panels) {
    try {
      const sequence = nextPanelLicenceSequence(panel.id);
      const signed = issueLicence({
        sequence,
        storeSlug: panel.slug,
        storeName: panel.name,
        companyId: ent.companyId,
        companyName: ent.companyName,
        planCode: ent.planCode,
        planName: ent.planName,
        features: ent.features,
        maxStores: ent.maxStores,
        maxTerminalsPerStore: ent.maxTerminalsPerStore,
        paidThrough: ent.paidThrough,
        billingState: ent.billingState,
      });
      await pushLicenceToPanel(
        { base_url: panel.base_url, control_plane_token: panel.control_plane_token },
        signed.token,
      );
      recordPanelLicencePush(panel.id, 'ok');
      panelsUpdated++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      recordPanelLicencePush(panel.id, 'failed', reason);
      const msg = `Failed to push licence to panel ${panel.slug}: ${reason}`;
      logger.error(msg);
      errors.push(msg);
    }
  }

  return { storesUpdated, panelsUpdated, errors };
}

/**
 * The terminals a client has actually been invoiced **and paid** for, from the
 * most recent settled invoice for the current period. That figure is what a
 * mid-period increase is measured against: they have paid for N terminals until
 * `paid_through`, so anything above N is unbilled time.
 *
 * `null` when no invoice has been settled — with no paid period there is nothing
 * to pro-rate.
 */
export const paidTerminalsFor = (companyId: number): number | null => {
  const settled = listInvoices(companyId)
    .filter((inv) => inv.status === 'paid')
    .sort((a, b) => (a.paid_date ?? '').localeCompare(b.paid_date ?? '') || a.id - b.id);
  return settled.length > 0 ? (settled[settled.length - 1].terminal_count ?? null) : null;
};

/**
 * The mid-period charge a client owes right now, or null when there is nothing to
 * charge. Computed from the AGREED rate — a plan edit must not change what an
 * existing client's increase costs.
 */
export type MidPeriodCharge = ProRataCharge & {
  /** The invoice that already bills this increase for this period, if any. */
  billedOn: string | null;
};

export const currentProRata = (
  company: CompanyRecord,
  plan: PlanRecord | null,
  quote?: SubscriptionQuote,
): MidPeriodCharge | null => {
  const priced = quote ?? quoteForSubscription(company, plan);
  const charge = proRataForIncrease({
    pricingMode: priced.pricingMode,
    rateCents: priced.rateCents,
    licensedTerminalCount: priced.licensedTerminalCount,
    paidTerminalCount: paidTerminalsFor(company.id),
    paidThrough: company.paid_through,
    billingPeriod: priced.billingPeriod,
  });
  if (!charge) return null;
  // One charge per paid period: an invoice that already covers this period means
  // the increase is billed, and raising it again would bill the same days twice.
  const billed = listInvoices(company.id).find(
    (inv) => inv.status !== 'cancelled' && inv.pro_rata_period === company.paid_through,
  );
  return { ...charge, billedOn: billed?.invoice_number ?? null };
};

/**
 * The lines a client reads on an invoice, in order, from one place — so the PDF
 * and the emailed invoice cannot show different arithmetic.
 *
 * Anything the structured lines do not explain becomes its own line labelled with
 * the invoice's description: that is how a hand-priced charge, a pro-rata increase
 * and a negotiated amount appear as real line items instead of a bare total.
 */
export interface InvoiceLineItem {
  label: string;
  detail: string;
  amountCents: number;
}

export const invoiceLineItems = (invoice: InvoiceRecord): InvoiceLineItem[] => {
  const items: InvoiceLineItem[] = [];
  // The once-off leads whenever it is on the invoice (owner, 2026-09-16).
  if ((invoice.setup_fee_cents ?? 0) > 0) {
    items.push({
      label: SETUP_FEE_LINE_LABEL,
      detail: 'Once-off — charged when the subscription starts',
      amountCents: invoice.setup_fee_cents!,
    });
  }
  if (invoice.terminal_count !== null && invoice.terminal_price_cents !== null) {
    items.push({
      label: 'Licensed terminals',
      detail: [
        invoice.plan_name,
        `${invoice.terminal_count} × ${formatCents2(invoice.terminal_price_cents)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      amountCents: invoice.terminal_count * invoice.terminal_price_cents,
    });
  }
  const explained = items.reduce((sum, i) => sum + i.amountCents, 0);
  const residual = invoice.amount_cents - explained;
  if (residual > 0 || items.length === 0) {
    items.push({
      label: invoice.description ?? 'Subscription charge',
      detail: '',
      amountCents: residual > 0 ? residual : invoice.amount_cents,
    });
  }
  return items;
};

/**
 * Create a billing invoice for a company.
 *
 * Without an explicit amount the invoice is computed from the subscription: the
 * recurring line is `licensed terminals × rate` (services/pricing.ts), plus the
 * once-off onboarding charge when `purpose` is `initial` and it has not been
 * charged yet. A `renewal` never carries the onboarding charge again, and a
 * `custom`-priced plan is refused rather than guessed at.
 */
export function createInvoiceForCompany(
  companyId: number,
  options?: CreateInvoiceOptions,
): InvoiceRecord {
  const company = getCompanyById(companyId);
  if (!company) {
    throw new HttpError(404, `Company ${companyId} not found`);
  }

  const plan = company.plan_id ? getPlanById(company.plan_id) : null;
  const quote = quoteForSubscription(company, plan);
  const explicit = options?.amountCents !== undefined;
  const purpose: InvoicePurpose = options?.purpose ?? (explicit ? 'manual' : 'initial');

  /**
   * The once-off onboarding charge rides on whichever invoice is raised next
   * while it is still unbilled — never only on the first one. Raising an invoice
   * for a client that owes it is the moment to capture it; waiting for the
   * operator to remember a separate "bill onboarding" step is how nine live
   * clients ended up with an unbilled R10 000 each.
   *
   * `setupFeeDueCents` is the guard against double-billing: it is zero as soon as
   * the charge sits on a standing invoice (or is paid/waived), and a cancelled
   * invoice releases it again. `includeOnboarding: false` lets the office say no
   * for one invoice — the modal shows what will be added.
   */
  const chargeOnboarding =
    purpose !== 'onboarding' && options?.includeOnboarding !== false && quote.setupFeeDueCents > 0;
  const onboardingCents = chargeOnboarding ? quote.setupFeeDueCents : 0;

  let amountCents: number;
  let lines: InvoiceLines | undefined;

  if (explicit) {
    amountCents = options!.amountCents! + onboardingCents;
    lines = {
      description: options?.description,
      setupFeeCents: chargeOnboarding ? onboardingCents : null,
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
    };
  } else if (purpose === 'onboarding') {
    // The once-off charge on its own: a client invoiced for a period already
    // must not be charged that period again just to be billed its onboarding.
    if (quote.setupFeeDueCents === 0) {
      throw new HttpError(
        409,
        `There is no onboarding charge to bill for ${company.name} — it is ${quote.setupFeeStatus.replace('_', ' ')}.`,
        'setup_fee_not_due',
      );
    }
    amountCents = quote.setupFeeDueCents;
    lines = {
      setupFeeCents: quote.setupFeeDueCents,
      description: options?.description ?? SETUP_FEE_LINE_LABEL,
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
    };
  } else if (purpose === 'pro_rata') {
    // Terminals bought mid-period, charged for the days left in the period the
    // client has already paid for. Nothing to charge means nothing is raised —
    // this never invents a figure (see `proRataForIncrease`).
    const charge = currentProRata(company, plan, quote);
    if (!charge) {
      throw new HttpError(
        409,
        `Nothing to pro-rate for ${company.name}: the licensed quantity has not increased above what this period was invoiced for, or the period it was invoiced for has lapsed.`,
        'nothing_to_pro_rate',
      );
    }
    if (charge.billedOn) {
      throw new HttpError(
        409,
        `The mid-period increase for ${company.name} is already on ${charge.billedOn}. Settle or void that invoice before raising another.`,
        'pro_rata_already_billed',
      );
    }
    amountCents = charge.amountCents + onboardingCents;
    lines = {
      // Deliberately no terminal_count/rate: this line is NOT `count × rate`, it
      // is the extra terminals for part of a period. The description carries the
      // arithmetic, and the document renders it as its own line.
      description: `Mid-period increase — ${charge.extraTerminals} extra terminal${
        charge.extraTerminals === 1 ? '' : 's'
      } for ${charge.daysRemaining} of ${charge.periodDays} days (${charge.from} to ${charge.to})`,
      // Stamped so this period cannot be pro-rated twice.
      proRataPeriod: charge.to,
      setupFeeCents: chargeOnboarding ? onboardingCents : null,
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
    };
  } else {
    if (quote.recurringAmountCents === null) {
      throw new HttpError(
        400,
        `${company.name} is on ${quote.planName} custom pricing with no agreed amount on the plan — enter the amount for this invoice, or set an agreed amount on the plan.`,
        'custom_pricing_requires_amount',
      );
    }
    if (quote.licensedTerminalCount === 0) {
      throw new HttpError(
        400,
        `${company.name} has no licensed terminals, so there is nothing to bill. Set the subscription's licensed terminal quantity or enter an amount.`,
        'no_licensed_terminals',
      );
    }
    amountCents = quote.recurringAmountCents + onboardingCents;
    lines = {
      // A per-terminal plan itemises its arithmetic; a custom plan's agreed
      // amount is a flat line, so no terminal count or rate is recorded.
      terminalCount: quote.pricingMode === 'per_terminal' ? quote.licensedTerminalCount : null,
      terminalPriceCents: quote.pricingMode === 'per_terminal' ? quote.rateCents : null,
      setupFeeCents: chargeOnboarding ? onboardingCents : null,
      // The plan on the document, not a pointer to today's catalogue entry.
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
      // Derived, not invented: the invoice says which subscription period it is
      // for, and the PDF/email itemise the arithmetic behind the figure.
      description:
        options?.description ??
        `Subscription — ${quote.planName}${
          quote.billingPeriod === 'annual'
            ? ' (annual)'
            : quote.billingPeriod === 'monthly'
              ? ' (monthly)'
              : ''
        }${chargeOnboarding ? ` + ${SETUP_FEE_LINE_LABEL}` : ''}`,
    };
  }

  const settings = getOfficeSettings();
  const due = options?.dueDate
    ? new Date(`${options.dueDate}T12:00:00.000Z`)
    : // Payment terms are an office setting (Settings page); 14 days is only the
      // value the singleton row is seeded with.
      new Date(Date.now() + settings.invoice_due_days * 24 * 60 * 60 * 1000);

  // Prices are quoted VAT-inclusive, so `amountCents` is the total the client pays
  // and the split is `inclusive − exclusive`. Computed and stored per invoice: the
  // rate is a setting, and changing it must never restate a document that has
  // already gone out.
  const linesWithTax = {
    ...lines,
    subtotalCents: exclusiveCents(amountCents, settings.vat_rate),
    vatCents: vatPortionCents(amountCents, settings.vat_rate),
    vatRate: settings.vat_rate,
  };

  const invoiceNumber = options?.invoiceNumber || generateInvoiceNumber();

  const invoice = dbCreateInvoice(companyId, amountCents, due, invoiceNumber, linesWithTax);

  // The onboarding charge is once-off: the moment an invoice carries it, the
  // subscription records it as invoiced so no later invoice repeats it — on any
  // kind of invoice, hand-priced included.
  if (lines?.setupFeeCents && lines.setupFeeCents > 0) {
    setSetupFeeStatus(companyId, 'invoiced');
  }

  return invoice;
}

/**
 * Process a payment against an invoice and advance subscription paid_through date.
 */
export async function processPaymentAndRenew(input: {
  invoiceId: number;
  amountCents?: number;
  method: PaymentRecord['method'];
  transactionId?: string;
  now?: Date;
}): Promise<RenewalResult> {
  const now = input.now ?? new Date();
  const invoice = getInvoiceById(input.invoiceId);
  if (!invoice) {
    throw new Error(`Invoice ${input.invoiceId} not found`);
  }
  if (invoice.status === 'paid') {
    throw new Error(`Invoice ${invoice.invoice_number} is already paid`);
  }
  if (invoice.status === 'cancelled') {
    throw new Error(`Invoice ${invoice.invoice_number} is cancelled`);
  }

  const company = getCompanyById(invoice.company_id);
  if (!company) {
    throw new Error(`Company ${invoice.company_id} not found`);
  }

  const paymentAmount = input.amountCents ?? invoice.amount_cents;

  // 1. Record completed payment
  const payment = dbCreatePayment(
    invoice.id,
    company.id,
    paymentAmount,
    input.method,
    input.transactionId,
  );

  // 2. Mark invoice paid
  const updatedInvoice = dbUpdateInvoice(invoice.id, {
    status: 'paid',
    paidDate: now,
  })!;

  // The once-off onboarding charge is settled with the invoice that carried it.
  if (
    (invoice.setup_fee_cents ?? 0) > 0 &&
    getSubscription(company.id)?.setup_fee_status === 'invoiced'
  ) {
    setSetupFeeStatus(company.id, 'paid');
  }

  // 3. Compute and advance paid_through date
  const plan = company.plan_id ? getPlanById(company.plan_id) : null;
  const billingPeriod = plan?.billing_period ?? 'monthly';
  const newPaidThrough = calculateRenewalDate(company.paid_through, billingPeriod, now);

  updateCompany(company.id, {
    paidThrough: newPaidThrough,
    status: 'active',
  });

  // 4. Re-push licences to all company stores and Head Office panels
  const licencePush = await pushLicencesForCompany(company.id);

  return {
    invoice: updatedInvoice,
    payment,
    newPaidThrough,
    licencePush,
  };
}

/**
 * Automated renewal cycle: checks all active companies with paid plans.
 * If renewal is due, generates (or reuses) the invoice.
 *
 * Amounts come from the canonical calculator: licensed terminals × the plan's
 * rate. A `custom`-priced plan has no formula, so the sweep leaves it alone
 * rather than inventing a figure — the office raises those invoices with the
 * agreed amount.
 *
 * Settlement truthfulness (production-readiness review, 2026-09-12): the sweep
 * NEVER records a payment by itself — a subscription is only extended by an
 * explicitly confirmed settlement (an office user recording the payment, or a
 * payment-provider webhook once a gateway is integrated). The synthetic
 * `manual` completion is available ONLY behind
 * BILLING_SIMULATE_RENEWAL_SETTLEMENT=true for disposable demo environments.
 */
export async function runAutomatedRenewals(options?: {
  now?: Date;
}): Promise<AutomatedRenewalSummary> {
  const now = options?.now ?? new Date();
  const nowDateStr = formatDateOnly(now);
  const simulateSettlement = process.env.BILLING_SIMULATE_RENEWAL_SETTLEMENT === 'true';
  const summary: AutomatedRenewalSummary = {
    companiesEvaluated: 0,
    invoicesCreated: 0,
    renewalsProcessed: 0,
    onboardingCharged: 0,
    customPricingSkipped: 0,
    noLicensedTerminalsSkipped: 0,
    errors: [],
  };

  const { listCompanies } = await import('../config/registryDb.js');
  const companies = listCompanies().filter((c) => c.status === 'active' && c.plan_id !== null);

  for (const company of companies) {
    summary.companiesEvaluated++;
    const plan = getPlanById(company.plan_id!);
    if (!plan) continue;

    // What this client actually pays comes from their AGREED price, not from the
    // plan in force — a plan edit must not re-price them, and a client whose
    // agreed deal is custom with no figure has no formula to invoice from. Both
    // cases are left for the office rather than guessed at.
    const quote = quoteForSubscription(company, plan);
    if (quote.recurringAmountCents === null) {
      summary.customPricingSkipped++;
      logger.info(
        `Renewal sweep skipped ${company.slug}: ${plan.name} is custom-priced with no agreed amount — raise its invoice with the agreed amount`,
      );
      continue;
    }
    if (quote.licensedTerminalCount === 0) {
      summary.noLicensedTerminalsSkipped++;
      logger.info(
        `Renewal sweep skipped ${company.slug}: no licensed terminals, so there is nothing to bill`,
      );
      continue;
    }

    const settings = getBillingSettings(company.id);
    const autoRenewEnabled = settings?.auto_renew ?? 1;

    // Check if subscription renewal is due (within 3 days of expiring or already expired)
    const paidThrough = company.paid_through;
    let isDue = false;

    if (!paidThrough) {
      isDue = true;
    } else {
      const paidThroughDate = new Date(`${paidThrough}T23:59:59.000Z`);
      const warningThreshold = new Date(paidThroughDate.getTime() - 3 * 24 * 60 * 60 * 1000);
      isDue = now.getTime() >= warningThreshold.getTime();
    }

    if (!isDue) continue;

    // Find any existing pending or overdue invoice for this company
    const existingInvoices = listInvoices(company.id).filter(
      (inv) => inv.status === 'pending' || inv.status === 'overdue',
    );

    let invoiceToPay: InvoiceRecord;
    if (existingInvoices.length > 0) {
      invoiceToPay = existingInvoices[0];
    } else {
      try {
        // Create the renewal invoice: the recurring line, plus any once-off
        // onboarding charge this client has never been billed for — the sweep is
        // the last place to catch it, and it is counted so the office sees it.
        invoiceToPay = createInvoiceForCompany(company.id, {
          dueDate: paidThrough || nowDateStr,
          purpose: 'renewal',
        });
      } catch (err) {
        // One client's data must not abort the sweep for everyone else — the same
        // isolation the health sweep gives each store. Recorded for the office.
        const msg = `Renewal skipped for ${company.name} (${company.slug}): ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.error(msg);
        summary.errors.push(msg);
        continue;
      }
      summary.invoicesCreated++;
      if ((invoiceToPay.setup_fee_cents ?? 0) > 0) summary.onboardingCharged++;
    }

    // Entitlement is never extended just because the sweep ran. Without a real
    // settlement the invoice stays open for the office user to confirm.
    if (autoRenewEnabled && simulateSettlement) {
      try {
        await processPaymentAndRenew({
          invoiceId: invoiceToPay.id,
          method: 'manual',
          transactionId: `simulated-${Date.now()}`,
          now,
        });
        summary.renewalsProcessed++;
      } catch (err) {
        const msg = `Auto-renewal failed for company ${company.name} (${company.slug}): ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.error(msg);
        summary.errors.push(msg);
      }
    } else if (autoRenewEnabled) {
      logger.info(
        `Renewal invoice ${invoiceToPay.invoice_number} for ${company.slug} is awaiting settlement; paid_through unchanged`,
      );
    }
  }

  return summary;
}
