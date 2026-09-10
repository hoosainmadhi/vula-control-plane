import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { FEATURE_KEYS, type Plan } from '../types';
import type { PlanPeriod } from '../types';

/**
 * The plan catalogue.
 *
 * A plan grants a store-count cap, a per-store terminal ceiling and a feature set.
 * Four SA-retail tiers are seeded, and every value is editable here — the first ten
 * customers each want something slightly different, so the operator must be able to
 * change a tier without a code change.
 */

const FEATURE_LABELS: Record<string, string> = {
  customer_credit: 'Customer credit (lay-bys & debtors)',
  advanced_reports: 'Advanced reports (profit & margin)',
  multi_store: 'Multi-store (Head Office)',
  stock_transfers: 'Inter-branch stock transfers',
  ecommerce_bridges: 'E-commerce bridges (Woo / Shopify)',
  ai_assistant: 'AI assistant',
};

const rand = (cents: number): string =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

/** Never show a bare number: a price without its period is not a price. */
const PERIOD_SUFFIX: Record<PlanPeriod, string> = {
  monthly: ' per month',
  annual: ' per year',
  'once-off': ' once-off',
};

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [formName, setFormName] = useState('');
  const [formStores, setFormStores] = useState('1');
  const [formTerminals, setFormTerminals] = useState('2');
  const [formPrice, setFormPrice] = useState('0');
  const [formFeatures, setFormFeatures] = useState<string[]>([]);
  const [formCode, setFormCode] = useState('');
  const [formPeriod, setFormPeriod] = useState<PlanPeriod>('monthly');

  const load = useCallback(async (): Promise<void> => {
    try {
      setPlans(await api<Plan[]>('/plans'));
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
    setFormStores('1');
    setFormTerminals('2');
    setFormPrice('0');
    setFormFeatures([]);
    setFormPeriod('monthly');
    setFormError(null);
  };

  const openEdit = (plan: Plan): void => {
    setEditing(plan);
    setCreating(false);
    setFormCode(plan.code);
    setFormPeriod(plan.billingPeriod);
    setFormName(plan.name);
    setFormStores(String(plan.maxStores));
    setFormTerminals(String(plan.maxTerminalsPerStore));
    setFormPrice((plan.priceCents / 100).toFixed(2));
    setFormFeatures(plan.features);
    setFormError(null);
  };

  const toggleFeature = (key: string): void =>
    setFormFeatures((prev) => (prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]));

  const save = async (): Promise<void> => {
    setSaving(true);
    setFormError(null);
    const body = {
      name: formName.trim(),
      maxStores: Number(formStores),
      maxTerminalsPerStore: Number(formTerminals),
      priceCents: Math.round(Number(formPrice || '0') * 100),
      billingPeriod: formPeriod,
      features: formFeatures,
    };
    try {
      if (editing) {
        await api(`/plans/${editing.id}`, { method: 'PUT', body });
      } else {
        await api('/plans', { method: 'POST', body: { ...body, code: formCode.trim().toLowerCase() } });
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
        <p className="text-sm text-slate-500">
          A plan caps how many stores a company may run, how many tills each store may have, and which
          features its applications unlock. Prices are shown with their recurrence so a figure is never
          ambiguous. Editing a tier affects every company on it at the next licence refresh.
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
              <th className="px-4 py-3 text-right">Tills / store</th>
              <th className="px-4 py-3">Features</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3 text-right">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {plans.map((plan) => (
              <tr key={plan.id} className="align-top hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="font-bold text-slate-900">{plan.name}</div>
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
                          title={FEATURE_LABELS[f] ?? f}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600"
                        >
                          {FEATURE_LABELS[f]?.split(' (')[0] ?? f}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="font-mono text-xs font-semibold text-slate-800">
                    {plan.priceCents > 0 ? rand(plan.priceCents) : '—'}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {plan.priceCents > 0 ? PERIOD_SUFFIX[plan.billingPeriod].trim() : ''}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => openEdit(plan)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <Modal
          title={editing ? `Edit ${editing.name}` : 'New plan'}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        >
          <div className="space-y-4">
            {formError && <ErrorBox message={formError} />}
            {!editing && (
              <div>
                <label className="mb-1 block text-sm font-semibold text-slate-700">Plan code</label>
                <input
                  value={formCode}
                  onChange={(e) => setFormCode(e.target.value.toLowerCase())}
                  placeholder="retail-plus"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-400">
                  Lowercase letters, digits and dashes. Fixed after creation.
                </p>
              </div>
            )}
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Plan name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Retail Plus"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-semibold text-slate-700">
                  Max stores
                </label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={formStores}
                  onChange={(e) => setFormStores(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold text-slate-700">
                  Tills per store
                </label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={formTerminals}
                  onChange={(e) => setFormTerminals(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-semibold text-slate-700">Price (R)</label>
                <input
                  value={formPrice}
                  onChange={(e) => setFormPrice(e.target.value)}
                  placeholder="499.00"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-semibold text-slate-700">
                  Billed how?
                </label>
                <select
                  value={formPeriod}
                  onChange={(e) => setFormPeriod(e.target.value as PlanPeriod)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                >
                  <option value="monthly">Monthly (recurring)</option>
                  <option value="annual">Annual (recurring)</option>
                  <option value="once-off">Once-off (perpetual licence)</option>
                </select>
              </div>
            </div>
            <p className="-mt-2 text-xs text-slate-400">
              This is a price list for quoting — the control plane does not charge anyone. It records
              what the plan costs and how that cost recurs, so an invoice raised elsewhere agrees with
              what the customer was told.
            </p>
            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-700">Features</label>
              <div className="space-y-2">
                {FEATURE_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={formFeatures.includes(key)}
                      onChange={() => toggleFeature(key)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {FEATURE_LABELS[key] ?? key}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !formName.trim() || (!editing && !formCode.trim())}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? 'Saving…' : editing ? 'Save plan' : 'Create plan'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
