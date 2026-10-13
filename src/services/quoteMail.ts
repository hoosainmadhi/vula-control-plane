/**
 * The quote desk's emails: the request as it arrives, and the quotation it sends.
 *
 * The site is static, so receiving is the part it cannot do itself: take a
 * visitor's address and get the quote into the office's inbox — the desk's copy
 * carries the record's number, the visitor keeps the copy the page promises, and
 * both answer the visitor. Sending is the other direction: the quotation itself
 * goes to the prospect as a PDF, answering the office.
 *
 * Everything the visitor typed is treated as untrusted text: escaped for the
 * HTML part, capped in length before it gets here, and never used as a header
 * value except the address, which is validated and shape-checked in the route.
 */
import { sendMail } from './mailer.js';
import { formatCents } from '../utils/money.js';

export interface QuoteLine {
  label: string;
  amount: string;
}

export interface QuoteRequestInput {
  /** The office's inbox. `QUOTE_TO` overrides the default. */
  to: string;
  business: string;
  name: string;
  email: string;
  phone: string;
  /** The trade, as the visitor described it (the product's own vocabulary). */
  vertical: string;
  note: string;
  stores: number;
  tills: number;
  lines: QuoteLine[];
  monthlyTotal: string;
  setupLabel: string;
  setupAmount: string;
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const quoteRequestSubject = (input: QuoteRequestInput): string =>
  `Quote request — ${input.business || 'a visitor'}: ${input.monthlyTotal} / month, ${input.stores} store${input.stores === 1 ? '' : 's'}`;

/** Plain text first: it is what a phone's notification and most previewers show. */
export const quoteRequestText = (input: QuoteRequestInput): string =>
  [
    'A quote request from the Vula website.',
    '',
    `Business: ${input.business || '(not given)'}`,
    `Name: ${input.name || '(not given)'}`,
    `Email: ${input.email}`,
    `Mobile: ${input.phone}`,
    `Trade: ${input.vertical || '(not given)'}`,
    '',
    'The quote they built:',
    ...input.lines.map((l) => `  • ${l.label}: ${l.amount}`),
    '',
    `Monthly total: ${input.monthlyTotal}`,
    `${input.setupLabel}: ${input.setupAmount}`,
    ...(input.note ? ['', 'Their note:', input.note] : []),
    '',
    'Reply to this message to answer them — it goes to their address.',
  ].join('\n');

export const quoteRequestHtml = (input: QuoteRequestInput): string => {
  const rows = input.lines
    .map(
      (l) =>
        `<tr><td style="padding:3px 0">${esc(l.label)}</td>` +
        `<td style="text-align:right;padding:3px 0;white-space:nowrap">${esc(l.amount)}</td></tr>`,
    )
    .join('');
  const detail = (label: string, value: string): string =>
    `<tr><td style="padding:1px 0;color:#64748b">${esc(label)}</td>` +
    `<td style="padding:1px 0">${esc(value)}</td></tr>`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
    <div style="border-bottom:3px solid #059669;padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:18px;font-weight:bold">Quote request</div>
      <div style="color:#64748b;font-size:13px">From the Vula website</div>
    </div>
    <table style="font-size:14px">
      <tbody>
        ${detail('Business', input.business || '(not given)')}
        ${detail('Name', input.name || '(not given)')}
        ${detail('Email', input.email)}
        ${detail('Mobile', input.phone)}
        ${detail('Trade', input.vertical || '(not given)')}
      </tbody>
    </table>
    <h3 style="margin:20px 0 6px;font-size:14px">The quote they built</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tbody>${rows}
        <tr><td style="padding-top:10px"><strong>Monthly total</strong></td>
            <td style="text-align:right;padding-top:10px"><strong>${esc(input.monthlyTotal)}</strong></td></tr>
        <tr><td style="color:#64748b">${esc(input.setupLabel)}</td>
            <td style="text-align:right;color:#64748b">${esc(input.setupAmount)}</td></tr>
      </tbody>
    </table>
    ${
      input.note
        ? `<h3 style="margin:20px 0 6px;font-size:14px">Their note</h3>
           <p style="margin:0;white-space:pre-line">${esc(input.note)}</p>`
        : ''
    }
    <p style="margin-top:24px;color:#94a3b8;font-size:12px">Reply to this message to answer
    ${esc(input.email)} — the reply-to is their address.</p>
  </div>`;
};

/**
 * The page's figures when they disagree with the catalogue — both sides, so the
 * office reads the delta rather than a verdict. Null when they agree.
 */
export interface QuoteDrift {
  requestedMonthlyCents: number | null;
  requestedSetupCents: number | null;
  monthlyTotalCents: number;
  setupCents: number;
}

/** What the desk's copy and subject need beyond the request itself. */
export interface QuoteDeskNotice {
  /** The record's number, `VULA-Q-…`. */
  number: string;
  /** The catalogue's monthly total — the figure the desk quotes from. */
  monthlyTotalCents: number;
  drift: QuoteDrift | null;
}

export const officeQuoteSubject = (input: QuoteRequestInput, notice: QuoteDeskNotice): string =>
  `Quote request ${notice.number} — ${input.business || 'a visitor'}: ${formatCents(notice.monthlyTotalCents)} / month, ${input.stores} store${input.stores === 1 ? '' : 's'}`;

const driftText = (drift: QuoteDrift): string =>
  [
    '',
    'Note: the page showed different figures than the catalogue prices —',
    `  page:      ${formatCents(drift.requestedMonthlyCents)} / month · ${formatCents(drift.requestedSetupCents)} set-up`,
    `  catalogue: ${formatCents(drift.monthlyTotalCents)} / month · ${formatCents(drift.setupCents)} set-up`,
    "Quote from the catalogue's figures; the page's copy is stale.",
  ].join('\n');

const driftHtml = (drift: QuoteDrift): string =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:16px auto 0;padding:10px 14px;border:1px solid #fbbf24;background:#fffbeb;color:#78350f;font-size:13px">
     <strong>Note:</strong> the page showed different figures than the catalogue prices —
     page ${esc(formatCents(drift.requestedMonthlyCents))} / month · ${esc(formatCents(drift.requestedSetupCents))} set-up;
     catalogue ${esc(formatCents(drift.monthlyTotalCents))} / month · ${esc(formatCents(drift.setupCents))} set-up.
     Quote from the catalogue's figures; the page's copy is stale.
   </div>`;

/** The desk's copy: the number up top, then the request, then any drift. */
export const officeQuoteText = (input: QuoteRequestInput, notice: QuoteDeskNotice): string =>
  [
    `Quote request ${notice.number}`,
    '',
    quoteRequestText(input),
    ...(notice.drift ? [driftText(notice.drift)] : []),
  ].join('\n');

export const officeQuoteHtml = (input: QuoteRequestInput, notice: QuoteDeskNotice): string =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#64748b;font-size:13px">
     Quote request <strong>${esc(notice.number)}</strong>
   </div>` +
  quoteRequestHtml(input) +
  (notice.drift ? driftHtml(notice.drift) : '');

/**
 * Sends the desk's copy and the visitor's copy — two messages, because they are
 * two different things: the desk's carries the record's number and the
 * catalogue's figure (flagging any drift), the visitor's is the copy the page
 * promises. Both answer the visitor. The desk's goes first: it is the one that
 * must arrive, and a refusal fails the request while the record survives either
 * way (the route stamps the outcome).
 */
export const sendQuoteRequest = async (
  input: QuoteRequestInput,
  notice: QuoteDeskNotice,
): Promise<void> => {
  await sendMail({
    to: [input.to],
    replyTo: input.email,
    subject: officeQuoteSubject(input, notice),
    text: officeQuoteText(input, notice),
    html: officeQuoteHtml(input, notice),
  });
  await sendMail({
    to: [input.email],
    replyTo: input.email,
    subject: quoteRequestSubject(input),
    text: quoteRequestText(input),
    html: quoteRequestHtml(input),
  });
};

/** What the document email needs — the record's facts, already computed. */
export interface QuoteDocumentInput {
  number: string;
  business: string;
  contactName: string;
  email: string;
  officeName: string;
  /** Where a reply should land — the office's own address. */
  replyTo: string | undefined;
  monthlyTotalCents: number;
  setupCents: number;
  validUntil: string;
}

export const quoteDocumentSubject = (input: QuoteDocumentInput): string =>
  `Quotation ${input.number} — ${input.business || 'your Vula quote'}`;

export const quoteDocumentText = (input: QuoteDocumentInput): string =>
  [
    `Hello ${input.contactName || 'there'},`,
    '',
    'Thank you for your interest in Vula. Here is the quotation we built for you:',
    '',
    `  ${formatCents(input.monthlyTotalCents)} / month (incl. VAT)`,
    `  ${formatCents(input.setupCents)} set-up, once off (incl. VAT)`,
    '',
    `It is valid until ${input.validUntil}. The full quotation is attached as a PDF.`,
    '',
    'Reply to this email and it comes straight to us.',
    '',
    input.officeName,
  ].join('\n');

export const quoteDocumentHtml = (input: QuoteDocumentInput): string =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
    <div style="border-bottom:3px solid #059669;padding-bottom:12px;margin-bottom:16px">
      <div style="font-size:18px;font-weight:bold">Quotation ${esc(input.number)}</div>
      <div style="color:#64748b;font-size:13px">From ${esc(input.officeName)}</div>
    </div>
    <p>Hello ${esc(input.contactName || 'there')},</p>
    <p>Thank you for your interest in Vula. Here is the quotation we built for you — the full
    document is attached as a PDF.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tbody>
        <tr><td style="padding:3px 0">Monthly (incl. VAT)</td>
            <td style="text-align:right;padding:3px 0"><strong>${esc(formatCents(input.monthlyTotalCents))}</strong></td></tr>
        <tr><td style="padding:3px 0;color:#64748b">Set-up, once off (incl. VAT)</td>
            <td style="text-align:right;padding:3px 0;color:#64748b">${esc(formatCents(input.setupCents))}</td></tr>
        <tr><td style="padding:3px 0;color:#64748b">Valid until</td>
            <td style="text-align:right;padding:3px 0;color:#64748b">${esc(input.validUntil)}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:24px;color:#94a3b8;font-size:12px">Reply to this email and it comes
    straight to us.</p>
  </div>`;

/**
 * Sends the quotation document itself: the PDF attachment to the prospect,
 * answering the office. The covering note stays short — the attached quotation
 * is the document, and the email is the envelope.
 */
export const sendQuoteDocument = async (input: QuoteDocumentInput, pdf: Buffer): Promise<void> => {
  await sendMail({
    to: [input.email],
    replyTo: input.replyTo,
    subject: quoteDocumentSubject(input),
    text: quoteDocumentText(input),
    html: quoteDocumentHtml(input),
    attachments: [{ filename: `${input.number}.pdf`, content: pdf }],
  });
};
