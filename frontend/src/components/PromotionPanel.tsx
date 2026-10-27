import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, Rocket, ShieldAlert, XCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import ErrorBox from './ErrorBox';
import Modal from './Modal';
import { ActionButton } from './storeUi';
import { fmtAgo, fmtTime } from '../lib/storeVocab';
import type { PromotionPreview, PromotionView } from '../types';

const shortDigest = (digest: string | null): string => (digest ? `${digest.slice(0, 19)}…` : '—');

const STATUS_COLORS: Record<string, string> = {
  dispatching: 'bg-sky-100 text-sky-700',
  running: 'bg-sky-100 text-sky-700',
  complete: 'bg-green-100 text-green-700',
  failed: 'bg-rose-100 text-rose-700',
  queued: 'bg-slate-100 text-slate-600',
  pending: 'bg-slate-100 text-slate-600',
  skipped: 'bg-amber-100 text-amber-700',
};

const StatusBadge = ({ status }: { status: string }) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${
      STATUS_COLORS[status] ?? 'bg-slate-100 text-slate-600'
    }`}
  >
    {status.replace('_', ' ')}
  </span>
);

const PromotionProgress = ({ promotion }: { promotion: PromotionView }) => {
  const active = promotion.status === 'dispatching' || promotion.status === 'running';
  return (
    <div
      className={`rounded-lg border px-3.5 py-3 ${
        promotion.status === 'failed'
          ? 'border-rose-200 bg-rose-50'
          : promotion.status === 'complete'
            ? 'border-green-200 bg-green-50'
            : 'border-sky-200 bg-sky-50'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={promotion.status} />
        <span className="text-sm font-bold text-slate-800">{promotion.tag}</span>
        <span className="text-xs text-slate-500">
          requested by {promotion.requestedBy} · {fmtAgo(promotion.createdAt)}
        </span>
        {promotion.githubRunUrl && (
          <a
            href={promotion.githubRunUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline"
          >
            GitHub run <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
      {promotion.githubStatus && (
        <p className="mt-1 text-xs text-slate-500">
          Workflow: {promotion.githubStatus}
          {promotion.githubConclusion ? ` · ${promotion.githubConclusion}` : ''}
          {active ? ' · refreshing automatically' : ''}
        </p>
      )}
      {promotion.error && (
        <p className="mt-1 text-xs font-semibold text-rose-700">{promotion.error}</p>
      )}
      {promotion.batches.length > 0 && (
        <div className="mt-2 space-y-2">
          {promotion.batches.map((batch) => (
            <div key={batch.id} className="rounded-md border border-slate-200 bg-white px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-slate-700">
                  {batch.kind === 'store' ? 'Stores' : 'Head Office'} batch #{batch.id}
                </span>
                <StatusBadge status={batch.status} />
                <span className="text-slate-500">
                  {batch.succeeded} succeeded · {batch.failed} failed · {batch.skipped} skipped ·{' '}
                  {batch.total} total
                </span>
              </div>
              {batch.error && <p className="mt-1 text-xs text-rose-700">{batch.error}</p>}
              {batch.items.filter((item) => item.error).length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {batch.items
                    .filter((item) => item.error)
                    .map((item) => (
                      <li
                        key={`${item.tenantType}-${item.tenantId}`}
                        className="text-[11px] text-rose-700"
                      >
                        {item.name}: {item.error}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default function PromotionPanel({
  preview,
  canManage,
  onChanged,
  notify,
}: {
  preview: PromotionPreview;
  canManage: boolean;
  onChanged: () => void;
  notify: (kind: 'ok' | 'error', text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const candidate = preview.candidate;
  const promotion = preview.promotion;
  const active = promotion?.status === 'dispatching' || promotion?.status === 'running';
  const targets = [...preview.targets.stores, ...preview.targets.panels];

  const disabledReason = !canManage
    ? 'Release-manager permission is required to promote to production.'
    : !preview.enabled
      ? preview.disabledReason
      : !candidate
        ? (preview.candidateError ?? 'The staging candidate is not available yet.')
        : preview.updatesRequired === 0
          ? 'Every target already runs the tested digests.'
          : preview.blockers.length > 0
            ? 'Resolve the blockers listed above before promoting.'
            : active
              ? 'A promotion is already in progress.'
              : null;

  const openModal = () => {
    setConfirm('');
    setError('');
    setOpen(true);
  };

  const submit = async () => {
    if (!candidate) return;
    setBusy(true);
    setError('');
    try {
      await api('/releases/promotion', {
        method: 'POST',
        body: { tag: candidate.tag, confirmTag: confirm },
      });
      setOpen(false);
      notify('ok', `Promotion of ${candidate.tag} dispatched. Progress appears below.`);
      onChanged();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not start the promotion';
      setError(message);
      notify('error', message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-brand-600" />
            <h2 className="text-sm font-black text-slate-900">Production promotion</h2>
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">
              Production
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Approve the release already tested on staging. The backend triggers the existing
            promotion workflow with the exact tested Store and Head Office digests; the scope is HM
            Stores only.
          </p>
        </div>
        <ActionButton
          icon={Rocket}
          label={active ? 'Promotion running' : 'Promote to production'}
          onClick={openModal}
          disabled={!canManage || !preview.canPromote || Boolean(active)}
          className="border-brand-300 bg-brand-600 text-white hover:bg-brand-700"
          title={disabledReason ?? 'Review targets and confirm'}
        />
      </div>

      {!preview.enabled && preview.disabledReason && (
        <div className="mt-3">
          <ErrorBox message={preview.disabledReason} />
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Staging-tested candidate
          </div>
          {candidate ? (
            <>
              <div className="mt-0.5 text-lg font-black text-slate-900">{candidate.tag}</div>
              <div className="text-[11px] text-slate-500">
                {candidate.commit ? `${candidate.commit.slice(0, 10)} · ` : ''}
                verified {fmtAgo(candidate.staging.verifiedAt)} on {candidate.staging.stores} Stores
                + {candidate.staging.panels} Head Office
              </div>
              <div className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-400">
                <div>store {shortDigest(candidate.store.digest)}</div>
                <div>ho {shortDigest(candidate.ho.digest)}</div>
              </div>
            </>
          ) : (
            <div className="mt-1 text-xs text-amber-700">
              {preview.candidateError ?? 'No fully tested staging release yet.'}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Current production
          </div>
          <div className="mt-0.5 text-lg font-black text-slate-900">
            {preview.current.stores.tag ?? '—'}
          </div>
          <div className="text-[11px] text-slate-500">
            Stores · {preview.current.stores.healthy}/{preview.current.stores.total} healthy
          </div>
          <div className="mt-1 text-sm font-bold text-slate-700">
            {preview.current.panels.tag ?? '—'}{' '}
            <span className="text-[11px] font-normal text-slate-500">
              Head Office · {preview.current.panels.healthy}/{preview.current.panels.total} healthy
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Applications requiring updates
          </div>
          <div
            className={`mt-0.5 text-lg font-black ${
              preview.updatesRequired > 0 ? 'text-amber-600' : 'text-green-600'
            }`}
          >
            {preview.updatesRequired}
          </div>
          <div className="text-[11px] text-slate-500">
            {preview.targets.stores.length} Stores + {preview.targets.panels.length} Head Office in
            scope
          </div>
          {preview.blockers.length > 0 && (
            <div className="mt-1 text-[11px] font-semibold text-rose-700">
              {preview.blockers.length} blocker{preview.blockers.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>

      {preview.blockers.length > 0 && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800">
            <XCircle className="h-3.5 w-3.5" /> Blockers
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-rose-700">
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.warnings.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800">
            <ShieldAlert className="h-3.5 w-3.5" /> Warnings
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-amber-700">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {promotion && (
        <div className="mt-3">
          <PromotionProgress promotion={promotion} />
        </div>
      )}

      {open && (
        <Modal
          title="Review production promotion"
          onClose={() => (busy ? undefined : setOpen(false))}
          size="lg"
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => void submit()}
                disabled={!candidate || busy || confirm !== candidate.tag}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Rocket className="h-3.5 w-3.5" />
                {busy ? 'Dispatching…' : 'Promote to production'}
              </button>
            </div>
          }
        >
          <div className="space-y-4 text-sm">
            {error && <ErrorBox message={error} />}
            {candidate && (
              <>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                  <div className="font-bold text-slate-800">{candidate.tag}</div>
                  <div>
                    Store {shortDigest(candidate.store.digest)} · Head Office{' '}
                    {shortDigest(candidate.ho.digest)}
                  </div>
                  <div>
                    Staging verified {fmtTime(candidate.staging.verifiedAt)} · schema{' '}
                    {candidate.store.schemaMin}..{candidate.store.schemaMax}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      <tr>
                        <th className="px-3 py-2 text-left">Target</th>
                        <th className="px-3 py-2 text-left">Current</th>
                        <th className="px-3 py-2 text-left">Becomes</th>
                        <th className="px-3 py-2 text-left">Health</th>
                      </tr>
                    </thead>
                    <tbody>
                      {targets.map((target) => (
                        <tr
                          key={`${target.tenantType}-${target.id}`}
                          className="border-t border-slate-100"
                        >
                          <td className="px-3 py-2">
                            <div className="font-semibold text-slate-700">{target.name}</div>
                            <div className="text-[10px] text-slate-400">
                              {target.tenantType === 'store' ? 'Store' : 'Head Office'} ·{' '}
                              {target.slug}
                            </div>
                          </td>
                          <td className="px-3 py-2 font-mono text-[10px] text-slate-500">
                            {target.currentTag ?? '—'}
                          </td>
                          <td className="px-3 py-2 font-mono text-[10px] text-slate-700">
                            {target.tenantType === 'store' ? candidate.store.tag : candidate.ho.tag}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={
                                target.runtimeHealth === 'up'
                                  ? 'text-green-600'
                                  : target.runtimeHealth === 'down'
                                    ? 'text-rose-600'
                                    : 'text-slate-400'
                              }
                            >
                              {target.runtimeHealth}
                            </span>
                            {target.paused && (
                              <span className="ml-1 text-[10px] text-amber-600">paused</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600">
                    Type <code className="rounded bg-slate-100 px-1">{candidate.tag}</code> to
                    confirm
                  </label>
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder={candidate.tag}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand-400"
                    autoFocus
                  />
                </div>

                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[11px] text-amber-800">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This changes the HM Stores production fleet. Each tenant stops its old container
                    before the new image starts, so only one SQLite writer can mount its volume. A
                    failed wave stops the remaining tenants.
                  </span>
                </div>

                {active && (
                  <div className="flex items-center gap-1.5 text-xs text-sky-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> A promotion is already running; wait
                    for it to finish before starting another.
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
