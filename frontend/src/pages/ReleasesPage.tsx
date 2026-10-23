import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronRight,
  History,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Rocket,
} from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import StatusBadge from '../components/StatusBadge';
import { ActionButton, NoticeBanner, SummaryTile } from '../components/storeUi';
import { ENVIRONMENT_COLORS, ENVIRONMENT_LABELS, fmtAgo, fmtTime } from '../lib/storeVocab';
import type {
  ImageRelease,
  ReleaseBatchDetail,
  ReleaseBatchSummary,
  ReleaseCapabilities,
  ReleaseDeploymentHistory,
  ReleaseFleet,
  ReleaseKind,
  TenantReleaseState,
} from '../types';

const CHANNEL_COLORS: Record<string, string> = {
  stable: 'bg-green-100 text-green-700',
  beta: 'bg-sky-100 text-sky-700',
  canary: 'bg-amber-100 text-amber-700',
};

const RELEASE_STATE_COLORS: Record<string, string> = {
  healthy: 'bg-green-100 text-green-700',
  deployed: 'bg-green-100 text-green-700',
  queued: 'bg-sky-100 text-sky-700',
  deploying: 'bg-sky-100 text-sky-700',
  verifying: 'bg-sky-100 text-sky-700',
  rolled_back: 'bg-indigo-100 text-indigo-700',
  failed: 'bg-rose-100 text-rose-700',
  idle: 'bg-slate-100 text-slate-600',
};

const BATCH_COLORS: Record<string, string> = {
  complete: 'bg-green-100 text-green-700',
  partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-rose-100 text-rose-700',
  running: 'bg-sky-100 text-sky-700',
  planned: 'bg-slate-100 text-slate-600',
  dry_run: 'bg-indigo-100 text-indigo-700',
};

const shortDigest = (digest: string | null): string => (digest ? `${digest.slice(0, 19)}…` : '—');

const kindLabel = (kind: ReleaseKind): string => (kind === 'store' ? 'Store' : 'Head Office');
const tenantTypeFor = (kind: ReleaseKind): 'store' | 'panel' =>
  kind === 'store' ? 'store' : 'panel';

const Badge = ({ value, colors }: { value: string; colors: Record<string, string> }) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${
      colors[value] ?? 'bg-slate-100 text-slate-600'
    }`}
  >
    {value.replace('_', ' ')}
  </span>
);

type Tab = 'fleet' | 'catalog' | 'rollouts';
type ActionTarget = {
  tenant: TenantReleaseState;
  action: 'upgrade' | 'rollback';
};

export default function ReleasesPage() {
  const [fleet, setFleet] = useState<ReleaseFleet>({ stores: [], panels: [] });
  const [releases, setReleases] = useState<ImageRelease[]>([]);
  const [batches, setBatches] = useState<ReleaseBatchSummary[]>([]);
  const [capabilities, setCapabilities] = useState<ReleaseCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<Tab>('fleet');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'store' | 'panel'>('all');
  const [publishOpen, setPublishOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<ActionTarget | null>(null);
  const [rolloutOpen, setRolloutOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<TenantReleaseState | null>(null);
  const [history, setHistory] = useState<ReleaseDeploymentHistory[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [batchTarget, setBatchTarget] = useState<ReleaseBatchSummary | null>(null);
  const [batchDetail, setBatchDetail] = useState<ReleaseBatchDetail | null>(null);
  const [batchError, setBatchError] = useState('');

  const notify = (kind: 'ok' | 'error', text: string) => setNotice({ kind, text });

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [nextFleet, nextReleases, nextBatches, caps] = await Promise.all([
        api<ReleaseFleet>('/releases/fleet'),
        api<ImageRelease[]>('/releases'),
        api<ReleaseBatchSummary[]>('/releases/batches'),
        api<ReleaseCapabilities>('/releases/capabilities'),
      ]);
      setFleet(nextFleet);
      setReleases(nextReleases);
      setBatches(nextBatches);
      setCapabilities(caps);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load release data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = useMemo(() => {
    const tenants = [...fleet.stores, ...fleet.panels];
    return (
      tenants.some((t) => ['queued', 'deploying', 'verifying'].includes(t.releaseState)) ||
      batches.some((b) => b.status === 'running')
    );
  }, [fleet, batches]);

  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [busy, load]);

  const releaseById = useMemo(() => {
    const map = new Map<number, ImageRelease>();
    for (const release of releases) map.set(release.id, release);
    return map;
  }, [releases]);

  const tenants = useMemo(() => {
    const all = [...fleet.stores, ...fleet.panels].sort((a, b) => a.name.localeCompare(b.name));
    const q = search.trim().toLowerCase();
    return all.filter((tenant) => {
      if (kindFilter !== 'all' && tenant.tenantType !== kindFilter) return false;
      if (!q) return true;
      return (
        tenant.name.toLowerCase().includes(q) ||
        tenant.slug.toLowerCase().includes(q) ||
        tenant.baseUrl.toLowerCase().includes(q) ||
        tenant.companySlug?.toLowerCase().includes(q)
      );
    });
  }, [fleet, kindFilter, search]);

  const summary = useMemo(() => {
    const all = [...fleet.stores, ...fleet.panels];
    return {
      total: all.length,
      healthy: all.filter((t) => t.runtimeHealth === 'up').length,
      attention: all.filter(
        (t) =>
          t.releaseState === 'failed' ||
          t.deployStatus === 'failed' ||
          (t.desiredReleaseId !== null && t.desiredReleaseId !== t.lastReleaseId),
      ).length,
      releases: releases.filter((r) => r.isActive).length,
      runningBatches: batches.filter((b) => b.status === 'running').length,
    };
  }, [fleet, releases, batches]);

  const canManage = capabilities?.releaseManager === true;

  const openHistory = async (tenant: TenantReleaseState) => {
    setHistoryTarget(tenant);
    setHistory([]);
    setHistoryError('');
    try {
      setHistory(
        await api<ReleaseDeploymentHistory[]>(
          `/releases/tenants/${tenant.tenantType}/${tenant.id}/history`,
        ),
      );
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : 'Could not load release history');
    }
  };

  const openBatch = async (batch: ReleaseBatchSummary) => {
    setBatchTarget(batch);
    setBatchDetail(null);
    setBatchError('');
    try {
      setBatchDetail(await api<ReleaseBatchDetail>(`/releases/batches/${batch.id}`));
    } catch (err) {
      setBatchError(err instanceof ApiError ? err.message : 'Could not load batch');
    }
  };

  if (loading) return <Spinner label="Loading releases…" />;
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
      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {(['fleet', 'catalog', 'rollouts'] as const).map((item) => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold capitalize transition ${
                tab === item
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <button
          onClick={() => void load()}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw className="mr-1 inline h-3.5 w-3.5" /> Refresh
        </button>
        <button
          onClick={() => setRolloutOpen(true)}
          disabled={!canManage || releases.length === 0}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Play className="mr-1 inline h-3.5 w-3.5" /> New rollout
        </button>
        <button
          onClick={() => setPublishOpen(true)}
          disabled={!canManage}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="mr-1 inline h-3.5 w-3.5" /> Publish release
        </button>
      </div>

      {!canManage && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Read-only release view. Release-manager permission is required to publish, upgrade, roll
          back or start a wave. Ask an administrator to add your email to
          <code className="mx-1 rounded bg-white px-1">RELEASE_MANAGER_EMAILS</code>.
        </div>
      )}

      {tab === 'fleet' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryTile label="Tenants" value={summary.total} />
            <SummaryTile
              label="Runtime healthy"
              value={summary.healthy}
              tone={summary.healthy === summary.total ? 'green' : 'amber'}
            />
            <SummaryTile
              label="Needs attention"
              value={summary.attention}
              tone={summary.attention ? 'red' : 'green'}
            />
            <SummaryTile label="Active releases" value={summary.releases} tone="brand" />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tenant, slug, company…"
              className="min-w-56 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-400 sm:max-w-md"
            />
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as 'all' | 'store' | 'panel')}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-400"
            >
              <option value="all">All kinds</option>
              <option value="store">Stores</option>
              <option value="panel">Head Offices</option>
            </select>
            <span className="ml-auto text-xs text-slate-400">{tenants.length} shown</span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[1000px] text-xs">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 text-left">Tenant</th>
                  <th className="px-4 py-2.5 text-left">Environment</th>
                  <th className="px-4 py-2.5 text-left">Current</th>
                  <th className="px-4 py-2.5 text-left">Desired</th>
                  <th className="px-4 py-2.5 text-left">Channel</th>
                  <th className="px-4 py-2.5 text-left">Runtime</th>
                  <th className="px-4 py-2.5 text-left">Last release</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenants.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                      No tenants match this view.
                    </td>
                  </tr>
                )}
                {tenants.map((tenant) => {
                  const desired = tenant.desiredReleaseId
                    ? releaseById.get(tenant.desiredReleaseId)
                    : null;
                  return (
                    <tr
                      key={`${tenant.tenantType}-${tenant.id}`}
                      className="border-t border-slate-100"
                    >
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-800">{tenant.name}</div>
                        <div className="text-[11px] text-slate-400">
                          {kindLabel(tenant.tenantType === 'store' ? 'store' : 'ho')} ·{' '}
                          {tenant.companySlug ?? 'unassigned'} · {tenant.slug}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {tenant.environment ? (
                          <StatusBadge
                            status={tenant.environment}
                            colors={ENVIRONMENT_COLORS}
                            label={ENVIRONMENT_LABELS[tenant.environment]}
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono font-semibold text-slate-700">
                          {tenant.appVersion ?? '—'}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {shortDigest(tenant.imageDigest)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-mono font-semibold text-slate-700">
                          {desired?.version ?? tenant.imageTag ?? '—'}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {desired ? shortDigest(desired.digest) : 'no desired release'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge value={tenant.releaseChannel} colors={CHANNEL_COLORS} />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            tenant.runtimeHealth === 'up'
                              ? 'bg-green-100 text-green-700'
                              : tenant.runtimeHealth === 'down'
                                ? 'bg-rose-100 text-rose-700'
                                : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {tenant.runtimeHealth === 'up'
                            ? 'healthy'
                            : tenant.runtimeHealth === 'down'
                              ? 'down'
                              : 'unknown'}
                        </span>
                        <div className="mt-1 text-[10px] text-slate-400">
                          deploy: {tenant.deployStatus}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge value={tenant.releaseState} colors={RELEASE_STATE_COLORS} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">
                          <ActionButton
                            icon={History}
                            label="History"
                            onClick={() => void openHistory(tenant)}
                          />
                          <ActionButton
                            icon={Rocket}
                            label="Upgrade"
                            title={
                              canManage ? 'Apply a release' : 'Release-manager permission required'
                            }
                            className="border-brand-200 text-brand-700 hover:bg-brand-50 disabled:opacity-40"
                            onClick={() =>
                              canManage && setActionTarget({ tenant, action: 'upgrade' })
                            }
                          />
                          <ActionButton
                            icon={RotateCcw}
                            label="Rollback"
                            disabled={!canManage || !tenant.rollbackEligible}
                            title={
                              !canManage
                                ? 'Release-manager permission required'
                                : tenant.rollbackEligible
                                  ? `Roll back to release ${tenant.rollbackReleaseId}`
                                  : (tenant.rollbackReason ?? 'No valid rollback target')
                            }
                            className="border-amber-200 text-amber-700 hover:bg-amber-50"
                            onClick={() =>
                              canManage &&
                              tenant.rollbackEligible &&
                              setActionTarget({ tenant, action: 'rollback' })
                            }
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'catalog' && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[900px] text-xs">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Kind</th>
                <th className="px-4 py-2.5 text-left">Version</th>
                <th className="px-4 py-2.5 text-left">Tag</th>
                <th className="px-4 py-2.5 text-left">Channel</th>
                <th className="px-4 py-2.5 text-left">Schema</th>
                <th className="px-4 py-2.5 text-left">Digest</th>
                <th className="px-4 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {releases.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    No releases registered. Publish an immutable digest to begin.
                  </td>
                </tr>
              )}
              {releases.map((release) => (
                <tr key={release.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-semibold text-slate-700">
                    {kindLabel(release.kind)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-mono font-semibold text-slate-700">{release.version}</div>
                    <div className="text-[10px] text-slate-400">
                      {release.revision ?? 'no revision'}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-slate-600">{release.tag}</td>
                  <td className="px-4 py-3">
                    <Badge value={release.channel} colors={CHANNEL_COLORS} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {release.schemaVersion} · {release.schemaMin}–{release.schemaMax}
                  </td>
                  <td
                    className="px-4 py-3 font-mono text-[10px] text-slate-500"
                    title={release.digest}
                  >
                    {shortDigest(release.digest)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        release.isActive
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {release.isActive ? 'active' : 'inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'rollouts' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryTile label="Batches" value={batches.length} />
            <SummaryTile
              label="Running"
              value={batches.filter((b) => b.status === 'running').length}
              tone={busy ? 'brand' : 'slate'}
            />
            <SummaryTile
              label="Failed / partial"
              value={batches.filter((b) => ['failed', 'partial'].includes(b.status)).length}
              tone={batches.some((b) => ['failed', 'partial'].includes(b.status)) ? 'red' : 'green'}
            />
            <SummaryTile label="Dry runs" value={batches.filter((b) => b.dryRun).length} />
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[850px] text-xs">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 text-left">Batch</th>
                  <th className="px-4 py-2.5 text-left">Release</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-right">Waves</th>
                  <th className="px-4 py-2.5 text-right">Result</th>
                  <th className="px-4 py-2.5 text-left">Started</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {batches.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      No rollouts yet.
                    </td>
                  </tr>
                )}
                {batches.map((batch) => {
                  const release = releaseById.get(batch.releaseId);
                  return (
                    <tr key={batch.id} className="border-t border-slate-100">
                      <td className="px-4 py-3 font-mono font-semibold text-slate-700">
                        #{batch.id}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-700">
                          {release?.version ?? `release ${batch.releaseId}`}
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {kindLabel(batch.kind)} · {batch.channel}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge value={batch.status} colors={BATCH_COLORS} />
                        {batch.error && (
                          <div className="mt-1 text-[10px] text-rose-600">{batch.error}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {batch.waveSize}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                        {batch.succeeded} ok · {batch.failed} failed · {batch.skipped} skipped
                      </td>
                      <td
                        className="px-4 py-3 text-slate-500"
                        title={fmtTime(batch.startedAt ?? batch.createdAt)}
                      >
                        {fmtAgo(batch.startedAt ?? batch.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => void openBatch(batch)}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
                        >
                          Details <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {publishOpen && (
        <PublishReleaseModal
          canManage={canManage}
          onClose={() => setPublishOpen(false)}
          onDone={() => {
            setPublishOpen(false);
            notify('ok', 'Release registered. It is now available for upgrades.');
            void load();
          }}
          onError={(message) => notify('error', message)}
        />
      )}

      {actionTarget && (
        <ReleaseActionModal
          target={actionTarget}
          releases={releases}
          canManage={canManage}
          onClose={() => setActionTarget(null)}
          onDone={(message) => {
            setActionTarget(null);
            notify('ok', message);
            void load();
          }}
          onError={(message) => notify('error', message)}
        />
      )}

      {rolloutOpen && (
        <RolloutModal
          tenants={tenants}
          releases={releases}
          canManage={canManage}
          onClose={() => setRolloutOpen(false)}
          onDone={(message) => {
            setRolloutOpen(false);
            notify('ok', message);
            void load();
          }}
          onError={(message) => notify('error', message)}
        />
      )}

      {historyTarget && (
        <Modal
          title={`Release history · ${historyTarget.name}`}
          onClose={() => setHistoryTarget(null)}
          size="2xl"
        >
          {historyError ? (
            <ErrorBox message={historyError} />
          ) : history.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">No release deployments yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-2 py-2 text-left">Action</th>
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-left">From → To</th>
                  <th className="px-2 py-2 text-left">Phase</th>
                  <th className="px-2 py-2 text-left">Error</th>
                  <th className="px-2 py-2 text-left">Completed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-2 py-2 font-semibold text-slate-700">{row.action}</td>
                    <td className="px-2 py-2">
                      <Badge value={row.status} colors={RELEASE_STATE_COLORS} />
                    </td>
                    <td className="px-2 py-2 font-mono text-[10px] text-slate-500">
                      {shortDigest(row.from_digest)} → {shortDigest(row.to_digest)}
                    </td>
                    <td className="px-2 py-2 text-slate-500">{row.phase}</td>
                    <td className="px-2 py-2 text-rose-600">{row.error ?? '—'}</td>
                    <td className="px-2 py-2 text-slate-500" title={fmtTime(row.completed_at)}>
                      {row.completed_at ? fmtAgo(row.completed_at) : 'running'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}

      {batchTarget && (
        <Modal title={`Rollout #${batchTarget.id}`} onClose={() => setBatchTarget(null)} size="2xl">
          {batchError ? (
            <ErrorBox message={batchError} />
          ) : !batchDetail ? (
            <Spinner label="Loading rollout…" />
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <SummaryTile label="Status" value={batchDetail.batch.status} />
                <SummaryTile label="Succeeded" value={batchDetail.batch.succeeded} tone="green" />
                <SummaryTile label="Failed" value={batchDetail.batch.failed} tone="red" />
                <SummaryTile label="Skipped" value={batchDetail.batch.skipped} tone="amber" />
              </div>
              <table className="w-full text-xs">
                <thead className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-2 py-2 text-left">Wave</th>
                    <th className="px-2 py-2 text-left">Tenant</th>
                    <th className="px-2 py-2 text-left">Action</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-left">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {batchDetail.items.map((item) => (
                    <tr key={item.id} className="border-t border-slate-100">
                      <td className="px-2 py-2 tabular-nums text-slate-600">{item.wave}</td>
                      <td className="px-2 py-2 text-slate-700">
                        {item.tenantType} #{item.tenantId}
                      </td>
                      <td className="px-2 py-2 text-slate-600">{item.action}</td>
                      <td className="px-2 py-2">
                        <Badge value={item.status} colors={RELEASE_STATE_COLORS} />
                      </td>
                      <td className="px-2 py-2 text-rose-600">{item.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function PublishReleaseModal({
  canManage,
  onClose,
  onDone,
  onError,
}: {
  canManage: boolean;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [kind, setKind] = useState<ReleaseKind>('store');
  const [tag, setTag] = useState('');
  const [digest, setDigest] = useState('');
  const [version, setVersion] = useState('');
  const [revision, setRevision] = useState('');
  const [channel, setChannel] = useState<'stable' | 'beta' | 'canary'>('stable');
  const [schemaVersion, setSchemaVersion] = useState('1');
  const [schemaMin, setSchemaMin] = useState('1');
  const [schemaMax, setSchemaMax] = useState('1');
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (confirm !== tag) return;
    setBusy(true);
    setError('');
    try {
      await api<ImageRelease>('/releases', {
        method: 'POST',
        body: {
          kind,
          tag,
          digest,
          version,
          revision: revision.trim() || undefined,
          channel,
          schemaVersion: Number(schemaVersion),
          schemaMin: Number(schemaMin),
          schemaMax: Number(schemaMax),
          notes: notes.trim() || undefined,
        },
      });
      onDone();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not publish release';
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Publish immutable release"
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!canManage || busy || confirm !== tag || !tag || !digest || !version}
            className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {busy ? 'Publishing…' : 'Publish release'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {error && <ErrorBox message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ReleaseKind)}
              className="input"
            >
              <option value="store">Store</option>
              <option value="ho">Head Office</option>
            </select>
          </Field>
          <Field label="Channel">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as typeof channel)}
              className="input"
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
              <option value="canary">Canary</option>
            </select>
          </Field>
          <Field label="Version">
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="v2026.10.23-…"
              className="input font-mono"
            />
          </Field>
          <Field label="Tag">
            <input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              placeholder="v2026.10.23-…"
              className="input font-mono"
            />
          </Field>
          <Field label="Revision (optional)">
            <input
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="full git SHA"
              className="input font-mono"
            />
          </Field>
          <Field label="Schema version">
            <input
              value={schemaVersion}
              onChange={(e) => setSchemaVersion(e.target.value)}
              className="input font-mono"
            />
          </Field>
          <Field label="Schema min">
            <input
              value={schemaMin}
              onChange={(e) => setSchemaMin(e.target.value)}
              className="input font-mono"
            />
          </Field>
          <Field label="Schema max">
            <input
              value={schemaMax}
              onChange={(e) => setSchemaMax(e.target.value)}
              className="input font-mono"
            />
          </Field>
        </div>
        <Field label="Digest">
          <input
            value={digest}
            onChange={(e) => setDigest(e.target.value)}
            placeholder="sha256:…"
            className="input font-mono"
          />
        </Field>
        <Field label="Notes (optional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="input"
          />
        </Field>
        <Field label={`Type "${tag || 'the tag'}" to confirm publication`}>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}

function ReleaseActionModal({
  target,
  releases,
  canManage,
  onClose,
  onDone,
  onError,
}: {
  target: ActionTarget;
  releases: ImageRelease[];
  canManage: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const kind: ReleaseKind = target.tenant.tenantType === 'store' ? 'store' : 'ho';
  const compatible = releases.filter((r) => r.kind === kind && r.isActive);
  const defaultTarget =
    target.action === 'rollback'
      ? (target.tenant.previousReleaseId ?? target.tenant.lastReleaseId)
      : (compatible[0]?.id ?? null);
  const [releaseId, setReleaseId] = useState<number | null>(defaultTarget);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = releases.find((r) => r.id === releaseId) ?? null;
  const destructive = target.action === 'rollback';
  const confirmationPhrase = target.tenant.slug;

  const submit = async () => {
    if (confirm !== confirmationPhrase) return;
    setBusy(true);
    setError('');
    try {
      if (target.action === 'rollback') {
        await api(`/releases/tenants/${target.tenant.tenantType}/${target.tenant.id}/rollback`, {
          method: 'POST',
          body: releaseId ? { toReleaseId: releaseId } : {},
        });
        onDone(`Rollback requested for ${target.tenant.name}.`);
      } else {
        if (!releaseId) throw new Error('Choose a release');
        await api(`/releases/tenants/${target.tenant.tenantType}/${target.tenant.id}/apply`, {
          method: 'POST',
          body: { releaseId, action: 'upgrade', reason: 'Upgrade from Releases UI' },
        });
        onDone(`${target.tenant.name} upgraded to ${selected?.version ?? 'release'}.`);
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Release action failed';
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${destructive ? 'Roll back' : 'Upgrade'} · ${target.tenant.name}`}
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={
              !canManage || busy || confirm !== confirmationPhrase || (!destructive && !releaseId)
            }
            className={`rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-40 ${
              destructive ? 'bg-amber-600 hover:bg-amber-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}
          >
            {busy ? 'Working…' : destructive ? 'Confirm rollback' : 'Confirm upgrade'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        {error && <ErrorBox message={error} />}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
          <div>
            Current: <strong>{target.tenant.appVersion ?? 'unknown'}</strong>
          </div>
          <div className="text-slate-500">
            State: {target.tenant.releaseState} · {target.tenant.deployStatus}
          </div>
        </div>
        {destructive ? (
          <p className="text-xs text-slate-600">
            This stops the current container first, then deploys the selected prior release. The
            SQLite data volume is retained.
          </p>
        ) : (
          <Field label="Target release">
            <select
              value={releaseId ?? ''}
              onChange={(e) => setReleaseId(Number(e.target.value) || null)}
              className="input"
            >
              <option value="">Choose a release…</option>
              {compatible.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.version} · {release.channel} · schema {release.schemaMin}–
                  {release.schemaMax}
                </option>
              ))}
            </select>
          </Field>
        )}
        {selected && (
          <div className="rounded-lg border border-slate-200 p-3 text-xs">
            <div className="font-semibold text-slate-700">{selected.version}</div>
            <div className="font-mono text-[10px] text-slate-500">{selected.digest}</div>
            <div className="mt-1 text-slate-500">
              {kindLabel(selected.kind)} · {selected.channel} · schema {selected.schemaVersion}
            </div>
          </div>
        )}
        <Field label={`Type "${confirmationPhrase}" to confirm`}>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}

function RolloutModal({
  tenants,
  releases,
  canManage,
  onClose,
  onDone,
  onError,
}: {
  tenants: TenantReleaseState[];
  releases: ImageRelease[];
  canManage: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [releaseId, setReleaseId] = useState<number | null>(
    releases.find((r) => r.isActive)?.id ?? null,
  );
  const selectedRelease = releases.find((r) => r.id === releaseId) ?? null;
  const releaseTenantType = selectedRelease ? tenantTypeFor(selectedRelease.kind) : null;
  const eligible = tenants.filter((t) => t.tenantType === releaseTenantType);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [waveSize, setWaveSize] = useState('1');
  const [dryRun, setDryRun] = useState(true);
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelectedIds(eligible.map((t) => t.id));
  }, [releaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: number) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const submit = async () => {
    if (!releaseId || confirm !== 'ROLLOUT') return;
    setBusy(true);
    setError('');
    try {
      const result = await api<ReleaseBatchDetail>(`/releases/${releaseId}/rollout`, {
        method: 'POST',
        body: {
          tenantIds: selectedIds,
          waveSize: Number(waveSize),
          dryRun,
          stopOnFailure,
        },
      });
      onDone(
        result.batch.dryRun
          ? `Dry run planned: ${result.batch.total} tenant(s), ${result.items.length} item(s).`
          : `Rollout #${result.batch.id} finished: ${result.batch.status}.`,
      );
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Rollout failed';
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New rollout"
      onClose={onClose}
      size="xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={
              !canManage || busy || confirm !== 'ROLLOUT' || !releaseId || selectedIds.length === 0
            }
            className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {busy ? 'Starting…' : dryRun ? 'Plan dry run' : 'Start rollout'}
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        {error && <ErrorBox message={error} />}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Release">
            <select
              value={releaseId ?? ''}
              onChange={(e) => setReleaseId(Number(e.target.value) || null)}
              className="input"
            >
              <option value="">Choose…</option>
              {releases
                .filter((r) => r.isActive)
                .map((release) => (
                  <option key={release.id} value={release.id}>
                    {kindLabel(release.kind)} · {release.version} · {release.channel}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Wave size">
            <input
              value={waveSize}
              onChange={(e) => setWaveSize(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Mode">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry run only
            </label>
            <label className="mt-1 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={stopOnFailure}
                onChange={(e) => setStopOnFailure(e.target.checked)}
              />
              Stop after failed wave
            </label>
          </Field>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Tenants ({selectedIds.length}/{eligible.length})
          </div>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
            {eligible.map((tenant) => (
              <label
                key={tenant.id}
                className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(tenant.id)}
                  onChange={() => toggle(tenant.id)}
                />
                <span className="font-semibold text-slate-700">{tenant.name}</span>
                <span className="text-slate-400">{tenant.slug}</span>
                <span className="ml-auto text-slate-500">{tenant.appVersion ?? '—'}</span>
              </label>
            ))}
            {eligible.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">
                No tenants for this release kind.
              </div>
            )}
          </div>
        </div>
        <Field label='Type "ROLLOUT" to confirm'>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="input font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-slate-600">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
