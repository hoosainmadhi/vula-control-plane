import { Router } from 'express';
import {
  listInvoices,
  getInvoiceById,
  updateInvoice,
  listPayments,
  getPaymentById,
  getBillingSettings,
  upsertBillingSettings,
  getCompanyById,
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
  optionalString,
  parseIdParam,
} from '../utils/validate.js';
import {
  createInvoiceForCompany,
  processPaymentAndRenew,
  runAutomatedRenewals,
} from '../services/billing.js';

export const billingRouter = Router();
billingRouter.use(requireOffice);

// --- Wire types ---

export interface InvoiceOut {
  id: number;
  companyId: number;
  companyName: string;
  invoiceNumber: string;
  amountCents: number;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  dueDate: string | null;
  paidDate: string | null;
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
    status: inv.status,
    dueDate: inv.due_date,
    paidDate: inv.paid_date,
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

    const company = getCompanyById(companyId);
    if (!company) throw new HttpError(404, 'Company not found');

    const invoice = createInvoiceForCompany(companyId, {
      amountCents: amountCents ?? undefined,
      dueDate: dueDate ?? undefined,
    });

    res.status(201).json(invoiceToOut(invoice));
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
      throw new HttpError(400, `Invalid payment method. Must be one of: ${validMethods.join(', ')}`);
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
    res.json({ ok: true, invoice: invoiceToOut(updated!) });
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

    const recipient = optionalString(req.body, 'email') || company.billing_email;
    if (!recipient) {
      throw new HttpError(400, 'Recipient billing email is required');
    }

    recordAuditLog('office', 'invoice_emailed', 'invoice', invoice.id, {
      after: { invoiceNumber: invoice.invoice_number, recipient },
      reason: `Emailed subscription invoice to ${recipient}`,
    });

    res.json({
      ok: true,
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
    const emailInvoice = req.body?.emailInvoice !== undefined ? Boolean(req.body.emailInvoice) : undefined;
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
