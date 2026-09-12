import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { SummaryTile } from '../components/storeUi';
import {
  AdminPasswordModal,
  DiagnosticsModal,
  StoreFormModal,
  SupportModal,
} from '../components/storeModals';
import { StoreCard } from '../components/StoreCard';
import { useStoreActions } from '../hooks/useStoreActions';
import type {
  CreateStoreResponse,
  Store,
  StoreFormValues,
} from '../types';
import { ModalState, Notice, NoticeKind } from '../lib/storeVocab';
import type { Company } from '../types';

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'healthy' | 'warning' | 'offline' | 'paused' | 'config-issue' | 'sync-issue'
  >('all');
  const [diagnostics, setDiagnostics] = useState<Store | null>(null);
  const [supportStore, setSupportStore] = useState<Store | null>(null);
  const [moreMenuId, setMoreMenuId] = useState<number | null>(null);
  const [newToken, setNewToken] = useState<{ storeName: string; token: string } | null>(null);
  const [adminPassword, setAdminPassword] = useState<{
    storeName: string;
    tempPassword: string;
    note: string;
  } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [data, companyList] = await Promise.all([
        api<Store[]>('/stores'),
        api<Company[]>('/companies'),
      ]);
      setStores(data);
      setCompanies(companyList);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load stores');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live polling when any store is currently being provisioned on Coolify
  useEffect(() => {
    const isProvisioning = stores.some((s) => s.deployStatus === 'provisioning');
    if (!isProvisioning) return;
    const interval = setInterval(() => {
      void load();
    }, 4000);
    return () => clearInterval(interval);
  }, [stores, load]);

  const notify = (kind: NoticeKind, text: string): void => setNotice({ kind, text });

  const actions = useStoreActions({
    notify,
    reload: load,
    onAdminPassword: (reveal) => setAdminPassword(reveal),
  });
  const { busyId, pushNow, healthCheck, togglePause, removeStore, startSupport, supportIssuePassword, supportBusy, supportError, setSupportError } = actions;

  const runDiagnostics = (store: Store): void => {
    setDiagnostics(store);
    void healthCheck(store);
  };

  const submitForm = async (values: StoreFormValues): Promise<void> => {
    setSaving(true);
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
      if (modal?.mode === 'edit') {
        if (values.tillNames) body.terminalNames = values.tillNames;
        await api<Store>(`/stores/${modal.store.id}`, { method: 'PUT', body });
        notify('ok', `${values.name.trim()} updated — changes apply on the next push`);
      } else {
        const res = await api<CreateStoreResponse>('/stores', {
          method: 'POST',
          body: {
            ...body,
            slug: values.slug,
            ...(values.controlPlaneToken ? { controlPlaneToken: values.controlPlaneToken } : {}),
            ...(values.provision ? { provision: true, adminEmail: values.adminEmail?.trim() } : {}),
          },
        });
        const store = res.store;
        notify(
          res.provisioning ? 'ok' : res.firstPush?.ok ? 'ok' : 'error',
          res.provisioning
            ? `Store ${store.slug} created — container provisioning launched on Coolify...`
            : res.firstPush?.ok
              ? `Store ${store.slug} created; Till 1..${store.terminalCount} pushed`
              : `Store ${store.slug} created but the first push failed: ${res.firstPush?.error ?? 'unknown error'}`,
        );
        // Reveal a generated token exactly once — otherwise the operator has no
        // way to put it into the deployment, and every push fails on mismatch.
        if (res.generatedControlPlaneToken) {
          setNewToken({ storeName: store.name, token: res.generatedControlPlaneToken });
        }
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Fleet totals — technical health leads, administrative state second (SPOG §20).
  const summary = useMemo(
    () => ({
      total: stores.length,
      healthy: stores.filter((s) => s.healthState === 'healthy').length,
      warning: stores.filter((s) => s.healthState === 'warning').length,
      offline: stores.filter((s) => s.healthState === 'offline').length,
      configIssues: stores.filter((s) => s.configState === 'failed' || s.configState === 'pending')
        .length,
      syncIssues: stores.filter((s) => (s.telemetry?.sync.failedEvents ?? 0) > 0).length,
      licenceWarnings: stores.filter(
        (s) =>
          s.registerState === 'warn' ||
          s.registerState === 'grace' ||
          s.registerState === 'suspended' ||
          s.registerState === 'unlicensed',
      ).length,
      terminals: stores.reduce((n, s) => n + s.terminalCount, 0),
      active: stores.filter((s) => s.status === 'active').length,
      paused: stores.filter((s) => s.status === 'paused').length,
    }),
    [stores],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return stores.filter((s) => {
      if (statusFilter === 'paused') {
        if (s.status !== 'paused') return false;
      } else if (statusFilter === 'config-issue') {
        if (s.configState !== 'failed' && s.configState !== 'pending') return false;
      } else if (statusFilter === 'sync-issue') {
        if ((s.telemetry?.sync.failedEvents ?? 0) === 0) return false;
      } else if (statusFilter !== 'all') {
        if (s.healthState !== statusFilter) return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.baseUrl.toLowerCase().includes(q) ||
        String(s.id) === q ||
        s.id === Number(q)
      );
    });
  }, [stores, query, statusFilter]);

  if (loading) {
    return <Spinner label="Loading stores…" />;
  }

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
      {/* Fleet summary — technical health first (SPOG §20) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile label="Stores" value={summary.total} />
        <SummaryTile label="Healthy" value={summary.healthy} tone="green" />
        <SummaryTile label="Warning" value={summary.warning} tone="amber" />
        <SummaryTile label="Offline" value={summary.offline} tone="red" />
        <SummaryTile label="Config issues" value={summary.configIssues} tone={summary.configIssues > 0 ? 'red' : 'slate'} />
        <SummaryTile label="Terminals" value={summary.terminals} tone="brand" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryTile label="Active" value={summary.active} />
        <SummaryTile label="Paused" value={summary.paused} tone="amber" />
        <SummaryTile label="Sync issues" value={summary.syncIssues} tone={summary.syncIssues > 0 ? 'red' : 'slate'} />
        <SummaryTile label="Licence warnings" value={summary.licenceWarnings} tone={summary.licenceWarnings > 0 ? 'amber' : 'slate'} />
        <div className="hidden lg:block" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search store, slug, domain or ID"
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ['all', 'All'],
                ['healthy', 'Healthy'],
                ['warning', 'Warning'],
                ['offline', 'Offline'],
                ['paused', 'Paused'],
                ['config-issue', 'Config issue'],
                ['sync-issue', 'Sync issue'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                  statusFilter === value
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => {
            setFormError(null);
            setModal({ mode: 'create' });
          }}
          className="rounded-lg bg-brand-600 px-4 py-2.5 text-center text-sm font-bold text-white hover:bg-brand-700"
        >
          + New store
        </button>
      </div>

      {notice && (
        <div
          className={`flex items-center justify-between rounded-lg px-4 py-2.5 text-sm ${
            notice.kind === 'ok'
              ? 'border border-green-200 bg-green-50 text-green-800'
              : 'border border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <span>{notice.text}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-xs text-slate-400 hover:text-slate-600"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {stores.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No stores registered yet.
          <div className="mt-4">
            <button
              onClick={() => {
                setFormError(null);
                setModal({ mode: 'create' });
              }}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700"
            >
              Register your first store
            </button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          No stores match “{query}”.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((store) => (
            <StoreCard
              key={store.id}
              store={store}
              busy={busyId === store.id}
              confirmRemove={confirmDeleteId === store.id}
              moreOpen={moreMenuId === store.id}
              nameHref={`/stores/${store.id}`}
              onConfigure={() => {
                setFormError(null);
                setModal({ mode: 'edit', store });
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
          ))}
        </div>
      )}

      <p className="text-xs text-slate-400">
        Each card is one Vula store deployment. Terminal tiles show Till 1…N as pushed to the store;
        green means the last config push succeeded.
      </p>

      {modal && (
        <StoreFormModal
          modal={modal}
          saving={saving}
          error={formError}
          companies={companies}
          onClose={() => setModal(null)}
          onSubmit={(values) => void submitForm(values)}
        />
      )}

      {newToken && (
        <Modal
          title={`Control-plane token — ${newToken.storeName}`}
          onClose={() => setNewToken(null)}
        >
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              The control plane generated this token. It is shown <strong>once</strong> and is never
              returned again — copy it into the deployment's env as{' '}
              <code className="rounded bg-slate-100 px-1 font-mono text-xs">
                CONTROL_PLANE_TOKEN
              </code>
              , then restart the store. Until that matches, every push and health check will fail
              with &ldquo;Invalid control plane token&rdquo;.
            </p>
            <div className="rounded-lg bg-slate-900 px-4 py-3 text-center font-mono text-sm tracking-wider text-emerald-300 break-all">
              {newToken.token}
            </div>
            <p className="text-xs text-slate-400">
              If the deployment already exists with its own token, delete this store record and add
              it again pasting that token instead.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(newToken.token).catch(() => undefined)
                }
                className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Copy
              </button>
              <button
                onClick={() => setNewToken(null)}
                className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}

      {adminPassword && (
        <AdminPasswordModal
          storeName={adminPassword.storeName}
          tempPassword={adminPassword.tempPassword}
          note={adminPassword.note}
          onClose={() => setAdminPassword(null)}
        />
      )}

      {diagnostics && (
        <DiagnosticsModal
          store={stores.find((s) => s.id === diagnostics.id) ?? diagnostics}
          running={busyId === diagnostics.id}
          onClose={() => setDiagnostics(null)}
          onRerun={() => void healthCheck(diagnostics)}
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
    </div>
  );
}
