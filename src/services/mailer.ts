/**
 * The control plane's SMTP mailer.
 *
 * Until this existed, `POST /api/billing/invoices/:id/email` audited an email,
 * answered `ok: true` with a `sentAt` and **sent nothing** — a fabricated
 * success on the billing surface. Everything that claims to have emailed a
 * client now goes through here, and a refusal or a transport failure reaches the
 * operator as an error rather than a cheerfully green toast.
 *
 * The transport is built per send from the stored settings (never cached), so a
 * corrected credential takes effect on the next attempt instead of on the next
 * restart. Credentials are stored plainly, like the tenant's mailer: keep the
 * registry file's permissions tight (see tidbits.md on secret-at-rest
 * encryption).
 */
import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import { HttpError } from '../utils/errors.js';
import { formatCents } from '../utils/money.js';
import { getRawOfficeSettings } from './officeSettings.js';
import { invoiceLineItems } from './billing.js';
import { buildInvoicePdf, invoicePdfFilename } from './invoicePdf.js';
import type { CompanyRecord, InvoiceRecord, OfficeSettingsRecord } from '../config/registryDb.js';

/** SMTP is not configured, or refused the message. 502 — the CP is fine, the relay is not. */
export class MailerError extends HttpError {
  constructor(message: string) {
    super(502, message, 'mailer_failed');
    this.name = 'MailerError';
  }
}

/** 400 — the settings themselves are incomplete, which the operator can fix. */
export class SmtpNotConfiguredError extends HttpError {
  constructor() {
    super(
      400,
      'SMTP is not configured. Set the mail server in Settings before sending mail.',
      'smtp_not_configured',
    );
    this.name = 'SmtpNotConfiguredError';
  }
}

export const isSmtpConfigured = (
  settings: OfficeSettingsRecord = getRawOfficeSettings(),
): boolean => Boolean(settings.smtp_host);

/** The envelope sender. Falls back to the SMTP user so a relay accepts the mail. */
const senderFor = (settings: OfficeSettingsRecord): string =>
  settings.smtp_from || settings.smtp_user || settings.office_email;

const createTransport = (settings: OfficeSettingsRecord): nodemailer.Transporter =>
  nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port,
    // Implicit TLS on the submission port; STARTTLS is negotiated otherwise.
    secure: settings.smtp_port === 465,
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: settings.smtp_pass } : undefined,
  });

/**
 * Sends a message, converting any nodemailer failure into a typed 502 whose text
 * is safe to show an operator (nodemailer's codes are about the relay, not the
 * client's data).
 */
const send = async (message: SendMailOptions): Promise<{ messageId: string }> => {
  const settings = getRawOfficeSettings();
  if (!isSmtpConfigured(settings)) throw new SmtpNotConfiguredError();
  if (!senderFor(settings)) {
    throw new HttpError(
      400,
      'Set a from-address (or an SMTP user) in Settings so the mail has a sender.',
      'smtp_sender_missing',
    );
  }
  try {
    const info = await createTransport(settings).sendMail(message);
    return { messageId: info.messageId ?? '' };
  } catch (err) {
    throw new MailerError(
      `Mail server refused the message: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Proof that the stored credentials work. Sent to the office, never to a client. */
export const sendTestEmail = async (to: string): Promise<{ messageId: string; to: string }> => {
  const settings = getRawOfficeSettings();
  const sent = await send({
    from: senderFor(settings),
    to,
    subject: `Vula control plane — SMTP test from ${settings.office_name}`,
    text: `SMTP settings work. Sent ${new Date().toISOString()} by ${settings.office_name}.`,
    html: `<p>SMTP settings work for <strong>${esc(settings.office_name)}</strong>.</p><p>Sent ${esc(
      new Date().toISOString(),
    )} by ${esc(settings.office_name)}.</p>`,
  });
  return { ...sent, to };
};

export interface InvoiceEmailInput {
  invoice: InvoiceRecord;
  company: CompanyRecord;
  recipient: string;
}

/**
 * The subscription invoice, as the client receives it: the vendor's identity,
 * the line the client is being billed for, and the arithmetic behind it. Only
 * what the control plane already knows about the invoice is stated — no till
 * counts beyond the licensed quantity on the line, and no store data.
 */
export const invoiceHtml = (
  { invoice, company }: InvoiceEmailInput,
  settings: OfficeSettingsRecord,
): string => {
  // One shared line model for every invoice document (`invoiceLineItems`).
  const rows = invoiceLineItems(invoice).map(
    (item) =>
      `<tr><td style="padding:4px 0">${esc(item.label)}${
        item.detail
          ? `<br><span style="color:#94a3b8;font-size:11px">${esc(item.detail)}</span>`
          : ''
      }</td><td style="text-align:right;vertical-align:top;white-space:nowrap">${formatCents(
        item.amountCents,
      )}</td></tr>`,
  );

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
    <div style="border-bottom:3px solid #059669;padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:20px;font-weight:bold">${esc(settings.office_name)}</div>
      <div style="color:#64748b;font-size:13px">${esc(settings.office_address)}</div>
      <div style="color:#64748b;font-size:13px">${esc(settings.office_email)}${
        settings.office_phone ? ` · ${esc(settings.office_phone)}` : ''
      }</div>
    </div>
    <h2 style="margin:0 0 4px;font-size:16px">${
      // Registered for VAT → the document is a tax invoice, same as the PDF.
      settings.vat_reg_no ? 'Tax invoice' : 'Subscription invoice'
    } ${esc(invoice.invoice_number)}</h2>
    <p style="margin:0 0 16px;color:#64748b;font-size:13px">${
      invoice.description ? `${esc(invoice.description)} · ` : ''
    }For ${esc(company.name)}${invoice.due_date ? ` · due ${esc(invoice.due_date)}` : ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tbody>${rows.join('')}</tbody>
    </table>
    <table style="width:100%;margin-top:10px;font-size:14px;border-top:1px solid #e2e8f0">
      <tbody>
        ${
          // VAT-inclusive prices: state the split above the total. Older invoices
          // carry no split and show the total alone (see invoicePdf).
          invoice.subtotal_cents !== null && invoice.vat_cents !== null
            ? `<tr><td style="padding-top:8px;color:#64748b">Subtotal (excl. VAT)</td>
                 <td style="text-align:right;padding-top:8px;color:#64748b">${formatCents(
                   invoice.subtotal_cents,
                 )}</td></tr>
               <tr><td style="color:#64748b">VAT at ${invoice.vat_rate ?? 0}%</td>
                 <td style="text-align:right;color:#64748b">${formatCents(invoice.vat_cents)}</td></tr>`
            : ''
        }
        <tr><td style="padding-top:8px"><strong>${
          invoice.subtotal_cents !== null ? 'Total (incl. VAT)' : 'Amount due'
        }</strong></td>
            <td style="text-align:right;padding-top:8px"><strong>${formatCents(
              invoice.amount_cents,
            )}</strong></td></tr>
      </tbody>
    </table>
    ${
      settings.invoice_footer
        ? `<p style="margin-top:16px;color:#64748b;font-size:12px;white-space:pre-line">${esc(
            settings.invoice_footer,
          )}</p>`
        : ''
    }
    <p style="margin-top:24px;color:#94a3b8;font-size:11px">Sent by ${esc(
      settings.office_name,
    )} · the invoice is attached as a PDF</p>
  </div>`;
};

export const sendInvoiceEmail = async (
  input: InvoiceEmailInput,
): Promise<{ messageId: string; recipient: string }> => {
  const settings = getRawOfficeSettings();
  // The same document the operator can download from Billing: one builder, so
  // the attachment and the download cannot drift apart.
  const pdf = await buildInvoicePdf({
    invoice: input.invoice,
    company: input.company,
    settings,
  });
  const sent = await send({
    from: senderFor(settings),
    to: input.recipient,
    subject: `Invoice ${input.invoice.invoice_number} from ${settings.office_name}`,
    text: `${settings.office_name} — invoice ${input.invoice.invoice_number} for ${
      input.company.name
    }: ${formatCents(input.invoice.amount_cents)}${
      input.invoice.due_date ? `, due ${input.invoice.due_date}` : ''
    }. The invoice is attached as a PDF.`,
    html: invoiceHtml(input, settings),
    attachments: [
      {
        filename: invoicePdfFilename(input.invoice),
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  });
  return { ...sent, recipient: input.recipient };
};

export interface AdminCredentialsEmailInput {
  /** The store or Head Office name the recipient will recognise. */
  surface: string;
  /** Where the recipient signs in — that deployment's own origin. */
  loginUrl: string;
  adminEmail: string;
  tempPassword: string;
}

/**
 * The one-time login for a newly bootstrapped store or Head Office admin.
 * The control plane never stores these passwords, so this email is the
 * durable copy the outlet keeps. The tenant keeps the password working until
 * it is changed — there is no forced first-login reset (owner decision,
 * 2026-10-02), which makes this delivery the credential, not a placeholder.
 */
export const sendAdminCredentialsEmail = async (
  input: AdminCredentialsEmailInput,
): Promise<{ messageId: string; recipient: string }> => {
  const settings = getRawOfficeSettings();
  const sent = await send({
    from: senderFor(settings),
    to: input.adminEmail,
    subject: `Your ${input.surface} login — from ${settings.office_name}`,
    text:
      `${settings.office_name} set up your point-of-sale login for ${input.surface}.\n\n` +
      `Sign in at ${input.loginUrl}\n` +
      `Email: ${input.adminEmail}\n` +
      `Password: ${input.tempPassword}\n\n` +
      `Keep this message — for security the password is not stored anywhere and cannot be looked up later.`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
      <div style="border-bottom:3px solid #059669;padding-bottom:12px;margin-bottom:16px">
        <div style="font-size:20px;font-weight:bold">${esc(settings.office_name)}</div>
      </div>
      <h2 style="margin:0 0 8px;font-size:16px">Your ${esc(input.surface)} login</h2>
      <p style="margin:0 0 12px;color:#64748b;font-size:13px">Sign in at <strong>${esc(
        input.loginUrl,
      )}</strong></p>
      <table style="font-size:14px"><tbody>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Email</td><td style="padding:4px 0">${esc(
          input.adminEmail,
        )}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Password</td><td style="padding:4px 0"><strong>${esc(
          input.tempPassword,
        )}</strong></td></tr>
      </tbody></table>
      <p style="margin-top:12px;color:#64748b;font-size:12px">Keep this message — for security the password is not stored anywhere and cannot be looked up again.</p>
      <p style="margin-top:24px;color:#94a3b8;font-size:11px">Sent by ${esc(settings.office_name)}</p>
    </div>`,
  });
  return { ...sent, recipient: input.adminEmail };
};

export interface AdminCredentialsDelivery {
  emailed: boolean;
  emailedTo?: string;
  emailError?: string;
}

/**
 * Best-effort delivery: a bootstrap or reset must not fail because SMTP is
 * unconfigured or the relay refused — the caller reports the outcome (a step
 * warning, a response field) and the operator can re-issue via the Admin
 * password action. The password passes through to the message body only.
 */
export const trySendAdminCredentialsEmail = async (
  input: AdminCredentialsEmailInput,
): Promise<AdminCredentialsDelivery> => {
  try {
    const sent = await sendAdminCredentialsEmail(input);
    return { emailed: true, emailedTo: sent.recipient };
  } catch (err) {
    return {
      emailed: false,
      emailError: err instanceof Error ? err.message : String(err),
    };
  }
};
