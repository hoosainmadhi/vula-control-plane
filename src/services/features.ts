import { ValidationError } from '../utils/validate.js';

/**
 * The curated plan-feature vocabulary (L4).
 *
 * Nine keys: seven sold monthly as add-ons (`PRICED_FEATURE_KEYS` — Head Office,
 * AI Copilot, Upload invoice, Credit accounts, Lay-by, E-commerce, WhatsApp
 * receipts) and two included by whichever plan grants them
 * (`advanced_reports`, `stock_transfers`). `layby` and `invoice_import` became
 * their own keys on 2026-10-10, split out of `customer_credit` and
 * `ai_assistant` so each could be sold and gated on its own. `whatsapp_cloud`
 * was added on 2026-10-20: the automatic Meta Cloud API delivery path is a paid
 * add-on, while manual `wa.me` sharing stays free.
 *
 * A plan's feature set is written into every licence it signs, and the
 * applications gate on
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
    key: 'whatsapp_cloud',
    label: 'WhatsApp messaging',
    description:
      'Automatic delivery of receipts, quotations, customer orders and purchase orders through the business’s WhatsApp Cloud API sender. Needs Meta credentials and an approved template per document; manual WhatsApp sharing remains free and always available.',
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
  'whatsapp_cloud',
];

/**
 * The add-ons charged once per COMPANY, not once per trading store (owner,
 * 2026-10-14). There are three, and each is one thing for the whole business:
 *
 *  - `multi_store` (Head Office) — there is one panel for the company.
 *  - `ecommerce_bridges` — one storefront connection to WooCommerce/Shopify. The
 *    online shop is the business's, not a shop's; a second branch does not open a
 *    second storefront, so charging per store would bill the same integration
 *    again for every branch.
 *  - `whatsapp_cloud` — one WhatsApp Business sender/number for the company. A
 *    branch may override the sender configuration later, but the entitlement is
 *    bought once for the business.
 *
 * Every other paid add-on is a per-store capability — each register either takes
 * lay-bys, holds credit accounts, asks the assistant or imports invoices, so the
 * bill follows the stores that have it. `addonQuantity` (services/pricing.ts) is
 * the one place this is applied; the marketing page's `data-per` attributes are
 * its display copy.
 */
export const PER_COMPANY_FEATURE_KEYS: readonly string[] = [
  'multi_store',
  'ecommerce_bridges',
  'whatsapp_cloud',
];

/**
 * The add-ons a suspended account may not use.
 *
 * They are sold per month, so suspension has to switch them off: the deployment
 * enforces the same rule on its own side (a suspended licence is refused there),
 * and keeping the signed claim in step with the intent means a deployment that
 * never ran that gate still refuses. Operational add-ons — Head Office, credit,
 * lay-by, e-commerce — stay in the claim: suspension blocks new sales, not a
 * merchant's access to data it already owns (CONTEXT §5).
 */
export const SUSPENSION_STRIPPED_FEATURES: readonly string[] = [
  'ai_assistant',
  'invoice_import',
  'whatsapp_cloud',
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
 * What each add-on costs per month (2026-10-10; Head Office repriced
 * 2026-10-14): R199 for Head Office — hosting and software, the same as a store
 * — R99 for AI Copilot and Upload invoice; R49 for Credit accounts, Lay-by and
 * E-commerce; R50 for the WhatsApp messaging entry bundle (250 messages).
 * Seeded onto every plan; the Plans page edits them, and a client's agreed
 * price is snapshotted when they buy, so this change re-prices nobody already
 * holding it.
 */
/**
 * The WhatsApp messaging bundles. The price is per COMPANY per month and the
 * messages are that company's monthly allowance. The add-on's plan price is the
 * entry bundle; a client can choose a larger bundle on a quote or in its
 * subscription, and the chosen price travels with the subscription/licence.
 */
export const WHATSAPP_BUNDLES = [
  { messages: 250, cents: 5000, label: '250 messages' },
  { messages: 500, cents: 10_000, label: '500 messages' },
  { messages: 750, cents: 15_000, label: '750 messages' },
  { messages: 1000, cents: 20_000, label: '1000 messages' },
] as const;

/** A wizard's bundle selection (messages) → its cents, or undefined when absent. */
export function whatsAppBundleCents(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const messages = Number(raw);
  const bundle = WHATSAPP_BUNDLES.find((b) => b.messages === messages);
  if (!bundle) {
    throw new ValidationError('whatsappBundle must be 250, 500, 750 or 1000 messages');
  }
  return bundle.cents;
}

/**
 * The monthly allowance a subscription's agreed price buys. A custom price
 * between tiers gets the lower bundle (the client is never charged for a larger
 * allowance than the tier below their price).
 */
export function whatsAppMessagesForPrice(cents: number | null | undefined): number {
  if (!cents || cents <= 0) return 0;
  if (cents >= 20_000) return 1000;
  if (cents >= 15_000) return 750;
  if (cents >= 10_000) return 500;
  if (cents >= 5_000) return 250;
  return 0;
}

export const DEFAULT_FEATURE_PRICES: Record<string, number> = {
  multi_store: 19_900,
  ai_assistant: 9900,
  invoice_import: 9900,
  customer_credit: 4900,
  layby: 4900,
  ecommerce_bridges: 4900,
  // The entry bundle: R50/month for 250 messages. The office can set R100
  // (500 messages), R150 (750) or R200 (1000) on a plan or an individual quote;
  // the price recorded on the subscription is what the client is billed. The register's
  // daily send cap is a safety limit, not the bundle meter (per-company message
  // metering is a later slice).
  whatsapp_cloud: 5000,
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
