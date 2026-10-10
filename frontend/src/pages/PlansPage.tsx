import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import type { Plan, PlanPeriod, PricingMode } from '../types';
import { rand, toCents, toRands, perTerminalLabel, PERIOD_LABEL } from '../lib/money';

/**
 * The plan catalogue.
 *
 * A plan grants a store-count cap, a per-store terminal ceiling, a feature set,
 * and its pricing: a rate per licensed terminal per period plus a once-off
 * onboarding charge — or `custom`, for a negotiated deal the control plane must
 * never price on the client's behalf.
 *
 * The per-store number here is an ENTITLEMENT LIMIT ("max licensed terminals per
 * store"), not the configured tills a POS runs, not claimed devices and not open
 * till sessions. Only the licensed quantity is billed.
 */

/**
 * Names come from the vocabulary (`GET /plans/features`), which carries the
 * pricing page's own words — the office sells "Head Office" and "Upload invoice
 * (AI assisted)", so those are the names it reads here, on the client card and on
 * the invoice. A local copy is what let those drift apart (owner, 2026-10-10).
 */
/**
 * Add-on display order — the pricing page's order (most expensive first, in the
 * order the page lists them). Which features ARE add-ons comes from the
 * vocabulary's `soldMonthly`, never from this list.
 */
const ADDON_ORDER = [
  'multi_store',
  'ai_assistant',
  'invoice_import',
  'customer_credit',
  'layby',
  'ecommerce_bridges',
] as const;

/** A plan's monthly price at its own ceiling, and with every add-on it sells. */
const planTotals = (plan: Plan): { atCeilingCents: number; addonsCents: number } => ({
  atCeilingCents: plan.terminalPriceCents * plan.maxTerminalsPerStore,
  addonsCents: Object.values(plan.featurePrices ?? {}).reduce((sum, c) => sum + c, 0),
});

/**
 * What this plan costs at its own ceiling — the one total a catalogue row can
 * state honestly, since the billable quantity belongs to each client. Rate × the
 * plan's per-store terminal ceiling, plus its add-ons if they are all taken.
 */
function PlanTotalLine({ plan }: { plan: Plan }) {
  const { atCeilingCents, addonsCents } = planTotals(plan);
  if (plan.pricingMode !== 'per_terminal') return null;
  return (
    <div className="text-[11px] text-slate-500">
      <span className="font-semibold">{rand(atCeilingCents)}</span> / month at{' '}
      {plan.maxTerminalsPerStore}
      {plan.maxTerminalsPerStore === 1 ? ' terminal' : ' terminals'} per store
      {addonsCents > 0 ? (
        <>
          <br />+ <span className="font-semibold">{rand(addonsCents)}</span> if every add-on is
          taken
        </>
      ) : null}
    </div>
  );
}

/** A plan code is the slug of its name: lowercase letters, digits and dashes. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  /** The vocabulary: names, and which features are SOLD monthly. */
  const [featureCatalogue, setFeatureCatalogue] = useState<
    Array<{ key: string; label: string; soldMonthly: boolean; monthlyPriceCents: number }>
  >([]);
  const featureLabels = Object.fromEntries(featureCatalogue.map((f) => [f.key, f.label]));
  /** Unsold-by-default features: what every plan includes. */
  const includedKeys = featureCatalogue.filter((f) => !f.soldMonthly).map((f) => f.key);
  /** The add-ons this plan sells, in the page's order. */
  const soldKeys = ADDON_ORDER.filter((key) =>
    featureCatalogue.some((f) => f.key === key && f.soldMonthly),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [formCode, setFormCode] = useState('');
  const [formName, setFormName] = useState('');
  /** True once the operator edits the code by hand — stops the name driving it. */
  const [codeEdited, setCodeEdited] = useState(false);
  const [formStores, setFormStores] = useState('1');
  const [formTerminals, setFormTerminals] = useState('10');
  const [formPricingMode, setFormPricingMode] = useState<PricingMode>('per_terminal');
  const [formTerminalPrice, setFormTerminalPrice] = useState('500.00');
  const [formCustomAmount, setFormCustomAmount] = useState('0.00');
  const [formSetupFee, setFormSetupFee] = useState('5000.00');
  /** What each add-on costs on this plan, in rands as typed. */
  const [formFeaturePrices, setFormFeaturePrices] = useState<Record<string, string>>({});
  /**
   * What this plan INCLUDES. Not a choice the operator makes: a plan includes the
   * product's base features, and everything else is sold as an add-on, priced
   * below (owner, 2026-10-10). Editing a plan never rewrites this, so the tiers
   * that already bundle features for live clients keep them.
   */
  const [formFeatures, setFormFeatures] = useState<string[]>([]);
  /** Features this plan carries beyond the base set — shown, never chosen. */
  const planExtras = formFeatures.filter((key) => !includedKeys.includes(key));
  const [formPeriod, setFormPeriod] = useState<PlanPeriod>('monthly');

  const load = useCallback(async (): Promise<void> => {
    try {
      const [planList, vocabulary] = await Promise.all([
        api<Plan[]>('/plans'),
        api<
          Array<{ key: string; label: string; soldMonthly: boolean; monthlyPriceCents: number }>
        >('/plans/features').catch(() => []),
      ]);
      setPlans(planList);
      setFeatureCatalogue(vocabulary);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load plans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = (): void => {
    setEditing(null);
    setCreating(true);
    setFormCode('');
    setFormName('');
    setCodeEdited(false);
    setFormStores('1');
    setFormTerminals('10');
    setFormPricingMode('per_terminal');
    // The approved pricing page: R99 a till, R5 000 assisted set-up, and the
    // add-ons at R99/R49. The office edits any of it.
    setFormTerminalPrice('99.00');
    setFormCustomAmount('0.00');
    setFormSetupFee('5000.00');
    // A new plan includes the base features and prices the add-ons at the
    // vocabulary's own defaults — both read off the catalogue, not typed here.
    setFormFeatures(includedKeys);
    setFormFeaturePrices(
      Object.fromEntries(
        featureCatalogue
          .filter((f) => f.soldMonthly)
          .map((f) => [f.key, toRands(f.monthlyPriceCents)]),
      ),
    );
    setFormPeriod('monthly');
    setFormError(null);
  };

  const openEdit = (plan: Plan): void => {
    setEditing(plan);
    setCreating(false);
    setFormCode(plan.code);
    setCodeEdited(true);
    setFormPeriod(plan.billingPeriod);
    setFormName(plan.name);
    setFormStores(String(plan.maxStores));
    setFormTerminals(String(plan.maxTerminalsPerStore));
    setFormPricingMode(plan.pricingMode);
    setFormTerminalPrice(toRands(plan.terminalPriceCents));
    setFormCustomAmount(toRands(plan.customAmountCents));
    setFormSetupFee(toRands(plan.setupFeeCents));
    setFormFeatures(plan.features);
    setFormFeaturePrices(
      Object.fromEntries(
        soldKeys.map((key) => [key, toRands(plan.featurePrices?.[key] ?? 0)]),
      ),
    );
    setFormError(null);
  };

  /** The code trails the name until the operator takes it over by hand. */
  const handleNameChange = (value: string): void => {
    setFormName(value);
    if (!codeEdited) setFormCode(slugify(value));
  };

  const priceMissing = formPricingMode === 'per_terminal' && toCents(formTerminalPrice) <= 0;
  /** A custom plan may bill from its agreed amount, or wait for a per-invoice figure. */
  const customAmount = toCents(formCustomAmount);

  const save = async (): Promise<void> => {
    setSaving(true);
    setFormError(null);
    const body = {
      code: formCode.trim().toLowerCase(),
      name: formName.trim(),
      maxStores: Number(formStores),
      maxTerminalsPerStore: Number(formTerminals),
      pricingMode: formPricingMode,
      terminalPriceCents: toCents(formTerminalPrice),
      customAmountCents: toCents(formCustomAmount),
      setupFeeCents: toCents(formSetupFee),
      billingPeriod: formPeriod,
      features: formFeatures,
      // Priced only for the features this plan does NOT include: a price on an
      // included feature would be a price nobody ever pays.
      featurePrices: Object.fromEntries(
        soldKeys.filter((key) => !formFeatures.includes(key))
          .map((key) => [key, toCents(formFeaturePrices[key] ?? '0')] as const)
          .filter(([, cents]) => cents > 0),
      ),
    };
    try {
      if (editing) {
        await api(`/plans/${editing.id}`, { method: 'PUT', body });
      } else {
        await api('/plans', { method: 'POST', body });
      }
      setEditing(null);
      setCreating(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (plan: Plan): Promise<void> => {
    try {
      await api(`/plans/${plan.id}`, {
        method: 'PUT',
        body: { isActive: !plan.isActive },
      });
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update plan');
    }
  };

  const handleDeletePlan = async (plan: Plan): Promise<void> => {
    if (!confirm(`Delete plan "${plan.name}" (${plan.code})?`)) return;
    try {
      await api(`/plans/${plan.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Delete failed');
    }
  };

  if (loading) return <Spinner label="Loading plans…" />;
  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError} />
        <button onClick={() => void load()} className="text-sm font-semibold text-brand-600 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-slate-500">
          A plan sets what a client may buy: how many stores, how many licensed terminals per store, and
          which features its applications unlock. Each licensed terminal recurs at the plan's rate, plus a
          once-off onboarding charge on the client's first invoice. Invoices are raised from the licensed
          quantity — never from configured tills, claimed devices or open sessions.
        </p>
        <button
          onClick={openCreate}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" /> New plan
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3 text-right">Stores</th>
              <th className="whitespace-nowrap px-4 py-3 text-right">
                Max licensed terminals / store
              </th>
              <th className="px-4 py-3">Features</th>
              <th className="px-4 py-3 text-right">Pricing</th>
              <th className="px-4 py-3 text-right">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {plans.map((plan) => (
              <tr key={plan.id} className="align-top hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900">{plan.name}</span>
                    {plan.isActive ? (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                        Active
                      </span>
                    ) : (
                      <span
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-500"
                        title="Archived — existing clients stay on it, but it is not offered to new ones"
                      >
                        Archived
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-slate-400">{plan.code}</div>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{plan.maxStores}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">
                  {plan.maxTerminalsPerStore}
                </td>
                <td className="px-4 py-3">
                  {plan.features.length === 0 ? (
                    <span className="text-xs text-slate-400">Core only</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {plan.features.map((f) => (
                        <span
                          key={f}
                          title={featureLabels[f] ?? f}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                        >
                          {featureLabels[f]?.split(' (')[0] ?? f}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {plan.pricingMode === 'custom' ? (
                    <>
                      <div className="font-mono text-xs font-semibold text-slate-800">
                        {plan.customAmountCents > 0
                          ? `${rand(plan.customAmountCents)} / ${plan.billingPeriod === 'monthly' ? 'month' : plan.billingPeriod === 'annual' ? 'year' : 'once-off'}`
                          : 'Custom pricing'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {plan.customAmountCents > 0
                          ? 'Agreed amount, billed flat'
                          : 'Invoices raised with an agreed amount'}
                      </div>
                      {plan.setupFeeCents > 0 && (
                        <div className="text-[11px] text-slate-400">
                          Setup {rand(plan.setupFeeCents)} once-off
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="font-mono text-xs font-semibold text-slate-800">
                        {perTerminalLabel(plan.terminalPriceCents, plan.billingPeriod)}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {plan.setupFeeCents > 0
                          ? `Setup ${rand(plan.setupFeeCents)} once-off`
                          : 'No onboarding charge'}
                      </div>
                      <PlanTotalLine plan={plan} />
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-3">
                    {/* An on/off switch: the plan is either offered to new clients or archived. */}
                    <label className="inline-flex cursor-pointer items-center">
                      <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
                        <input
                          type="checkbox"
                          className="peer sr-only"
                          checked={plan.isActive}
                          onChange={() => void handleToggleActive(plan)}
                          aria-label={`${plan.name} active`}
                        />
                        <span
                          aria-hidden="true"
                          className="absolute inset-0 rounded-full bg-slate-300 transition peer-checked:bg-emerald-600"
                        />
                        <span
                          aria-hidden="true"
                          className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4"
                        />
                      </span>
                    </label>
                    <button
                      onClick={() => openEdit(plan)}
                      title={`Edit ${plan.name}`}
                      aria-label={`Edit ${plan.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 cursor-pointer"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDeletePlan(plan)}
                      title={`Delete ${plan.name}`}
                      aria-label={`Delete ${plan.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 cursor-pointer"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <Modal
          size="xl"
          title={editing ? `Edit ${editing.name}` : 'New plan'}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          footer={
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setEditing(null);
                  setCreating(false);
                }}
                className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !formName.trim() || !formCode.trim() || priceMissing}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? 'Saving…' : editing ? 'Save plan' : 'Create plan'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            {formError && <ErrorBox message={formError} />}

            <section className="space-y-3">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Plan</h3>
              <div>
                <label htmlFor="plan-name" className="mb-1 block text-sm font-semibold text-slate-700">
                  Plan name
                </label>
                <input
                  id="plan-name"
                  value={formName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Business"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="plan-code" className="mb-1 block text-sm font-semibold text-slate-700">
                  Plan code
                </label>
                <input
                  id="plan-code"
                  value={formCode}
                  onChange={(e) => {
                    setCodeEdited(true);
                    setFormCode(e.target.value.toLowerCase());
                  }}
                  placeholder="business"
                  readOnly={Boolean(editing)}
                  className={`w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none ${
                    editing ? 'bg-slate-100 text-slate-500' : ''
                  }`}
                />
                <p className="mt-1 text-xs text-slate-400">
                  {editing
                    ? 'Cannot be changed after creation — licences and integrations depend on it.'
                    : 'Auto-generated from the name · cannot be changed later.'}
                </p>
              </div>
            </section>

            <section className="space-y-3 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Capacity</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="plan-max-stores"
                    className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                  >
                    Maximum stores
                  </label>
                  <input
                    id="plan-max-stores"
                    type="number"
                    min={1}
                    max={500}
                    value={formStores}
                    onChange={(e) => setFormStores(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="plan-max-terminals"
                    className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                  >
                    Max terminals / store
                  </label>
                  <input
                    id="plan-max-terminals"
                    type="number"
                    min={1}
                    max={99}
                    value={formTerminals}
                    onChange={(e) => setFormTerminals(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-400">Licence limits only</p>
            </section>

            <section className="space-y-3 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">Pricing</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="plan-pricing-model"
                    className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                  >
                    Pricing model
                  </label>
                  <select
                    id="plan-pricing-model"
                    value={formPricingMode}
                    onChange={(e) => setFormPricingMode(e.target.value as PricingMode)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                  >
                    <option value="per_terminal">Per licensed terminal</option>
                    <option value="custom">Custom (negotiated)</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="plan-billing-cycle"
                    className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                  >
                    Billing cycle
                  </label>
                  <select
                    id="plan-billing-cycle"
                    value={formPeriod}
                    onChange={(e) => setFormPeriod(e.target.value as PlanPeriod)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                  >
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                    <option value="once-off">Once-off (perpetual licence)</option>
                  </select>
                </div>
                {formPricingMode === 'per_terminal' ? (
                  <div>
                    <label
                      htmlFor="plan-terminal-price"
                      className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                    >
                      Price / terminal (R)
                    </label>
                    <input
                      id="plan-terminal-price"
                      value={formTerminalPrice}
                      onChange={(e) => setFormTerminalPrice(e.target.value)}
                      placeholder="500.00"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                ) : (
                  <div>
                    <label
                      htmlFor="plan-custom-amount"
                      className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                    >
                      Agreed amount (R)
                    </label>
                    <input
                      id="plan-custom-amount"
                      value={formCustomAmount}
                      onChange={(e) => setFormCustomAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                )}
                <div>
                  <label
                    htmlFor="plan-onboarding"
                    className="mb-1 block whitespace-nowrap text-sm font-semibold text-slate-700"
                  >
                    Onboarding (R)
                  </label>
                  <input
                    id="plan-onboarding"
                    value={formSetupFee}
                    onChange={(e) => setFormSetupFee(e.target.value)}
                    placeholder="10000.00"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                {formPricingMode === 'per_terminal' ? (
                  priceMissing ? (
                    <p className="font-semibold text-rose-600">
                      Set a price per licensed terminal to see what this plan is worth at full capacity.
                    </p>
                  ) : (
                    <>
                      <p className="text-slate-500">
                        Maximum on this plan:{' '}
                        <span className="font-semibold text-slate-700">
                          {Number(formStores) || 0} × {Number(formTerminals) || 0} ×{' '}
                          {rand(toCents(formTerminalPrice))} ={' '}
                          {rand(
                            (Number(formStores) || 0) *
                              (Number(formTerminals) || 0) *
                              toCents(formTerminalPrice),
                          )}{' '}
                          {PERIOD_LABEL[formPeriod]}
                        </span>
                      </p>
                      <p className="text-[11px] text-slate-400">
                        Stores × terminals per store × rate. A quote for the plan's ceiling — the invoice
                        bills the client's licensed terminals × this rate, not these caps.
                      </p>
                      <p className="text-slate-500">
                        Once-off onboarding ={' '}
                        <span className="font-semibold text-slate-700">
                          {toCents(formSetupFee) > 0 ? rand(toCents(formSetupFee)) : 'none'}
                        </span>
                      </p>
                    </>
                  )
                ) : (
                  <>
                    <p className="text-slate-500">
                      Custom plan ={' '}
                      <span className="font-semibold text-slate-700">
                        {customAmount > 0
                          ? `${rand(customAmount)} ${PERIOD_LABEL[formPeriod]}`
                          : 'no agreed amount yet'}
                      </span>
                      {customAmount > 0
                        ? ' · billed regardless of terminal count'
                        : ' · invoices will need an amount typed each time'}
                    </p>
                    <p className="text-slate-500">
                      Once-off onboarding ={' '}
                      <span className="font-semibold text-slate-700">
                        {toCents(formSetupFee) > 0 ? rand(toCents(formSetupFee)) : 'none'}
                      </span>
                    </p>
                  </>
                )}
              </div>
            </section>

            <section className="space-y-2 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                Included
              </h3>
              <p className="text-xs text-slate-400">
                {formFeatures.length > 0 ? (
                  <>
                    Granted with this plan, free:{' '}
                    <span className="font-medium text-slate-600">
                      {formFeatures.map((key) => featureLabels[key] ?? key).join(' · ')}
                    </span>
                    . A plan is not a feature picker — the base capabilities come with it.
                  </>
                ) : (
                  <>This plan grants no features of its own.</>
                )}{' '}
                Everything else is sold as an add-on, priced below.
              </p>
              {planExtras.length > 0 ? (
                <p className="text-xs text-slate-500">
                  This plan also includes{' '}
                  <span className="font-semibold text-slate-700">
                    {planExtras.map((key) => featureLabels[key] ?? key).join(' · ')}
                  </span>{' '}
                  — its clients have these without buying them, so they are not priced below.
                </p>
              ) : null}
              <div className="mt-4 border-t border-slate-200 pt-4">
                <h4 className="text-sm font-semibold text-slate-700">Add-ons</h4>
                <p className="mt-0.5 text-xs text-slate-400">
                  Monthly price for the features this plan does not include — the client buys them
                  on top of the rate. Anything switched on above is the client&apos;s already and is
                  not priced here. A blank or zero price means this plan does not sell it.
                </p>
                <div className="mt-2 space-y-2">
                  {soldKeys.filter((key) => !formFeatures.includes(key)).map((key) => (
                    <div key={key} className="flex items-center justify-between gap-3">
                      <label
                        htmlFor={`plan-addon-${key}`}
                        className="text-sm text-slate-700"
                        title={featureLabels[key] ?? key}
                      >
                        {featureLabels[key] ?? key}
                      </label>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-slate-400">R</span>
                        <input
                          id={`plan-addon-${key}`}
                          value={formFeaturePrices[key] ?? ''}
                          onChange={(e) =>
                            setFormFeaturePrices((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder="0.00"
                          className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-brand-500 focus:outline-none"
                        />
                      </span>
                    </div>
                  ))}
                  {soldKeys.every((key) => formFeatures.includes(key)) ? (
                    <p className="text-xs text-slate-400">
                      This plan includes every paid feature, so there is nothing to sell on top.
                    </p>
                  ) : null}
                </div>
              </div>
            </section>

          </div>
        </Modal>
      )}
    </div>
  );
}
