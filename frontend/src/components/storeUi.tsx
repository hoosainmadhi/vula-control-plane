import type { Store } from '../types';

export function TerminalRoster({ store }: { store: Store }) {
  const configured = store.lastConfigStatus === 'ok';
  const names = store.terminalNames ?? [];
  const tills = Array.from({ length: store.terminalCount }, (_, i) => i + 1);
  return (
    <div className="flex flex-wrap gap-1">
      {tills.map((till) => {
        const name = names[till - 1]?.trim();
        const custom = Boolean(name) && name !== `Till ${till}`;
        return (
          <span
            key={till}
            title={`Till ${till}${custom ? ` — “${name}”` : ''} — ${configured ? 'configured' : 'pending'}`}
            className={`flex h-7 items-center justify-center rounded-md px-1.5 text-[11px] font-bold tabular-nums ${
              configured ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
            } ${custom ? 'w-auto min-w-9' : 'w-9'}`}
          >
            {custom ? name : till}
          </span>
        );
      })}
    </div>
  );
}

// --- Small building blocks ---------------------------------------------------

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  className = 'border-slate-200 text-slate-600 hover:bg-slate-50',
  title,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${className}`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

export function SummaryTile({
  label,
  value,
  tone = 'slate',
}: {
  label: string;
  value: string | number;
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'brand';
}) {
  const tones: Record<string, string> = {
    slate: 'text-slate-900',
    green: 'text-green-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
    brand: 'text-brand-600',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-black tabular-nums ${tones[tone]}`}>{value}</div>
    </div>
  );
}

/**
 * The outcome of a privileged action, shown as a fixed toast rather than inline.
 *
 * These messages used to render in the document flow at the foot of the page, which
 * meant a refusal (e.g. removing an active store) appeared below every store card —
 * on a 44-branch client that is several screens down, so the action read as though
 * nothing had happened. Anchored to the viewport it cannot be scrolled away from.
 */
export function NoticeBanner({
  notice,
  onDismiss,
}: {
  notice: { kind: 'ok' | 'error'; text: string } | null;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-2xl items-start gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-lg ${
          notice.kind === 'ok'
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-red-200 bg-red-50 text-red-700'
        }`}
      >
        <span>{notice.text}</span>
        <button
          onClick={onDismiss}
          className="text-xs text-slate-400 hover:text-slate-600"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
