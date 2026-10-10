import { ValidationError } from '../utils/validate.js';

/**
 * The curated plan-feature vocabulary (L4).
 *
 * Six keys, locked with the owner when plans were introduced. A plan's feature
 * set is written into every licence it signs, and the applications gate on
 * these exact keys — so the control plane owns the list and refuses anything
 * else at plan write time. A typo'd key would otherwise flow silently into
 * licences and gate nothing on either side.
 *
 * `enforcedBy` records where each gate lives, so the office can see which
 * application refuses what:
 *  - `store`        — the za-pos register's own API (`requireFeature` → 402)
 *  - `head-office`  — the merchant's Company Control Panel
 *  - `control-plane`— this app, at the point it grants capability
 */
export interface PlanFeature {
  key: string;
  label: string;
  description: string;
  enforcedBy: Array<'store' | 'head-office' | 'control-plane'>;
}

export const PLAN_FEATURES: readonly PlanFeature[] = [
  {
    key: 'customer_credit',
    label: 'Credit accounts',
    description: 'Customer accounts, credit sales and payments in / out on the register.',
    enforcedBy: ['store'],
  },
  {
    key: 'advanced_reports',
    label: 'Advanced reports',
    description: 'Report suites beyond the daily basics (sales by period, stock movement, staff).',
    enforcedBy: ['store'],
  },
  {
    key: 'multi_store',
    label: 'Head Office',
    description:
      'Head Office deployment, branch fleet and inter-branch visibility. The control plane refuses multi-store orchestration without it, and the Head Office gates itself on it.',
    enforcedBy: ['control-plane', 'head-office', 'store'],
  },
  {
    key: 'stock_transfers',
    label: 'Inter-branch transfers',
    description: 'Inter-branch transfers (IBT) dispatched and received through Head Office.',
    enforcedBy: ['head-office'],
  },
  {
    key: 'ecommerce_bridges',
    label: 'E-commerce',
    description: 'WooCommerce / Shopify product and stock bridges on the store.',
    enforcedBy: ['store'],
  },
  {
    key: 'ai_assistant',
    label: 'AI Copilot',
    description:
      'The store assistant (its own figures, admin-only) AND the Head Office executive copilot, which asks across branches. One key, both surfaces; each needs AI_* configured where it runs.',
    enforcedBy: ['store', 'head-office'],
  },
  // Split out of the keys that used to imply them (2026-10-10), so each can be
  // sold and switched off on its own: lay-bys were gated on `customer_credit`,
  // and the supplier-invoice importer was gated on nothing at all.
  {
    key: 'layby',
    label: 'Lay-by',
    description: 'Lay-bys: deposits, instalments and collection against a sale.',
    enforcedBy: ['store'],
  },
  {
    key: 'invoice_import',
    label: 'Upload invoice (AI assisted)',
    description:
      'Supplier-invoice PDF → draft goods receipt, on a BRANCH (stock lives per branch, so there is nothing to receive on a Head Office). Bought once per client and delivered to every store of it. Was ungated before 2026-10-10.',
    enforcedBy: ['store'],
  },
];

/**
 * The features a client is SOLD monthly, and what each is called on a quote or
 * an invoice. The names are the ones the pricing page uses — a client reading an
 * invoice should see the words they bought.
 */
export const PRICED_FEATURE_KEYS: readonly string[] = [
  'multi_store',
  'ai_assistant',
  'invoice_import',
  'customer_credit',
  'layby',
  'ecommerce_bridges',
];

/**
 * What a feature is called on an invoice, a quote, and everywhere the office
 * reads it. Derived from the vocabulary above so the two can never disagree —
 * and they are the pricing page's own words, because that is what the client
 * bought (owner: "cp and marketing dont match", 2026-10-10).
 */
export const FEATURE_LABELS: Record<string, string> = Object.fromEntries(
  PLAN_FEATURES.map((f) => [f.key, f.label]),
);

/**
 * What each add-on costs per month, from the approved pricing page
 * (2026-10-10): R99 for Head Office, AI Copilot and Upload invoice; R49 for
 * Credit accounts, Lay-by and E-commerce. Seeded onto every plan; the Plans page
 * edits them, and a client's agreed price is snapshotted when they buy.
 */
export const DEFAULT_FEATURE_PRICES: Record<string, number> = {
  multi_store: 9900,
  ai_assistant: 9900,
  invoice_import: 9900,
  customer_credit: 4900,
  layby: 4900,
  ecommerce_bridges: 4900,
};

/**
 * Validates a plan's add-on prices: priced keys only, whole cents, no negatives.
 * An EMPTY object is allowed and means "this plan prices nothing extra" — the
 * way a plan that bundles everything says so.
 */
export const validateFeaturePrices = (raw: unknown): Record<string, number> => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('featurePrices must be an object of { featureKey: cents }');
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PLAN_FEATURE_KEYS.includes(key)) {
      throw new ValidationError(
        `Unknown feature key in featurePrices: ${key}. Allowed keys: ${PLAN_FEATURE_KEYS.join(', ')}`,
      );
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ValidationError(`featurePrices.${key} must be whole cents (0 or more)`);
    }
    if (value > 0) out[key] = value;
  }
  return out;
};

export const PLAN_FEATURE_KEYS: readonly string[] = PLAN_FEATURES.map((f) => f.key);

/**
 * The vocabulary as the office UI renders it: each feature with whether it is
 * SOLD monthly (an add-on) and what it costs by default. Derived from the price
 * table above, so a UI never keeps its own list of which keys are for sale
 * (owner, 2026-10-10: the included set should be "separated and not something to
 * choose").
 */
export const featureCatalogue = (): Array<
  PlanFeature & { soldMonthly: boolean; monthlyPriceCents: number }
> =>
  PLAN_FEATURES.map((f) => ({
    ...f,
    soldMonthly: f.key in DEFAULT_FEATURE_PRICES,
    monthlyPriceCents: DEFAULT_FEATURE_PRICES[f.key] ?? 0,
  }));

export const getPlanFeature = (key: string): PlanFeature | undefined =>
  PLAN_FEATURES.find((f) => f.key === key);

/**
 * Validates a plan's feature list against the vocabulary, returning the
 * normalised (deduplicated, vocabulary-ordered) keys. Unknown keys are refused
 * by name — the vocabulary is the cross-application contract.
 */
export const validateFeatureKeys = (raw: unknown): string[] => {
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
    throw new ValidationError('features must be an array of feature keys');
  }
  const unknown = [...new Set(raw as string[])].filter((k) => !PLAN_FEATURE_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unknown feature key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Allowed keys: ${PLAN_FEATURE_KEYS.join(', ')}`,
    );
  }
  return PLAN_FEATURE_KEYS.filter((key) => (raw as string[]).includes(key));
};
