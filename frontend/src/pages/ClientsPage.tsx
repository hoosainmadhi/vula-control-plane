import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { ClientListItem, Plan, StoreVertical } from '../types';

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Wizard state
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [clientName, setClientName] = useState('');
  const [clientSlug, setClientSlug] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [planId, setPlanId] = useState<string>('');
  const [vertical, setVertical] = useState<StoreVertical>('general');
  const [deploymentType, setDeploymentType] = useState<'single_store' | 'multi_store'>('single_store');

  // Single store inputs
  const [singleStoreName, setSingleStoreName] = useState('');
  const [singleStoreUrl, setSingleStoreUrl] = useState('');
  const [singleStoreTills, setSingleStoreTills] = useState('2');
  const [singleStoreAdminEmail, setSingleStoreAdminEmail] = useState('');

  // Multi store inputs
  const [hoName, setHoName] = useState('');
  const [hoUrl, setHoUrl] = useState('');
  const [hoAdminEmail, setHoAdminEmail] = useState('');
  const [multiStores, setMultiStores] = useState<Array<{ name: string; slug: string; baseUrl: string; terminalCount: number }>>([
    { name: '', slug: '', baseUrl: '', terminalCount: 2 },
  ]);

  const [deploying, setDeploying] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [cList, pList] = await Promise.all([
        api<ClientListItem[]>('/clients'),
        api<Plan[]>('/plans'),
      ]);
      setClients(cList);
      setPlans(pList);
      if (pList.length > 0 && !planId) {
        setPlanId(String(pList[0].id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clients');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleNameChange = (name: string) => {
    setClientName(name);
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    setClientSlug(slug);
    setSingleStoreName(name);
    setSingleStoreUrl(`https://${slug}.vula-app.co.za`);
    setHoName(`${name} Head Office`);
    setHoUrl(`https://${slug}-ho.vula-app.co.za`);
  };

  const handleAddMultiStoreRow = () => {
    setMultiStores([
      ...multiStores,
      {
        name: '',
        slug: '',
        baseUrl: '',
        terminalCount: 2,
      },
    ]);
  };

  const handleRemoveMultiStoreRow = (index: number) => {
    setMultiStores(multiStores.filter((_, i) => i !== index));
  };

  const handleDeployClient = async () => {
    setDeploying(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name: clientName,
        slug: clientSlug,
        billingEmail,
        planId: planId ? Number(planId) : null,
        vertical,
        deploymentType,
      };

      if (deploymentType === 'single_store') {
        payload.stores = [
          {
            name: singleStoreName || clientName,
            slug: clientSlug,
            baseUrl: singleStoreUrl || `https://${clientSlug}.vula-app.co.za`,
            terminalCount: Number(singleStoreTills) || 1,
            adminEmail: singleStoreAdminEmail || billingEmail,
          },
        ];
      } else {
        payload.headOffice = {
          name: hoName || `${clientName} Head Office`,
          slug: `${clientSlug}-ho`,
          baseUrl: hoUrl || `https://${clientSlug}-ho.vula-app.co.za`,
          adminEmail: hoAdminEmail || billingEmail,
        };
        payload.stores = multiStores.map((s, i) => ({
          name: s.name || `${clientName} Branch ${i + 1}`,
          slug: s.slug || `${clientSlug}-${i + 1}`,
          baseUrl: s.baseUrl || `https://${clientSlug}-${i + 1}.vula-app.co.za`,
          terminalCount: s.terminalCount || 1,
        }));
      }

      await api('/clients', { method: 'POST', body: payload });
      setWizardOpen(false);
      resetWizard();
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deployment failed');
    } finally {
      setDeploying(false);
    }
  };

  const resetWizard = () => {
    setStep(1);
    setClientName('');
    setClientSlug('');
    setBillingEmail('');
    setSingleStoreName('');
    setSingleStoreUrl('');
    setSingleStoreTills('2');
    setSingleStoreAdminEmail('');
    setHoName('');
    setHoUrl('');
    setHoAdminEmail('');
    setMultiStores([{ name: '', slug: '', baseUrl: '', terminalCount: 2 }]);
  };

  const singleStoreCount = clients.filter((c) => c.topology === 'single_store').length;
  const multiStoreCount = clients.filter((c) => c.topology === 'multi_store').length;
  const totalStores = clients.reduce((acc, c) => acc + c.storesCount, 0);
  const totalTills = clients.reduce((acc, c) => acc + c.totalTills, 0);

  const filteredClients = clients.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.slug.toLowerCase().includes(q) ||
      c.billingEmail.toLowerCase().includes(q) ||
      c.planName.toLowerCase().includes(q) ||
      c.topology.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Link to="/companies" className="text-xs font-semibold text-slate-400 hover:text-brand-600">
          Company accounts (advanced) →
        </Link>
      </div>
      {error && (
        <div className="flex items-center justify-between rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold text-rose-800">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="opacity-70 hover:opacity-100">
            Dismiss
          </button>
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Clients</div>
          <div className="mt-2 text-2xl font-black text-slate-900">{clients.length}</div>
          <div className="mt-1 text-xs text-slate-500">
            {singleStoreCount} Single · {multiStoreCount} Multi-Store
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-brand-600">Store Deployments</div>
          <div className="mt-2 text-2xl font-black text-brand-600">{totalStores}</div>
          <div className="mt-1 text-xs text-slate-500">Active retail containers</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-indigo-600">Head Offices</div>
          <div className="mt-2 text-2xl font-black text-indigo-600">{multiStoreCount}</div>
          <div className="mt-1 text-xs text-slate-500">Client executive panels</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="text-xs font-bold uppercase tracking-wider text-emerald-600">Total Terminals</div>
          <div className="mt-2 text-2xl font-black text-emerald-600">{totalTills}</div>
          <div className="mt-1 text-xs text-slate-500">Licensed cash registers</div>
        </div>
      </div>

      {/* Action Header with Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-slate-900">Clients & Topologies</h3>
          <p className="text-xs text-slate-500">Manage client organizations, store fleets, and Head Offices</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <input
              type="text"
              placeholder="Search clients, plans, slugs…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-64 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs placeholder:text-slate-400 shadow-2xs focus:border-brand-500 focus:outline-hidden"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1.5 text-xs text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              resetWizard();
              setWizardOpen(true);
            }}
            className="rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 cursor-pointer shrink-0"
          >
            + New Client
          </button>
        </div>
      </div>

      {/* Client Cards Grid */}
      {loading ? (
        <div className="p-12 text-center text-sm text-slate-400">Loading clients…</div>
      ) : clients.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 p-12 text-center">
          <h4 className="text-sm font-bold text-slate-700">No clients onboarded yet</h4>
          <p className="mt-1 text-xs text-slate-400">
            Use the New Client wizard to provision your first store or multi-store group.
          </p>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700"
          >
            + Onboard Client
          </button>
        </div>
      ) : filteredClients.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500 shadow-2xs">
          No clients matching "{searchQuery}".
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {filteredClients.map((c) => (
            <div
              key={c.id}
              className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs transition hover:border-slate-300 hover:shadow-xs"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-base font-black text-slate-900">{c.name}</h4>
                    <p className="text-xs font-mono text-slate-400">{c.slug}</p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                      c.topology === 'multi_store'
                        ? 'bg-purple-50 text-purple-700 ring-1 ring-purple-500/20'
                        : 'bg-blue-50 text-blue-700 ring-1 ring-blue-500/20'
                    }`}
                  >
                    {c.topology === 'multi_store' ? 'Multi-Store' : 'Single Store'}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 border-y border-slate-100 py-3.5 text-xs">
                  <div>
                    <span className="text-[11px] font-semibold text-slate-400">Plan & Status:</span>
                    <div className="font-bold text-slate-800">
                      {c.planName}{' '}
                      <span className="rounded bg-slate-100 px-1.5 py-0.2 text-[10px] font-bold text-slate-600">
                        {c.billingState}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-slate-400">Paid up to:</span>
                    <div className="font-semibold text-slate-800">{c.paidThrough || '—'}</div>
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-slate-400">Store Fleet:</span>
                    <div className="font-bold text-slate-800">
                      {c.healthyStoresCount} / {c.storesCount} online ({c.totalTills} tills)
                    </div>
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-slate-400">Head Office:</span>
                    <div className="font-semibold text-slate-800">
                      {c.headOffice ? (
                        <span className="text-emerald-700 font-bold">
                          ● {c.headOffice.health === 'up' ? 'Healthy' : 'Registered'}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">None (Single Store)</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Stores are reached through the client card: each store links
                  straight into its SPOG detail; Manage opens the workflow. */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-slate-400">Stores:</span>
                {(c.stores ?? []).length === 0 ? (
                  <span className="text-[11px] italic text-slate-400">None yet</span>
                ) : (
                  (c.stores ?? []).map((st) => (
                    <Link
                      key={st.id}
                      to={`/stores/${st.id}`}
                      title={`${st.name} — open store detail`}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition hover:border-brand-400 hover:text-brand-700 ${
                        st.healthState === 'offline'
                          ? 'border-rose-200 bg-rose-50 text-rose-700'
                          : st.healthState === 'warning'
                            ? 'border-amber-200 bg-amber-50 text-amber-700'
                            : 'border-slate-200 bg-slate-50 text-slate-700'
                      }`}
                    >
                      {st.name}
                    </Link>
                  ))
                )}
              </div>

              <div className="mt-4 flex items-center justify-between pt-2">
                <span className="text-[11px] text-slate-400">
                  Onboarded {c.createdAt.slice(0, 10)}
                </span>
                <Link
                  to={`/clients/${c.id}`}
                  className="rounded-lg bg-slate-100 px-3.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200 transition"
                >
                  Manage Client →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New Client Onboarding Wizard Modal (§5, §6) */}
      {wizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="mb-4 border-b border-slate-100 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900">New Client Onboarding</h3>
                <p className="text-xs text-slate-500">Step {step} of 4: {step === 1 ? 'Client Information' : step === 2 ? 'Deployment Topology' : step === 3 ? 'Store & Office Setup' : 'Review & Deploy'}</p>
              </div>
              <button
                onClick={() => setWizardOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            {/* Step 1: Client Info */}
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700">Client / Company Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Gardens Pharmacy or Urban Threads"
                    value={clientName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700">Slug *</label>
                  <input
                    type="text"
                    required
                    value={clientSlug}
                    onChange={(e) => setClientSlug(e.target.value.toLowerCase())}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700">Billing Email</label>
                  <input
                    type="email"
                    placeholder="accounts@client.co.za"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700">Subscription Plan *</label>
                    <select
                      value={planId}
                      onChange={(e) => setPlanId(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                    >
                      {/* Archived plans stay on existing clients but are not offered to new ones. */}
                      {plans.filter((p) => p.isActive).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700">POS Profile / Vertical</label>
                    <select
                      value={vertical}
                      onChange={(e) => setVertical(e.target.value as StoreVertical)}
                      className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                    >
                      <option value="general">General Retail & Spaza</option>
                      <option value="clothing">Clothing & Apparel</option>
                      <option value="spares">Auto Spares</option>
                      <option value="hardware">Hardware & Building</option>
                      <option value="pharmacy">Pharmacy & Wellness</option>
                      <option value="restaurant">Restaurant & Quick Service</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end pt-4">
                  <button
                    type="button"
                    disabled={!clientName || !clientSlug}
                    onClick={() => setStep(2)}
                    className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50"
                  >
                    Next: Topology →
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Topology Choice */}
            {step === 2 && (
              <div className="space-y-4">
                <p className="text-xs text-slate-600">How will this merchant operate their retail business?</p>
                <div className="grid grid-cols-2 gap-4">
                  <div
                    onClick={() => setDeploymentType('single_store')}
                    className={`cursor-pointer rounded-xl border p-4 transition ${
                      deploymentType === 'single_store'
                        ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-500/20'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-bold text-slate-900 text-sm">Single Store</div>
                    <p className="mt-1 text-xs text-slate-500">
                      Standalone shop with local till registers. One store container with its own database.
                    </p>
                  </div>

                  <div
                    onClick={() => setDeploymentType('multi_store')}
                    className={`cursor-pointer rounded-xl border p-4 transition ${
                      deploymentType === 'multi_store'
                        ? 'border-purple-600 bg-purple-50/50 ring-2 ring-purple-500/20'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="font-bold text-slate-900 text-sm">Multi-Store Chain</div>
                    <p className="mt-1 text-xs text-slate-500">
                      Multiple branch stores coordinated by a central Head Office executive portal.
                    </p>
                  </div>
                </div>

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700"
                  >
                    Next: Technical Setup →
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Technical Details */}
            {step === 3 && (
              <div className="space-y-4">
                {deploymentType === 'single_store' ? (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700">Store Name</label>
                      <input
                        type="text"
                        value={singleStoreName}
                        onChange={(e) => setSingleStoreName(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700">Store FQDN / Base URL</label>
                      <input
                        type="text"
                        value={singleStoreUrl}
                        onChange={(e) => setSingleStoreUrl(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-700">Tills Count</label>
                        <input
                          type="number"
                          min="1"
                          max="20"
                          value={singleStoreTills}
                          onChange={(e) => setSingleStoreTills(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-700">Store Manager Email</label>
                        <input
                          type="email"
                          placeholder={billingEmail || 'admin@store.co.za'}
                          value={singleStoreAdminEmail}
                          onChange={(e) => setSingleStoreAdminEmail(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-purple-200 bg-purple-50/60 p-3.5 space-y-2.5">
                      <div className="text-xs font-bold text-purple-900 uppercase tracking-wide">
                        Head Office Portal Configuration
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-purple-800">HO Portal Name</label>
                        <input
                          type="text"
                          value={hoName}
                          onChange={(e) => setHoName(e.target.value)}
                          className="mt-0.5 w-full rounded-lg border border-purple-200 bg-white p-2 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-purple-800">HO URL</label>
                        <input
                          type="text"
                          value={hoUrl}
                          onChange={(e) => setHoUrl(e.target.value)}
                          className="mt-0.5 w-full rounded-lg border border-purple-200 bg-white p-2 text-xs"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-bold text-slate-700">Branch Stores</label>
                        <button
                          type="button"
                          onClick={handleAddMultiStoreRow}
                          className="text-xs font-bold text-brand-600 hover:text-brand-700 cursor-pointer"
                        >
                          + Add Branch Store
                        </button>
                      </div>

                      {/* Explicit column labels (§33) */}
                      <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 px-1 pb-1">
                        <div className="col-span-5">Store Name</div>
                        <div className="col-span-4">Store Base URL</div>
                        <div className="col-span-3 text-right pr-2">Till Counter</div>
                      </div>

                      <div className="space-y-2">
                        {multiStores.map((ms, idx) => (
                          <div key={idx} className="grid grid-cols-12 gap-2 items-center rounded-lg border border-slate-200 p-2">
                            <input
                              type="text"
                              placeholder="e.g. Durban Gateway"
                              value={ms.name}
                              onChange={(e) => {
                                const next = [...multiStores];
                                next[idx].name = e.target.value;
                                setMultiStores(next);
                              }}
                              className="col-span-5 rounded border border-slate-300 p-2 text-xs"
                            />
                            <input
                              type="text"
                              placeholder="https://..."
                              value={ms.baseUrl}
                              onChange={(e) => {
                                const next = [...multiStores];
                                next[idx].baseUrl = e.target.value;
                                setMultiStores(next);
                              }}
                              className="col-span-4 rounded border border-slate-300 p-2 text-xs font-mono"
                            />
                            <div className="col-span-3 flex items-center justify-end gap-1.5">
                              <span className="text-[10px] font-bold text-slate-500 uppercase shrink-0">Tills:</span>
                              <input
                                type="number"
                                min="1"
                                max="50"
                                title="Number of Till Registers"
                                value={ms.terminalCount}
                                onChange={(e) => {
                                  const next = [...multiStores];
                                  next[idx].terminalCount = Number(e.target.value) || 1;
                                  setMultiStores(next);
                                }}
                                className="w-14 rounded border border-slate-300 p-2 text-xs text-center font-bold"
                              />
                              {multiStores.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveMultiStoreRow(idx)}
                                  className="text-rose-500 hover:text-rose-700 px-1 text-sm font-bold cursor-pointer"
                                  title="Remove branch"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={() => setStep(2)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep(4)}
                    className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700"
                  >
                    Next: Review →
                  </button>
                </div>
              </div>
            )}

            {/* Step 4: Review and Deploy */}
            {step === 4 && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-semibold">Client:</span>
                    <span className="font-bold text-slate-900">{clientName} ({clientSlug})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-semibold">Deployment:</span>
                    <span className="font-bold uppercase text-brand-700">{deploymentType.replace('_', ' ')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 font-semibold">Plan:</span>
                    <span className="font-bold text-slate-900">{plans.find((p) => String(p.id) === planId)?.name}</span>
                  </div>
                  {deploymentType === 'multi_store' ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-500 font-semibold">Head Office URL:</span>
                        <span className="font-mono text-purple-700 font-bold">{hoUrl}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-500 font-semibold">Stores to Deploy:</span>
                        <span className="font-bold text-slate-900">{multiStores.length} branches</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between">
                      <span className="text-slate-500 font-semibold">Store URL:</span>
                      <span className="font-mono text-blue-700 font-bold">{singleStoreUrl}</span>
                    </div>
                  )}
                </div>

                <div className="rounded-lg bg-amber-50 p-3 text-[11px] text-amber-800 border border-amber-200">
                  ⚡ Automatic orchestration will create client resources, configure initial terminals, issue signed trade licences, and verify fleet health.
                </div>

                <div className="flex justify-between pt-4">
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600"
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    disabled={deploying}
                    onClick={handleDeployClient}
                    className="rounded-lg bg-emerald-600 px-6 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {deploying ? 'Deploying Client…' : 'Confirm & Deploy Client'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
