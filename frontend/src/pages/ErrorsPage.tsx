import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { SummaryTile } from '../components/storeUi';
import { fmtAgo, fmtTime } from '../lib/storeVocab';
import type { ErrorGroup, ErrorGroupDetail, ErrorSource, Panel, Store } from '../types';

/** Which subsystem failed — the label the operator reads on the row. */
const SOURCE_LABELS: Record<ErrorSource, string> = {
  health: 'Health',
  config: 'Config',
  licence: 'Licence',
  deploy: 'Deploy',
};

const SOURCE_COLORS: Record<ErrorSource, string> = {
  health: 'bg-rose-50 text-rose-700',
  config: 'bg-amber-50 text-amber-700',
  licence: 'bg-indigo-50 text-indigo-700',
  deploy: 'bg-orange-50 text-orange-700',
};

const SOURCE_FILTERS: Array<{ id: ErrorSource | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'health', label: 'Health' },
  { id: 'config', label: 'Config' },
  { id: 'licence', label: 'Licence' },
  { id: 'deploy', label: 'Deploy' },
];

const SourceChip = ({ source }: { source: ErrorSource }) => (
  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${SOURCE_COLORS[source]}`}>
    {SOURCE_LABELS[source]}
  </span>
);

export default function ErrorsPage() {
  const [groups, setGroups] = useState<ErrorGroup[]>([]);
  const [storeNames, setStoreNames] = useState<Record<number, string>>({});
  const [panelNames, setPanelNames] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<ErrorSource | 'all'>('all');

  const [detail, setDetail] = useState<ErrorGroupDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      // Store and panel names ride along so an occurrence can name the thing it
      // came from instead of showing a bare id.
      const [groupList, stores, panels] = await Promise.all([
        api<ErrorGroup[]>('/errors'),
        api<Store[]>('/stores'),
        api<Panel[]>('/panels'),
      ]);
      setGroups(groupList);
      setStoreNames(Object.fromEntries(stores.map((s) => [s.id, s.name])));
      setPanelNames(Object.fromEntries(panels.map((p) => [p.id, p.name])));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load the error feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openGroup = async (group: ErrorGroup) => {
    setDetailLoading(true);
    setDetailError('');
    try {
      setDetail(await api<ErrorGroupDetail>(`/errors/${group.fingerprint}`));
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : 'Could not load this fault');
    } finally {
      setDetailLoading(false);
    }
  };

  const filtered = useMemo(
    () => (sourceFilter === 'all' ? groups : groups.filter((g) => g.sources.includes(sourceFilter))),
    [groups, sourceFilter],
  );

  const totals = useMemo(
    () => ({
      faults: groups.length,
      occurrences: groups.reduce((sum, g) => sum + g.occurrences, 0),
      // A store can appear in more than one fault, so this counts hits, not
      // distinct stores.
      storeHits: groups.reduce((sum, g) => sum + g.storeCount, 0),
      newest: groups[0]?.lastSeen ?? null,
    }),
    [groups],
  );

  const entityName = (type: 'store' | 'panel', id: number): string =>
    (type === 'store' ? storeNames[id] : panelNames[id]) ?? `${type === 'store' ? 'Store' : 'Head Office'} #${id}`;

  if (loading) return <Spinner label="Loading error feed…" />;
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Open faults" value={totals.faults} tone={totals.faults ? 'red' : 'green'} />
        <SummaryTile label="Occurrences" value={totals.occurrences} />
        <SummaryTile label="Store hits" value={totals.storeHits} tone={totals.storeHits ? 'amber' : 'green'} />
        <SummaryTile label="Newest" value={totals.newest ? fmtAgo(totals.newest) : '—'} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setSourceFilter(f.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${
                sourceFilter === f.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
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
          {groups.length === 0
            ? 'No failures recorded — every store and Head Office is reporting clean.'
            : 'No faults from this subsystem.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Error</th>
                <th className="px-4 py-2.5 text-left">Source</th>
                <th className="px-4 py-2.5 text-right">Stores</th>
                <th className="px-4 py-2.5 text-right">Occurrences</th>
                <th className="px-4 py-2.5 text-right">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((group) => (
                <tr
                  key={group.fingerprint}
                  onClick={() => void openGroup(group)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="max-w-xl px-4 py-2.5">
                    <div className="truncate font-semibold text-slate-700" title={group.message}>
                      {group.message}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                      {group.fingerprint}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {group.sources.map((s) => (
                        <SourceChip key={s} source={s} />
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                    {group.storeCount}
                    {group.panelCount > 0 && (
                      <span className="text-slate-400"> +{group.panelCount} HO</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-700">
                    {group.occurrences}
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-500" title={fmtTime(group.lastSeen)}>
                    {fmtAgo(group.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Every failure the control plane records, grouped by fault. Repeats increment the
        occurrence count; a recovery does not delete history, so the newest line shows a fault's
        freshness. Messages are the control plane's own technical summaries — merchant data never
        appears here.
      </p>

      {(detail || detailLoading || detailError) && (
        <Modal title="Fault detail" onClose={() => setDetail(null)} size="lg">
          {detailLoading && <Spinner label="Loading occurrences…" />}
          {detailError && <ErrorBox message={detailError} />}
          {detail && (
            <div className="space-y-4">
              <p className="text-sm font-semibold text-slate-800">{detail.group.message}</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryTile label="Occurrences" value={detail.group.occurrences} />
                <SummaryTile label="Stores" value={detail.group.storeCount} />
                <SummaryTile label="Head offices" value={detail.group.panelCount} />
                <SummaryTile label="First seen" value={fmtAgo(detail.group.firstSeen)} />
              </div>
              <div className="text-xs text-slate-500">
                Fingerprint <span className="font-mono text-slate-600">{detail.group.fingerprint}</span>
                {' · '}
                Last seen {fmtTime(detail.group.lastSeen)}
              </div>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Where</th>
                      <th className="px-3 py-2 text-left">Source</th>
                      <th className="px-3 py-2 text-right">Times</th>
                      <th className="px-3 py-2 text-left">Version</th>
                      <th className="px-3 py-2 text-left">Environment</th>
                      <th className="px-3 py-2 text-right">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.events.map((event) => (
                      <tr key={event.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-semibold text-slate-700">
                          {entityName(event.entityType, event.entityId)}
                        </td>
                        <td className="px-3 py-2">
                          <SourceChip source={event.source} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                          {event.occurrences}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{event.appVersion ?? '—'}</td>
                        <td className="px-3 py-2 text-slate-500">{event.environment ?? '—'}</td>
                        <td className="px-3 py-2 text-right text-slate-500" title={fmtTime(event.lastSeen)}>
                          {fmtAgo(event.lastSeen)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
