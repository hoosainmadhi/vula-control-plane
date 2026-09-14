import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Modal from '../components/Modal';
import Spinner from '../components/Spinner';
import { SummaryTile } from '../components/storeUi';
import { fmtAgo, fmtTime } from '../lib/storeVocab';
import type {
  DeploymentDetail,
  DeploymentJobStatus,
  DeploymentStepStatus,
  DeploymentSummary,
} from '../types';

const JOB_STATUS_LABELS: Record<DeploymentJobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
};

const JOB_STATUS_COLORS: Record<DeploymentJobStatus, string> = {
  pending: 'bg-slate-100 text-slate-500 border-slate-200',
  running: 'bg-sky-50 text-sky-700 border-sky-200',
  complete: 'bg-green-50 text-green-700 border-green-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
};

const STEP_STATUS_COLORS: Record<DeploymentStepStatus, string> = {
  pending: 'bg-slate-100 text-slate-500',
  running: 'bg-sky-50 text-sky-700',
  complete: 'bg-green-50 text-green-700',
  failed: 'bg-rose-50 text-rose-700',
  skipped: 'bg-amber-50 text-amber-700',
};

/** Job types are the orchestrator's own strings — humanised, never invented. */
const typeLabel = (type: string): string =>
  type
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const Pill = ({ status }: { status: DeploymentJobStatus }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${JOB_STATUS_COLORS[status]}`}
  >
    {JOB_STATUS_LABELS[status]}
  </span>
);

export default function DeploymentsPage() {
  const [jobs, setJobs] = useState<DeploymentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [statusFilter, setStatusFilter] = useState<DeploymentJobStatus | 'all'>('all');
  const [detail, setDetail] = useState<DeploymentDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      setJobs(await api<DeploymentSummary[]>('/deployments'));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load deployments');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openJob = async (job: DeploymentSummary) => {
    setDetailLoading(true);
    setDetailError('');
    try {
      setDetail(await api<DeploymentDetail>(`/deployments/${job.id}`));
    } catch (err) {
      setDetailError(err instanceof ApiError ? err.message : 'Could not load this deployment');
    } finally {
      setDetailLoading(false);
    }
  };

  const filtered = useMemo(
    () => (statusFilter === 'all' ? jobs : jobs.filter((j) => j.status === statusFilter)),
    [jobs, statusFilter],
  );

  const counts = useMemo(
    () => ({
      total: jobs.length,
      running: jobs.filter((j) => j.status === 'running').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      complete: jobs.filter((j) => j.status === 'complete').length,
    }),
    [jobs],
  );

  if (loading) return <Spinner label="Loading deployments…" />;
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryTile label="Deployments" value={counts.total} />
        <SummaryTile label="Running" value={counts.running} tone="brand" />
        <SummaryTile label="Failed" value={counts.failed} tone={counts.failed ? 'red' : 'green'} />
        <SummaryTile label="Complete" value={counts.complete} tone="green" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {(['all', 'running', 'failed', 'complete'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold capitalize transition ${
                statusFilter === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {s}
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
          {jobs.length === 0
            ? 'No deployments yet — onboard a client and its orchestrated deployment appears here.'
            : 'No deployments with this status.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left">Client</th>
                <th className="px-4 py-2.5 text-left">Type</th>
                <th className="px-4 py-2.5 text-left">Status</th>
                <th className="px-4 py-2.5 text-left">Steps</th>
                <th className="px-4 py-2.5 text-right">Started</th>
                <th className="px-4 py-2.5 text-right">Completed</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((job) => (
                <tr
                  key={job.id}
                  onClick={() => void openJob(job)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-4 py-2.5 font-semibold text-slate-700">{job.companyName}</td>
                  <td className="px-4 py-2.5 text-slate-500">{typeLabel(job.type)}</td>
                  <td className="px-4 py-2.5">
                    <Pill status={job.status} />
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">
                    {job.stepCounts.complete}/{job.stepCounts.total} complete
                    {job.stepCounts.failed > 0 && (
                      <span className="ml-1 font-bold text-rose-600">· {job.stepCounts.failed} failed</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-500" title={fmtTime(job.startedAt)}>
                    {fmtAgo(job.startedAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-500" title={fmtTime(job.completedAt)}>
                    {job.completedAt ? fmtAgo(job.completedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Orchestrated client deployments, newest first — read-only. A job records its type, status and
        timing; the build it deployed and the operator who started it are <span className="font-semibold">not</span>{' '}
        recorded on the job, so those spec columns are omitted rather than filled with a guess. Open a
        job to see its steps, attempts, warnings and failures.
      </p>

      {(detail || detailLoading || detailError) && (
        <Modal title="Deployment detail" onClose={() => setDetail(null)} size="xl">
          {detailLoading && <Spinner label="Loading steps…" />}
          {detailError && <ErrorBox message={detailError} />}
          {detail && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-bold text-slate-800">{detail.job.companyName}</span>
                <Pill status={detail.job.status} />
                <span className="text-xs text-slate-500">{typeLabel(detail.job.type)}</span>
                <span className="text-xs text-slate-400">Job #{detail.job.id}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <SummaryTile label="Steps" value={detail.job.stepCounts.total} />
                <SummaryTile label="Complete" value={detail.job.stepCounts.complete} tone="green" />
                <SummaryTile
                  label="Failed"
                  value={detail.job.stepCounts.failed}
                  tone={detail.job.stepCounts.failed ? 'red' : 'slate'}
                />
                <SummaryTile label="Attempts" value={detail.steps.reduce((n, s) => n + s.attempts, 0)} />
              </div>
              {detail.job.error && <ErrorBox message={detail.job.error} />}
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">Step</th>
                      <th className="px-3 py-2 text-left">Target</th>
                      <th className="px-3 py-2 text-left">Status</th>
                      <th className="px-3 py-2 text-right">Attempts</th>
                      <th className="px-3 py-2 text-right">Finished</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.steps.map((step) => (
                      <tr key={step.id} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-700">{step.stepKey}</div>
                          {step.warnings.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {step.warnings.map((w) => (
                                <li key={w} className="text-[10px] text-amber-700">
                                  ⚠ {w}
                                </li>
                              ))}
                            </ul>
                          )}
                          {step.error && (
                            <div className="mt-1 text-[10px] text-rose-700">{step.error}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {step.resourceType}
                          {step.resourceId !== null ? ` #${step.resourceId}` : ''}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STEP_STATUS_COLORS[step.status]}`}
                          >
                            {step.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{step.attempts}</td>
                        <td className="px-3 py-2 text-right text-slate-500" title={fmtTime(step.completedAt)}>
                          {step.completedAt ? fmtAgo(step.completedAt) : '—'}
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
