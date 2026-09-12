import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { StoreCard } from '../components/StoreCard';
import { AdminPasswordModal, DiagnosticsModal, StoreFormModal, SupportModal } from '../components/storeModals';
import { useStoreActions } from '../hooks/useStoreActions';
import type { ClientDetailResponse, Company, Plan, Store, StoreFormValues } from '../types';
import type { Notice } from '../lib/storeVocab';

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ClientDetailResponse | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'stores' | 'head_office' | 'deployments'>('overview');
  const [error, setError] = useState<string | null>(null);

  // Edit Client modal state
  const [editClientOpen, setEditClientOpen] = useState(false);
  const [editClientName, setEditClientName] = useState('');
  const [editClientEmail, setEditClientEmail] = useState('');
  const [editClientPlanId, setEditClientPlanId] = useState('');
  const [savingClient, setSavingClient] = useState(false);

  // Upgrade modal state (§7)
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeHoName, setUpgradeHoName] = useState('');
  const [upgradeHoUrl, setUpgradeHoUrl] = useState('');
  const [newStoreName, setNewStoreName] = useState('');
  const [newStoreUrl, setNewStoreUrl] = useState('');
  const [newStoreTills, setNewStoreTills] = useState('2');
  const [upgradePlanId, setUpgradePlanId] = useState<string>('');
  const [upgrading, setUpgrading] = useState(false);

  // Shared store-card action state (Configure/Diagnostics/Support/More)
  const [notice, setNotice] = useState<Notice>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [configureStore, setConfigureStore] = useState<Store | null>(null);
  const [savingStore, setSavingStore] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [diagnosticsStore, setDiagnosticsStore] = useState<Store | null>(null);
  const [supportStore, setSupportStore] = useState<Store | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [moreMenuId, setMoreMenuId] = useState<number | null>(null);
  const [adminPassword, setAdminPassword] = useState<{
    storeName: string;
    tempPassword: string;
    note: string;
  } | null>(null);

  // Add Store modal state
  const [addStoreOpen, setAddStoreOpen] = useState(false);
  const [addStoreName, setAddStoreName] = useState('');
  const [addStoreSlug, setAddStoreSlug] = useState('');
  const [addStoreUrl, setAddStoreUrl] = useState('');
  const [addStoreTills, setAddStoreTills] = useState('2');
  const [addingStore, setAddingStore] = useState(false);

  // Retrying job state
  const [retrying, setRetrying] = useState(false);

  const loadData = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [res, pList, companiesList] = await Promise.all([
        api<ClientDetailResponse>(`/clients/${id}`),
        api<Plan[]>('/plans'),
        api<Company[]>('/companies'),
      ]);
      setData(res);
      setPlans(pList);
      setCompanies(companiesList);

      const client = res.client;
      setUpgradeHoName(`${client.name} Head Office`);
      setUpgradeHoUrl(`https://${client.slug}-ho.vula-app.co.za`);
      setNewStoreName(`${client.name} Branch 2`);
      setNewStoreUrl(`https://${client.slug}-2.vula-app.co.za`);

      const multiPlan = pList.find((p) => p.code === 'multi-store') || pList[0];
      if (multiPlan) setUpgradePlanId(String(multiPlan.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load client details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [id]);

  const handleOpenEditClient = () => {
    if (!data) return;
    setEditClientName(data.client.name);
    setEditClientEmail(data.client.billingEmail || '');
    setEditClientPlanId(data.client.planId ? String(data.client.planId) : '');
    setEditClientOpen(true);
  };

  const handleSaveClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !editClientName.trim()) return;
    setSavingClient(true);
    setError(null);
    try {
      await api(`/clients/${id}`, {
        method: 'PUT',
        body: {
          name: editClientName.trim(),
          billingEmail: editClientEmail.trim() || undefined,
          planId: editClientPlanId ? Number(editClientPlanId) : null,
        },
      });
      setEditClientOpen(false);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update client');
    } finally {
      setSavingClient(false);
    }
  };

  const handleUpgradeToMultiStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setUpgrading(true);
    setError(null);
    try {
      await api(`/clients/${id}/upgrade-to-multistore`, {
        method: 'POST',
        body: {
          headOffice: {
            name: upgradeHoName,
            baseUrl: upgradeHoUrl,
          },
          newStore: newStoreName
            ? {
                name: newStoreName,
                baseUrl: newStoreUrl,
                terminalCount: Number(newStoreTills) || 1,
              }
            : undefined,
          planId: upgradePlanId ? Number(upgradePlanId) : undefined,
        },
      });
      setUpgradeOpen(false);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upgrade failed');
    } finally {
      setUpgrading(false);
    }
  };

  const handleRetryJob = async (jobId: number) => {
    setRetrying(true);
    setError(null);
    try {
      await api(`/clients/jobs/${jobId}/retry`, { method: 'POST' });
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  const notify = (kind: 'ok' | 'error', text: string): void => setNotice({ kind, text });

  const actions = useStoreActions({
    notify,
    reload: async () => {
      await loadData();
    },
    onAdminPassword: setAdminPassword,
  });
  const {
    busyId,
    pushNow,
    healthCheck,
    togglePause,
    removeStore,
    startSupport,
    supportIssuePassword,
    supportBusy,
    supportError,
    setSupportError,
  } = actions;

  const runDiagnostics = (store: Store): void => {
    setDiagnosticsStore(store);
    void healthCheck(store);
  };

  const handleSaveStore = async (values: StoreFormValues): Promise<void> => {
    if (!configureStore) return;
    setSavingStore(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        vertical: values.vertical,
        baseUrl: values.baseUrl.trim(),
        terminalCount: Number(values.terminalCount),
        environment: values.environment,
        companyId: values.companyId === '' ? null : Number(values.companyId),
      };
      if (values.tillNames) body.terminalNames = values.tillNames;
      await api(`/stores/${configureStore.id}`, { method: 'PUT', body });
      notify('ok', `${values.name.trim()} updated — changes apply on the next push`);
      setConfigureStore(null);
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update store');
    } finally {
      setSavingStore(false);
    }
  };

  const handleAddStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !addStoreName || !addStoreSlug) return;
    setAddingStore(true);
    setError(null);
    try {
      await api('/stores', {
        method: 'POST',
        body: {
          name: addStoreName.trim(),
          slug: addStoreSlug.trim(),
          baseUrl: addStoreUrl.trim() || `https://${addStoreSlug.trim()}.vula-app.co.za`,
          terminalCount: Number(addStoreTills) || 1,
          companyId: Number(id),
          vertical: 'general',
        },
      });
      setAddStoreOpen(false);
      setAddStoreName('');
      setAddStoreSlug('');
      setAddStoreUrl('');
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add store');
    } finally {
      setAddingStore(false);
    }
  };

  if (loading && !data) {
    return <div className="p-12 text-center text-sm text-slate-500">Loading client details…</div>;
  }

  if (!data) {
    return <div className="p-12 text-center text-sm text-rose-500">Client not found.</div>;
  }

  const { client, headOffice, stores, latestDeployment } = data;

  return (
    <div className="space-y-6">
      {/* Back breadcrumb */}
      <div>
        <Link to="/" className="text-xs font-bold text-slate-500 hover:text-slate-800">
          ← Back to All Clients
        </Link>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-800">
          {error}
        </div>
      )}

      {/* Client Header Banner */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-2xl font-black text-slate-900">{client.name}</h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${
                  client.topology === 'multi_store'
                    ? 'bg-purple-50 text-purple-700 ring-1 ring-purple-500/20'
                    : 'bg-blue-50 text-blue-700 ring-1 ring-blue-500/20'
                }`}
              >
                {client.topology === 'multi_store' ? 'Multi-Store' : 'Single Store'}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-slate-400">
              Slug: {client.slug} · Billing email: {client.billingEmail || 'None'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpenEditClient}
              className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 shadow-2xs hover:bg-slate-50 cursor-pointer"
            >
              Edit Client
            </button>
            {client.topology === 'single_store' && (
              <button
                type="button"
                onClick={() => setUpgradeOpen(true)}
                className="rounded-lg bg-purple-600 px-3.5 py-2 text-xs font-bold text-white shadow-xs hover:bg-purple-700 cursor-pointer"
              >
                ⚡ Upgrade to Multi-Store
              </button>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="mt-6 flex border-b border-slate-200 gap-2">
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'stores', label: `Stores (${stores.length})` },
            { id: 'head_office', label: client.topology === 'multi_store' ? 'Head Office' : 'Head Office (None)' },
            { id: 'deployments', label: 'Deployments & Automation' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-xs font-bold transition ${
                activeTab === tab.id
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Contents */}

      {/* 1. Overview */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
            <h4 className="text-sm font-bold text-slate-900">Subscription & Commercial State</h4>
            <div className="divide-y divide-slate-100 text-xs">
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Assigned Plan:</span>
                <span className="font-bold text-slate-900">{client.planName}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Billing State:</span>
                <span className="font-bold text-emerald-700 uppercase">{client.billingState}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Subscription Paid Up To:</span>
                <span className="font-semibold text-slate-900">{client.paidThrough || '—'}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Trial Ends:</span>
                <span className="text-slate-700">{client.trialEndsAt || 'No active trial'}</span>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
            <h4 className="text-sm font-bold text-slate-900">Topology & Fleet Health</h4>
            <div className="divide-y divide-slate-100 text-xs">
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Retail Topology:</span>
                <span className="font-bold text-slate-900">{client.topology === 'multi_store' ? 'Multi-Store (Group + Branches)' : 'Single Store'}</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Store Fleet:</span>
                <span className="font-bold text-slate-900">{client.healthyStoresCount} of {client.storesCount} healthy</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Licensed Registers:</span>
                <span className="font-bold text-slate-900">{client.totalTills} total terminals</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-slate-500 font-medium">Head Office Executive Panel:</span>
                <span className="font-semibold">{headOffice ? 'Active (Connected)' : 'None'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. Stores */}
      {activeTab === 'stores' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-slate-900">Store Fleet Deployments</h4>
              <p className="text-xs text-slate-500">Retail branch containers belonging to this client</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setAddStoreName('');
                setAddStoreSlug(`${client.slug}-${stores.length + 1}`);
                setAddStoreUrl(`https://${client.slug}-${stores.length + 1}.vula-app.co.za`);
                setAddStoreTills('2');
                setAddStoreOpen(true);
              }}
              className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-brand-700 cursor-pointer"
            >
              + Add Store to Fleet
            </button>
          </div>
          <div className="space-y-3 p-4">
            {stores.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">
                No stores on this client yet — add one above.
              </div>
            ) : (
              stores.map((store) => (
                <StoreCard
                  key={store.id}
                  store={store}
                  busy={busyId === store.id}
                  confirmRemove={confirmDeleteId === store.id}
                  moreOpen={moreMenuId === store.id}
                  nameHref={`/stores/${store.id}`}
                  onConfigure={() => {
                    setFormError(null);
                    setConfigureStore(store);
                  }}
                  onPush={() => void pushNow(store)}
                  onDiagnostics={() => runDiagnostics(store)}
                  onSupport={() => {
                    setSupportError(null);
                    setSupportStore(store);
                  }}
                  onPauseResume={() => void togglePause(store)}
                  onRequestRemove={() => setConfirmDeleteId(store.id)}
                  onConfirmRemove={() => void removeStore(store, () => setConfirmDeleteId(null))}
                  onCancelRemove={() => setConfirmDeleteId(null)}
                  onToggleMore={() => setMoreMenuId(moreMenuId === store.id ? null : store.id)}
                  onCloseMore={() => setMoreMenuId(null)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* 3. Head Office */}
      {activeTab === 'head_office' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
          <h4 className="text-sm font-bold text-slate-900">Client Head Office Panel</h4>
          {headOffice ? (
            <div className="space-y-3 text-xs">
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">Panel Name:</span>
                <span className="font-bold text-slate-900">{headOffice.name}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">Access URL:</span>
                <a
                  href={headOffice.baseUrl || (headOffice as any).base_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-purple-700 font-bold hover:underline"
                >
                  {headOffice.baseUrl || (headOffice as any).base_url} ↗
                </a>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">Health Status:</span>
                <span className="font-bold uppercase text-emerald-700">{headOffice.status}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">App Version:</span>
                <span className="font-mono">{headOffice.appVersion || 'v1.0.0'}</span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
              This client is currently Single-Store and does not have a Head Office panel.
              <div className="mt-3">
                <button
                  onClick={() => setUpgradeOpen(true)}
                  className="rounded-lg bg-purple-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-purple-700"
                >
                  Upgrade to Multi-Store & Deploy Head Office
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4. Deployments & Automation Stepper (§11, §12) */}
      {activeTab === 'deployments' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-slate-900">Durable Deployment Jobs</h4>
              <p className="text-xs text-slate-500">Idempotent container provisioning, volume attachment & licence wiring</p>
            </div>
            {latestDeployment?.job?.status === 'failed' && (
              <button
                type="button"
                disabled={retrying}
                onClick={() => handleRetryJob(latestDeployment.job.id)}
                className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-amber-700 disabled:opacity-50"
              >
                {retrying ? 'Retrying…' : '↻ Resume / Retry Failed Steps'}
              </button>
            )}
          </div>

          {latestDeployment ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-slate-500">Job #{latestDeployment.job.id}: </span>
                  <span className="font-bold text-slate-800 uppercase">{latestDeployment.job.type.replace(/_/g, ' ')}</span>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                    latestDeployment.job.status === 'complete'
                      ? 'bg-emerald-50 text-emerald-700'
                      : latestDeployment.job.status === 'failed'
                      ? 'bg-rose-50 text-rose-700'
                      : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  {latestDeployment.job.status}
                </span>
              </div>

              {/* Step progression */}
              <div className="space-y-2">
                {latestDeployment.steps.map((st, i) => {
                  const warnings: string[] = (() => {
                    if (!st.warnings_json) return [];
                    try {
                      const parsed = JSON.parse(st.warnings_json);
                      return Array.isArray(parsed) ? (parsed as string[]) : [];
                    } catch {
                      return [];
                    }
                  })();
                  const doneWithWarnings = st.status === 'complete' && warnings.length > 0;
                  return (
                  <div
                    key={st.id}
                    className="flex items-center justify-between rounded-xl border border-slate-200 p-3 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex size-5 items-center justify-center rounded-full bg-slate-100 font-bold text-[10px] text-slate-600">
                        {i + 1}
                      </span>
                      <div>
                        <div className="font-bold text-slate-900 uppercase tracking-wide text-[11px]">
                          {st.step_key.replace(/_/g, ' ')}
                        </div>
                        <div className="text-[10px] text-slate-400">Resource: {st.resource_type}</div>
                        {warnings.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {warnings.map((w, wi) => (
                              <div key={wi} className="text-[10px] text-amber-600">⚠ {w}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {st.error && <span className="text-[10px] text-rose-600 font-semibold">{st.error}</span>}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                          st.status === 'complete'
                            ? doneWithWarnings
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700'
                            : st.status === 'failed'
                            ? 'bg-rose-50 text-rose-700'
                            : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {doneWithWarnings ? 'complete · warnings' : st.status}
                      </span>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="p-8 text-center text-xs text-slate-400">No recent deployment jobs recorded.</div>
          )}
        </div>
      )}

      {/* Edit Client Profile Modal */}
      {editClientOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Edit Client Profile</h3>
            <p className="mt-1 text-xs text-slate-500">Update company details for {client.slug}</p>
            <form onSubmit={handleSaveClient} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700">Client / Company Name *</label>
                <input
                  type="text"
                  required
                  value={editClientName}
                  onChange={(e) => setEditClientName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                  placeholder="e.g. Kloof Auto Spares"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Billing Email</label>
                <input
                  type="email"
                  value={editClientEmail}
                  onChange={(e) => setEditClientEmail(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                  placeholder="accounts@kloofautospares.co.za"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Subscription Plan</label>
                <select
                  value={editClientPlanId}
                  onChange={(e) => setEditClientPlanId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                >
                  <option value="">No plan assigned</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setEditClientOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingClient || !editClientName.trim()}
                  className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50 cursor-pointer"
                >
                  {savingClient ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upgrade to Multi-Store Modal (§7) */}
      {upgradeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Upgrade to Multi-Store Topology</h3>
            <p className="mt-1 text-xs text-slate-500">
              Deploy a merchant Head Office portal and attach branches. Existing store data remains 100% intact (§7).
            </p>
            <form onSubmit={handleUpgradeToMultiStore} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700">Head Office Portal Name</label>
                <input
                  type="text"
                  required
                  value={upgradeHoName}
                  onChange={(e) => setUpgradeHoName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Head Office URL</label>
                <input
                  type="text"
                  required
                  value={upgradeHoUrl}
                  onChange={(e) => setUpgradeHoUrl(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                />
              </div>
              <div className="border-t border-slate-100 pt-3">
                <div className="text-xs font-bold text-slate-700 mb-2">Optional Second Branch Store</div>
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="text"
                    placeholder="New Store Name"
                    value={newStoreName}
                    onChange={(e) => setNewStoreName(e.target.value)}
                    className="col-span-1 rounded-lg border border-slate-300 p-2 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="New Store URL"
                    value={newStoreUrl}
                    onChange={(e) => setNewStoreUrl(e.target.value)}
                    className="col-span-1 rounded-lg border border-slate-300 p-2 text-xs font-mono"
                  />
                  <input
                    type="number"
                    min="1"
                    max="20"
                    placeholder="Tills"
                    value={newStoreTills}
                    onChange={(e) => setNewStoreTills(e.target.value)}
                    className="col-span-1 rounded-lg border border-slate-300 p-2 text-xs text-center"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Target Multi-Store Plan</label>
                <select
                  value={upgradePlanId}
                  onChange={(e) => setUpgradePlanId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                >
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.maxStores} stores)
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setUpgradeOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={upgrading}
                  className="rounded-lg bg-purple-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-purple-700 disabled:opacity-50"
                >
                  {upgrading ? 'Upgrading…' : 'Execute Multi-Store Upgrade'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {/* Add Store to Fleet Modal */}
      {addStoreOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Add Store to Fleet</h3>
            <p className="mt-1 text-xs text-slate-500">Attach a new retail store to {client.name}</p>
            <form onSubmit={handleAddStore} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700">Store Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Durban Gateway"
                  value={addStoreName}
                  onChange={(e) => {
                    setAddStoreName(e.target.value);
                    if (!addStoreSlug || addStoreSlug.startsWith(`${client.slug}-`)) {
                      const sub = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                      setAddStoreSlug(`${client.slug}-${sub}`);
                      setAddStoreUrl(`https://${client.slug}-${sub}.vula-app.co.za`);
                    }
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Slug *</label>
                <input
                  type="text"
                  required
                  value={addStoreSlug}
                  onChange={(e) => setAddStoreSlug(e.target.value.toLowerCase())}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Base URL *</label>
                <input
                  type="text"
                  required
                  value={addStoreUrl}
                  onChange={(e) => setAddStoreUrl(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm font-mono text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700">Till Registers</label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={addStoreTills}
                  onChange={(e) => setAddStoreTills(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm text-center font-bold"
                />
              </div>
              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setAddStoreOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addingStore || !addStoreName || !addStoreSlug}
                  className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50"
                >
                  {addingStore ? 'Adding…' : 'Add Store'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {notice && (
        <div
          className={`flex items-center justify-between rounded-lg px-4 py-2.5 text-sm ${
            notice.kind === 'ok'
              ? 'border border-green-200 bg-green-50 text-green-800'
              : 'border border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="text-xs text-slate-400 hover:text-slate-600" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {configureStore && (
        <StoreFormModal
          modal={{ mode: 'edit', store: configureStore }}
          saving={savingStore}
          error={formError}
          companies={companies}
          onClose={() => setConfigureStore(null)}
          onSubmit={(values) => void handleSaveStore(values)}
        />
      )}

      {diagnosticsStore && (
        <DiagnosticsModal
          store={stores.find((x) => x.id === diagnosticsStore.id) ?? diagnosticsStore}
          running={busyId === diagnosticsStore.id}
          onClose={() => setDiagnosticsStore(null)}
          onRerun={() => runDiagnostics(diagnosticsStore)}
        />
      )}

      {supportStore && (
        <SupportModal
          store={supportStore}
          busy={supportBusy}
          error={supportError}
          onClose={() => setSupportStore(null)}
          onStart={(reason) => {
            void startSupport(supportStore, reason).then((ok) => {
              if (ok) setSupportStore(null);
            });
          }}
          onIssuePassword={() => {
            void supportIssuePassword(supportStore).then((ok) => {
              if (ok) setSupportStore(null);
            });
          }}
        />
      )}

      {adminPassword && (
        <AdminPasswordModal
          storeName={adminPassword.storeName}
          tempPassword={adminPassword.tempPassword}
          note={adminPassword.note}
          onClose={() => setAdminPassword(null)}
        />
      )}
    </div>
  );
}
