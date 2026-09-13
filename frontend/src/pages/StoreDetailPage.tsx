import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, HeartPulse, LifeBuoy, Loader2, MoreHorizontal, Pencil, Rocket } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Spinner from '../components/Spinner';
import StatusBadge, { REGISTER_STATE_COLORS, STORE_COLORS, VERTICAL_COLORS } from '../components/StatusBadge';
import { TerminalRoster, ActionButton } from '../components/storeUi';
import {
  AdminPasswordModal,
  DiagnosticsModal,
  StoreFormModal,
  SupportModal,
} from '../components/storeModals';
import { useStoreActions } from '../hooks/useStoreActions';
import {
  CONFIG_STATE_COLORS,
  CONFIG_STATE_LABELS,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_LABELS,
  HEALTH_STATE_COLORS,
  HEALTH_STATE_LABELS,
  LICENCE_LABELS,
  STATUS_LABELS,
  VERTICAL_LABELS,
  fmtAgo,
  fmtTime,
} from '../lib/storeVocab';
import type { Company, Store, StoreFormValues } from '../types';

/** One audited action in the store's trail. */
interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  reason: string | null;
  result: string;
  created_at: string;
}

interface StoreDetail extends Store {
  lastConfigSnapshot: unknown;
  terminals: Array<{ till: number; name: string; configured: boolean }>;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 space-y-0.5 text-xs text-slate-600">{children}</div>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-1 last:border-0">
    <span className="text-slate-400">{k}</span>
    <span className="text-right font-semibold text-slate-700">{v}</span>
  </div>
);

export default function StoreDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [store, setStore] = useState<StoreDetail | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [configureOpen, setConfigureOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState<{
    storeName: string;
    tempPassword: string;
    note: string;
  } | null>(null);

  const storeId = Number(id);
  const notify = (kind: 'ok' | 'error', text: string): void => setNotice({ kind, text });

  const load = useCallback(async (): Promise<void> => {
    try {
      const [detail, companyList, auditLogs] = await Promise.all([
        api<StoreDetail>(`/stores/${storeId}`),
        api<Company[]>('/companies'),
        api<{ ok: boolean; logs: AuditEntry[] }>(`/stores/${storeId}/audit`),
      ]);
      setStore(detail);
      setCompanies(companyList);
      setAudit(auditLogs.logs ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load store');
    } finally {
      setLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const actions = useStoreActions({ notify, reload: load, onAdminPassword: setAdminPassword });
  const { busyId, pushNow, healthCheck, togglePause, removeStore, startSupport, supportIssuePassword, supportBusy, supportError, setSupportError } = actions;

  const runDiagnostics = (): void => {
    setDiagnosticsOpen(true);
    if (store) void healthCheck(store);
  };

  const submitForm = async (values: StoreFormValues): Promise<void> => {
    if (!store) return;
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
      if (values.tillNames) body.terminalNames = values.tillNames;
      await api<Store>(`/stores/${store.id}`, { method: 'PUT', body });
      notify('ok', `${values.name.trim()} updated — changes apply on the next push`);
      setConfigureOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner label="Loading store…" />;

  if (loadError || !store) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError ?? 'Store not found'} />
        <Link to="/" className="text-sm font-semibold text-brand-600 hover:underline">
          ← Back to Clients
        </Link>
      </div>
    );
  }

  const busy = busyId === store.id;
  const configStateLabel = CONFIG_STATE_LABELS[store.configState];

  return (
    <div className="space-y-5">
      {/* Breadcrumbs + identity */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {store.companyId !== null && store.companyName ? (
              <Link
                to={`/clients/${store.companyId}`}
                className="inline-flex items-center gap-1 hover:text-slate-600"
              >
                <ArrowLeft className="h-3 w-3" /> {store.companyName}
              </Link>
            ) : (
              <Link to="/" className="inline-flex items-center gap-1 hover:text-slate-600">
                <ArrowLeft className="h-3 w-3" /> Clients
              </Link>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-black text-slate-900">{store.name}</h3>
            <StatusBadge status={store.status} colors={STORE_COLORS} label={STATUS_LABELS[store.status]} />
            <StatusBadge status={store.environment} colors={ENVIRONMENT_COLORS} label={ENVIRONMENT_LABELS[store.environment]} />
            <StatusBadge status={store.vertical} colors={VERTICAL_COLORS} label={VERTICAL_LABELS[store.vertical]} />
            {store.deployStatus === 'provisioning' && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                <Loader2 className="h-3 w-3 animate-spin" /> Provisioning
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs text-slate-400">
            {store.slug} · #{store.id} · {store.baseUrl.replace(/^https?:\/\//, '')}
          </div>
        </div>

        {/* Actions (SPOG §16) */}
        <div className="relative flex flex-wrap items-start gap-1.5">
          {busy && (
            <span className="inline-flex items-center gap-2 py-1.5 text-xs font-semibold text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
            </span>
          )}
          {!busy && (
            <>
              <ActionButton icon={HeartPulse} label="Diagnostics" onClick={runDiagnostics} className="border-sky-200 text-sky-700 hover:bg-sky-50" />
              <ActionButton icon={Pencil} label="Configure" onClick={() => { setFormError(null); setConfigureOpen(true); }} />
              <ActionButton icon={Rocket} label="Push Config" onClick={() => void pushNow(store)} />
              <ActionButton
                icon={LifeBuoy}
                label="Support"
                onClick={() => {
                  setSupportError(null);
                  setSupportOpen(true);
                }}
                className="border-violet-200 text-violet-700 hover:bg-violet-50"
              />
              <ActionButton icon={MoreHorizontal} label="More" onClick={() => setMoreOpen(!moreOpen)} />
            </>
          )}
          {moreOpen && (
            <>
              <button className="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onClick={() => setMoreOpen(false)} />
              <div className="absolute right-0 top-10 z-40 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    void togglePause(store);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {store.status === 'active' ? 'Pause store' : 'Resume store'}
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    void removeStore(store, () => {
                      setConfirmRemove(false);
                      navigate('/stores');
                    });
                  }}
                  disabled={confirmRemove ? false : store.status === 'active'}
                  title={store.status === 'active' ? 'Pause the store first' : 'Remove the registry row (deployment untouched)'}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {confirmRemove ? 'Confirm remove' : 'Remove store'}
                </button>
              </div>
            </>
          )}
        </div>
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
          <button onClick={() => setNotice(null)} className="text-xs text-slate-400 hover:text-slate-600" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* Overview sections (SPOG §24) */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <Section label="Administrative state">
            <Row k="Status" v={STATUS_LABELS[store.status]} />
            <Row k="Environment" v={ENVIRONMENT_LABELS[store.environment]} />
            <Row k="Deploy" v={store.deployStatus} />
            <Row k="Client" v={store.companyId !== null ? (
              <Link to={`/clients/${store.companyId}`} className="text-brand-600 hover:underline">
                {store.companyName}
              </Link>
            ) : ('Unassigned')} />
            <Row k="Plan" v={store.planName ?? '—'} />
          </Section>
          <Section label="Licence">
            <div className="mb-1">
              <StatusBadge status={store.registerState} colors={REGISTER_STATE_COLORS} label={LICENCE_LABELS[store.registerState] ?? store.registerState} />
            </div>
            <Row k="Trading" v={store.tradingBlocked ? 'New sales refused' : 'Normal'} />
            <Row k="Sequence" v={`#${store.licenceSequence}`} />
            <Row k="Last push" v={store.licencePushStatus === 'ok' ? fmtAgo(store.licencePushedAt) : store.licencePushStatus} />
          </Section>
        </div>

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <Section label="Technical health">
            <div className="mb-1">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${HEALTH_STATE_COLORS[store.healthState]}`}>
                {HEALTH_STATE_LABELS[store.healthState]}
              </span>
            </div>
            <Row k="Checked" v={fmtAgo(store.lastHealthAt)} />
            <Row k="Latency" v={store.latencyMs != null ? `${store.latencyMs} ms` : '—'} />
            {store.healthState === 'offline' && store.lastHealthError && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-600">{store.lastHealthError}</div>
            )}
          </Section>
          <Section label="Version">
            <Row k="App" v={store.appVersion ?? '—'} />
            <Row k="Schema" v={store.schemaVersion != null ? `v${store.schemaVersion}` : '—'} />
            <Row k="Heartbeat" v={fmtAgo(store.lastHeartbeatAt)} />
          </Section>
          <Section label="Sync">
            <Row k="Last device sync" v={store.telemetry?.sync.lastSyncAt ? fmtAgo(store.telemetry.sync.lastSyncAt) : '—'} />
            <Row k="Pending / failed" v={(() => {
              const p = store.telemetry?.sync.pendingEvents;
              const f = store.telemetry?.sync.failedEvents;
              return p == null && f == null ? 'device-side — not reported' : `${p ?? 0} / ${f ?? 0}`;
            })()} />
          </Section>
        </div>

        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <Section label="Configuration">
            <div className="mb-1">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${CONFIG_STATE_COLORS[store.configState]}`}>
                {configStateLabel}
              </span>
            </div>
            <Row k="Expected" v={`v${store.configVersion.expected}`} />
            <Row k="Applied" v={`v${store.configVersion.applied}`} />
            <Row k="Last push" v={fmtAgo(store.lastConfigAt)} />
            {store.configState === 'failed' && store.lastConfigError && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-600">{store.lastConfigError}</div>
            )}
          </Section>
          <Section label="Devices">
            <div className="mb-2">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                {store.telemetry
                  ? `${store.telemetry.terminals.configured} configured · ${store.telemetry.terminals.claimed} claimed · ${store.telemetry.terminals.open} open`
                  : `${store.terminalCount} configured`}
              </span>
            </div>
            <TerminalRoster store={store} />
          </Section>
        </div>
      </div>

      {/* Audit trail (SPOG §38) */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Recent audited actions
        </div>
        {audit.length === 0 ? (
          <div className="px-5 py-4 text-xs text-slate-400">No audited actions recorded for this store yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {audit.slice(0, 15).map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2 text-xs">
                <span className="font-semibold text-slate-700">{entry.action.replace(/_/g, ' ')}</span>
                <span className="text-slate-400">{entry.reason ?? ''}</span>
                <span className="text-slate-400">{fmtTime(entry.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {diagnosticsOpen && store && (
        <DiagnosticsModal
          store={store}
          running={busyId === store.id}
          onClose={() => setDiagnosticsOpen(false)}
          onRerun={runDiagnostics}
        />
      )}

      {configureOpen && (
        <StoreFormModal
          modal={{ mode: 'edit', store }}
          saving={saving}
          error={formError}
          companies={companies}
          onClose={() => setConfigureOpen(false)}
          onSubmit={(values) => void submitForm(values)}
        />
      )}

      {supportOpen && (
        <SupportModal
          store={store}
          busy={supportBusy}
          error={supportError}
          onClose={() => setSupportOpen(false)}
          onStart={(reason) => {
            void startSupport(store, reason).then((ok) => {
              if (ok) setSupportOpen(false);
            });
          }}
          onIssuePassword={() => {
            void supportIssuePassword(store).then((ok) => {
              if (ok) setSupportOpen(false);
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
