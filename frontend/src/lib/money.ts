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
 * The per-store rate and its additional-till pair, in one line — the model's two
 * numbers always read together, with the included first till said out loud so
 * neither is mistaken for the other (2026-10-14).
 */
export const perStoreLabel = (
  storeCents: number,
  tillCents: number,
  period: 'monthly' | 'annual' | 'once-off',
): string => {
  const unit = period === 'monthly' ? 'month' : period === 'annual' ? 'year' : 'once-off';
  return `${rand(storeCents)} / store / ${unit} (first till included) + ${rand(tillCents)} per extra till`;
};

/**
 * The add-ons charged once per COMPANY rather than once per trading store (owner,
 * 2026-10-14): Head Office (one panel for the business) and the e-commerce bridges
 * (one storefront for the business). Mirrors `PER_COMPANY_FEATURE_KEYS` in the
 * server's `services/features.ts` — the two builds cannot share a module, so the
 * rule is stated in both and the server's copy is the authority the invoice uses.
 */
export const PER_COMPANY_ADDONS: readonly string[] = ['multi_store', 'ecommerce_bridges'];

/**
 * The add-on lines a plan sells and the office has ticked in the subscription
 * editor, priced at what THIS client agreed where a price is on record and at the
 * plan's price otherwise — the same order the server's quote uses
 * (`services/pricing.ts`), so the editor's figure and the raised invoice agree.
 *
 * An add-on is charged per TRADING STORE, except the per-company ones above —
 * which is the same rule the server applies in `addonQuantity`.
 *
 * A feature the plan already includes is not offered in the editor, so it cannot
 * appear here; the lines are what the client BOUGHT.
 */
export const addonLinesFor = (
  options: ReadonlyArray<{ key: string; cents: number; label: string }>,
  selected: readonly string[],
  agreedPrices: Record<string, number> = {},
  tradingStores = 1,
): Array<{ key: string; label: string; cents: number; unitCents: number; quantity: number }> =>
  options
    .filter((option) => selected.includes(option.key))
    .map((option) => {
      const unitCents = agreedPrices[option.key] ?? option.cents;
      const quantity = PER_COMPANY_ADDONS.includes(option.key) ? 1 : Math.max(1, tradingStores);
      return {
        key: option.key,
        label: option.label,
        cents: unitCents * quantity,
        unitCents,
        quantity,
      };
    });

/**
 * The assisted-setup fallback. Both onboarding figures now live in Office
 * Settings (2026-10-14) and are read through `lib/officeFees.ts`; these constants
 * are what the office ships with and what a failed read falls back to, so a page
 * never renders an empty price. A plan's own `setupFeeCents` is its SELF figure —
 * the per-tier override of the office's self price.
 */
export const ASSISTED_SETUP_CENTS = 500_000;

/** The self-setup fallback — what Office Settings ships with (see below). */
export const SELF_SETUP_CENTS = 150_000;
