import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Spinner from '../components/Spinner';
import { SummaryTile } from '../components/storeUi';
import { ENVIRONMENT_LABELS, ENVIRONMENT_COLORS, fmtAgo, fmtTime } from '../lib/storeVocab';
import type { StoreEnvironment, VersionsView } from '../types';

/** Sentinel for the "never reported" bucket, which is a real version row. */
const UNREPORTED = '__unreported__';

const keyOf = (version: string | null): string => version ?? UNREPORTED;

export default function VersionsPage() {
  const [data, setData] = useState<VersionsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string>('all');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setData(await api<VersionsView>('/versions'));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load version data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const members = useMemo(() => {
    if (!data) return [];
    if (selected === 'all') return data.versions.flatMap((row) => row.members);
    return data.versions.find((row) => keyOf(row.version) === selected)?.members ?? [];
  }, [data, selected]);

  if (loading) return <Spinner label="Loading versions…" />;
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
  if (!data) return null;

  const reporting = data.totals.storesReporting + data.totals.panelsReporting;
  const fleet = data.totals.stores + data.totals.panels;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Members reporting" value={`${reporting} / ${fleet}`} tone={reporting === fleet ? 'green' : 'amber'} />
        <SummaryTile label="Distinct builds" value={data.versions.length} />
        <SummaryTile label="Most deployed · Production" value={data.mostDeployed.production ?? '—'} tone="brand" />
        <SummaryTile label="Most deployed · Staging" value={data.mostDeployed.staging ?? '—'} tone="brand" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-slate-500" htmlFor="version-filter">
          Build
        </label>
        <select
          id="version-filter"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
        >
          <option value="all">All builds</option>
          {data.versions.map((row) => (
            <option key={keyOf(row.version)} value={keyOf(row.version)}>
              {row.version ?? 'Never reported'}
            </option>
          ))}
        </select>
        <button
          onClick={() => void load()}
          className="ml-auto rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-2.5 text-left">Version</th>
              <th className="px-4 py-2.5 text-right">Stores</th>
              <th className="px-4 py-2.5 text-right">Head offices</th>
              <th className="px-4 py-2.5 text-left">Environments</th>
              <th className="px-4 py-2.5 text-right">Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {data.versions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  No stores or Head Offices registered yet.
                </td>
              </tr>
            )}
            {data.versions.map((row) => {
              const key = keyOf(row.version);
              return (
                <tr
                  key={key}
                  onClick={() => setSelected(key)}
                  className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                    selected === key ? 'bg-brand-50/40' : ''
                  }`}
                >
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-700">
                    {row.version ?? <span className="font-sans text-slate-400">Never reported</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{row.stores}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{row.panels}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {(Object.keys(row.byEnvironment) as StoreEnvironment[])
                        .filter((env) => row.byEnvironment[env] > 0)
                        .map((env) => (
                          <span
                            key={env}
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${ENVIRONMENT_COLORS[env]}`}
                          >
                            {ENVIRONMENT_LABELS[env]} {row.byEnvironment[env]}
                          </span>
                        ))}
                      {row.panels > 0 && (
                        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                          No environment recorded
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-500">
                    {row.lastHeartbeatAt ? (
                      <span title={fmtTime(row.lastHeartbeatAt)}>{fmtAgo(row.lastHeartbeatAt)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Schema version spread
          </div>
          <table className="w-full text-xs">
            <tbody>
              {data.schemas.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500">No schema version reported yet.</td>
                </tr>
              )}
              {data.schemas.map((s) => (
                <tr key={String(s.schemaVersion)} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-mono text-slate-700">{s.schemaVersion}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                    {s.stores} {s.stores === 1 ? 'store' : 'stores'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Members {selected === 'all' ? '' : `on ${selected === UNREPORTED ? 'no reported build' : selected}`}
            </span>
            <span className="text-[11px] font-semibold text-slate-400">{members.length}</span>
          </div>
          <table className="w-full text-xs">
            <tbody>
              {members.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-slate-500">No members on this build.</td>
                </tr>
              )}
              {members.map((member) => (
                <tr key={`${member.kind}-${member.id}`} className="border-t border-slate-100">
                  <td className="px-4 py-2 text-slate-700">{member.name}</td>
                  <td className="px-4 py-2 text-slate-400">{member.kind === 'store' ? 'Store' : 'Head Office'}</td>
                  <td className="px-4 py-2 text-slate-500">
                    {(member.environment ? [ENVIRONMENT_LABELS[member.environment]] : []).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    {member.lastHeartbeatAt ? fmtAgo(member.lastHeartbeatAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-400">
        The build each registered member last reported — there is no version history, only the current
        one. &ldquo;Never reported&rdquo; means registered but no telemetry yet, which is a real bucket
        rather than a missing value. A Head Office records no environment, and the spec&rsquo;s
        &ldquo;minimum supported&rdquo; version is not shown because no such policy exists in the control
        plane — inventing one would invent a support commitment.
      </p>
    </div>
  );
}
