/**
 * Cents → a rand label, for the server-side documents the control plane sends
 * (today: the invoice email body).
 *
 * Money is integer cents everywhere on the wire and in the registry; this is a
 * display helper and computes nothing. It mirrors `frontend/src/lib/money.ts`
 * deliberately — the SPA renders amounts in the browser, the mailer renders them
 * in the mail server, and the two cannot share a module across the build.
 */
const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });

export const formatCents = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '—' : zar.format(cents / 100);

/**
 * VAT on a **VAT-inclusive** amount (owner decision, 2026-09-16: the prices this
 * office quotes are inclusive). The portion is `inclusive − exclusive` with the
 * exclusive figure rounded to the cent, so the two always add back to the amount
 * the client is charged — never a rounding drift of a cent on an invoice.
 *
 * Integer arithmetic only; mirrors the tenant's `utils/money.ts`.
 */
export const vatPortionCents = (inclusiveCents: number, vatRate: number): number => {
  if (vatRate <= 0) return 0;
  const exclusive = Math.round((inclusiveCents * 100) / (100 + vatRate));
  return inclusiveCents - exclusive;
};

/** The VAT-exclusive amount behind a VAT-inclusive one. */
export const exclusiveCents = (inclusiveCents: number, vatRate: number): number =>
  inclusiveCents - vatPortionCents(inclusiveCents, vatRate);
