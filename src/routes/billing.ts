import { Router } from 'express';
import {
  listInvoices,
  getInvoiceById,
  updateInvoice,
  recordInvoiceEmail,
  listPayments,
  getPaymentById,
  getBillingSettings,
  upsertBillingSettings,
  getCompanyById,
  getSubscription,
  setSetupFeeStatus,
  recordAuditLog,
  type InvoiceRecord,
  type PaymentRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import {
  requireInt,
  optionalInt,
  optionalBool,
  optionalString,
  parseIdParam,
} from '../utils/validate.js';
import {
  createInvoiceForCompany,
  processPaymentAndRenew,
  runAutomatedRenewals,
} from '../services/billing.js';
import { sendInvoiceEmail } from '../services/mailer.js';
import { buildInvoicePdf, invoicePdfFilename } from '../services/invoicePdf.js';
import { getRawOfficeSettings } from '../services/officeSettings.js';

export const billingRouter = Router();
billingRouter.use(requireOffice);

// --- Wire types ---

export interface InvoiceOut {
  id: number;
  companyId: number;
  companyName: string;
  invoiceNumber: string;
  amountCents: number;
  /** Licensed terminals on the recurring line; null on a manually-priced invoice. */
  terminalCount: number | null;
  /** The per-terminal rate when the invoice was raised (a snapshot). */
  terminalPriceCents: number | null;
  /** Once-off onboarding charge when this invoice carried it. */
  setupFeeCents: number | null;
  /** What the charge is for — required on a hand-priced invoice. */
  description: string | null;
  /** The plan at the time of issue — a snapshot, not today's catalogue entry. */
  planCode: string | null;
  planName: string | null;
  /** `amountCents` broken down: it is the VAT-inclusive total. Null on invoices
   *  raised before the split existed. */
  subtotalCents: number | null;
  vatCents: number | null;
  vatRate: number | null;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  dueDate: string | null;
  paidDate: string | null;
  /** When the invoice was last emailed to the client (null = never). */
  emailedAt: string | null;
  emailedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentOut {
  id: number;
  invoiceId: number;
  companyId: number;
  amountCents: number;
  method: string;
  status: string;
  transactionId: string | null;
  createdAt: string;
}

const invoiceToOut = (inv: InvoiceRecord): InvoiceOut => {
  const company = getCompanyById(inv.company_id);
  return {
    id: inv.id,
    companyId: inv.company_id,
    companyName: company?.name ?? `Company #${inv.company_id}`,
    invoiceNumber: inv.invoice_number,
    amountCents: inv.amount_cents,
    terminalCount: inv.terminal_count ?? null,
    terminalPriceCents: inv.terminal_price_cents ?? null,
    setupFeeCents: inv.setup_fee_cents ?? null,
    description: inv.description,
    planCode: inv.plan_code,
    planName: inv.plan_name,
    subtotalCents: inv.subtotal_cents,
    vatCents: inv.vat_cents,
    vatRate: inv.vat_rate,
    status: inv.status,
    dueDate: inv.due_date,
    paidDate: inv.paid_date,
    emailedAt: inv.emailed_at,
    emailedTo: inv.emailed_to,
    createdAt: inv.created_at,
    updatedAt: inv.updated_at,
  };
};

const paymentToOut = (p: PaymentRecord): PaymentOut => ({
  id: p.id,
  invoiceId: p.invoice_id,
  companyId: p.company_id,
  amountCents: p.amount_cents,
  method: p.method,
  status: p.status,
  transactionId: p.transaction_id,
  createdAt: p.created_at,
});

// --- Invoices ---

billingRouter.get(
  '/invoices',
  asyncHandler(async (req, res) => {
    const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
    const invoices = listInvoices(companyId);
    res.json(invoices.map(invoiceToOut));
  }),
);

billingRouter.get(
  '/invoices/:id',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const invoice = getInvoiceById(id);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    res.json(invoiceToOut(invoice));
  }),
);

billingRouter.post(
  '/invoices',
  asyncHandler(async (req, res) => {
    const companyId = requireInt(req.body, 'companyId');
    const amountCents = optionalInt(req.body, 'amountCents');
    const dueDate = optionalString(req.body, 'dueDate');
    const description = optionalString(req.body, 'description', 200);
    // An unbilled once-off onboarding charge rides on the next invoice raised —
    // of any kind — unless the office says no for this one.
    const includeOnboarding = optionalBool(req.body, 'includeOnboarding');
    const purposeRaw = req.body?.purpose;
    if (
      purposeRaw !== undefined &&
      !['initial', 'renewal', 'manual', 'onboarding', 'pro_rata'].includes(String(purposeRaw))
    ) {
      throw new HttpError(
        400,
        'purpose must be one of: initial, renewal, manual, onboarding, pro_rata',
      );
    }
    // A hand-priced invoice must say what it is for. It is how a once-off charge
    // gets a home (installation, training, a data migration), and it is what
    // stops a client receiving a bare "Amount due: R2 500,00" with no subject.
    if (amountCents !== undefined && !description) {
      throw new HttpError(
        400,
        'An invoice with an agreed amount must carry a description of what it is for.',
        'invoice_description_required',
      );
    }

    const company = getCompanyById(companyId);
    if (!company) throw new HttpError(404, 'Company not found');

    const invoice = createInvoiceForCompany(companyId, {
      amountCents: amountCents ?? undefined,
      dueDate: dueDate ?? undefined,
      description: description ?? undefined,
      includeOnboarding,
      purpose: purposeRaw as
        'initial' | 'renewal' | 'manual' | 'onboarding' | 'pro_rata' | undefined,
    });

    res.status(201).json(invoiceToOut(invoice));
  }),
);

/**
 * The invoice as a downloadable PDF — the same builder the mailer attaches, so
 * what the operator saves and what the client receives cannot diverge.
 */
billingRouter.get(
  '/invoices/:id/pdf',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const invoice = getInvoiceById(id);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    const company = getCompanyById(invoice.company_id);
    if (!company) throw new HttpError(404, 'Company not found');

    const pdf = await buildInvoicePdf({ invoice, company, settings: getRawOfficeSettings() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoicePdfFilename(invoice)}"`);
    res.send(pdf);
  }),
);

billingRouter.post(
  '/invoices/:id/pay',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const invoice = getInvoiceById(id);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    if (invoice.status === 'paid') throw new HttpError(409, 'Invoice is already paid');
    if (invoice.status === 'cancelled') throw new HttpError(409, 'Invoice is cancelled');

    const method = req.body?.method || 'manual';
    const validMethods = ['stripe', 'manual', 'bank_transfer', 'credit_card', 'paypal'];
    if (!validMethods.includes(method)) {
      throw new HttpError(
        400,
        `Invalid payment method. Must be one of: ${validMethods.join(', ')}`,
      );
    }

    const amountCents = optionalInt(req.body, 'amountCents') ?? invoice.amount_cents;
    const transactionId = optionalString(req.body, 'transactionId');

    const result = await processPaymentAndRenew({
      invoiceId: id,
      amountCents,
      method,
      transactionId: transactionId || undefined,
    });

    res.json({
      ok: true,
      invoice: invoiceToOut(result.invoice),
      payment: paymentToOut(result.payment),
      newPaidThrough: result.newPaidThrough,
      licencePush: result.licencePush,
    });
  }),
);

billingRouter.post(
  '/invoices/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const invoice = getInvoiceById(id);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    if (invoice.status === 'paid') throw new HttpError(409, 'Cannot cancel a paid invoice');

    const updated = updateInvoice(id, { status: 'cancelled' });

    // A voided invoice must not keep the once-off onboarding charge marked as
    // billed: the charge would then be uncollectable — no invoice carries it, and
    // the client cannot be billed for it again. Only the last standing invoice
    // carrying it releases it.
    let setupFeeReleased = false;
    if ((invoice.setup_fee_cents ?? 0) > 0) {
      const standing = listInvoices(invoice.company_id).filter(
        (i) => i.id !== invoice.id && i.status !== 'cancelled' && (i.setup_fee_cents ?? 0) > 0,
      );
      const subscription = getSubscription(invoice.company_id);
      if (standing.length === 0 && subscription?.setup_fee_status === 'invoiced') {
        setSetupFeeStatus(invoice.company_id, 'not_invoiced');
        setupFeeReleased = true;
      }
    }

    // Voiding an issued document is a privileged act, so it is attributed like
    // every other one (push, pause, licence, settings).
    recordAuditLog('office', 'invoice_voided', 'invoice', invoice.id, {
      before: { status: invoice.status },
      after: { status: 'cancelled', setupFeeReleased },
      reason: `Voided ${invoice.invoice_number}${
        setupFeeReleased ? ' — released the once-off onboarding charge it carried' : ''
      }`,
    });

    res.json({
      ok: true,
      invoice: invoiceToOut(updated!),
      ...(setupFeeReleased ? { setupFeeReleased: true } : {}),
    });
  }),
);

billingRouter.post(
  '/invoices/:id/email',
  asyncHandler(async (req, res) => {
    const id = parseIdParam(req.params.id);
    const invoice = getInvoiceById(id);
    if (!invoice) throw new HttpError(404, 'Invoice not found');

    const company = getCompanyById(invoice.company_id);
    if (!company) throw new HttpError(404, 'Company not found');

    // Who it goes to: an address named for this send, else the client's billing
    // configuration, else the company's billing email.
    const billing = getBillingSettings(company.id);
    const recipient =
      optionalString(req.body, 'email', 254) || billing?.invoice_email || company.billing_email;
    if (!recipient) {
      throw new HttpError(400, 'Recipient billing email is required');
    }

    try {
      await sendInvoiceEmail({ invoice, company, recipient });
    } catch (err) {
      // A refused or unconfigured send is a failure, and the trail says so: an
      // `ok` audit row for an email nobody received is the fabricated success
      // this route used to hand back unconditionally.
      recordAuditLog('office', 'invoice_emailed', 'invoice', invoice.id, {
        after: { invoiceNumber: invoice.invoice_number, recipient },
        reason: err instanceof Error ? err.message : String(err),
        result: 'failed',
      });
      throw err;
    }

    // Stamped only after the mail server accepted the message.
    const updated = recordInvoiceEmail(invoice.id, recipient)!;
    recordAuditLog('office', 'invoice_emailed', 'invoice', invoice.id, {
      after: { invoiceNumber: invoice.invoice_number, recipient },
      reason: `Emailed subscription invoice to ${recipient}`,
    });

    res.json({
      ok: true,
      invoice: invoiceToOut(updated),
      invoiceNumber: invoice.invoice_number,
      recipient,
      sentAt: new Date().toISOString(),
    });
  }),
);

// --- Payments ---

billingRouter.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const companyId = req.query.companyId ? Number(req.query.companyId) : undefined;
    const payments = listPayments(companyId);
    res.json(payments.map(paymentToOut));
  }),
);

// --- Settings ---

billingRouter.get(
  '/settings/:companyId',
  asyncHandler(async (req, res) => {
    const companyId = parseIdParam(req.params.companyId);
    const settings = getBillingSettings(companyId);
    res.json({
      companyId,
      autoRenew: settings ? Boolean(settings.auto_renew) : true,
      emailInvoice: settings ? Boolean(settings.email_invoice) : true,
      invoiceEmail: settings?.invoice_email || '',
    });
  }),
);

billingRouter.put(
  '/settings/:companyId',
  asyncHandler(async (req, res) => {
    const companyId = parseIdParam(req.params.companyId);
    const company = getCompanyById(companyId);
    if (!company) throw new HttpError(404, 'Company not found');

    const autoRenew = req.body?.autoRenew !== undefined ? Boolean(req.body.autoRenew) : undefined;
    const emailInvoice =
      req.body?.emailInvoice !== undefined ? Boolean(req.body.emailInvoice) : undefined;
    const invoiceEmail = optionalString(req.body, 'invoiceEmail');

    const updated = upsertBillingSettings(companyId, {
      auto_renew: autoRenew !== undefined ? (autoRenew ? 1 : 0) : undefined,
      email_invoice: emailInvoice !== undefined ? (emailInvoice ? 1 : 0) : undefined,
      invoice_email: invoiceEmail !== undefined ? invoiceEmail : undefined,
    });

    res.json({
      companyId,
      autoRenew: Boolean(updated.auto_renew),
      emailInvoice: Boolean(updated.email_invoice),
      invoiceEmail: updated.invoice_email || '',
    });
  }),
);

// --- Automated renewal trigger ---

billingRouter.post(
  '/renew-check',
  asyncHandler(async (_req, res) => {
    const summary = await runAutomatedRenewals();
    res.json({
      ok: true,
      summary,
    });
  }),
);
