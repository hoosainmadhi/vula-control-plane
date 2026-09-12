import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge from '../components/StatusBadge';
import type { Company, Plan } from '../types';

/**
 * Companies — the merchant accounts.
 *
 * A company owns its branches and its Head Office application, and it is where the
 * plan and the paid-through date live. This is the screen for the two questions
 * that matter commercially: which plan are they on, and are they paid up.
 */

const BILLING_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  trial: 'bg-sky-100 text-sky-700',
  past_due: 'bg-amber-100 text-amber-700',
  suspended: 'bg-red-100 text-red-700',
  unlicensed: 'bg-slate-100 text-slate-600',
};

const BILLING_LABELS: Record<string, string> = {
  active: 'Active',
  trial: 'Trial',
  past_due: 'Past due',
  suspended: 'Suspended',
  unlicensed: 'No plan',
};

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none';
const labelCls = 'mb-1 block text-sm font-semibold text-slate-700';

interface FormState {
  name: string;
  slug: string;
  billingEmail: string;
  planId: string;
  paidThrough: string;
  trialEndsAt: string;
  status: 'active' | 'suspended';
}

const EMPTY_FORM: FormState = {
  name: '',
  slug: '',
  billingEmail: '',
  planId: '',
  paidThrough: '',
  trialEndsAt: '',
  status: 'active',
};

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [companyList, planList] = await Promise.all([
        api<Company[]>('/companies'),
        api<Plan[]>('/plans'),
      ]);
      setCompanies(companyList);
      setPlans(planList);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load companies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(
    () => ({
      total: companies.length,
      onPlan: companies.filter((c) => c.planId !== null).length,
      attention: companies.filter((c) => c.billingState !== 'active' && c.billingState !== 'trial')
        .length,
      stores: companies.reduce((n, c) => n + c.storesUsed, 0),
    }),
    [companies],
  );

  const openCreate = (): void => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, planId: plans.length > 0 ? String(plans[0]!.id) : '' });
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (company: Company): void => {
    setEditingId(company.id);
    setForm({
      name: company.name,
      slug: company.slug,
      billingEmail: company.billingEmail,
      planId: company.planId === null ? '' : String(company.planId),
      paidThrough: company.paidThrough ?? '',
      trialEndsAt: company.trialEndsAt ?? '',
      status: company.status,
    });
    setFormError(null);
    setModalOpen(true);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        name: form.name.trim(),
        billingEmail: form.billingEmail.trim(),
        planId: form.planId === '' ? null : Number(form.planId),
        paidThrough: form.paidThrough.trim() || null,
        trialEndsAt: form.trialEndsAt.trim() || null,
        status: form.status,
      };
      if (editingId !== null) {
        await api(`/companies/${editingId}`, { method: 'PUT', body });
        setNotice(`${body.name} updated`);
      } else {
        await api('/companies', {
          method: 'POST',
          body: { ...body, slug: form.slug.trim().toLowerCase() },
        });
        setNotice(`${body.name} created`);
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (company: Company): Promise<void> => {
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/companies/${company.id}`, {
        method: 'DELETE',
      });
      setConfirmDeleteId(null);
      setNotice(res.message);
      await load();
    } catch (err) {
      setConfirmDeleteId(null);
      setNotice(err instanceof ApiError ? err.message : 'Delete failed');
    }
  };

  if (loading) return <Spinner label="Loading companies…" />;
  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError} />
        <button
          onClick={() => void load()}
          className="text-sm font-semibold text-brand-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Companies', value: summary.total, tone: 'text-slate-900' },
          { label: 'On a plan', value: summary.onPlan, tone: 'text-slate-900' },
          { label: 'Billing attention', value: summary.attention, tone: 'text-amber-600' },
          { label: 'Stores managed', value: summary.stores, tone: 'text-brand-600' },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {tile.label}
            </div>
            <div className={`mt-0.5 text-lg font-black tabular-nums ${tile.tone}`}>
              {tile.value}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          A company is the merchant account: it owns the branches and the Head Office application,
          and is where the plan and paid-through date live.
        </p>
        <button
          onClick={openCreate}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" /> New company (advanced)
        </button>
      </div>

      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-700">
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
      )}

      {companies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No companies yet. Create one to own a merchant's stores and Head Office, then assign
          stores to it.
        </div>
      ) : (
        <div className="space-y-3">
          {companies.map((company) => (
            <div key={company.id} className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-col gap-4 px-5 py-4 xl:flex-row xl:items-start xl:gap-8">
                <div className="min-w-0 xl:w-72 xl:shrink-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-base font-bold text-slate-900">
                      {company.name}
                    </span>
                    <StatusBadge
                      status={company.billingState}
                      colors={BILLING_COLORS}
                      label={BILLING_LABELS[company.billingState]}
                    />
                    {company.tradingBlocked ? (
                      <span
                        className="inline-block whitespace-nowrap rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700"
                        title="The registers refuse new sales while the subscription is suspended"
                      >
                        Sales blocked
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-xs text-slate-400">{company.slug}</div>
                  <div className="truncate text-xs text-slate-500">
                    {company.billingEmail || '—'}
                  </div>
                </div>

                <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Plan
                    </div>
                    <div className="mt-0.5 text-xs font-bold text-slate-800">
                      {company.planName}
                    </div>
                    <div className="font-mono text-[11px] text-slate-400">{company.planCode}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Stores
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-slate-700">
                      {company.storesUsed} / {company.maxStores}
                    </div>
                    {company.storesUsed >= company.maxStores ? (
                      <div className="text-[11px] font-semibold text-amber-600">At plan limit</div>
                    ) : null}
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Paid through
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-slate-700">
                      {company.paidThrough ?? '—'}
                    </div>
                    {company.trialEndsAt ? (
                      <div className="text-[11px] text-slate-400">
                        Trial to {company.trialEndsAt}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Head Office
                    </div>
                    <div className="mt-0.5 text-xs text-slate-700">
                      {company.panels > 0 ? `${company.panels} registered` : 'None'}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 xl:shrink-0 xl:justify-end">
                  <button
                    onClick={() => openEdit(company)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Set plan & billing
                  </button>
                  {confirmDeleteId === company.id ? (
                    <>
                      <button
                        onClick={() => void remove(company)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-red-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Confirm delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(company.id)}
                      title="Only a company with no stores and no Head Office can be deleted"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  )}
                </div>
              </div>

              {company.note ? (
                <div className="border-t border-amber-100 bg-amber-50/60 px-5 py-2 text-[11px] font-medium text-amber-800">
                  {company.note}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <Modal
          title={editingId ? `Configure ${form.name}` : 'New company (advanced)'}
          onClose={() => setModalOpen(false)}
        >
          <div className="space-y-4">
            {formError && <ErrorBox message={formError} />}

            <div>
              <label className={labelCls}>Company name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Street Gym"
                className={inputCls}
              />
            </div>

            {editingId === null && (
              <div>
                <label className={labelCls}>Slug</label>
                <input
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                  placeholder="street-gym"
                  className={`${inputCls} font-mono`}
                />
                <p className="mt-1 text-xs text-slate-400">
                  Lowercase letters, digits and dashes. Used for URLs; fixed after creation.
                </p>
              </div>
            )}

            <div>
              <label className={labelCls}>Billing email</label>
              <input
                value={form.billingEmail}
                onChange={(e) => setForm({ ...form, billingEmail: e.target.value })}
                placeholder="accounts@streetgym.co.za"
                className={inputCls}
              />
            </div>

            <div>
              <label className={labelCls}>Plan</label>
              <select
                value={form.planId}
                onChange={(e) => setForm({ ...form, planId: e.target.value })}
                className={inputCls}
              >
                <option value="">No plan</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} — {plan.maxStores} store{plan.maxStores === 1 ? '' : 's'},{' '}
                    {plan.maxTerminalsPerStore} tills each
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">
                Raising the plan here is what allows the next store to be created.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Paid up to</label>
                <input
                  type="date"
                  value={form.paidThrough}
                  onChange={(e) => setForm({ ...form, paidThrough: e.target.value })}
                  className={inputCls}
                />
                <p className="mt-1 text-xs text-slate-400">
                  The date this subscription is paid up to. Before it the account is active; after
                  it the account goes past due for the grace window, then new sales stop. It also
                  caps how long a disconnected till may keep trading offline.
                </p>
              </div>
              <div>
                <label className={labelCls}>Trial ends</label>
                <input
                  type="date"
                  value={form.trialEndsAt}
                  onChange={(e) => setForm({ ...form, trialEndsAt: e.target.value })}
                  className={inputCls}
                />
              </div>
            </div>

            {editingId !== null && (
              <div>
                <label className={labelCls}>Account status</label>
                <select
                  value={form.status}
                  onChange={(e) =>
                    setForm({ ...form, status: e.target.value as 'active' | 'suspended' })
                  }
                  className={inputCls}
                >
                  <option value="active">Active</option>
                  <option value="suspended">Suspended (manual override)</option>
                </select>
                <p className="mt-1 text-xs text-slate-400">
                  Billing state is normally derived from the paid-through date; suspending here
                  overrides it.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setModalOpen(false)}
                className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !form.name.trim() || (editingId === null && !form.slug.trim())}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create company'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
