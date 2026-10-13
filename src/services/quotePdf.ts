/**
 * The quotation a quote-desk record becomes, built with pdfkit — the same
 * engine, geometry and conventions as `invoicePdf.ts` (A4, 48pt margins, the
 * brand rule under the header, the money column on the right), deliberately:
 * the office's documents should look like one company's.
 *
 * It is headed **Quotation** and says plainly that it is not a tax invoice.
 * Nothing on it is due — the amounts are VAT-inclusive prices (owner,
 * 2026-09-16) with the tax broken out at the rate snapshotted on the record.
 * The invoice's footer (payment instructions) is deliberately not printed here:
 * nobody owes anything yet.
 */
import PDFDocument from 'pdfkit';
import type { OfficeSettingsRecord, QuoteRecord } from '../config/registryDb.js';
import { formatCents } from '../utils/money.js';
import { AMOUNT_LEFT, AMOUNT_WIDTH, DESCRIPTION_WIDTH, PAGE_RIGHT } from './invoicePdf.js';
import { brandMarkPng } from './brandMark.js';
import type { QuotePricedLine } from './quotePricing.js';

const BRAND = '#059669';
const GRAY = '#64748b';
const INK = '#0f172a';
const MUTED = '#94a3b8';

export interface QuotePdfInput {
  quote: QuoteRecord;
  settings: OfficeSettingsRecord;
}

const setupTitle = (quote: QuoteRecord): string =>
  quote.setup_variant === 'assisted' ? 'Assisted set-up' : 'Self set-up';

const setupDetail = (quote: QuoteRecord): string => {
  if (quote.setup_variant !== 'assisted') return 'you prepare your stores with our guides';
  return quote.stores === 1
    ? 'includes provisioning the store'
    : `includes provisioning all ${quote.stores} stores`;
};

/** Renders the quotation and resolves with the finished document bytes. */
export const buildQuotePdf = ({ quote, settings }: QuotePdfInput): Promise<Buffer> =>
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
    // The mark sits beside the name it belongs to — the site's own lockup.
    const headerTop = doc.y;
    const mark = brandMarkPng();
    const textLeft = mark ? 90 : 48;
    if (mark) doc.image(mark, 48, headerTop, { height: 30 });
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .fillColor(INK)
      .text(settings.office_name, textLeft, headerTop + 1, { width: PAGE_RIGHT - textLeft });
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(GRAY)
      .text(
        [
          settings.office_address,
          settings.office_phone,
          settings.office_email,
          settings.vat_reg_no ? `VAT Reg No ${settings.vat_reg_no}` : '',
        ]
          .filter(Boolean)
          .join('   |   '),
        textLeft,
        doc.y + 3,
        { width: PAGE_RIGHT - textLeft },
      );
    doc.y = Math.max(doc.y, headerTop + 32);
    doc.moveDown(0.4);
    doc.rect(48, doc.y, PAGE_RIGHT - 48, 2).fill(BRAND);
    // The header left the flow cursor beside the mark; body text belongs at the
    // left margin.
    doc.x = 48;
    doc.moveDown(1);

    doc.fontSize(14).font('Helvetica-Bold').fillColor(INK).text('Quotation');
    doc.moveDown(0.15);
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(GRAY)
      .text('This is a quotation, not a tax invoice.');
    doc.moveDown(0.6);

    // --- Metadata: quotation on the left, prepared-for on the right ---
    const top = doc.y;
    doc.fontSize(9).font('Helvetica').fillColor(GRAY);
    const field = (label: string, value: string, y: number, right = false): void => {
      const x = right ? 330 : 48;
      doc.fillColor(GRAY).text(label, x, y, { width: 90 });
      doc.fillColor(INK).text(value, x + 80, y, { width: PAGE_RIGHT - (x + 80) });
    };
    field('QUOTATION', quote.quote_number, top);
    field('ISSUED', quote.created_at.slice(0, 10), top + 14);
    if (quote.valid_until) field('VALID UNTIL', quote.valid_until, top + 28);

    const preparedFor = quote.business || '—';
    field('PREPARED FOR', preparedFor, top, true);
    // A business name wraps, and a wrapped name must push the rest down rather
    // than run into it: the offset is measured, not assumed.
    let rightY = top + doc.heightOfString(preparedFor, { width: PAGE_RIGHT - 410 }) + 4;
    const rightField = (label: string, value: string): void => {
      field(label, value, rightY, true);
      rightY += 14;
    };
    if (quote.contact_name) rightField('CONTACT', quote.contact_name);
    rightField('EMAIL', quote.email);
    if (quote.phone) rightField('PHONE', quote.phone);
    if (quote.vertical) rightField('TRADE', quote.vertical);

    doc.y = Math.max(top + 46, rightY + 4);
    doc.moveDown(0.5);
    let y = rule(doc.y);

    // --- Lines ---
    const money = (value: string, at: number): void => {
      doc.text(value, AMOUNT_LEFT, at, {
        width: AMOUNT_WIDTH,
        align: 'right',
        lineBreak: false,
      });
    };
    const header = (title: string): void => {
      y += 8;
      doc.font('Helvetica').fontSize(8).fillColor(GRAY);
      doc.text(title, 48, y, { width: DESCRIPTION_WIDTH });
      doc.text('AMOUNT (INCL. VAT)', AMOUNT_LEFT, y, { width: AMOUNT_WIDTH, align: 'right' });
      y += 14;
      doc.fontSize(9.5).fillColor(INK);
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

    const pricedLines = JSON.parse(quote.priced_lines_json) as QuotePricedLine[];
    // The detail plus the rate when the line carries one — the invoice's own
    // "7 × R 500,00" shape, so the quotation's arithmetic can be checked.
    const detailFor = (line: QuotePricedLine): string =>
      [
        line.detail,
        line.quantity !== undefined && line.rateCents !== undefined
          ? `${line.quantity} × ${formatCents(line.rateCents)}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
    header('MONTHLY');
    for (const line of pricedLines) row(line.label, detailFor(line), formatCents(line.cents));

    header('ONCE OFF');
    row(setupTitle(quote), setupDetail(quote), formatCents(quote.setup_cents));

    y = rule(Math.max(y + 6, 140));
    y += 12;

    // --- Totals ---
    doc.fontSize(11).font('Helvetica-Bold').fillColor(INK);
    doc.text('Monthly total (incl. VAT)', 300, y, { width: 130 });
    doc.text(formatCents(quote.monthly_total_cents), AMOUNT_LEFT, y, {
      width: AMOUNT_WIDTH,
      align: 'right',
      lineBreak: false,
    });
    y += 16;
    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    doc.text('Set-up, once off (incl. VAT)', 300, y, { width: 130 });
    doc.text(formatCents(quote.setup_cents), AMOUNT_LEFT, y, {
      width: AMOUNT_WIDTH,
      align: 'right',
      lineBreak: false,
    });
    y += 14;
    // Anything that can wrap is measured: the VAT note is two lines of prose in
    // a narrow column, and the closing block flows after its real height.
    const vatNote =
      `Prices include VAT at ${quote.vat_rate}% — ` +
      `${formatCents(quote.monthly_vat_cents)} of the monthly total and ` +
      `${formatCents(quote.setup_vat_cents)} of the set-up.`;
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(vatNote, 300, y, { width: PAGE_RIGHT - 300 });
    y += doc.heightOfString(vatNote, { width: PAGE_RIGHT - 300 }) + 12;

    if (quote.valid_until) {
      doc
        .fontSize(9)
        .fillColor(GRAY)
        .text(`This quotation is valid until ${quote.valid_until}.`, 48, y, { width: 450 });
      y += 14;
    }

    y = Math.max(y + 10, 200);
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Issued by ${settings.office_name} · ${new Date().toISOString().slice(0, 10)}`, 48, y, {
        width: 450,
      });

    doc.end();
  });

/** `VULA-Q-2026-000001.pdf` — a filename an operator can file without opening it. */
export const quotePdfFilename = (quote: QuoteRecord): string => `${quote.quote_number}.pdf`;
