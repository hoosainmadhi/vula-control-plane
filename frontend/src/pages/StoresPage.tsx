import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  HeartPulse,
  KeyRound,
  Loader2,
  Pencil,
  Rocket,
  Trash2,
  X,
  Search,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge, {
  CONFIG_COLORS,
  HealthDot,
  REGISTER_STATE_COLORS,
  REGISTER_STATE_LABELS,
  STORE_COLORS,
  VERTICAL_COLORS,
} from '../components/StatusBadge';
import type {
  ConfigStatus,
  CreateStoreResponse,
  HealthOutcome,
  HealthStatus,
  PushOutcome,
  ResetAdminResponse,
  Store,
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
  controlPlaneToken: '',
  companyId: '',
};

type NoticeKind = 'ok' | 'error';
type Notice = { kind: NoticeKind; text: string } | null;

type ModalState = { mode: 'create' } | { mode: 'edit'; store: Store } | null;

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** SQLite datetimes arrive in UTC ("YYYY-MM-DD HH:MM:SS"); show them locally. */
const fmtTime = (value: string | null): string => {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const HEALTH_LABELS: Record<HealthStatus, string> = {
  up: 'Up',
  down: 'Down',
  unknown: 'Unknown',
};

const STATUS_LABELS: Record<StoreStatus, string> = {
  active: 'Active',
  paused: 'Paused',
};

const CONFIG_LABELS: Record<ConfigStatus, string> = {
  ok: 'Config pushed',
  failed: 'Push failed',
  pending: 'Never pushed',
};

/** Store-type labels: short for chips, fuller for the form select (title = full). */
const VERTICAL_LABELS: Record<StoreVertical, string> = {
  general: 'General',
  clothing: 'Clothing',
  spares: 'Spares',
  hardware: 'Hardware',
  pharmacy: 'Pharmacy',
  restaurant: 'Restaurant',
};

const VERTICAL_OPTIONS: Array<{ value: StoreVertical; label: string }> = [
  { value: 'general', label: 'General retail, convenience & spaza' },
  { value: 'clothing', label: 'Clothing & footwear' },
  { value: 'spares', label: 'Motor spares & parts' },
  { value: 'hardware', label: 'Hardware & building supplies' },
  { value: 'pharmacy', label: 'Pharmacy & wellness' },
  { value: 'restaurant', label: 'Restaurant & quick service' },
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
          <label className={labelCls}>Store type</label>
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
  const [statusFilter, setStatusFilter] = useState<'all' | StoreStatus>('all');
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

  const getAdminPassword = async (store: Store): Promise<void> => {
    setBusyId(store.id);
    try {
      const res = await api<ResetAdminResponse>(`/stores/${store.id}/reset-admin`, {
        method: 'POST',
      });
      setAdminPassword({ storeName: store.name, tempPassword: res.tempPassword, note: res.note });
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setBusyId(null);
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

  // Fleet totals — the vendor's at-a-glance view of everything they operate.
  const summary = useMemo(
    () => ({
      total: stores.length,
      active: stores.filter((s) => s.status === 'active').length,
      paused: stores.filter((s) => s.status === 'paused').length,
      up: stores.filter((s) => s.lastHealthStatus === 'up').length,
      down: stores.filter((s) => s.lastHealthStatus === 'down').length,
      unknown: stores.filter((s) => s.lastHealthStatus === 'unknown').length,
      terminals: stores.reduce((n, s) => n + s.terminalCount, 0),
    }),
    [stores],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return stores.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.baseUrl.toLowerCase().includes(q)
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
      {/* Fleet summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile label="Stores" value={summary.total} />
        <SummaryTile label="Active" value={summary.active} tone="green" />
        <SummaryTile label="Paused" value={summary.paused} tone="amber" />
        <SummaryTile label="Healthy" value={summary.up} tone="green" />
        <SummaryTile label="Unreachable" value={summary.down} tone="red" />
        <SummaryTile label="Terminals" value={summary.terminals} tone="brand" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, slug or domain"
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ['all', 'All'],
                ['active', 'Active'],
                ['paused', 'Paused'],
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
                    </div>
                  </div>

                  {/* Details as labelled columns */}
                  <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-5">
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
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                        <HealthDot status={store.lastHealthStatus} />
                        {HEALTH_LABELS[store.lastHealthStatus]}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {store.lastHealthStatus === 'unknown'
                          ? 'Never checked'
                          : fmtTime(store.lastHealthAt)}
                      </div>
                      {store.lastHealthStatus === 'down' && store.lastHealthError && (
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
                        Config
                      </div>
                      <div className="mt-0.5">
                        <StatusBadge
                          status={store.lastConfigStatus}
                          colors={CONFIG_COLORS}
                          label={CONFIG_LABELS[store.lastConfigStatus]}
                        />
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {fmtTime(store.lastConfigAt)}
                      </div>
                      {store.lastConfigStatus === 'failed' && store.lastConfigError && (
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
                        Register
                      </div>
                      <div
                        className="mt-0.5"
                        title="What the store's register shows for the subscription"
                      >
                        <StatusBadge
                          status={store.registerState}
                          colors={REGISTER_STATE_COLORS}
                          label={REGISTER_STATE_LABELS[store.registerState] ?? store.registerState}
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
                          icon={Pencil}
                          label="Edit"
                          onClick={() => {
                            setFormError(null);
                            setModal({ mode: 'edit', store });
                          }}
                        />
                        <ActionButton
                          icon={Rocket}
                          label="Push"
                          title="Push Till 1..N to this store now"
                          onClick={() => void pushNow(store)}
                        />
                        <ActionButton
                          icon={HeartPulse}
                          label="Check"
                          title="Check store health"
                          onClick={() => void healthCheck(store)}
                          className="border-sky-200 text-sky-700 hover:bg-sky-50"
                        />
                        <ActionButton
                          icon={KeyRound}
                          label="Admin"
                          title="Issue a temporary store admin password"
                          onClick={() => void getAdminPassword(store)}
                          className="border-violet-200 text-violet-700 hover:bg-violet-50"
                        />
                        <ActionButton
                          icon={store.status === 'active' ? ToggleRight : ToggleLeft}
                          label={store.status === 'active' ? 'Pause' : 'Resume'}
                          onClick={() => void togglePause(store)}
                          className={
                            store.status === 'active'
                              ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                              : 'border-green-200 text-green-700 hover:bg-green-50'
                          }
                        />
                        {confirmDeleteId === store.id ? (
                          <>
                            <ActionButton
                              icon={Trash2}
                              label="Confirm remove"
                              onClick={() => void removeStore(store)}
                              className="border-red-600 bg-red-600 text-white hover:bg-red-500"
                            />
                            <ActionButton
                              label="Cancel"
                              icon={X}
                              onClick={() => setConfirmDeleteId(null)}
                            />
                          </>
                        ) : (
                          <ActionButton
                            icon={Trash2}
                            label="Remove"
                            title="Remove this store from the control plane (pause it first)"
                            onClick={() => setConfirmDeleteId(store.id)}
                            className="border-red-200 text-red-600 hover:bg-red-50"
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Entitlement needs attention (over cap, overdue, unassigned) */}
                {store.entitlementNote ? (
                  <div className="border-t border-amber-100 bg-amber-50/60 px-5 py-2 text-[11px] font-medium text-amber-800">
                    {store.entitlementNote}
                  </div>
                ) : null}

                {/* Terminal roster — every till, laid out across the full card width */}
                <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-3">
                  <div className="mb-2 flex items-center gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Terminals
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        terminalsPushed
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {store.terminalCount} configured
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
    </div>
  );
}
