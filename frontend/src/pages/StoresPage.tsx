import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge from '../components/StatusBadge';
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
} from '../types';

const EMPTY_FORM: StoreFormValues = {
  name: '',
  slug: '',
  vatRegNo: '',
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

const configBadge = (status: ConfigStatus, at: string | null) => {
  const tone = status === 'ok' ? 'green' : status === 'failed' ? 'red' : 'amber';
  const label = status === 'ok' ? 'Configured' : status === 'failed' ? 'Push failed' : 'Not pushed';
  return (
    <div className="flex items-center gap-2">
      <StatusBadge tone={tone}>{label}</StatusBadge>
      <span className="text-xs text-slate-400">{status === 'pending' ? '' : fmtTime(at)}</span>
    </div>
  );
};

const healthBadge = (status: HealthStatus, at: string | null) => {
  const tone = status === 'up' ? 'green' : status === 'down' ? 'red' : 'slate';
  const label = status === 'up' ? 'Up' : status === 'down' ? 'Down' : 'Unknown';
  return (
    <div className="flex items-center gap-2">
      <StatusBadge tone={tone}>{label}</StatusBadge>
      <span className="text-xs text-slate-400">{status === 'unknown' ? '' : fmtTime(at)}</span>
    </div>
  );
};

const statusBadge = (status: StoreStatus) => (
  <StatusBadge tone={status === 'active' ? 'teal' : 'amber'}>
    {status === 'active' ? 'Active' : 'Paused'}
  </StatusBadge>
);

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
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${
            configured
              ? 'bg-brand-50 text-brand-700 ring-brand-600/20'
              : 'bg-slate-100 text-slate-500 ring-slate-400/20'
          }`}
        >
          {till}
        </span>
      ))}
      {store.terminalCount > MAX_CHIPS && (
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-400/20">
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

function StoreFormModal({ modal, saving, error, onClose, onSubmit }: FormModalProps) {
  const editing = modal.mode === 'edit' ? modal.store : null;
  const [form, setForm] = useState<StoreFormValues>(() =>
    editing
      ? {
          name: editing.name,
          slug: editing.slug,
          vatRegNo: editing.vatRegNo ?? '',
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

  const inputCls =
    'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

  return (
    <Modal title={editing ? `Edit ${editing.name}` : 'New store'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBox message={error} />}
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Store name</label>
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
            placeholder="Gardens Mall"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Slug</label>
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
          <label className="mb-1 block text-sm font-medium text-slate-700">
            VAT registration no.
          </label>
          <input
            value={form.vatRegNo}
            onChange={(e) => setForm({ ...form, vatRegNo: e.target.value })}
            className={inputCls}
            placeholder="4530211828 (optional)"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Store base URL</label>
          <input
            required
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            className={inputCls}
            placeholder="https://gardens-mall.vula-app.co.za"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Terminal count (1–99)
          </label>
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
            <label className="mb-1 block text-sm font-medium text-slate-700">
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
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || slugInvalid}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
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
        <div className="rounded-md bg-slate-900 px-4 py-3 text-center font-mono text-lg tracking-widest text-emerald-300">
          {tempPassword}
        </div>
        <p className="text-xs text-amber-700">{note}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={copy}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Copy
          </button>
          <button
            onClick={onClose}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
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
        baseUrl: values.baseUrl.trim(),
        terminalCount: Number(values.terminalCount),
      };
      if (modal?.mode === 'edit') {
        await api<Store>(`/stores/${modal.store.id}`, { method: 'PUT', body });
        notify('ok', `${values.name.trim()} updated — terminal changes apply on the next push`);
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
    return (
      <div className="py-12 text-center">
        <Spinner label="Loading stores…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError} />
        <button
          onClick={() => void load()}
          className="text-sm font-medium text-brand-700 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const actionBtn =
    'rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Store fleet</h2>
          <p className="text-sm text-slate-500">
            {stores.length} store{stores.length === 1 ? '' : 's'} — each row is one Coolify
            deployment
          </p>
        </div>
        <button
          onClick={() => {
            setFormError(null);
            setModal({ mode: 'create' });
          }}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New store
        </button>
      </div>

      {notice && (
        <div
          className={`flex items-center justify-between rounded-md px-4 py-2.5 text-sm ring-1 ring-inset ${
            notice.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-800 ring-emerald-600/20'
              : 'bg-red-50 text-red-800 ring-red-600/20'
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
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <p className="font-medium text-slate-700">No stores yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Deploy a Vula store with its CONTROL_PLANE_TOKEN, then add it here to push terminal
            config.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Terminals</th>
                <th className="px-4 py-3">VAT no.</th>
                <th className="px-4 py-3">Terminal config</th>
                <th className="px-4 py-3">Health</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stores.map((store) => (
                <tr key={store.id} className="align-top hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{store.name}</div>
                    <div className="text-xs text-slate-400">
                      {store.slug} ·{' '}
                      <span className="break-all">{store.baseUrl.replace(/^https?:\/\//, '')}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <TerminalChips store={store} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {store.vatRegNo ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {configBadge(store.lastConfigStatus, store.lastConfigAt)}
                  </td>
                  <td className="px-4 py-3">
                    {healthBadge(store.lastHealthStatus, store.lastHealthAt)}
                  </td>
                  <td className="px-4 py-3">{statusBadge(store.status)}</td>
                  <td className="px-4 py-3">
                    {busyId === store.id ? (
                      <Spinner label="" />
                    ) : (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button
                          className={actionBtn}
                          onClick={() => {
                            setFormError(null);
                            setModal({ mode: 'edit', store });
                          }}
                        >
                          Edit
                        </button>
                        <button className={actionBtn} onClick={() => void pushNow(store)}>
                          Push now
                        </button>
                        <button className={actionBtn} onClick={() => void healthCheck(store)}>
                          Health
                        </button>
                        <button className={actionBtn} onClick={() => void getAdminPassword(store)}>
                          Admin password
                        </button>
                        <button className={actionBtn} onClick={() => void togglePause(store)}>
                          {store.status === 'active' ? 'Pause' : 'Resume'}
                        </button>
                      </div>
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
