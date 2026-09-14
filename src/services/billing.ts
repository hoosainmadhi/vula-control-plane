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
  getSubscription,
  setSetupFeeStatus,
  updateCompany,
  type CompanyRecord,
  type InvoiceLines,
  type PlanPeriod,
  type InvoiceRecord,
  type PaymentRecord,
} from '../config/registryDb.js';
import { issueLicence } from './licenceSigner.js';
import { pushLicence, pushLicenceToPanel } from './storeClient.js';
import { entitlementsFor, entitlementsForStore } from './subscriptions.js';
import { quoteForSubscription } from './pricing.js';
import { HttpError } from '../utils/errors.js';
import { logger } from '../config/env.js';

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
  /** Companies on negotiated pricing — the sweep never invents an amount for them. */
  customPricingSkipped: number;
  errors: string[];
}

/** What an invoice is for. Only `initial` may carry the once-off onboarding fee. */
export type InvoicePurpose = 'initial' | 'renewal' | 'manual';

export interface CreateInvoiceOptions {
  amountCents?: number;
  dueDate?: string;
  invoiceNumber?: string;
  purpose?: InvoicePurpose;
}

/**
 * Format a Date as YYYY-MM-DD
 */
export const formatDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Generate a sequential or collision-free invoice number: INV-YYYYMMDD-XXXX
 */
export function generateInvoiceNumber(now: Date = new Date()): string {
  const ymd = formatDateOnly(now).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `INV-${ymd}-${rand}`;
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
      recordLicencePush(store.id, 'failed');
      const msg = `Failed to push licence to store ${store.slug}: ${err instanceof Error ? err.message : String(err)}`;
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
      recordPanelLicencePush(panel.id, 'failed');
      const msg = `Failed to push licence to panel ${panel.slug}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      errors.push(msg);
    }
  }

  return { storesUpdated, panelsUpdated, errors };
}

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

  let amountCents: number;
  let lines: InvoiceLines | undefined;

  if (explicit) {
    amountCents = options!.amountCents!;
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
    const setupFeeDue = purpose === 'initial' ? quote.setupFeeDueCents : 0;
    amountCents = quote.recurringAmountCents + setupFeeDue;
    lines = {
      // A per-terminal plan itemises its arithmetic; a custom plan's agreed
      // amount is a flat line, so no terminal count or rate is recorded.
      terminalCount: quote.pricingMode === 'per_terminal' ? quote.licensedTerminalCount : null,
      terminalPriceCents: quote.pricingMode === 'per_terminal' ? quote.rateCents : null,
      setupFeeCents: setupFeeDue > 0 ? setupFeeDue : null,
    };
  }

  const due = options?.dueDate
    ? new Date(`${options.dueDate}T12:00:00.000Z`)
    : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days default

  const invoiceNumber = options?.invoiceNumber || generateInvoiceNumber();

  const invoice = dbCreateInvoice(companyId, amountCents, due, invoiceNumber, lines);

  // The onboarding charge is once-off: the moment an invoice carries it, the
  // subscription records it as invoiced so no later invoice repeats it.
  if (!explicit && lines?.setupFeeCents && lines.setupFeeCents > 0) {
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
  if ((invoice.setup_fee_cents ?? 0) > 0 && getSubscription(company.id)?.setup_fee_status === 'invoiced') {
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
    customPricingSkipped: 0,
    errors: [],
  };

  const { listCompanies } = await import('../config/registryDb.js');
  const companies = listCompanies().filter((c) => c.status === 'active' && c.plan_id !== null);

  for (const company of companies) {
    summary.companiesEvaluated++;
    const plan = getPlanById(company.plan_id!);
    if (!plan) continue;

    // A custom plan renews from its agreed amount; a custom plan with none has
    // no formula, so the sweep leaves it for the office rather than inventing one.
    if (plan.pricing_mode === 'custom' && plan.custom_amount_cents <= 0) {
      summary.customPricingSkipped++;
      logger.info(
        `Renewal sweep skipped ${company.slug}: ${plan.name} is custom-priced with no agreed amount — raise its invoice with the agreed amount`,
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
      // Create the renewal invoice: recurring charges only, never the setup fee.
      invoiceToPay = createInvoiceForCompany(company.id, {
        dueDate: paidThrough || nowDateStr,
        purpose: 'renewal',
      });
      summary.invoicesCreated++;
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
