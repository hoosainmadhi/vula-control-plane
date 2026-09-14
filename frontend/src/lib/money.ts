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

/** The per-terminal rate, always with its recurrence: a bare number is not a price. */
export const perTerminalLabel = (cents: number, period: 'monthly' | 'annual' | 'once-off'): string =>
  `${rand(cents)} / terminal / ${period === 'monthly' ? 'month' : period === 'annual' ? 'year' : 'once-off'}`;
