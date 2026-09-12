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
  icon: React.ComponentType<{ className?: string }>;
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
      <Icon className="h-3.5 w-3.5" />
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
