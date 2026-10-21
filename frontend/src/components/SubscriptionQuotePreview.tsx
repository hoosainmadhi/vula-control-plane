import type { Plan } from '../types';
import { addonLinesFor, perStoreLabel, PERIOD_LABEL, rand } from '../lib/money';

/**
 * The live recurring quote for a plan plus an estate — the figure an invoice
 * will carry, itemised. It mirrors `quoteForSubscription` (services/pricing.ts):
 *
 *   per_store    → stores × store rate + max(0, licensed − stores) × till rate
 *   per_terminal → licensed × terminal rate
 *   custom       → the agreed flat amount
 *
 * plus every selected add-on at the plan/agreed price and the quantity the
 * server applies (`addonLinesFor`: once per trading store, once per company for
 * Head Office/E-commerce/WhatsApp).
 *
 * One component for the client-detail subscription editor and the onboarding
 * wizard, so the number the operator sees before onboarding is the number the
 * server records. The wizard used to show "Custom pricing" for every per-store
 * plan because it only knew the per-terminal mode.
 */
export default function SubscriptionQuotePreview({
  plan,
  licensed,
  stores,
  addonOptions,
  selected,
  agreedPrices = {},
  setupFeeCents,
}: {
  plan: Plan | undefined;
  /** The licensed terminal quantity. */
  licensed: number;
  /** The trading stores the plan bills; 1 for a single-store deployment. */
  stores: number;
  /** What the plan sells and at what price — the lines the ticks can produce. */
  addonOptions: Array<{ key: string; cents: number; label: string }>;
  selected: string[];
  /** Prices already agreed with this client; they govern over the plan's. */
  agreedPrices?: Record<string, number>;
  /** The once-off chosen for this client; the plan's self figure when untouched. */
  setupFeeCents?: number;
}) {
  if (!plan) return null;
  const addonLines = addonLinesFor(addonOptions, selected, agreedPrices, Math.max(1, stores));
  const addonsCents = addonLines.reduce((sum, line) => sum + line.cents, 0);
  const period = plan.billingPeriod === 'once-off' ? '' : PERIOD_LABEL[plan.billingPeriod];
  const custom = plan.pricingMode === 'custom';
  const perStore = plan.pricingMode === 'per_store';
  const tradingStores = Math.max(0, stores);
  const additional = Math.max(0, licensed - tradingStores);
  const storesCents = perStore ? tradingStores * plan.storePriceCents : 0;
  const terminalsCents = custom
    ? 0
    : perStore
      ? additional * plan.terminalPriceCents
      : plan.terminalPriceCents * licensed;
  const setup = setupFeeCents ?? plan.setupFeeCents;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
        Commercial summary
      </div>
      {custom ? (
        <div className="mt-2 flex justify-between">
          <span className="text-slate-500">Recurring</span>
          <span className="font-bold text-slate-800">Custom pricing — agreed per client</span>
        </div>
      ) : (
        <>
          {perStore ? (
            <>
              <div className="mt-2 flex justify-between">
                <span className="text-slate-500">
                  Stores ({tradingStores} × {rand(plan.storePriceCents)})
                  <span className="block text-[10px] text-slate-400">
                    {perStoreLabel(
                      plan.storePriceCents,
                      plan.terminalPriceCents,
                      plan.billingPeriod,
                    )}
                  </span>
                </span>
                <span className="font-mono text-slate-700">{rand(storesCents)}</span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-slate-500">
                  Additional tills ({additional} × {rand(plan.terminalPriceCents)})
                </span>
                <span className="font-mono text-slate-700">{rand(terminalsCents)}</span>
              </div>
            </>
          ) : (
            <div className="mt-2 flex justify-between">
              <span className="text-slate-500">
                Licensed terminals ({licensed} × {rand(plan.terminalPriceCents)})
              </span>
              <span className="font-mono text-slate-700">{rand(terminalsCents)}</span>
            </div>
          )}
          {addonLines.map((line) => (
            <div key={line.key} className="mt-1 flex justify-between">
              <span className="text-slate-500">
                {line.label}
                {line.quantity > 1 ? (
                  <span className="text-slate-400">
                    {' '}
                    ({line.quantity} × {rand(line.unitCents)})
                  </span>
                ) : null}
              </span>
              <span className="font-mono text-slate-700">{rand(line.cents)} / month</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t border-slate-200 pt-1.5">
            <span className="font-semibold text-slate-600">Recurring</span>
            <span className="font-mono font-black text-slate-900">
              {rand(storesCents + terminalsCents + addonsCents)} {period}
            </span>
          </div>
        </>
      )}
      {custom && addonLines.length > 0 && (
        <p className="mt-1 text-[11px] text-slate-500">
          {addonLines.length === 1 ? 'This add-on is' : 'These add-ons are'} carried inside the
          agreed flat amount — the invoice shows {addonLines.length === 1 ? 'it' : 'them'} as
          included, not on top.
        </p>
      )}
      <div className="mt-1 flex justify-between">
        <span className="text-slate-500">Once-off onboarding</span>
        <span className="font-mono font-semibold text-slate-800">
          {setup > 0 ? rand(setup) : 'None'}
        </span>
      </div>
    </div>
  );
}
