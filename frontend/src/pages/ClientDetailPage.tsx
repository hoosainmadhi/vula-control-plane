import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { StoreCard } from '../components/StoreCard';
import {
  AdminPasswordModal,
  DiagnosticsModal,
  StoreFormModal,
  SupportModal,
  TokenRevealModal,
} from '../components/storeModals';
import { NoticeBanner } from '../components/storeUi';
import { useStoreActions } from '../hooks/useStoreActions';
import type {
  ClientDetailResponse,
  Company,
  CreateStoreResponse,
  Plan,
  SetupFeeStatus,
  Store,
  StoreFormValues,
} from '../types';
import { SETUP_FEE_LABEL, type Notice } from '../lib/storeVocab';
import { rand, PERIOD_LABEL, perTerminalLabel } from '../lib/money';

const SETUP_FEE_LABELS: Record<SetupFeeStatus, string> = {
  not_invoiced: 'Not invoiced yet',
  invoiced: 'Invoiced',
  paid: 'Paid',
  waived: 'Waived',
};

/** The live quote inside the subscription editor — the figure the invoice will carry. */
function SubscriptionQuotePreview({
  plan,
  licensed,
}: {
  plan: Plan | undefined;
  licensed: number;
}) {
  if (!plan) return null;
  const recurring = plan.pricingMode === 'per_terminal' ? plan.terminalPriceCents * licensed : null;
  return (
    <div className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs">
      {recurring === null ? (
        <div className="flex justify-between">
          <span className="text-slate-500">Recurring</span>
          <span className="font-bold text-slate-800">Custom pricing — agreed per client</span>
        </div>
      ) : (
        <div className="flex justify-between">
          <span className="text-slate-500">
            Recurring ({licensed} × {rand(plan.terminalPriceCents)})
          </span>
          <span className="font-mono font-black text-slate-900">
            {rand(recurring)}{' '}
            {plan.billingPeriod === 'once-off' ? '' : PERIOD_LABEL[plan.billingPeriod]}
          </span>
        </div>
      )}
      <div className="mt-1 flex justify-between">
        <span className="text-slate-500">{SETUP_FEE_LABEL}</span>
        <span className="font-mono font-semibold text-slate-800">
          {plan.setupFeeCents > 0 ? rand(plan.setupFeeCents) : 'None'}
        </span>
      </div>
    </div>
  );
}

export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ClientDetailResponse | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'head_office' | 'stores' | 'deployments'>(
    'overview',
  );
  const [error, setError] = useState<string | null>(null);

  // Edit Client modal state
  const [editClientOpen, setEditClientOpen] = useState(false);
  const [editClientName, setEditClientName] = useState('');
  const [editClientEmail, setEditClientEmail] = useState('');
  const [editClientPlanId, setEditClientPlanId] = useState('');
  const [savingClient, setSavingClient] = useState(false);

  // Subscription editor (plan + licensed terminals + allocations + onboarding)
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [subPlanId, setSubPlanId] = useState('');
  const [subLicensed, setSubLicensed] = useState('0');
  const [subSetupFeeStatus, setSubSetupFeeStatus] = useState<SetupFeeStatus>('not_invoiced');
  const [subAllocations, setSubAllocations] = useState<
    Array<{ storeId: number; name: string; licensed: string }>
  >([]);
  const [savingSubscription, setSavingSubscription] = useState(false);

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
  const [supportEndBusy, setSupportEndBusy] = useState(false);
  const [panelEditOpen, setPanelEditOpen] = useState(false);
  const [panelEditName, setPanelEditName] = useState('');
  const [panelEditUrl, setPanelEditUrl] = useState('');
  const [panelSaving, setPanelSaving] = useState(false);
  const [panelRemoveConfirm, setPanelRemoveConfirm] = useState(false);
  const [panelToken, setPanelToken] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
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
  const [addStoreToken, setAddStoreToken] = useState('');
  const [addingStore, setAddingStore] = useState(false);
  const [billingOnboarding, setBillingOnboarding] = useState(false);
  /** A token the control plane generated — shown once, right after creation. */
  const [newToken, setNewToken] = useState<{ storeName: string; token: string } | null>(null);

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

  /**
   * The subscription editor: the plan, the licensed quantity (per store for a
   * multi-store client, so the allocation can be distributed), and the state of
   * the once-off onboarding charge.
   */
  const handleOpenSubscription = () => {
    if (!data) return;
    const sub = data.subscription;
    setSubPlanId(data.client.planId ? String(data.client.planId) : '');
    setSubLicensed(String(sub?.licensedTerminalCount ?? data.client.licensedTerminalCount ?? 0));
    setSubSetupFeeStatus(sub?.setupFeeStatus ?? data.client.setupFeeStatus ?? 'not_invoiced');
    setSubAllocations(
      (data.stores ?? []).map((store) => {
        const allocation = sub?.allocations.find((a) => a.storeId === store.id);
        return {
          storeId: store.id,
          name: store.name,
          licensed: String(allocation?.licensedTerminalCount ?? 0),
        };
      }),
    );
    setSubscriptionOpen(true);
  };

  const handleSaveSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSavingSubscription(true);
    setError(null);
    try {
      const isMulti = (data?.client.topology ?? 'single_store') === 'multi_store';
      await api(`/clients/${id}`, {
        method: 'PUT',
        body: {
          planId: subPlanId ? Number(subPlanId) : null,
          setupFeeStatus: subSetupFeeStatus,
          ...(isMulti
            ? {
                allocations: subAllocations.map((a) => ({
                  storeId: a.storeId,
                  licensedTerminalCount: Number(a.licensed) || 0,
                })),
              }
            : { licensedTerminalCount: Number(subLicensed) || 0 }),
        },
      });
      setSubscriptionOpen(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the subscription');
    } finally {
      setSavingSubscription(false);
    }
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
                // The new branch's licences, drawn from the client's purchased
                // total — the upgrade route sums them with the existing stores.
                licensedTerminalCount: Number(newStoreTills) || 1,
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

  const runPanelDiagnostics = async (): Promise<void> => {
    if (!headOffice) return;
    setError(null);
    try {
      const res = await api<{ ok: boolean; error?: string }>(`/panels/${headOffice.id}/health`, {
        method: 'POST',
      });
      notify(
        res.ok ? 'ok' : 'error',
        res.ok
          ? `${headOffice.slug} is up — licence refreshed`
          : `${headOffice.slug} is down: ${res.error}`,
      );
      await loadData();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Diagnostics failed');
    }
  };

  const pushPanelLicence = async (): Promise<void> => {
    if (!headOffice) return;
    setError(null);
    try {
      const res = await api<{ ok: boolean; sequence?: number; error?: string }>(
        `/panels/${headOffice.id}/licence`,
        { method: 'POST' },
      );
      notify(
        res.ok ? 'ok' : 'error',
        res.ok
          ? `Licence v${res.sequence} pushed to ${headOffice.slug}`
          : `Licence push failed: ${res.error}`,
      );
      await loadData();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Licence push failed');
    }
  };

  const openPanelEdit = (): void => {
    if (!headOffice) return;
    setPanelEditName(headOffice.name);
    setPanelEditUrl(headOffice.baseUrl);
    setPanelEditOpen(true);
  };

  const savePanelEdit = async (): Promise<void> => {
    if (!headOffice) return;
    setPanelSaving(true);
    setError(null);
    try {
      await api(`/panels/${headOffice.id}`, {
        method: 'PUT',
        body: { name: panelEditName.trim(), baseUrl: panelEditUrl.trim() },
      });
      notify('ok', `${panelEditName.trim()} updated`);
      setPanelEditOpen(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the Head Office');
    } finally {
      setPanelSaving(false);
    }
  };

  const revealPanelToken = async (): Promise<void> => {
    if (!headOffice) return;
    try {
      const res = await api<{ ok: boolean; token: string }>(`/panels/${headOffice.id}/token`);
      setPanelToken(res.token);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to reveal token');
    }
  };

  const removePanel = async (): Promise<void> => {
    if (!headOffice) return;
    setError(null);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/panels/${headOffice.id}`, {
        method: 'DELETE',
      });
      notify('ok', res.message);
      setPanelRemoveConfirm(false);
      await loadData();
    } catch (err) {
      setPanelRemoveConfirm(false);
      notify('error', err instanceof Error ? err.message : 'Failed to remove the Head Office');
    }
  };

  const endSupport = async (store: Store): Promise<void> => {
    setSupportEndBusy(true);
    try {
      await api<{ ok: boolean }>(`/stores/${store.id}/support/end`, { method: 'POST' });
      notify('ok', `Support session for ${store.slug} ended — recorded in the audit trail.`);
      setSupportStore(null);
      await loadData();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Failed to end support session');
    } finally {
      setSupportEndBusy(false);
    }
  };

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
      // Blank keeps the stored credential; a value reconciles it with the
      // deployment (the repair for "Invalid control plane token").
      if (values.controlPlaneToken) body.controlPlaneToken = values.controlPlaneToken;
      await api(`/stores/${configureStore.id}`, { method: 'PUT', body });
      notify(
        'ok',
        values.controlPlaneToken
          ? `${values.name.trim()} updated — push credential replaced, so the next push should authenticate`
          : `${values.name.trim()} updated — changes apply on the next push`,
      );
      setConfigureStore(null);
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update store');
    } finally {
      setSavingStore(false);
    }
  };

  /**
   * Raises the invoice for a plan's once-off onboarding charge — the one
   * accounting entry the subscription showed but could not bill. Billing the
   * `initial` invoice instead would charge the client's current period twice.
   */
  const billOnboarding = async (): Promise<void> => {
    if (!id) return;
    setBillingOnboarding(true);
    try {
      const invoice = await api<{ invoiceNumber: string; amountCents: number }>(
        '/billing/invoices',
        { method: 'POST', body: { companyId: Number(id), purpose: 'onboarding' } },
      );
      notify(
        'ok',
        `Onboarding billed — invoice ${invoice.invoiceNumber} for ${rand(invoice.amountCents)}. It is on the Billing page, ready to email or settle.`,
      );
      await loadData();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Could not bill the onboarding charge');
    } finally {
      setBillingOnboarding(false);
    }
  };

  /**
   * Applies the plan's current price to this client. Plans no longer re-price the
   * clients on them, so this is how a price rise actually takes effect — one
   * client at a time, explicitly.
   */
  const [repricing, setRepricing] = useState(false);
  const rePrice = async (): Promise<void> => {
    if (!id) return;
    if (
      !confirm(
        "Apply the plan's current price to this client? It governs invoices raised from now on.",
      )
    ) {
      return;
    }
    setRepricing(true);
    try {
      const res = await api<{
        planCode: string;
        rateCents: number;
        recurringAmountCents: number | null;
        previousRecurringAmountCents: number | null;
      }>(`/clients/${id}/reprice`, { method: 'POST' });
      notify(
        'ok',
        `Re-priced to ${res.planCode}: ${res.previousRecurringAmountCents === null ? '—' : rand(res.previousRecurringAmountCents)} → ${res.recurringAmountCents === null ? '—' : rand(res.recurringAmountCents)} per period. Invoices already issued keep their figures.`,
      );
      await loadData();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Could not re-price this client');
    } finally {
      setRepricing(false);
    }
  };

  /** Bills the extra terminals bought since this period was invoiced. */
  const [billingProRata, setBillingProRata] = useState(false);
  const billProRata = async (): Promise<void> => {
    if (!id) return;
    setBillingProRata(true);
    try {
      const invoice = await api<{ invoiceNumber: string; amountCents: number }>(
        '/billing/invoices',
        { method: 'POST', body: { companyId: Number(id), purpose: 'pro_rata' } },
      );
      notify(
        'ok',
        `Mid-period increase billed — invoice ${invoice.invoiceNumber} for ${rand(invoice.amountCents)}. It is on the Billing page, ready to email or settle.`,
      );
      await loadData();
    } catch (err) {
      notify(
        'error',
        err instanceof Error ? err.message : 'Could not bill the mid-period increase',
      );
    } finally {
      setBillingProRata(false);
    }
  };

  const handleAddStore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !addStoreName || !addStoreSlug) return;
    setAddingStore(true);
    setError(null);
    try {
      const res = await api<CreateStoreResponse>('/stores', {
        method: 'POST',
        body: {
          name: addStoreName.trim(),
          slug: addStoreSlug.trim(),
          baseUrl: addStoreUrl.trim() || `https://${addStoreSlug.trim()}.vula-app.co.za`,
          terminalCount: Number(addStoreTills) || 1,
          // Licences come out of the client's purchased quantity; the API refuses
          // a store the client has not licensed.
          licensedTerminalCount: Number(addStoreTills) || 1,
          companyId: Number(id),
          vertical: 'general',
          ...(addStoreToken ? { controlPlaneToken: addStoreToken } : {}),
        },
      });
      setAddStoreOpen(false);
      setAddStoreName('');
      setAddStoreSlug('');
      setAddStoreUrl('');
      setAddStoreToken('');
      // Report the first push and hand over a generated token. Discarding both
      // (as this form used to) leaves a store whose generated token nobody ever
      // saw: every push then fails with "Invalid control plane token" and
      // nothing on screen explains why.
      if (res.generatedControlPlaneToken) {
        setNewToken({ storeName: res.store.name, token: res.generatedControlPlaneToken });
      } else if (res.firstPush && !res.firstPush.ok) {
        notify(
          'error',
          `${res.store.slug} created, but the first push failed: ${res.firstPush.error ?? 'unknown error'}`,
        );
      } else {
        notify('ok', `${res.store.slug} created — Till 1..${res.store.terminalCount} pushed`);
      }
      await loadData();
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
  const subscription = data.subscription;

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
            {
              id: 'head_office',
              label: client.topology === 'multi_store' ? 'Head Office' : 'Head Office (None)',
            },
            { id: 'stores', label: `Stores (${stores.length})` },
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
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h4 className="text-sm font-bold text-slate-900">Subscription</h4>
                <button
                  type="button"
                  onClick={handleOpenSubscription}
                  className="rounded-lg border border-brand-200 px-3 py-1.5 text-xs font-bold text-brand-700 hover:bg-brand-50"
                >
                  Edit subscription
                </button>
              </div>
              <div className="divide-y divide-slate-100 text-xs">
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Plan:</span>
                  <span className="font-bold text-slate-900">
                    {client.planName}
                    {subscription?.pricingMode === 'custom' && (
                      <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600">
                        Custom
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Licensed terminals:</span>
                  <span className="font-bold text-slate-900">
                    {client.licensedTerminalCount ?? 0}
                    <span className="ml-1.5 font-normal text-slate-400">
                      ({client.allocatedTerminals ?? 0} allocated to stores)
                    </span>
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Monthly recurring:</span>
                  <span className="font-mono font-bold text-slate-900">
                    {subscription && subscription.recurringAmountCents !== null
                      ? `${rand(subscription.recurringAmountCents)} ${PERIOD_LABEL[subscription.billingPeriod ?? 'monthly']}`
                      : subscription?.pricingMode === 'custom'
                        ? 'Negotiated per client'
                        : '—'}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-3 py-2">
                  <span className="text-slate-500 font-medium">{SETUP_FEE_LABEL}:</span>
                  <span className="text-right font-semibold text-slate-800">
                    {subscription && subscription.setupFeeCents > 0
                      ? `${rand(subscription.setupFeeCents)} · ${SETUP_FEE_LABELS[subscription.setupFeeStatus]}`
                      : 'None'}
                    {/* The charge is only billable while it is still unbilled; a
                        client invoiced for a period must not be charged that
                        period again just to raise its onboarding. */}
                    {subscription?.setupFeeStatus === 'not_invoiced' &&
                      subscription.setupFeeCents > 0 && (
                        <button
                          type="button"
                          onClick={() => void billOnboarding()}
                          disabled={billingOnboarding}
                          className="mt-1.5 block w-full rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-700 hover:bg-brand-100 disabled:opacity-50"
                        >
                          {billingOnboarding
                            ? 'Raising…'
                            : `Bill ${rand(subscription.setupFeeCents)} onboarding`}
                        </button>
                      )}
                  </span>
                </div>

                {/* The price this client agreed, and whether a plan edit could
                    still move it. */}
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[11px] text-slate-500">
                      {subscription?.pricingSource === 'agreed' ? (
                        <>
                          Priced by agreement
                          {subscription.pricedAt ? (
                            <span className="text-slate-400">
                              {' '}
                              · recorded {subscription.pricedAt}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-amber-700">
                          Priced from the plan — no agreed price recorded yet, so editing the plan
                          would change what this client pays.
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => void rePrice()}
                      disabled={repricing}
                      className="shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      title="Apply the plan's current price to this client"
                    >
                      {repricing ? 'Applying…' : 'Apply plan price'}
                    </button>
                  </div>
                </div>

                {/* Terminals bought since this period was invoiced. */}
                {subscription?.midPeriodCharge && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[11px] font-medium text-amber-900">
                        {subscription.midPeriodCharge.extraTerminals} extra terminal
                        {subscription.midPeriodCharge.extraTerminals === 1 ? '' : 's'} bought
                        mid-period
                        <span className="block text-amber-700">
                          {subscription.midPeriodCharge.daysRemaining} of{' '}
                          {subscription.midPeriodCharge.periodDays} days left ·{' '}
                          {subscription.midPeriodCharge.from} to {subscription.midPeriodCharge.to}
                          {subscription.midPeriodCharge.billedOn
                            ? ` · already on ${subscription.midPeriodCharge.billedOn}`
                            : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-xs font-bold text-amber-900">
                          {rand(subscription.midPeriodCharge.amountCents)}
                        </span>
                        {!subscription.midPeriodCharge.billedOn && (
                          <button
                            type="button"
                            onClick={() => void billProRata()}
                            disabled={billingProRata}
                            className="mt-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                          >
                            {billingProRata ? 'Raising…' : 'Bill the difference'}
                          </button>
                        )}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Billing state:</span>
                  <span className="font-bold uppercase text-emerald-700">
                    {client.billingState}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Paid up to:</span>
                  <span className="font-semibold text-slate-900">{client.paidThrough || '—'}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Trial ends:</span>
                  <span className="text-slate-700">{client.trialEndsAt || 'No active trial'}</span>
                </div>
              </div>
              {subscription?.note && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
                  {subscription.note}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
              <h4 className="text-sm font-bold text-slate-900">Topology & Fleet Health</h4>
              <div className="divide-y divide-slate-100 text-xs">
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Retail Topology:</span>
                  <span className="font-bold text-slate-900">
                    {client.topology === 'multi_store'
                      ? 'Multi-Store (Group + Branches)'
                      : 'Single Store'}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Store Fleet:</span>
                  <span className="font-bold text-slate-900">
                    {client.healthyStoresCount} of {client.storesCount} healthy
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Terminals:</span>
                  <span className="font-bold text-slate-900">
                    {client.licensedTerminalCount ?? 0} licensed · {client.totalTills} configured
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-medium">Head Office Executive Panel:</span>
                  <span className="font-semibold">
                    {headOffice ? 'Active (Connected)' : 'None'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Licence allocation (§20): what the client bought, placed per store. */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-slate-900">Terminal licence allocation</h4>
              <span className="text-xs font-bold text-slate-500">
                Total allocated {subscription?.allocatedTerminals ?? 0} /{' '}
                {subscription?.licensedTerminalCount ?? 0}
              </span>
            </div>
            {(subscription?.allocations ?? []).length === 0 ? (
              <p className="text-xs text-slate-400">
                No terminals allocated yet. Edit the subscription to place licensed terminals on
                this client's stores.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="py-1.5">Store</th>
                    <th className="py-1.5 text-right">Licensed</th>
                    <th className="py-1.5 text-right">Configured tills</th>
                    <th className="py-1.5 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(subscription?.allocations ?? []).map((a) => (
                    <tr key={a.storeId}>
                      <td className="py-2 font-semibold text-slate-800">
                        <Link
                          to={`/stores/${a.storeId}`}
                          className="hover:text-brand-700 hover:underline"
                        >
                          {a.storeName}
                        </Link>
                      </td>
                      <td className="py-2 text-right font-mono font-bold text-slate-900">
                        {a.licensedTerminalCount}
                      </td>
                      <td className="py-2 text-right font-mono text-slate-600">
                        {a.terminalCount}
                      </td>
                      <td className="py-2 text-right">
                        {a.terminalCount > a.licensedTerminalCount ? (
                          <span className="font-bold text-amber-700">Configured above licence</span>
                        ) : (
                          <span className="text-emerald-700">Within licence</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(subscription?.unallocatedTerminals ?? 0) > 0 && (
              <p className="text-[11px] text-slate-500">
                {subscription?.unallocatedTerminals} licensed terminal
                {(subscription?.unallocatedTerminals ?? 0) === 1 ? '' : 's'} not yet placed on a
                store — the client pays for them regardless.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 2. Head Office — its own tab between Overview and Stores */}
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
                <span className="text-slate-500">Last Check:</span>
                <span className="text-slate-600">{headOffice.lastHealthAt ?? 'Never checked'}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">App Version:</span>
                <span className="font-mono">{headOffice.appVersion || 'v1.0.0'}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100">
                <span className="text-slate-500">Licence:</span>
                <span className="font-mono text-slate-700">
                  v{headOffice.licenceSequence} · push {headOffice.licencePushStatus}
                </span>
              </div>
              {panelToken && (
                <div className="w-full rounded-lg bg-slate-900 px-3 py-2 text-center">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    CONTROL_PLANE_TOKEN for this panel's deployment
                  </div>
                  <div className="mt-1 break-all font-mono text-xs tracking-wider text-emerald-300">
                    {panelToken}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void runPanelDiagnostics()}
                  className="rounded-lg border border-sky-200 px-3 py-1.5 text-xs font-bold text-sky-700 hover:bg-sky-50"
                >
                  Diagnostics
                </button>
                <button
                  type="button"
                  onClick={() => void pushPanelLicence()}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  Push Licence
                </button>
                <button
                  type="button"
                  onClick={openPanelEdit}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void revealPanelToken()}
                  title="Show the CONTROL_PLANE_TOKEN this panel expects (audited)"
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  Reveal Token
                </button>
                {panelRemoveConfirm ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void removePanel()}
                      className="rounded-lg border border-red-600 bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-500"
                    >
                      Confirm remove
                    </button>
                    <button
                      type="button"
                      onClick={() => setPanelRemoveConfirm(false)}
                      className="rounded-lg px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPanelRemoveConfirm(true)}
                    title="Remove the Head Office registration (the deployment and its data are untouched)"
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50"
                  >
                    Remove
                  </button>
                )}
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

      {/* 3. Stores */}
      {activeTab === 'stores' && (
        <div className="rounded-2xl border border-slate-200 bg-white shadow-2xs overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-4 flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-slate-900">Store Fleet Deployments</h4>
              <p className="text-xs text-slate-500">
                Retail branch containers belonging to this client
              </p>
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
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* 4. Deployments & Automation Stepper (§11, §12) */}
      {activeTab === 'deployments' && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-bold text-slate-900">Durable Deployment Jobs</h4>
              <p className="text-xs text-slate-500">
                Idempotent container provisioning, volume attachment & licence wiring
              </p>
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
                  <span className="font-semibold text-slate-500">
                    Job #{latestDeployment.job.id}:{' '}
                  </span>
                  <span className="font-bold text-slate-800 uppercase">
                    {latestDeployment.job.type.replace(/_/g, ' ')}
                  </span>
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
                          <div className="text-[10px] text-slate-400">
                            Resource: {st.resource_type}
                          </div>
                          {warnings.length > 0 && (
                            <div className="mt-1 space-y-0.5">
                              {warnings.map((w, wi) => (
                                <div key={wi} className="text-[10px] text-amber-600">
                                  ⚠ {w}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {st.error && (
                          <span className="text-[10px] text-rose-600 font-semibold">
                            {st.error}
                          </span>
                        )}
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
            <div className="p-8 text-center text-xs text-slate-400">
              No recent deployment jobs recorded.
            </div>
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
                <label className="block text-xs font-bold text-slate-700">
                  Client / Company Name *
                </label>
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

      {/* Subscription editor: plan, purchased quantity, allocation, onboarding state */}
      {subscriptionOpen && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Subscription for {client.name}</h3>
            <p className="mt-1 text-xs text-slate-500">
              What the client has purchased. The recurring fee is the licensed quantity × the plan's
              rate; configured tills and claimed devices never change it.
            </p>
            <form onSubmit={handleSaveSubscription} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700">Plan</label>
                <select
                  value={subPlanId}
                  onChange={(e) => setSubPlanId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                >
                  <option value="">No plan assigned</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.pricingMode === 'per_terminal'
                        ? ` — ${perTerminalLabel(p.terminalPriceCents, p.billingPeriod)}`
                        : ' — custom pricing'}
                    </option>
                  ))}
                </select>
              </div>

              {client.topology === 'multi_store' ? (
                <div>
                  <label className="block text-xs font-bold text-slate-700">
                    Licensed terminals
                  </label>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    Distribute the client's purchased terminals across its stores. Each store's
                    signed licence permits exactly its allocation.
                  </p>
                  <div className="mt-2 space-y-2">
                    {subAllocations.map((a, idx) => (
                      <div key={a.storeId} className="flex items-center justify-between gap-3">
                        <Link
                          to={`/stores/${a.storeId}`}
                          className="text-xs font-semibold text-slate-700 hover:text-brand-700 hover:underline"
                        >
                          {a.name}
                        </Link>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={99}
                            value={a.licensed}
                            onChange={(e) => {
                              const next = [...subAllocations];
                              next[idx] = { ...next[idx], licensed: e.target.value };
                              setSubAllocations(next);
                            }}
                            className="w-20 rounded-lg border border-slate-300 p-2 text-center text-sm font-bold"
                          />
                          <span className="text-[11px] text-slate-400">
                            configured{' '}
                            {data.stores.find((s) => s.id === a.storeId)?.terminalCount ?? 0}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-xs font-bold">
                    <span className="text-slate-600">Total licensed</span>
                    <span className="font-mono text-slate-900">
                      {subAllocations.reduce((n, a) => n + (Number(a.licensed) || 0), 0)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Adding a branch later draws from the same total, so raise this first if the
                    client is buying more terminals.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-bold text-slate-700">
                    Licensed terminals
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={subLicensed}
                    onChange={(e) => setSubLicensed(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    The store may be configured for at most this many tills.
                  </p>
                </div>
              )}

              <SubscriptionQuotePreview
                plan={plans.find((p) => String(p.id) === subPlanId)}
                licensed={
                  client.topology === 'multi_store'
                    ? subAllocations.reduce((n, a) => n + (Number(a.licensed) || 0), 0)
                    : Number(subLicensed) || 0
                }
              />

              <div>
                <label className="block text-xs font-bold text-slate-700">{SETUP_FEE_LABEL}</label>
                <select
                  value={subSetupFeeStatus}
                  onChange={(e) => setSubSetupFeeStatus(e.target.value as SetupFeeStatus)}
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 text-sm"
                >
                  {(Object.keys(SETUP_FEE_LABELS) as SetupFeeStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {SETUP_FEE_LABELS[s]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-400">
                  Charged once. Whichever invoice is raised next carries it while it is unbilled — a
                  renewal included; after that it is never repeated.
                </p>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setSubscriptionOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSubscription}
                  className="rounded-lg bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50 cursor-pointer"
                >
                  {savingSubscription ? 'Saving…' : 'Save subscription'}
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
              Deploy a merchant Head Office portal and attach branches. Existing store data remains
              100% intact (§7).
            </p>
            <form onSubmit={handleUpgradeToMultiStore} className="mt-4 space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-700">
                  Head Office Portal Name
                </label>
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
                <div className="text-xs font-bold text-slate-700 mb-2">
                  Optional Second Branch Store
                </div>
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
                <label className="block text-xs font-bold text-slate-700">
                  Target Multi-Store Plan
                </label>
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
            <p className="mt-1 text-xs text-slate-500">
              Attach a new retail store to {client.name}
            </p>
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
              <div>
                <label className="block text-xs font-bold text-slate-700">
                  Control-plane token <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={addStoreToken}
                  onChange={(e) => setAddStoreToken(e.target.value.trim().toLowerCase())}
                  placeholder="64 hex chars — blank generates one"
                  className="mt-1 w-full rounded-lg border border-slate-300 p-2 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  For a deployment that already exists, paste its{' '}
                  <code className="font-mono">CONTROL_PLANE_TOKEN</code>. Leave blank for a new one
                  and the control plane shows the generated token once.
                </p>
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
      {panelEditOpen && headOffice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h3 className="text-lg font-bold text-slate-900">Edit Head Office</h3>
            <p className="mt-1 text-xs text-slate-500">
              Update the panel registration for {headOffice.slug}
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void savePanelEdit();
              }}
            >
              <div>
                <label className="mb-1 block text-xs font-bold text-slate-700">Panel name</label>
                <input
                  value={panelEditName}
                  onChange={(e) => setPanelEditName(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 p-2.5 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-bold text-slate-700">Base URL</label>
                <input
                  value={panelEditUrl}
                  onChange={(e) => setPanelEditUrl(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 p-2.5 font-mono text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPanelEditOpen(false)}
                  className="rounded-lg px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={panelSaving || !panelEditName.trim()}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {panelSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

      {newToken && (
        <TokenRevealModal
          storeName={newToken.storeName}
          token={newToken.token}
          onClose={() => setNewToken(null)}
        />
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
          onStart={(reason) =>
            startSupport(supportStore, reason).then((ok) => {
              if (ok) void loadData();
              return ok;
            })
          }
          onIssuePassword={() => supportIssuePassword(supportStore)}
          onEnd={() => void endSupport(supportStore)}
          endBusy={supportEndBusy}
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
