import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Spinner from '../components/Spinner';
import { SummaryTile } from '../components/storeUi';
import { HealthDot, VERTICAL_COLORS } from '../components/StatusBadge';
import { ENVIRONMENT_LABELS, CONFIG_STATE_LABELS, fmtAgo, fmtTime, VERTICAL_LABELS } from '../lib/storeVocab';
import type { Device, DeviceStatus, StoreEnvironment, StoreVertical } from '../types';

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

/**
 * Stores at or below this many tills open on load; larger ones start collapsed
 * so one 25-till store cannot bury the other fifteen. Expand all / Collapse all
 * override it either way.
 */
const DEFAULT_EXPAND_MAX_TILLS = 5;

const StatusPill = ({ status }: { status: DeviceStatus }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_COLORS[status]}`}
  >
    {STATUS_LABELS[status]}
  </span>
);

const VerticalChip = ({ vertical }: { vertical: StoreVertical }) => (
  <span
    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${VERTICAL_COLORS[vertical] ?? 'bg-slate-100 text-slate-600'}`}
  >
    {VERTICAL_LABELS[vertical]}
  </span>
);

/** The store header's right-hand summary: how big it is and how fresh it is. */
const storeSummary = (devices: Device[]): string => {
  const claimed = devices.filter((d) => d.claimed).length;
  const parts = [`${devices.length} ${devices.length === 1 ? 'till' : 'tills'}`];
  if (claimed > 0) parts.push(`${claimed} claimed`);
  const seen = devices
    .map((d) => d.lastSeenAt ?? d.lastHeartbeatAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  if (seen) parts.push(`heartbeat ${fmtAgo(seen)}`);
  return parts.join(' · ');
};

interface StoreGroup {
  key: string;
  name: string;
  slug: string;
  companyName: string | null;
  environment: StoreEnvironment | null;
  vertical: StoreVertical | null;
  healthStatus: Device['healthStatus'];
  devices: Device[];
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'pos' | 'office'>('all');
  const [statusFilter, setStatusFilter] = useState<DeviceStatus | 'all'>('all');
  /** Explicit open/closed choices; absent means "use the size default". */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
      // A store-name match brings the whole store's tills with it, which is what
      // "search for Everyday Retail" should do.
      return [d.name, d.storeName, d.storeSlug, d.companyName ?? '', d.deviceId ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [devices, query, typeFilter, statusFilter]);

  const groups = useMemo(() => {
    const byStore = new Map<string, StoreGroup>();
    const offices: Device[] = [];
    for (const device of filtered) {
      if (device.type === 'office') {
        offices.push(device);
        continue;
      }
      const key = `store:${device.storeId ?? device.storeSlug}`;
      let group = byStore.get(key);
      if (!group) {
        group = {
          key,
          name: device.storeName,
          slug: device.storeSlug,
          companyName: device.companyName,
          environment: device.environment,
          vertical: device.vertical,
          healthStatus: device.healthStatus,
          devices: [],
        };
        byStore.set(key, group);
      }
      group.devices.push(device);
    }
    const stores = [...byStore.values()].sort((a, b) => a.name.localeCompare(b.name));
    offices.sort((a, b) => a.name.localeCompare(b.name));
    return { stores, offices };
  }, [filtered]);

  /**
   * Client sections. The fleet is read client-first everywhere else in the
   * panel, so devices group that way too — but with an explicit "Unassigned"
   * section, because most of this fleet's tills (37 of 65) belong to stores no
   * client owns. Without that section they would be invisible; with it, they are
   * visibly unowned, which is the more useful signal.
   */
  const sections = useMemo(() => {
    const byClient = new Map<string, { key: string; name: string | null; stores: StoreGroup[] }>();
    for (const group of groups.stores) {
      const key = group.companyName ?? '__unassigned__';
      let section = byClient.get(key);
      if (!section) {
        section = { key, name: group.companyName, stores: [] };
        byClient.set(key, section);
      }
      section.stores.push(group);
    }
    // Named clients alphabetically, then whatever is unowned.
    return [...byClient.values()].sort(
      (a, b) =>
        (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || (a.name ?? '').localeCompare(b.name ?? ''),
    );
  }, [groups.stores]);

  const sectionSummary = (section: { stores: StoreGroup[] }): string => {
    const tills = section.stores.reduce((n, g) => n + g.devices.length, 0);
    return `${section.stores.length} ${section.stores.length === 1 ? 'store' : 'stores'} · ${tills} ${tills === 1 ? 'till' : 'tills'}`;
  };

  const isOpen = (group: StoreGroup): boolean =>
    expanded[group.key] ?? group.devices.length <= DEFAULT_EXPAND_MAX_TILLS;

  const toggle = (group: StoreGroup): void =>
    setExpanded((prev) => ({ ...prev, [group.key]: !isOpen(group) }));

  const setAll = (open: boolean): void =>
    setExpanded(Object.fromEntries(groups.stores.map((g) => [g.key, open])));

  const tillTotal = useMemo(
    () => groups.stores.reduce((n, g) => n + g.devices.length, 0),
    [groups.stores],
  );

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
          placeholder="Search store, device or device id…"
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

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {groups.stores.length} {groups.stores.length === 1 ? 'store' : 'stores'} · {tillTotal}{' '}
          {tillTotal === 1 ? 'till' : 'tills'}
          {groups.offices.length > 0 && ` · ${groups.offices.length} head ${groups.offices.length === 1 ? 'office' : 'offices'}`}
        </span>
        <span className="flex gap-2">
          <button onClick={() => setAll(true)} className="font-semibold text-brand-600 hover:underline">
            Expand all
          </button>
          <button onClick={() => setAll(false)} className="font-semibold text-brand-600 hover:underline">
            Collapse all
          </button>
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
          {devices.length === 0
            ? 'No stores or Head Offices registered yet — devices appear with their fleet members.'
            : 'No devices match these filters.'}
        </div>
      ) : (
        <>
          {sections.map((section) => (
            <section
              key={section.key}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                <span
                  className={`text-[11px] font-bold uppercase tracking-wide ${
                    section.name ? 'text-slate-600' : 'text-amber-700'
                  }`}
                >
                  {section.name ?? 'Unassigned — no client'}
                </span>
                <span className="text-[11px] text-slate-400">{sectionSummary(section)}</span>
              </div>
              {section.stores.map((group) => {
                const open = isOpen(group);
                return (
                  <div key={group.key} className="border-t border-slate-100 first:border-t-0">
                    <button
                      onClick={() => toggle(group)}
                      aria-expanded={open}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50"
                    >
                      <span className="w-3 text-[10px] text-slate-400">{open ? '▼' : '▶'}</span>
                      <HealthDot status={group.healthStatus} />
                      {/* The store is the entity being scanned, so its name
                          leads the row — larger and bolder than the chips and
                          the summary that qualify it. */}
                      <span className="text-lg font-bold text-slate-900">{group.name}</span>
                      {group.vertical && <VerticalChip vertical={group.vertical} />}
                      {/* Development is the local default, so the chip would be
                          noise on every row; anything else is worth flagging. */}
                      {group.environment && group.environment !== 'development' && (
                        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                          {ENVIRONMENT_LABELS[group.environment]}
                        </span>
                      )}
                      <span className="ml-auto text-xs tabular-nums text-slate-500">
                        {storeSummary(group.devices)}
                      </span>
                    </button>

                    {open && (
                      <table className="w-full text-xs">
                        <thead className="bg-slate-50/70 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          <tr>
                            <th className="px-4 py-2 pl-10 text-left">Till</th>
                            <th className="px-4 py-2 text-left">Version</th>
                            <th className="px-4 py-2 text-left">Status</th>
                            <th className="px-4 py-2 text-right">Last seen</th>
                            <th className="px-4 py-2 text-left">Config</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.devices.map((device) => (
                            <tr key={device.id} className="border-t border-slate-100">
                              <td className="px-4 py-2 pl-10">
                                <div className="font-semibold text-slate-700">{device.name}</div>
                                <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                                  {device.deviceId ?? 'no device bound'}
                                  {device.sessionOpen && (
                                    <span className="ml-1 text-green-600">· session open</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-2 font-mono text-slate-500">{device.version ?? '—'}</td>
                              <td className="px-4 py-2">
                                <StatusPill status={device.status} />
                              </td>
                              <td className="px-4 py-2 text-right text-slate-500">
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
                              <td className="px-4 py-2 text-slate-500">
                                {CONFIG_STATE_LABELS[device.configState]}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {groups.offices.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Head offices
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50/70 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-4 py-2 text-left">Head office</th>
                    <th className="px-4 py-2 text-left">Client</th>
                    <th className="px-4 py-2 text-left">Version</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-right">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.offices.map((device) => (
                    <tr key={device.id} className="border-t border-slate-100">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <HealthDot status={device.healthStatus} />
                          <span className="font-semibold text-slate-700">{device.name}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                            Office
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-slate-400">{device.storeSlug}</div>
                      </td>
                      <td className="px-4 py-2 text-slate-500">{device.companyName ?? '—'}</td>
                      <td className="px-4 py-2 font-mono text-slate-500">{device.version ?? '—'}</td>
                      <td className="px-4 py-2">
                        <StatusPill status={device.status} />
                      </td>
                      <td className="px-4 py-2 text-right text-slate-500">
                        {device.lastSeenAt ? (
                          <span title={fmtTime(device.lastSeenAt)}>{fmtAgo(device.lastSeenAt)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <p className="text-xs text-slate-400">
        Grouped by client, then store, because that is how the panel is read everywhere else — a
        fleet of 16 stores and 65 tills has no useful flat form. Stores with more than{' '}
        {DEFAULT_EXPAND_MAX_TILLS} tills start collapsed so one store cannot bury the rest, and
        stores no client owns sit in an explicitly marked <span className="font-semibold">Unassigned</span>{' '}
        section rather than being hidden or silently attributed to someone. A Head Office is a fleet
        member in its own right, so it has its own section rather than being nested under a store it
        does not have. Registers do not report a per-device heartbeat yet, so a bound till reads{' '}
        <span className="font-semibold">Claimed</span> rather than Online, and Last seen falls back to
        the store&rsquo;s own heartbeat. Read-only: the tenant exposes no per-device command API.
      </p>
    </div>
  );
}
