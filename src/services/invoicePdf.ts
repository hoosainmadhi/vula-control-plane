/**
 * The subscription invoice as a PDF, built with pdfkit — the same engine and
 * layout conventions as the tenant's documents (A4, 48pt margins, a brand rule
 * under the header, a totals block on the right).
 *
 * The document carries the **vendor's** identity and the client's name, the
 * description of the charge, and the arithmetic behind the amount. It carries no
 * store data and no till counts beyond the licensed quantity on the recurring
 * line: the invoice is about what the client bought, not about their trading.
 */
import PDFDocument from 'pdfkit';
import type { CompanyRecord, InvoiceRecord, OfficeSettingsRecord } from '../config/registryDb.js';
import { formatCents } from '../utils/money.js';
import { SETUP_FEE_LINE_LABEL } from './billing.js';

const BRAND = '#059669';
const GRAY = '#64748b';
const INK = '#0f172a';
const MUTED = '#94a3b8';
/**
 * Right edge of the content box: A4 width (595pt) less the 48pt margins.
 */
export const PAGE_RIGHT = 547;
/**
 * The money column. Wide enough for seven figures at 11pt bold, and rendered
 * with `lineBreak: false` so a figure can never be split across two lines —
 * "R 14 500,0 / 0" is not an amount anyone should have to read.
 */
export const AMOUNT_LEFT = 437;
export const AMOUNT_WIDTH = PAGE_RIGHT - AMOUNT_LEFT;
/** The description/label column, kept clear of the money column. */
export const DESCRIPTION_WIDTH = 340;

/**
 * How wide a figure is at a given size, in the font it is drawn in — measured
 * with pdfkit's own metrics, so the check cannot drift from the renderer.
 */
export const moneyWidth = (label: string, font = 'Helvetica-Bold', size = 11): number => {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.font(font).fontSize(size);
  const width = doc.widthOfString(label);
  doc.end();
  return width;
};

/**
 * Does a figure fit the money column at the size it is drawn? The column width
 * is the one thing about this document that a bug breaks silently: too narrow,
 * and pdfkit wraps the number across two lines.
 */
export const moneyColumnFits = (label: string, font?: string, size?: number): boolean =>
  moneyWidth(label, font, size) <= AMOUNT_WIDTH;

export interface InvoicePdfInput {
  invoice: InvoiceRecord;
  company: CompanyRecord;
  settings: OfficeSettingsRecord;
}

/** Renders the invoice and resolves with the finished document bytes. */
export const buildInvoicePdf = ({ invoice, company, settings }: InvoicePdfInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const rule = (y: number): number => {
      doc.moveTo(48, y).lineTo(PAGE_RIGHT, y).strokeColor('#cbd5e1').lineWidth(1).stroke();
      return y;
    };

    // --- Header: the vendor, not the merchant ---
    doc.fontSize(18).font('Helvetica-Bold').fillColor(INK).text(settings.office_name);
    doc.moveDown(0.2);
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(GRAY)
      .text(
        [settings.office_address, settings.office_phone, settings.office_email]
          .filter(Boolean)
          .join('   |   '),
      );
    doc.moveDown(0.4);
    doc.rect(48, doc.y, PAGE_RIGHT - 48, 2).fill(BRAND);
    doc.moveDown(1);

    doc.fontSize(14).font('Helvetica-Bold').fillColor(INK).text('Subscription invoice');
    // The subject sits with the title, not in the amounts column: it is what the
    // invoice is about, and a line in the table with no amount reads as an
    // uncharged item.
    if (invoice.description) {
      doc.moveDown(0.15);
      doc.fontSize(9).font('Helvetica').fillColor(GRAY).text(invoice.description);
    }
    doc.moveDown(0.6);

    // --- Metadata: invoice on the left, billed-to on the right ---
    const top = doc.y;
    doc.fontSize(9).font('Helvetica').fillColor(GRAY);
    const field = (label: string, value: string, y: number, right = false): void => {
      const x = right ? 330 : 48;
      doc.fillColor(GRAY).text(label, x, y, { width: 90 });
      doc.fillColor(INK).text(value, x + 80, y, { width: PAGE_RIGHT - (x + 80) });
    };
    field('INVOICE', invoice.invoice_number, top);
    field('ISSUED', invoice.created_at.slice(0, 10), top + 14);
    if (invoice.due_date) field('DUE', invoice.due_date, top + 28);
    field('STATUS', invoice.status.toUpperCase(), top + 42);

    field('BILLED TO', company.name, top, true);
    // Merchant names wrap, and a wrapped name must push the address down rather
    // than run into it: the offset is measured, not assumed.
    const billedToBottom = top + doc.heightOfString(company.name, { width: PAGE_RIGHT - 410 }) + 4;
    if (company.billing_email) field('EMAIL', company.billing_email, billedToBottom, true);

    doc.y = Math.max(top + 60, billedToBottom + 18);
    doc.moveDown(0.5);
    let y = rule(doc.y);

    // --- Lines ---
    y += 8;
    doc.fontSize(8).fillColor(GRAY);
    doc.text('DESCRIPTION', 48, y, { width: DESCRIPTION_WIDTH });
    doc.text('AMOUNT', AMOUNT_LEFT, y, { width: AMOUNT_WIDTH, align: 'right' });
    y += 14;

    doc.fontSize(9.5).fillColor(INK);
    const money = (value: string, at: number): void => {
      doc.text(value, AMOUNT_LEFT, at, {
        width: AMOUNT_WIDTH,
        align: 'right',
        lineBreak: false,
      });
    };
    const row = (label: string, detail: string, amount: string): void => {
      doc.font('Helvetica').text(label, 48, y, { width: DESCRIPTION_WIDTH });
      if (detail) {
        doc
          .fontSize(8)
          .fillColor(GRAY)
          .text(detail, 48, y + 11, { width: DESCRIPTION_WIDTH });
        doc.fontSize(9.5).fillColor(INK);
      }
      money(amount, y);
      y += detail ? 28 : 16;
    };

    // The once-off charge leads the lines whenever it is on the invoice: it is
    // the first thing the client is being asked to pay for (owner, 2026-09-16).
    if (invoice.setup_fee_cents) {
      row(
        SETUP_FEE_LINE_LABEL,
        'Once-off — charged when the subscription starts',
        formatCents(invoice.setup_fee_cents),
      );
    }
    if (invoice.terminal_count !== null && invoice.terminal_price_cents !== null) {
      row(
        'Licensed terminals',
        '',
        `${invoice.terminal_count} × ${formatCents(invoice.terminal_price_cents)}`,
      );
    }
    if (!invoice.description && !invoice.terminal_count && !invoice.setup_fee_cents) {
      doc.fillColor(GRAY).fontSize(9).text('Subscription charge', 48, y);
      y += 16;
      doc.fillColor(INK).fontSize(9.5);
    }

    y = rule(Math.max(y + 6, 140));
    y += 12;

    // --- Total ---
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK);
    doc.text('Amount due', 300, y, { width: 130 });
    doc.text(formatCents(invoice.amount_cents), AMOUNT_LEFT, y, {
      width: AMOUNT_WIDTH,
      align: 'right',
      lineBreak: false,
    });
    y += 20;
    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    if (invoice.paid_date) {
      doc.fillColor(BRAND).text(`Settled ${invoice.paid_date}`, 330, y, {
        width: PAGE_RIGHT - 330,
        align: 'right',
      });
      y += 14;
    }

    // Payment instructions sit under the charge block, not at the foot of the
    // page: a one-line invoice on A4 otherwise leaves half the sheet blank.
    y = Math.max(y + 20, 200);
    if (settings.invoice_footer) {
      doc.fontSize(9).fillColor(GRAY).text(settings.invoice_footer, 48, y, { width: 450 });
      y += doc.heightOfString(settings.invoice_footer, { width: 450 }) + 6;
    }

    y += 24;
    // Flows after the charge block rather than being pinned to the foot of the
    // page: a one-line invoice on A4 otherwise leaves half the sheet blank.
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Issued by ${settings.office_name} · ${new Date().toISOString().slice(0, 10)}`, 48, y, {
        width: 450,
      });

    doc.end();
  });

/** `INV-20260916-1234.pdf` — a filename an operator can file without opening it. */
export const invoicePdfFilename = (invoice: InvoiceRecord): string =>
  `${invoice.invoice_number}.pdf`;
