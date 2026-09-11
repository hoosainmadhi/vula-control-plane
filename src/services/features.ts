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
    label: 'Customer credit',
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
    label: 'Multi-store',
    description:
      'Head Office deployment, branch fleet and inter-branch visibility. The control plane refuses multi-store orchestration without it, and the Head Office gates itself on it.',
    enforcedBy: ['control-plane', 'head-office', 'store'],
  },
  {
    key: 'stock_transfers',
    label: 'Stock transfers',
    description: 'Inter-branch transfers (IBT) dispatched and received through Head Office.',
    enforcedBy: ['head-office'],
  },
  {
    key: 'ecommerce_bridges',
    label: 'E-commerce bridges',
    description: 'WooCommerce / Shopify product and stock bridges on the store.',
    enforcedBy: ['store'],
  },
  {
    key: 'ai_assistant',
    label: 'AI assistant',
    description: 'The register AI assistant (also needs AI_* env configured on the store).',
    enforcedBy: ['store'],
  },
];

export const PLAN_FEATURE_KEYS: readonly string[] = PLAN_FEATURES.map((f) => f.key);

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
