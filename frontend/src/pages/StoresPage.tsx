import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  HeartPulse,
  KeyRound,
  Loader2,
  Pencil,
  Rocket,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import IconButton from '../components/IconButton';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge, { HealthDot, STORE_COLORS, VERTICAL_COLORS } from '../components/StatusBadge';
import type {
  CreateStoreResponse,
  HealthOutcome,
  HealthStatus,
  PushOutcome,
  ResetAdminResponse,
  Store,
  StoreFormValues,
  StoreStatus,
  StoreVertical,
} from '../types';

const EMPTY_FORM: StoreFormValues = {
  name: '',
  slug: '',
  vatRegNo: '',
  vertical: 'general',
  baseUrl: '',
  terminalCount: '1',
  controlPlaneToken: '',
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

/** Store-type labels: short for chips, fuller for the form select (title = full). */
const VERTICAL_LABELS: Record<StoreVertical, string> = {
  general: 'General',
  clothing: 'Clothing',
  spares: 'Spares',
  hardware: 'Hardware',
  pharmacy: 'Pharmacy',
};

const VERTICAL_OPTIONS: Array<{ value: StoreVertical; label: string }> = [
  { value: 'general', label: 'General retail, convenience & spaza' },
  { value: 'clothing', label: 'Clothing & footwear' },
  { value: 'spares', label: 'Motor spares & parts' },
  { value: 'hardware', label: 'Hardware & building supplies' },
  { value: 'pharmacy', label: 'Pharmacy & wellness' },
];

const MAX_CHIPS = 12;

function TerminalChips({ store }: { store: Store }) {
  const chips = Array.from({ length: store.terminalCount }, (_, i) => i + 1);
  const visible = chips.slice(0, MAX_CHIPS);
  const configured = store.lastConfigStatus === 'ok';
  return (
    <div className="flex max-w-[240px] flex-wrap gap-1">
      {visible.map((till) => (
        <span
          key={till}
          title={configured ? `Till ${till} — configured` : `Till ${till} — pending`}
          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            configured ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {till}
        </span>
      ))}
      {store.terminalCount > MAX_CHIPS && (
        <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
          +{store.terminalCount - MAX_CHIPS}
        </span>
      )}
    </div>
  );
}

// --- Store create/edit modal -------------------------------------------------

interface FormModalProps {
  modal: Exclude<ModalState, null>;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: StoreFormValues) => void;
}

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none';

const labelCls = 'mb-1 block text-sm font-semibold text-slate-700';

function StoreFormModal({ modal, saving, error, onClose, onSubmit }: FormModalProps) {
  const editing = modal.mode === 'edit' ? modal.store : null;
  const [form, setForm] = useState<StoreFormValues>(() =>
    editing
      ? {
          name: editing.name,
          slug: editing.slug,
          vatRegNo: editing.vatRegNo ?? '',
          vertical: editing.vertical,
          baseUrl: editing.baseUrl,
          terminalCount: String(editing.terminalCount),
          controlPlaneToken: '',
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
          <label className={labelCls}>VAT registration no.</label>
          <input
            value={form.vatRegNo}
            onChange={(e) => setForm({ ...form, vatRegNo: e.target.value })}
            className={inputCls}
            placeholder="4530211828 (optional)"
          />
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
        {!editing && (
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
  const [adminPassword, setAdminPassword] = useState<{
    storeName: string;
    tempPassword: string;
    note: string;
  } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Store[]>('/stores');
      setStores(data);
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

  const notify = (kind: NoticeKind, text: string): void => setNotice({ kind, text });

  const submitForm = async (values: StoreFormValues): Promise<void> => {
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        name: values.name.trim(),
        vatRegNo: values.vatRegNo.trim() || null,
        vertical: values.vertical,
        baseUrl: values.baseUrl.trim(),
        terminalCount: Number(values.terminalCount),
      };
      if (modal?.mode === 'edit') {
        await api<Store>(`/stores/${modal.store.id}`, { method: 'PUT', body });
        notify('ok', `${values.name.trim()} updated — changes apply on the next push`);
      } else {
        const res = await api<CreateStoreResponse>('/stores', {
          method: 'POST',
          body: {
            ...body,
            slug: values.slug,
            ...(values.controlPlaneToken ? { controlPlaneToken: values.controlPlaneToken } : {}),
          },
        });
        const store = res.store;
        notify(
          res.firstPush?.ok ? 'ok' : 'error',
          res.firstPush?.ok
            ? `Store ${store.slug} created; Till 1..${store.terminalCount} pushed`
            : `Store ${store.slug} created but the first push failed: ${res.firstPush?.error ?? 'unknown error'}`,
        );
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
      notify('error', err instanceof ApiError ? err.message : 'Action failed');
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

  const togglePause = (store: Store): Promise<void> =>
    runAction(store, async () => {
      await api<Store>(`/stores/${store.id}/${store.status === 'active' ? 'pause' : 'resume'}`, {
        method: 'PATCH',
      });
      notify('ok', store.status === 'active' ? `${store.name} paused` : `${store.name} resumed`);
    });

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
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-400">
          {stores.length} store{stores.length === 1 ? '' : 's'} — each row is one Vula deployment
        </p>
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
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Terminals</th>
                <th className="px-4 py-3">Health</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stores.map((store) => (
                <tr key={store.id} className="align-top hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-bold text-slate-900">{store.name}</div>
                    <p className="font-mono text-xs text-slate-400">{store.slug}</p>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={store.vertical}
                      colors={VERTICAL_COLORS}
                      label={VERTICAL_LABELS[store.vertical]}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={store.baseUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={store.baseUrl}
                      className="break-all font-mono text-xs text-brand-600 hover:underline"
                    >
                      {store.baseUrl.replace(/^https?:\/\//, '')}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <TerminalChips store={store} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <HealthDot status={store.lastHealthStatus} />
                      <span className="text-xs font-semibold text-slate-600">
                        {HEALTH_LABELS[store.lastHealthStatus]}
                      </span>
                    </span>
                    {store.lastHealthStatus !== 'unknown' && (
                      <p className="mt-1 text-xs text-slate-400">{fmtTime(store.lastHealthAt)}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={store.status}
                      colors={STORE_COLORS}
                      label={STATUS_LABELS[store.status]}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {busyId === store.id ? (
                      <span className="inline-flex justify-end">
                        <IconButton
                          icon={Loader2}
                          title="Working…"
                          onClick={() => undefined}
                          busy
                        />
                      </span>
                    ) : (
                      <span className="inline-flex gap-1.5">
                        <IconButton
                          icon={Pencil}
                          title="Edit store"
                          onClick={() => {
                            setFormError(null);
                            setModal({ mode: 'edit', store });
                          }}
                          className="bg-slate-100 text-slate-700 hover:bg-slate-200"
                        />
                        <IconButton
                          icon={Rocket}
                          title="Push terminals now"
                          onClick={() => void pushNow(store)}
                          className="bg-slate-100 text-slate-600 hover:bg-slate-200"
                        />
                        <IconButton
                          icon={HeartPulse}
                          title="Check health"
                          onClick={() => void healthCheck(store)}
                          className="bg-sky-50 text-sky-700 hover:bg-sky-100"
                        />
                        <IconButton
                          icon={KeyRound}
                          title="Get store admin password"
                          onClick={() => void getAdminPassword(store)}
                          className="bg-violet-50 text-violet-700 hover:bg-violet-100"
                        />
                        <IconButton
                          icon={store.status === 'active' ? ToggleRight : ToggleLeft}
                          title={store.status === 'active' ? 'Pause store' : 'Resume store'}
                          onClick={() => void togglePause(store)}
                          className={
                            store.status === 'active'
                              ? 'bg-green-50 text-green-700 hover:bg-green-100'
                              : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                          }
                        />
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <StoreFormModal
          modal={modal}
          saving={saving}
          error={formError}
          onClose={() => setModal(null)}
          onSubmit={(values) => void submitForm(values)}
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
