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
