import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Spinner from '../components/Spinner';
import { SummaryTile } from '../components/storeUi';
import { ENVIRONMENT_LABELS, fmtAgo, fmtTime } from '../lib/storeVocab';
import type { Device, DeviceStatus } from '../types';

const STATUS_LABELS: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  // Bound to a register that has not reported a device heartbeat yet.
  claimed: 'Claimed',
  unclaimed: 'Unclaimed',
  unknown: 'Unknown',
};

const STATUS_COLORS: Record<DeviceStatus, string> = {
  online: 'bg-green-50 text-green-700 border-green-200',
  offline: 'bg-rose-50 text-rose-700 border-rose-200',
  claimed: 'bg-sky-50 text-sky-700 border-sky-200',
  unclaimed: 'bg-slate-100 text-slate-500 border-slate-200',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

const STATUS_FILTERS: Array<{ id: DeviceStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'claimed', label: 'Claimed' },
  { id: 'offline', label: 'Offline' },
  { id: 'unclaimed', label: 'Unclaimed' },
];

const StatusPill = ({ status }: { status: DeviceStatus }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[status]}`}
  >
    {STATUS_LABELS[status]}
  </span>
);

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'pos' | 'office'>('all');
  const [statusFilter, setStatusFilter] = useState<DeviceStatus | 'all'>('all');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setDevices(await api<Device[]>('/devices'));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load devices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: devices.length,
      online: devices.filter((d) => d.status === 'online').length,
      claimed: devices.filter((d) => d.status === 'claimed').length,
      offline: devices.filter((d) => d.status === 'offline').length,
      unclaimed: devices.filter((d) => d.status === 'unclaimed').length,
      unknown: devices.filter((d) => d.status === 'unknown').length,
    }),
    [devices],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return devices.filter((d) => {
      if (typeFilter !== 'all' && d.type !== typeFilter) return false;
      if (statusFilter !== 'all' && d.status !== statusFilter) return false;
      if (!needle) return true;
      return [d.name, d.storeName, d.storeSlug, d.companyName ?? '', d.deviceId ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [devices, query, typeFilter, statusFilter]);

  if (loading) return <Spinner label="Loading devices…" />;
  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError} />
        <button onClick={() => void load()} className="text-sm font-semibold text-brand-600 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Every status has a tile, so the breakdown always accounts for the total
          (a never-probed Head Office is Unknown, not silently uncounted). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryTile label="Devices" value={counts.total} />
        <SummaryTile label="Online" value={counts.online} tone={counts.online ? 'green' : 'slate'} />
        <SummaryTile label="Claimed" value={counts.claimed} tone="brand" />
        <SummaryTile label="Offline" value={counts.offline} tone={counts.offline ? 'red' : 'green'} />
        <SummaryTile label="Unclaimed" value={counts.unclaimed} tone={counts.unclaimed ? 'amber' : 'green'} />
        <SummaryTile label="Unknown" value={counts.unknown} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search device, store or device id…"
          className="w-full max-w-sm rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
        />
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(['all', 'pos', 'office'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                typeFilter === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === 'all' ? 'All types' : t === 'pos' ? 'POS' : 'Office'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                statusFilter === f.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void load()}
          className="ml-auto rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          {devices.length === 0
            ? 'No stores or Head Offices registered yet — devices appear with their fleet members.'
            : 'No devices match these filters.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Device</th>
                <th className="px-4 py-2.5 text-left">Store</th>
                <th className="px-4 py-2.5 text-left">Type</th>
                <th className="px-4 py-2.5 text-left">Version</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-right">Last seen</th>
                <th className="px-4 py-2.5 text-left">Config</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((device) => (
                <tr key={device.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-700">{device.name}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                      {device.deviceId ?? 'no device bound'}
                      {device.sessionOpen && <span className="ml-1 text-green-600">· session open</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="text-slate-700">{device.storeName}</div>
                    <div className="text-[10px] text-slate-400">
                      {device.companyName ?? '—'}
                      {device.environment ? ` · ${ENVIRONMENT_LABELS[device.environment]}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">
                    {device.type === 'pos' ? 'POS' : 'Office'}
                    {device.till !== null && <span className="text-slate-400"> · Till {device.till}</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-500">{device.version ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={device.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-500">
                    {/* A till reports no per-device heartbeat yet, so fall back to
                        the store's own and say which one it is via the title. */}
                    {device.lastSeenAt ? (
                      <span title={fmtTime(device.lastSeenAt)}>{fmtAgo(device.lastSeenAt)}</span>
                    ) : device.lastHeartbeatAt ? (
                      <span title={`Store heartbeat: ${fmtTime(device.lastHeartbeatAt)}`}>
                        {fmtAgo(device.lastHeartbeatAt)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{device.configState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Every configured till of every store — claimed or not — plus one entry per Head Office.
        Registers do not report a per-device heartbeat yet, so a bound till reads
        <span className="font-semibold"> Claimed</span> rather than Online, and Last seen falls back to the
        store&rsquo;s own heartbeat. Read-only: the tenant exposes no per-device command API.
      </p>
    </div>
  );
}
