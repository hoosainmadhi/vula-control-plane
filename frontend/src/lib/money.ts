/**
 * Money is integer cents on the wire and in the registry; rands exist only in
 * inputs and labels. One formatter, so every screen agrees.
 */
const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });

export const rand = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '—' : zar.format(cents / 100);

/** Rands entered in a form → integer cents. Never a float on the wire. */
export const toCents = (rands: string): number => {
  const value = Number.parseFloat(rands || '0');
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

export const toRands = (cents: number | null | undefined): string =>
  ((cents ?? 0) / 100).toFixed(2);

export const PERIOD_LABEL: Record<'monthly' | 'annual' | 'once-off', string> = {
  monthly: 'per month',
  annual: 'per year',
  'once-off': 'once-off',
};

/**
 * The per-terminal rate, always with its recurrence: a bare number is not a price.
 *
 * Prices this office quotes are **VAT-inclusive** (owner, 2026-09-16), so the
 * label says so — otherwise the office reads a rate as ex-VAT and the invoice
 * adds a tax line nobody planned for.
 */
export const perTerminalLabel = (
  cents: number,
  period: 'monthly' | 'annual' | 'once-off',
): string =>
  `${rand(cents)} / terminal / ${period === 'monthly' ? 'month' : period === 'annual' ? 'year' : 'once-off'} incl. VAT`;

/**
 * The add-on lines a plan sells and the office has ticked in the subscription
 * editor, priced at what THIS client agreed where a price is on record and at the
 * plan's price otherwise — the same order the server's quote uses
 * (`services/pricing.ts`), so the editor's figure and the raised invoice agree.
 *
 * A feature the plan already includes is not offered in the editor, so it cannot
 * appear here; the lines are what the client BOUGHT.
 */
export const addonLinesFor = (
  options: ReadonlyArray<{ key: string; cents: number; label: string }>,
  selected: readonly string[],
  agreedPrices: Record<string, number> = {},
): Array<{ key: string; label: string; cents: number }> =>
  options
    .filter((option) => selected.includes(option.key))
    .map((option) => ({
      key: option.key,
      label: option.label,
      cents: agreedPrices[option.key] ?? option.cents,
    }));
