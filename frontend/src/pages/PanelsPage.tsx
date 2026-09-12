import { useCallback, useEffect, useMemo, useState } from 'react';
import { HeartPulse, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge, { CONFIG_COLORS, HealthDot, STORE_COLORS } from '../components/StatusBadge';
import type { Company, Panel, PanelPushOutcome, Plan } from '../types';

/**
 * Company Control Panels — one per client.
 *
 * The control plane deploys, monitors and licences these, and is forbidden to
 * read inside them. So this screen shows operational metadata only: where it is,
 * whether it is reachable, what version it runs, and the state of its licence.
 * No business figures appear here by design.
 */

const HEALTH_LABELS = { up: 'Up', down: 'Down', unknown: 'Unknown' } as const;

const fmtTime = (value: string | null): string => {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export default function PanelsPage() {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Panel | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newCompanyId, setNewCompanyId] = useState('');
  const [newClientMode, setNewClientMode] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientSlug, setNewClientSlug] = useState('');
  const [newClientPlanId, setNewClientPlanId] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [newBaseUrl, setNewBaseUrl] = useState('https://');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const [panelList, companyList, planList] = await Promise.all([
        api<Panel[]>('/panels'),
        api<Company[]>('/companies'),
        api<Plan[]>('/plans'),
      ]);
      setPanels(panelList);
      setCompanies(companyList);
      setPlans(planList);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load panels');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(
    () => ({
      total: panels.length,
      up: panels.filter((p) => p.lastHealthStatus === 'up').length,
      down: panels.filter((p) => p.lastHealthStatus === 'down').length,
      licenceAttention: panels.filter((p) => p.billingState !== 'active' && p.billingState !== 'trial').length,
    }),
    [panels],
  );

  const run = async (panel: Panel, action: () => Promise<void>): Promise<void> => {
    setBusyId(panel.id);
    try {
      await action();
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const checkHealth = (panel: Panel): Promise<void> =>
    run(panel, async () => {
      await api(`/panels/${panel.id}/health`, { method: 'POST' });
      setNotice(`${panel.name} checked`);
    });

  const pushLicence = (panel: Panel): Promise<void> =>
    run(panel, async () => {
      const res = await api<PanelPushOutcome>(`/panels/${panel.id}/licence`, { method: 'POST' });
      setNotice(res.ok ? `Licence #${res.sequence} delivered to ${panel.name}` : `Push failed: ${res.error}`);
    });

  const openCreate = (): void => {
    setNewName('');
    setNewSlug('');
    setNewCompanyId(companies.length > 0 ? String(companies[0]!.id) : '');
    setNewBaseUrl('');
    // With no clients yet, go straight to creating one — otherwise the operator
    // is stuck looking at an empty dropdown.
    setNewClientMode(companies.length === 0);
    setNewClientName('');
    setNewClientSlug('');
    setNewClientPlanId(plans.length > 0 ? String(plans[0]!.id) : '');
    setCreateError(null);
    setCreateOpen(true);
  };

  const createPanel = async (): Promise<void> => {
    setCreating(true);
    setCreateError(null);
    try {
      // Onboarding a brand-new client must not require leaving this screen:
      // create the client, then hang the Head Office off it.
      let companyId = Number(newCompanyId);
      if (newClientMode) {
        const client = await api<Company>('/companies', {
          method: 'POST',
          body: {
            name: newClientName.trim(),
            slug: newClientSlug.trim().toLowerCase(),
            planId: newClientPlanId === '' ? null : Number(newClientPlanId),
          },
        });
        companyId = client.id;
      }
      await api('/panels', {
        method: 'POST',
        body: {
          companyId,
          name: newName.trim(),
          slug: newSlug.trim().toLowerCase(),
          baseUrl: newBaseUrl.trim(),
        },
      });
      setCreateOpen(false);
      setNotice(
        newClientMode
          ? `${newClientName.trim()} created and ${newName.trim()} registered and licensed`
          : `${newName.trim()} registered and licensed`,
      );
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const remove = async (panel: Panel): Promise<void> => {
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/panels/${panel.id}`, {
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

  const openEdit = (panel: Panel): void => {
    setEditing(panel);
    setFormName(panel.name);
    setFormUrl(panel.baseUrl);
    setFormError(null);
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    setSaving(true);
    setFormError(null);
    try {
      await api(`/panels/${editing.id}`, {
        method: 'PUT',
        body: { name: formName.trim(), baseUrl: formUrl.trim() },
      });
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner label="Loading panels…" />;
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Panels', value: summary.total, tone: 'text-slate-900' },
          { label: 'Reachable', value: summary.up, tone: 'text-green-600' },
          { label: 'Unreachable', value: summary.down, tone: 'text-red-600' },
          { label: 'Licence attention', value: summary.licenceAttention, tone: 'text-amber-600' },
        ].map((tile) => (
          <div key={tile.label} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {tile.label}
            </div>
            <div className={`mt-0.5 text-lg font-black tabular-nums ${tile.tone}`}>{tile.value}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          A Head Office is the client's own multi-store application. You deploy, monitor and licence it;
          the customer reaches it at its own URL with their own login.
        </p>
        <button
          onClick={openCreate}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" /> New Head Office
        </button>
      </div>

      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-700">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>
      )}

      {panels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No Company Control Panels registered yet. A panel is created for a client and reached at its own
          URL — the control plane monitors it, it does not host it.
        </div>
      ) : (
        <div className="space-y-3">
          {panels.map((panel) => {
            const busy = busyId === panel.id;
            return (
              <div key={panel.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-4 px-5 py-4 xl:flex-row xl:items-start xl:gap-8">
                  <div className="min-w-0 xl:w-72 xl:shrink-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-base font-bold text-slate-900" title={panel.name}>
                        {panel.name}
                      </span>
                      <StatusBadge status={panel.status} colors={STORE_COLORS} />
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500" title={panel.companyName}>
                      {panel.companyName}
                    </div>
                    <div className="truncate font-mono text-xs text-slate-400">{panel.slug}</div>
                  </div>

                  <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-4">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Domain
                      </div>
                      <a
                        href={panel.baseUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={panel.baseUrl}
                        className="mt-0.5 block truncate font-mono text-xs text-brand-600 hover:underline"
                      >
                        {panel.baseUrl.replace(/^https?:\/\//, '')}
                      </a>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Health
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                        <HealthDot status={panel.lastHealthStatus} />
                        {HEALTH_LABELS[panel.lastHealthStatus]}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {panel.lastHealthStatus === 'unknown' ? 'Never checked' : fmtTime(panel.lastHealthAt)}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Version
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-slate-700">
                        {panel.appVersion ? `v${panel.appVersion}` : '—'}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Licence
                      </div>
                      <div className="mt-0.5">
                        <StatusBadge
                          status={panel.billingState}
                          colors={CONFIG_COLORS}
                          label={panel.billingState.replace('_', ' ')}
                        />
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {panel.planName} · #{panel.licenceSequence}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 xl:shrink-0 xl:justify-end">
                    {busy ? (
                      <span className="inline-flex items-center gap-2 py-1.5 text-xs font-semibold text-slate-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Working…
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => openEdit(panel)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Configure
                        </button>
                        <button
                          onClick={() => void pushLicence(panel)}
                          title="Re-issue and deliver the company licence"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <KeyRound className="h-3.5 w-3.5" /> Push Licence
                        </button>
                        <button
                          onClick={() => void checkHealth(panel)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-200 px-2.5 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-50"
                        >
                          <HeartPulse className="h-3.5 w-3.5" /> Diagnostics
                        </button>
                        {confirmDeleteId === panel.id ? (
                          <>
                            <button
                              onClick={() => void remove(panel)}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-red-500"
                            >
                              <Trash2 className="h-3.5 w-3.5" /> Confirm
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
                            onClick={() => setConfirmDeleteId(panel.id)}
                            title="Remove this Head Office registration (the deployment itself is untouched)"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-slate-400">
        Each panel is one client's multi-store application. The control plane deploys, monitors and licences
        it, and never reads its business content.
      </p>

      {createOpen && (
        <Modal title="New Head Office" onClose={() => setCreateOpen(false)}>
          <div className="space-y-4">
            {createError && <ErrorBox message={createError} />}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-sm font-semibold text-slate-700">Client</label>
                {companies.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setNewClientMode(!newClientMode)}
                    className="text-xs font-bold text-brand-700 hover:underline"
                  >
                    {newClientMode ? 'Choose existing' : '+ New client'}
                  </button>
                )}
              </div>

              {newClientMode ? (
                <div className="space-y-3 rounded-lg border border-brand-100 bg-brand-50/40 p-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-600">
                      New client name
                    </label>
                    <input
                      value={newClientName}
                      onChange={(e) => setNewClientName(e.target.value)}
                      placeholder="Street Gym"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-600">Slug</label>
                    <input
                      value={newClientSlug}
                      onChange={(e) => setNewClientSlug(e.target.value.toLowerCase())}
                      placeholder="street-gym"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-600">Plan</label>
                    <select
                      value={newClientPlanId}
                      onChange={(e) => setNewClientPlanId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                    >
                      <option value="">No plan</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name} — {plan.maxStores} store{plan.maxStores === 1 ? '' : 's'}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <select
                  value={newCompanyId}
                  onChange={(e) => setNewCompanyId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.planName})
                    </option>
                  ))}
                </select>
              )}

              <p className="mt-1 text-xs text-slate-400">
                A Head Office belongs to one client, and its licence comes from that client's plan.
                Creating the client here does not require leaving this screen.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Street Gym Head Office"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Slug</label>
              <input
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
                placeholder="street-gym-ho"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Base URL</label>
              <input
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                placeholder="https://street-gym-ho.vula-app.co.za (http://localhost:3260 for a local deployment)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-400">
                Where the customer reaches their Head Office — a Head Office app, not a store (the control
                plane checks). Leave the token blank and one is generated; copy it into the deployment's env.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setCreateOpen(false)}
                className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void createPanel()}
                disabled={
                  creating ||
                  !newName.trim() ||
                  !newSlug.trim() ||
                  (newClientMode
                    ? !newClientName.trim() || !newClientSlug.trim()
                    : !newCompanyId)
                }
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                {creating ? 'Registering…' : 'Register Head Office'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={`Configure ${editing.name}`} onClose={() => setEditing(null)}>
          <div className="space-y-4">
            {formError && <ErrorBox message={formError} />}
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Panel name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-slate-700">Base URL</label>
              <input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <p className="text-xs text-slate-400">
              The customer reaches the panel at this URL with their own login. The control plane links out to it
              and does not embed it.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveEdit()}
                disabled={saving}
                className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
