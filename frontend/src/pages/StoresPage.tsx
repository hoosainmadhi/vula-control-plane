import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  HeartPulse,
  LifeBuoy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Rocket,
  Search,
} from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge, {
  REGISTER_STATE_COLORS,
  STORE_COLORS,
  VERTICAL_COLORS,
} from '../components/StatusBadge';
import type {
  CreateStoreResponse,
  HealthOutcome,
  ConfigState,
  HealthState,
  PushOutcome,
  ResetAdminResponse,
  Store,
  StoreEnvironment,
  StoreFormValues,
  StoreStatus,
  StoreVertical,
  Company,
} from '../types';

const EMPTY_FORM: StoreFormValues = {
  name: '',
  slug: '',
  vertical: 'general',
  baseUrl: '',
  terminalCount: '1',
  environment: undefined as unknown as StoreEnvironment,
  controlPlaneToken: '',
  companyId: '',
};

type NoticeKind = 'ok' | 'error';
type Notice = { kind: NoticeKind; text: string } | null;

type ModalState = { mode: 'create' } | { mode: 'edit'; store: Store } | null;

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** "4 sec ago" style relative times for heartbeat/sync lines (SPOG §7). */
const fmtAgo = (value: string | null | undefined): string => {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec} sec ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
};

const HEALTH_STATE_LABELS: Record<HealthState, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Unknown',
};

const HEALTH_STATE_COLORS: Record<HealthState, string> = {
  healthy: 'bg-green-50 text-green-700 border-green-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  degraded: 'bg-orange-50 text-orange-700 border-orange-200',
  offline: 'bg-rose-50 text-rose-700 border-rose-200',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

const CONFIG_STATE_LABELS: Record<ConfigState, string> = {
  current: '✓ Current',
  pending: '⚠ Pending',
  failed: '✕ Failed',
  unknown: 'Unknown',
};

const CONFIG_STATE_COLORS: Record<ConfigState, string> = {
  current: 'bg-green-50 text-green-700 border-green-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

/** Licence vocabulary (SPOG §15) — mapped from the register states. */
const LICENCE_LABELS: Record<string, string> = {
  ok: 'Active',
  trial: 'Trial',
  warn: 'Expiring',
  grace: 'Grace',
  suspended: 'Suspended',
  unlicensed: 'Unlicensed',
};

const ENVIRONMENT_LABELS: Record<StoreEnvironment, string> = {
  production: 'Production',
  staging: 'Staging',
  demo: 'Demo',
  development: 'Development',
};

const ENVIRONMENT_COLORS: Record<StoreEnvironment, string> = {
  production: 'bg-brand-50 text-brand-700 border-brand-200',
  staging: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  demo: 'bg-purple-50 text-purple-700 border-purple-200',
  development: 'bg-slate-100 text-slate-600 border-slate-200',
};

const STATUS_LABELS: Record<StoreStatus, string> = {
  active: 'Active',
  paused: 'Paused',
};

/** Store-type labels: short for chips, fuller for the form select (title = full). */
const VERTICAL_LABELS: Record<StoreVertical, string> = {
  general: 'General',
  clothing: 'Clothing',
  spares: 'Spares',
  hardware: 'Hardware',
  pharmacy: 'Pharmacy',
  restaurant: 'Restaurant',
  custom: 'Custom',
};

const VERTICAL_OPTIONS: Array<{ value: StoreVertical; label: string }> = [
  { value: 'general', label: 'General retail, convenience & spaza' },
  { value: 'clothing', label: 'Clothing & footwear' },
  { value: 'spares', label: 'Motor spares & parts' },
  { value: 'hardware', label: 'Hardware & building supplies' },
  { value: 'pharmacy', label: 'Pharmacy & wellness' },
  { value: 'restaurant', label: 'Restaurant & quick service' },
  { value: 'custom', label: 'Custom (no starter pack)' },
];

// --- Terminal roster ---------------------------------------------------------

/**
 * Every configured till, laid out in a wrapping grid. Deliberately unbounded:
 * a store with 25 tills must show all 25, not a truncated chip row.
 */
function TerminalRoster({ store }: { store: Store }) {
  const configured = store.lastConfigStatus === 'ok';
  const names = store.terminalNames ?? [];
  const tills = Array.from({ length: store.terminalCount }, (_, i) => i + 1);
  return (
    <div className="flex flex-wrap gap-1">
      {tills.map((till) => {
        const name = names[till - 1]?.trim();
        const custom = Boolean(name) && name !== `Till ${till}`;
        return (
          <span
            key={till}
            title={`Till ${till}${custom ? ` — “${name}”` : ''} — ${configured ? 'configured' : 'pending'}`}
            className={`flex h-7 items-center justify-center rounded-md px-1.5 text-[11px] font-bold tabular-nums ${
              configured ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
            } ${custom ? 'w-auto min-w-9' : 'w-9'}`}
          >
            {custom ? name : till}
          </span>
        );
      })}
    </div>
  );
}

// --- Small building blocks ---------------------------------------------------

function ActionButton({
  icon: Icon,
  label,
  onClick,
  className = 'border-slate-200 text-slate-600 hover:bg-slate-50',
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string | number;
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'brand';
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-900',
    green: 'text-green-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
    brand: 'text-brand-600',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-black tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

// --- Store create/edit modal -------------------------------------------------

interface FormModalProps {
  modal: Exclude<ModalState, null>;
  saving: boolean;
  error: string | null;
  /** Merchants available to attach this store to. */
  companies: Company[];
  onClose: () => void;
  onSubmit: (values: StoreFormValues) => void;
}

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none';

const labelCls = 'mb-1 block text-sm font-semibold text-slate-700';

function StoreFormModal({ modal, saving, error, companies, onClose, onSubmit }: FormModalProps) {
  const editing = modal.mode === 'edit' ? modal.store : null;
  const [form, setForm] = useState<StoreFormValues>(() =>
    editing
      ? {
          name: editing.name,
          slug: editing.slug,
          vertical: editing.vertical,
          baseUrl: editing.baseUrl,
          terminalCount: String(editing.terminalCount),
          tillNames: editing.terminalNames ?? [],
          environment: editing.environment,
          controlPlaneToken: '',
          companyId: editing.companyId === null ? '' : String(editing.companyId),
        }
      : EMPTY_FORM,
  );
  const slugInvalid = !SLUG_REGEX.test(form.slug) || form.slug.length > 40;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <Modal title={editing ? `Edit ${editing.name}` : 'New store'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox message={error} />}
        <div>
          <label className={labelCls}>Store name</label>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
            placeholder="Gardens Mall"
          />
        </div>
        <div>
          <label className={labelCls}>Slug</label>
          <input
            required
            disabled={editing !== null}
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            className={`${inputCls} ${editing ? 'bg-slate-50 text-slate-400' : ''}`}
            placeholder="gardens-mall"
          />
          {!editing && slugInvalid && form.slug !== '' && (
            <p className="mt-1 text-xs text-red-600">
              Lowercase letters, digits and dashes only (start with a letter or digit, max 40)
            </p>
          )}
          {editing && <p className="mt-1 text-xs text-slate-400">Slug is fixed after creation</p>}
        </div>
        <div>
          <label className={labelCls}>POS profile</label>
          <select
            value={form.vertical}
            onChange={(e) => setForm({ ...form, vertical: e.target.value as StoreVertical })}
            className={inputCls}
          >
            {VERTICAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {editing && (
            <p className="mt-1 text-xs text-slate-400">
              Type changes reach the store on the next push
            </p>
          )}
        </div>
        <div>
          <label className={labelCls}>Company</label>
          <select
            value={form.companyId}
            onChange={(e) => setForm({ ...form, companyId: e.target.value })}
            className={inputCls}
          >
            <option value="">Unassigned</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.planName} ({c.storesUsed}/{c.maxStores} stores)
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-400">
            The merchant this store belongs to. Its plan caps how many stores you can add and how
            many tills each may run.
          </p>
        </div>
        <div>
          <label className={labelCls}>Store base URL</label>
          <input
            required
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            className={inputCls}
            placeholder="https://gardens-mall.vula-app.co.za"
          />
        </div>
        <div>
          <label className={labelCls}>Environment</label>
          <select
            value={form.environment ?? ''}
            onChange={(e) => setForm({ ...form, environment: e.target.value as StoreEnvironment })}
            className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm"
          >
            <option value="">Auto — match this control plane</option>
            {(Object.keys(ENVIRONMENT_LABELS) as StoreEnvironment[]).map((envKey) => (
              <option key={envKey} value={envKey}>
                {ENVIRONMENT_LABELS[envKey]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Terminal count (1–99)</label>
          <input
            required
            type="number"
            min={1}
            max={99}
            value={form.terminalCount}
            onChange={(e) => setForm({ ...form, terminalCount: e.target.value })}
            className={inputCls}
          />
        </div>
        {editing && (
          <div>
            <label className={labelCls}>
              Till names <span className="font-normal text-slate-400">(optional — blank keeps “Till N”)</span>
            </label>
            <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: Number(form.terminalCount) || 0 }, (_, i) => (
                <input
                  key={i}
                  type="text"
                  maxLength={60}
                  placeholder={`Till ${i + 1}`}
                  value={form.tillNames?.[i] ?? ''}
                  onChange={(e) => {
                    const next = [...(form.tillNames ?? [])];
                    while (next.length < (Number(form.terminalCount) || 0)) next.push('');
                    next[i] = e.target.value;
                    setForm({ ...form, tillNames: next });
                  }}
                  className="w-full rounded-lg border border-slate-300 p-2 text-xs"
                />
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-400">
              Custom names ride on every config push and show on the roster.
            </p>
          </div>
        )}
        {!editing && (
          <div className="space-y-3 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
            <label className="flex items-center gap-2.5 text-xs font-bold text-teal-950 cursor-pointer">
              <input
                type="checkbox"
                checked={form.provision ?? false}
                onChange={(e) => setForm({ ...form, provision: e.target.checked })}
                className="rounded border-teal-300 text-teal-600 focus:ring-teal-500"
              />
              <span>Auto-provision container on Coolify</span>
            </label>
            <p className="text-[11px] text-teal-800">
              When checked, Coolify creates the application container, attaches a persistent /data
              volume, and deploys it automatically.
            </p>
            {form.provision ? (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Initial Store Administrator Email
                </label>
                <input
                  type="email"
                  value={form.adminEmail ?? ''}
                  onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
                  placeholder="admin@newstore.co.za"
                  className={inputCls}
                />
              </div>
            ) : null}
          </div>
        )}
        {!editing && !form.provision && (
          <div>
            <label className={labelCls}>
              Control plane token <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              value={form.controlPlaneToken}
              onChange={(e) =>
                setForm({ ...form, controlPlaneToken: e.target.value.trim().toLowerCase() })
              }
              className={`${inputCls} font-mono text-xs`}
              placeholder="64 hex chars — leave blank to generate"
            />
            <p className="mt-1 text-xs text-slate-400">
              Must match the CONTROL_PLANE_TOKEN env on the store's container. Blank = the control
              plane generates one.
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || slugInvalid}
            className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create store'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- One-time admin password modal ------------------------------------------

interface AdminPasswordModalProps {
  storeName: string;
  tempPassword: string;
  note: string;
  onClose: () => void;
}

function AdminPasswordModal({ storeName, tempPassword, note, onClose }: AdminPasswordModalProps) {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(tempPassword);
    } catch {
      // Clipboard unavailable; the password is selectable in the box.
    }
  };
  return (
    <Modal title={`Admin password — ${storeName}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          The store reset its admin password. The temporary password below is shown once and is not
          stored by the control plane — save it somewhere safe, then close this box.
        </p>
        <div className="rounded-lg bg-slate-900 px-4 py-3 text-center font-mono text-lg tracking-widest text-emerald-300">
          {tempPassword}
        </div>
        <p className="text-xs text-amber-700">{note}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={copy}
            className="rounded-lg px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-100"
          >
            Copy
          </button>
          <button
            onClick={onClose}
            className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Stores dashboard --------------------------------------------------------

/** Per-till rows for the Diagnostics drawer (SPOG §17). */
function DiagnosticsModal({
  store,
  running,
  onClose,
  onRerun,
}: {
  store: Store;
  running: boolean;
  onClose: () => void;
  onRerun: () => void;
}) {
  const rows: Array<{ label: string; value: string; ok: boolean | null }> = [
    {
      label: 'Application',
      value: store.healthState === 'offline' ? 'Unreachable' : 'Reachable',
      ok: store.healthState !== 'offline' && store.healthState !== 'unknown',
    },
    { label: 'API', value: store.healthState === 'offline' ? 'No answer' : 'Healthy', ok: store.healthState !== 'offline' },
    { label: 'Database', value: 'Not reported yet', ok: null },
    {
      label: 'Schema',
      value: store.schemaVersion != null ? `v${store.schemaVersion}` : '—',
      ok: store.schemaVersion != null ? true : null,
    },
    { label: 'Sync engine', value: 'Device-side — not reported yet', ok: null },
    {
      label: 'Configuration',
      value:
        store.configState === 'current'
          ? `Current (v${store.configVersion.expected})`
          : store.configState === 'pending'
            ? `Pending — expected v${store.configVersion.expected}, applied v${store.configVersion.applied}`
            : store.configState === 'failed'
              ? 'Last push failed'
              : 'Unknown',
      ok: store.configState === 'current' ? true : store.configState === 'unknown' ? null : false,
    },
    {
      label: 'Licence',
      value: LICENCE_LABELS[store.registerState] ?? store.registerState,
      ok: store.registerState === 'ok' || store.registerState === 'trial',
    },
  ];
  return (
    <Modal title={`Diagnostics — ${store.name}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between border-b border-slate-100 pb-2">
            <span className="text-slate-500">{r.label}</span>
            <span
              className={`font-semibold ${
                r.ok === true ? 'text-green-700' : r.ok === false ? 'text-rose-600' : 'text-slate-400'
              }`}
            >
              {r.ok === true ? '✓ ' : r.ok === false ? '✕ ' : ''}
              {r.value}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
          <span className="text-slate-500">Latency</span>
          <span className="font-semibold text-slate-700">{store.latencyMs != null ? `${store.latencyMs} ms` : '—'}</span>
        </div>
        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
          <span className="text-slate-500">Last heartbeat</span>
          <span className="font-semibold text-slate-700">{fmtAgo(store.lastHeartbeatAt)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Last successful device sync</span>
          <span className="font-semibold text-slate-700">
            {store.telemetry?.sync.lastSyncAt ? fmtAgo(store.telemetry.sync.lastSyncAt) : '—'}
          </span>
        </div>
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Diagnostics shows technical state only — never business records.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onRerun}
            disabled={running}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run diagnostics again'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Support session opener (SPOG §18): audited, diagnostics-only access. */
function SupportModal({
  store,
  busy,
  error,
  onClose,
  onStart,
  onIssuePassword,
}: {
  store: Store;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (reason: string) => void;
  onIssuePassword: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Start support session" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onStart(reason.trim());
        }}
      >
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Store</div>
          <div className="text-sm font-semibold text-slate-800">{store.name}</div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-bold text-slate-700">Reason</label>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What are you helping with?"
            className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Access</div>
            <div className="text-slate-700">Technical diagnostics only</div>
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Duration</div>
            <div className="text-slate-700">30 minutes</div>
          </div>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={onIssuePassword}
            disabled={busy}
            title="Issue a one-time temporary store admin password (audited)"
            className="rounded-lg border border-violet-200 px-3 py-2 text-xs font-bold text-violet-700 hover:bg-violet-50 disabled:opacity-50"
          >
            Issue temporary password
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export default function StoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'healthy' | 'warning' | 'offline' | 'paused' | 'config-issue' | 'sync-issue'
  >('all');
  const [diagnostics, setDiagnostics] = useState<Store | null>(null);
  const [supportStore, setSupportStore] = useState<Store | null>(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
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

  const runAction = async (store: Store, action: () => Promise<void>): Promise<void> => {
    setBusyId(store.id);
    try {
      await action();
      await load();
    } catch (err) {
      // Always show the underlying reason: a bare 'Action failed' tells the
      // operator nothing about what to do next.
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Action failed';
      notify('error', message);
    } finally {
      setBusyId(null);
    }
  };

  const pushNow = (store: Store): Promise<void> =>
    runAction(store, async () => {
      const res = await api<PushOutcome>(`/stores/${store.id}/push`, { method: 'POST' });
      notify(
        res.ok ? 'ok' : 'error',
        res.ok
          ? `Till 1..${store.terminalCount} pushed to ${store.slug}`
          : `Push failed: ${res.error}`,
      );
    });

  const healthCheck = (store: Store): Promise<void> =>
    runAction(store, async () => {
      const res = await api<HealthOutcome>(`/stores/${store.id}/health`, { method: 'POST' });
      notify(
        res.ok ? 'ok' : 'error',
        res.ok ? `${store.slug} is up` : `${store.slug} is down: ${res.error}`,
      );
    });

  const runDiagnostics = (store: Store): void => {
    setDiagnostics(store);
    void healthCheck(store);
  };

  const startSupport = async (store: Store, reason: string): Promise<void> => {
    setSupportBusy(true);
    setSupportError(null);
    try {
      await api<{ ok: boolean }>(`/stores/${store.id}/support`, {
        method: 'POST',
        body: { reason },
      });
      notify('ok', `Support session started for ${store.slug} — recorded in the audit trail.`);
      setSupportStore(null);
    } catch (err) {
      setSupportError(err instanceof ApiError ? err.message : 'Failed to start support session');
    } finally {
      setSupportBusy(false);
    }
  };

  const supportIssuePassword = async (store: Store): Promise<void> => {
    setSupportBusy(true);
    setSupportError(null);
    try {
      const res = await api<ResetAdminResponse>(`/stores/${store.id}/reset-admin`, {
        method: 'POST',
      });
      setSupportStore(null);
      setAdminPassword({ storeName: store.name, tempPassword: res.tempPassword, note: res.note });
    } catch (err) {
      setSupportError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setSupportBusy(false);
    }
  };

  const removeStore = async (store: Store): Promise<void> => {
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; message: string }>(`/stores/${store.id}`, {
        method: 'DELETE',
      });
      setConfirmDeleteId(null);
      notify('ok', res.message);
      await load();
    } catch (err) {
      setConfirmDeleteId(null);
      notify('error', err instanceof ApiError ? err.message : 'Remove failed');
    }
  };

  const togglePause = (store: Store): Promise<void> =>
    runAction(store, async () => {
      await api<Store>(`/stores/${store.id}/${store.status === 'active' ? 'pause' : 'resume'}`, {
        method: 'PATCH',
      });
      notify('ok', store.status === 'active' ? `${store.name} paused` : `${store.name} resumed`);
    });

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
          {visible.map((store) => {
            const busy = busyId === store.id;
            const terminalsPushed = store.terminalCount > 0 && store.lastConfigStatus === 'ok';

            return (
              <div
                key={store.id}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex flex-col gap-4 px-5 py-4 xl:flex-row xl:items-start xl:gap-8">
                  {/* Identity */}
                  <div className="min-w-0 xl:w-72 xl:shrink-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="truncate text-base font-bold text-slate-900"
                        title={store.name}
                      >
                        {store.name}
                      </span>
                      <StatusBadge
                        status={store.status}
                        colors={STORE_COLORS}
                        label={STATUS_LABELS[store.status]}
                      />
                      {store.deployStatus === 'provisioning' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700 animate-pulse">
                          <Loader2 className="h-3 w-3 animate-spin" /> Provisioning
                        </span>
                      ) : store.deployStatus === 'deployed' ? (
                        <span className="inline-flex items-center rounded-full bg-teal-50 border border-teal-200 px-2 py-0.5 text-[10px] font-bold text-teal-700">
                          Auto-deployed
                        </span>
                      ) : store.deployStatus === 'failed' ? (
                        <span className="inline-flex items-center rounded-full bg-rose-50 border border-rose-200 px-2 py-0.5 text-[10px] font-bold text-rose-700">
                          Deploy failed
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className="truncate font-mono text-xs text-slate-400"
                        title={store.slug}
                      >
                        {store.slug}
                      </span>
                      <StatusBadge
                        status={store.vertical}
                        colors={VERTICAL_COLORS}
                        label={VERTICAL_LABELS[store.vertical]}
                      />
                      <StatusBadge
                        status={store.environment}
                        colors={ENVIRONMENT_COLORS}
                        label={ENVIRONMENT_LABELS[store.environment]}
                      />
                    </div>
                  </div>

                  {/* Details as labelled columns (SPOG §7/§8) */}
                  <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Company
                      </div>
                      <div
                        className="mt-0.5 truncate text-xs font-semibold text-slate-700"
                        title={store.companyName || 'Unassigned'}
                      >
                        {store.companyName || 'Unassigned'}
                      </div>
                      <div className="text-[11px] text-slate-400">{store.planName}</div>
                    </div>

                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Domain
                      </div>
                      <a
                        href={store.baseUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={store.baseUrl}
                        className="mt-0.5 block truncate font-mono text-xs text-brand-600 hover:underline"
                      >
                        {store.baseUrl.replace(/^https?:\/\//, '')}
                      </a>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Health
                      </div>
                      <div className="mt-0.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                            HEALTH_STATE_COLORS[store.healthState]
                          }`}
                        >
                          {HEALTH_STATE_LABELS[store.healthState]}
                        </span>
                      </div>
                      <div
                        className="text-[11px] text-slate-400"
                        title={`Heartbeat ${fmtAgo(store.lastHeartbeatAt)}`}
                      >
                        {store.lastHeartbeatAt
                          ? `Last seen ${fmtAgo(store.lastHeartbeatAt)}`
                          : store.lastHealthStatus === 'unknown'
                            ? 'Never checked'
                            : fmtAgo(store.lastHealthAt)}
                      </div>
                      {store.healthState === 'offline' && store.lastHealthError && (
                        <div
                          className="max-w-[16rem] truncate text-[11px] text-rose-500"
                          title={store.lastHealthError}
                        >
                          {store.lastHealthError}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Version
                      </div>
                      <div className="mt-0.5 font-mono text-xs font-semibold text-slate-700">
                        {store.appVersion ?? '—'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {store.schemaVersion != null ? `schema v${store.schemaVersion}` : 'schema —'}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Config
                      </div>
                      <div className="mt-0.5">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                            CONFIG_STATE_COLORS[store.configState]
                          }`}
                        >
                          {CONFIG_STATE_LABELS[store.configState]}
                        </span>
                      </div>
                      <div
                        className="text-[11px] text-slate-400"
                        title={`Expected v${store.configVersion.expected} · applied v${store.configVersion.applied}`}
                      >
                        v{store.configVersion.expected}
                        {store.configState === 'pending'
                          ? ` · applied v${store.configVersion.applied}`
                          : ''}
                      </div>
                      {store.configState === 'failed' && store.lastConfigError && (
                        <div
                          className="max-w-[16rem] truncate text-[11px] text-rose-500"
                          title={store.lastConfigError}
                        >
                          {store.lastConfigError}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Licence
                      </div>
                      <div
                        className="mt-0.5"
                        title="What the store's register shows for the subscription"
                      >
                        <StatusBadge
                          status={store.registerState}
                          colors={REGISTER_STATE_COLORS}
                          label={LICENCE_LABELS[store.registerState] ?? store.registerState}
                        />
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {store.tradingBlocked ? 'New sales refused' : 'Trading normally'}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap gap-1.5 xl:shrink-0 xl:justify-end">
                    {busy ? (
                      <span className="inline-flex items-center gap-2 py-1.5 text-xs font-semibold text-slate-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Working…
                      </span>
                    ) : (
                      <>
                        <ActionButton
                          icon={HeartPulse}
                          label="Diagnostics"
                          title="Run diagnostics against this store"
                          onClick={() => runDiagnostics(store)}
                          className="border-sky-200 text-sky-700 hover:bg-sky-50"
                        />
                        <ActionButton
                          icon={Pencil}
                          label="Configure"
                          title="Edit this store's configuration"
                          onClick={() => {
                            setFormError(null);
                            setModal({ mode: 'edit', store });
                          }}
                        />
                        <ActionButton
                          icon={Rocket}
                          label="Push Config"
                          title="Push Till 1..N and settings to this store now"
                          onClick={() => void pushNow(store)}
                        />
                        <ActionButton
                          icon={LifeBuoy}
                          label="Support"
                          title="Start an audited support session"
                          onClick={() => {
                            setSupportError(null);
                            setSupportStore(store);
                          }}
                          className="border-violet-200 text-violet-700 hover:bg-violet-50"
                        />
                        <ActionButton
                          icon={MoreHorizontal}
                          label="More"
                          title="Pause, resume and removal actions"
                          onClick={() => setMoreMenuId(moreMenuId === store.id ? null : store.id)}
                        />
                      </>
                    )}
                  </div>

                  {/* More menu — administrative and destructive actions (SPOG §16) */}
                  {moreMenuId === store.id && (
                    <>
                      <button
                        className="fixed inset-0 z-30 cursor-default"
                        aria-label="Close menu"
                        onClick={() => setMoreMenuId(null)}
                      />
                      <div className="relative z-40 xl:absolute xl:right-5 xl:top-16 xl:z-40 w-full max-w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
                        <button
                          onClick={() => {
                            setMoreMenuId(null);
                            void togglePause(store);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          {store.status === 'active' ? 'Pause store' : 'Resume store'}
                        </button>
                        {confirmDeleteId === store.id ? (
                          <>
                            <button
                              onClick={() => void removeStore(store)}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-bold text-white bg-red-600 hover:bg-red-500"
                            >
                              Confirm remove
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteId(store.id)}
                            title="Remove this store from the control plane (pause it first)"
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            Remove store
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {/* Entitlement needs attention (over cap, overdue, unassigned) */}
                {store.entitlementNote ? (
                  <div className="border-t border-amber-100 bg-amber-50/60 px-5 py-2 text-[11px] font-medium text-amber-800">
                    {store.entitlementNote}
                  </div>
                ) : null}

                {/* Terminal roster — every till, laid out across the full card width */}
                <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-3">
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Terminals
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        terminalsPushed
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                      title="Configured · claimed · session open"
                    >
                      {store.telemetry
                        ? `${store.telemetry.terminals.configured} configured · ${store.telemetry.terminals.claimed} claimed · ${store.telemetry.terminals.open} open`
                        : `${store.terminalCount} configured`}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Sync: {store.telemetry?.sync.lastSyncAt ? fmtAgo(store.telemetry.sync.lastSyncAt) : 'no device sync yet'}
                    </span>
                  </div>
                  <TerminalRoster store={store} />
                </div>
              </div>
            );
          })}
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
          onStart={(reason) => void startSupport(supportStore, reason)}
          onIssuePassword={() => void supportIssuePassword(supportStore)}
        />
      )}
    </div>
  );
}
