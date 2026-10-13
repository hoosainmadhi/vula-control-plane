import { DEFAULT_FEATURE_PRICES, FEATURE_LABELS, PRICED_FEATURE_KEYS } from './features.js';
import { ValidationError } from '../utils/validate.js';
import { vatPortionCents } from '../utils/money.js';

/**
 * The list price a quote is built from — the marketing page's own figures, held
 * here so the desk prices a configuration for itself instead of trusting the
 * numbers on the wire (the page's `data-cents` are this list's display copy).
 * P4 of the quote-desk plan serves them from the control plane; until then, a
 * page that disagrees with this file is flagged on the record rather than
 * believed (2026-10-13).
 */
export const LIST_TILL_RATE_CENTS = 9900; // R99,00 per till per month

/** The once-off onboarding charge, by setup variant (the page's advertised pair). */
export const SETUP_FEE_CENTS = { assisted: 500000, self: 150000 } as const;
export type QuoteSetupVariant = keyof typeof SETUP_FEE_CENTS;

export const QUOTE_SETUP_VARIANTS = Object.keys(SETUP_FEE_CENTS) as QuoteSetupVariant[];

export interface QuoteConfig {
  stores: number;
  /** Total tills across the stores (the wire's own count). */
  tills: number;
  /** Add-on keys, from the curated vocabulary. */
  addons: string[];
  setup: QuoteSetupVariant;
}

export interface QuotePricedLine {
  label: string;
  detail: string;
  cents: number;
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
 * Prices a configuration from the list: tills × rate, the chargeable add-ons in
 * the vocabulary's own order, and the setup variant — VAT-inclusive, with the
 * tax broken out at the office's rate (the same arithmetic as an invoice).
 */
export const priceQuote = (config: QuoteConfig, vatRate: number): PricedQuote => {
  validateQuoteConfig(config);
  const perStore =
    config.stores > 0 && config.tills % config.stores === 0 ? config.tills / config.stores : null;
  // The split, spelled out: "(3 × 1)" left the reader guessing which number was
  // which — and it is how a per-store count once got read as a total. A
  // single-store quote needs no split.
  const detail =
    config.stores === 1
      ? ''
      : perStore === null
        ? `(across ${config.stores} stores)`
        : `(${perStore} till${perStore === 1 ? '' : 's'} per store × ${config.stores} stores)`;
  const lines: QuotePricedLine[] = [
    {
      label: `${config.tills} till${config.tills === 1 ? '' : 's'}`,
      detail,
      cents: config.tills * LIST_TILL_RATE_CENTS,
    },
  ];
  for (const key of PRICED_FEATURE_KEYS) {
    if (!config.addons.includes(key)) continue;
    lines.push({
      label: FEATURE_LABELS[key] ?? key,
      detail: '',
      cents: DEFAULT_FEATURE_PRICES[key] ?? 0,
    });
  }
  const monthlyTotalCents = lines.reduce((sum, line) => sum + line.cents, 0);
  const setupCents = SETUP_FEE_CENTS[config.setup];
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
