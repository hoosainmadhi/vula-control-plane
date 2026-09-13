import { useState, type FormEvent } from 'react';
import Modal from './Modal';
import ErrorBox from './ErrorBox';
import type { Company, Store, StoreEnvironment, StoreFormValues, StoreVertical } from '../types';
import type { ModalState } from '../lib/storeVocab';
import {
  CONFIG_STATE_LABELS,
  EMPTY_FORM,
  ENVIRONMENT_LABELS,
  HEALTH_STATE_LABELS,
  LICENCE_LABELS,
  SLUG_REGEX,
  VERTICAL_OPTIONS,
  fmtAgo,
} from '../lib/storeVocab';

export interface FormModalProps {
  modal: Exclude<ModalState, null>;
  saving: boolean;
  error: string | null;
  /** Clients available to attach this store to. */
  companies: Company[];
  onClose: () => void;
  onSubmit: (values: StoreFormValues) => void;
}

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-500 focus:outline-none';

const labelCls = 'mb-1 block text-sm font-semibold text-slate-700';

export function StoreFormModal({ modal, saving, error, companies, onClose, onSubmit }: FormModalProps) {
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

export interface AdminPasswordModalProps {
  storeName: string;
  tempPassword: string;
  note: string;
  onClose: () => void;
}

export function AdminPasswordModal({ storeName, tempPassword, note, onClose }: AdminPasswordModalProps) {
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
export function DiagnosticsModal({
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
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1">
      <span className="text-slate-400">{k}</span>
      <span className="text-right font-semibold text-slate-700">{v}</span>
    </div>
  );
}

export function SupportModal({
  store,
  busy,
  error,
  onClose,
  onStart,
  onIssuePassword,
  onEnd,
  endBusy,
}: {
  store: Store;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Starts the session (audited); resolves true when it began. */
  onStart: (reason: string) => Promise<boolean>;
  onIssuePassword: () => Promise<boolean>;
  /** Ends the session (audited) — the parent closes the modal afterwards. */
  onEnd: () => void;
  endBusy: boolean;
}) {
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'start' | 'active'>('start');
  const [startedAt, setStartedAt] = useState<Date | null>(null);

  if (phase === 'start') {
    return (
      <Modal title="Start support session" onClose={onClose}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onStart(reason.trim()).then((ok) => {
              if (ok) {
                setPhase('active');
                setStartedAt(new Date());
              }
            });
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
              onClick={() => {
                void onIssuePassword().then((ok) => {
                  void ok; // the parent reveals the password; the session stays open
                });
              }}
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

  // Active session (SPOG §18): the technical picture the developer is allowed
  // to see, a visible window, and an explicit, audited end.
  const endsAt = startedAt ? new Date(startedAt.getTime() + 30 * 60 * 1000) : null;
  return (
    <Modal title={`Support session — ${store.name}`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="flex items-center justify-between rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
          <span className="text-xs font-bold uppercase tracking-wide text-violet-700">
            Session active
          </span>
          <span className="text-xs font-semibold text-violet-700">
            {startedAt?.toLocaleTimeString()} → {endsAt?.toLocaleTimeString()}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-x-4 text-xs">
          <Row k="Health" v={HEALTH_STATE_LABELS[store.healthState]} />
          <Row k="Version" v={store.appVersion ?? '—'} />
          <Row k="Schema" v={store.schemaVersion != null ? `v${store.schemaVersion}` : '—'} />
          <Row k="Config" v={CONFIG_STATE_LABELS[store.configState]} />
          <Row k="Licence" v={LICENCE_LABELS[store.registerState] ?? store.registerState} />
          <Row
            k="Last sync"
            v={store.telemetry?.sync.lastSyncAt ? fmtAgo(store.telemetry.sync.lastSyncAt) : '—'}
          />
          <Row k="Latency" v={store.latencyMs != null ? `${store.latencyMs} ms` : '—'} />
          <Row k="Tills" v={`${store.terminalCount} configured`} />
        </div>

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Technical diagnostics only — business data stays in the store. Starting and ending the
          session is recorded in the audit trail.
        </p>
        {error && <ErrorBox message={error} />}

        <div className="flex justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              void onIssuePassword();
            }}
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
              Leave open
            </button>
            <button
              type="button"
              onClick={onEnd}
              disabled={endBusy}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {endBusy ? 'Ending…' : 'End session'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
