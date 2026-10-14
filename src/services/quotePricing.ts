import { DEFAULT_FEATURE_PRICES, FEATURE_LABELS, PRICED_FEATURE_KEYS } from './features.js';
import { addonQuantity } from './pricing.js';
import { getRawOfficeSettings } from './officeSettings.js';
import { ValidationError } from '../utils/validate.js';
import { vatPortionCents } from '../utils/money.js';

/**
 * The list price a quote is built from — the marketing page's own figures, held
 * here so the desk prices a configuration for itself instead of trusting the
 * numbers on the wire (the page's `data-cents` are this list's display copy).
 * P5 of the quote-desk plan serves them from the control plane; until then, a
 * page that disagrees with this file is flagged on the record rather than
 * believed (2026-10-13).
 *
 * Since 2026-10-14 the list prices per STORE (its first till included) plus a
 * rate per ADDITIONAL till — `199 + 49 × (tills − stores)`, i.e.
 * `49 × tills + 150 × stores`. The owner settled the additional-till rate at R49
 * the same day: the price of the seat sits level with the per-store add-ons
 * (lay-by, credit, e-commerce), and a store's first till stays inside its rate.
 */
export const LIST_STORE_RATE_CENTS = 19_900; // R199,00 per store per month — first till included
export const LIST_TILL_RATE_CENTS = 4_900; // R49,00 per ADDITIONAL till per month

/** The once-off onboarding charge, by setup variant — the PUBLISHED pair, used
 *  as the fallback when Office Settings has not been read (and by tests). */
export const SETUP_FEE_CENTS = { assisted: 500000, self: 150000 } as const;
export type QuoteSetupVariant = keyof typeof SETUP_FEE_CENTS;

export const QUOTE_SETUP_VARIANTS = Object.keys(SETUP_FEE_CENTS) as QuoteSetupVariant[];

/**
 * The onboarding pair as the office has it configured — the one home for both
 * figures (owner, 2026-10-14). The desk, the onboarding form and the marketing
 * page all read these, so changing a price is a Settings edit rather than a
 * deploy; `SETUP_FEE_CENTS` above is only the fallback default.
 */
export const officeSetupFees = (): Record<QuoteSetupVariant, number> => {
  const row = getRawOfficeSettings();
  return {
    assisted: row.setup_fee_assisted_cents ?? SETUP_FEE_CENTS.assisted,
    self: row.setup_fee_self_cents ?? SETUP_FEE_CENTS.self,
  };
};

export interface QuoteConfig {
  stores: number;
  /** Total tills across the stores (the wire's own count). */
  tills: number;
  /** Add-on keys, from the curated vocabulary. */
  addons: string[];
  setup: QuoteSetupVariant;
  /**
   * The real per-store tills, when the office gave one (e.g. 2, 3, 1). The list
   * is the truth then: `stores` and `tills` are derived from it, so the quote
   * states the estate as it is rather than an even multiplication that isn't.
   */
  tillsSplit?: number[];
}

export interface QuotePricedLine {
  label: string;
  detail: string;
  cents: number;
  /**
   * The unit rate behind the line, in cents, when it has one — the tills line
   * does; a flat add-on's amount *is* its rate. Snapshotted with the quantity
   * so a later list-price change cannot rewrite an issued quote, the way an
   * invoice stores its `terminal_price_cents`.
   */
  rateCents?: number;
  /** The billed quantity the rate multiplies — what the label counts. */
  quantity?: number;
  /** The per-store tills behind the quantity, when the office gave a real split. */
  split?: number[];
}

export interface PricedQuote {
  lines: QuotePricedLine[];
  monthlyTotalCents: number;
  setupCents: number;
  vatRate: number;
  monthlyVatCents: number;
  setupVatCents: number;
}

/** Refuses a configuration the vocabulary does not know, or one that cannot be sold. */
export const validateQuoteConfig = (config: QuoteConfig): void => {
  const unknown = config.addons.filter((key) => !PRICED_FEATURE_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown add-on in the quote: ${unknown.join(', ')}`);
  }
  // The page switches Head Office off at one store (it has no branches to
  // oversee); a post that asks for it anyway is refused by name rather than
  // priced, so the record never quotes a capability the product cannot deliver.
  if (config.addons.includes('multi_store') && config.stores < 2) {
    throw new ValidationError('Head Office needs two or more stores');
  }
  // Every store runs at least one till: a quote with fewer tills than stores is
  // a typo, not a configuration (3 stores × 1 till is 3 tills, not 1 — the desk
  // used to record exactly that).
  if (config.tills < config.stores) {
    throw new ValidationError(
      `Every store runs at least one till — ${config.stores} stores need ${config.stores} tills or more`,
    );
  }
};

/**
 * The configuration as the quote must read it: a real per-store split sets both
 * the store count and the total — the even counts beside it are then ignored,
 * never trusted, because the list is what the office actually knows.
 */
export const resolveQuoteConfig = (config: QuoteConfig): QuoteConfig =>
  config.tillsSplit && config.tillsSplit.length > 0
    ? {
        ...config,
        stores: config.tillsSplit.length,
        tills: config.tillsSplit.reduce((sum, tills) => sum + tills, 0),
      }
    : config;

/**
 * Prices a configuration from the list: the stores (first till of each included
 * in its rate) plus the tills beyond them, the chargeable add-ons in the
 * vocabulary's own order, and the setup variant — VAT-inclusive, with the tax
 * broken out at the office's rate (the same arithmetic as an invoice).
 */
export const priceQuote = (
  configInput: QuoteConfig,
  vatRate: number,
  setupFees: Record<QuoteSetupVariant, number> = officeSetupFees(),
): PricedQuote => {
  const config = resolveQuoteConfig(configInput);
  validateQuoteConfig(config);
  const split = config.tillsSplit && config.tillsSplit.length > 0 ? config.tillsSplit : undefined;
  const perStore =
    !split && config.stores > 0 && config.tills % config.stores === 0
      ? config.tills / config.stores
      : null;
  // The split, spelled out: "(3 × 1)" left the reader guessing which number was
  // which — and it is how a per-store count once got read as a total. A real
  // per-store list is stated as itself; a single-store quote needs no split. The
  // store count is already in the label, so the detail never repeats it.
  const storesDetail =
    config.stores === 1
      ? ''
      : split
        ? `(${split.join(' + ')} across ${config.stores} stores)`
        : perStore === null
          ? ''
          : `(${perStore} till${perStore === 1 ? '' : 's'} per store)`;
  const additional = config.tills - config.stores;
  // The extra tills each store carries, from the real split: the same list, one
  // till removed per store, is what the additional-till rate is charged on.
  const additionalDetail = split
    ? `(${split.map((tills) => Math.max(0, tills - 1)).join(' + ')} extra across ${config.stores} stores)`
    : '';
  const lines: QuotePricedLine[] = [
    {
      label: `${config.stores} store${config.stores === 1 ? '' : 's'}`,
      detail: ['first till included', storesDetail].filter(Boolean).join(' · '),
      cents: config.stores * LIST_STORE_RATE_CENTS,
      rateCents: LIST_STORE_RATE_CENTS,
      quantity: config.stores,
      ...(split ? { split } : {}),
    },
  ];
  if (additional > 0) {
    lines.push({
      label: `${additional} additional till${additional === 1 ? '' : 's'}`,
      detail: additionalDetail,
      cents: additional * LIST_TILL_RATE_CENTS,
      rateCents: LIST_TILL_RATE_CENTS,
      quantity: additional,
    });
  }
  for (const key of PRICED_FEATURE_KEYS) {
    if (!config.addons.includes(key)) continue;
    // An add-on is a per-store capability (owner, 2026-10-14) — Head Office the
    // one exception: there is one panel for the whole company. The rate and
    // quantity travel so the document reads "Lay-by · 3 × R 49,00".
    const unitCents = DEFAULT_FEATURE_PRICES[key] ?? 0;
    const quantity = addonQuantity(key, config.stores);
    lines.push({
      label: FEATURE_LABELS[key] ?? key,
      detail: '',
      cents: unitCents * quantity,
      rateCents: unitCents,
      quantity,
    });
  }
  const monthlyTotalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  const setupCents = setupFees[config.setup] ?? SETUP_FEE_CENTS[config.setup];
  return {
    lines,
    monthlyTotalCents,
    setupCents,
    vatRate,
    monthlyVatCents: vatPortionCents(monthlyTotalCents, vatRate),
    setupVatCents: vatPortionCents(setupCents, vatRate),
  };
};

/**
 * The page prints money as `R 1 234,56`; parsed back to cents so the record can
 * show what the visitor saw beside what the catalogue prices. Anything that does
 * not read as a plain amount stays null — an unreadable figure is a reason to
 * flag drift, never to guess.
 */
export const parseMoneyCents = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Only the shape the page prints — an optional R, digits, spaces, separators.
  // Anything else is not an amount and is not mined for whatever digits it has.
  if (!/^R?[\s\d.,]*$/.test(trimmed)) return null;
  const cleaned = trimmed.replace(/[^\d.,]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalised: string;
  if (lastComma > lastDot) {
    // Comma decimals (the page's own format): dots are thousands separators.
    normalised = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalised = cleaned.replace(/,/g, '');
  } else {
    normalised = cleaned;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  return Math.round(Number(normalised) * 100);
};

/** The add-on keys a caller sent, from the curated vocabulary and nothing else. */
export const parseAddonKeys = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    throw new ValidationError('A quote needs its add-ons (an array — empty is fine)');
  }
  const keys: string[] = [];
  for (const value of raw) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!PRICED_FEATURE_KEYS.includes(key)) {
      throw new ValidationError('Unknown add-on in the quote');
    }
    keys.push(key);
  }
  return keys;
};

/** The once-off a caller chose: assisted or self. */
export const parseSetupVariant = (raw: unknown): QuoteSetupVariant => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!(value in SETUP_FEE_CENTS)) {
    throw new ValidationError('A quote needs its setup choice (assisted or self)');
  }
  return value as QuoteSetupVariant;
};

/**
 * The real per-store till list a caller sent, if any — whole counts, one to
 * fifty stores, and the same 500-till ceiling the even path carries. Absent
 * means "no split given", which is what clears one on an edit.
 */
export const optionalTillsSplit = (body: Record<string, unknown>): number[] | undefined => {
  const raw = body['tillsSplit'];
  if (raw === undefined || raw === null) return undefined;
  const shape = 'The split is a list of per-store till counts (e.g. 2, 3, 1)';
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    throw new ValidationError(shape);
  }
  const split = raw.map((value) => Number(value));
  if (split.some((tills) => !Number.isInteger(tills) || tills < 1 || tills > 50)) {
    throw new ValidationError(shape);
  }
  if (split.reduce((sum, tills) => sum + tills, 0) > 500) {
    throw new ValidationError('The split totals more tills than a quote can carry (500)');
  }
  return split;
};
