/**
 * The marketing site's quote request, as an email.
 *
 * The site is static, so this is the part it cannot do itself: take a visitor's
 * address and get the quote into the office's inbox. The message goes to the
 * office and **to the visitor** — the promise on the page ("with a copy to you")
 * is kept here, by putting both addresses on one message rather than sending two
 * — with the visitor's address as the reply-to, so hitting Reply answers the
 * person who asked.
 *
 * Everything the visitor typed is treated as untrusted text: escaped for the
 * HTML part, capped in length before it gets here, and never used as a header
 * value except the address, which is validated and shape-checked in the route.
 */
import { sendMail } from './mailer.js';

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

/** Sends the request to the office, with the visitor's own copy on the same message. */
export const sendQuoteRequest = async (
  input: QuoteRequestInput,
): Promise<{ messageId: string; to: string[] }> => {
  const sent = await sendMail({
    to: [input.to, input.email],
    replyTo: input.email,
    subject: quoteRequestSubject(input),
    text: quoteRequestText(input),
    html: quoteRequestHtml(input),
  });
  return { messageId: sent.messageId, to: [input.to, input.email] };
};
