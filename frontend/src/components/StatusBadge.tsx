import type { HealthStatus } from '../types';

/** Tinted pill colors keyed by a status string (optimed CP style). */
export const STORE_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  paused: 'bg-amber-100 text-amber-700',
};

export const CONFIG_COLORS: Record<string, string> = {
  ok: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
};

export const HEALTH_COLORS: Record<string, string> = {
  up: 'bg-green-100 text-green-700',
  down: 'bg-red-100 text-red-700',
  unknown: 'bg-slate-100 text-slate-600',
};

export const VERTICAL_COLORS: Record<string, string> = {
  general: 'bg-slate-100 text-slate-600',
  clothing: 'bg-fuchsia-100 text-fuchsia-700',
  spares: 'bg-sky-100 text-sky-700',
  hardware: 'bg-amber-100 text-amber-700',
  pharmacy: 'bg-emerald-100 text-emerald-700',
  restaurant: 'bg-rose-100 text-rose-700',
};

/** Register subscription states (L4) — what the till shows and whether it sells. */
export const REGISTER_STATE_COLORS: Record<string, string> = {
  ok: 'bg-green-100 text-green-700',
  warn: 'bg-amber-100 text-amber-700',
  grace: 'bg-orange-100 text-orange-700',
  suspended: 'bg-red-100 text-red-700',
  trial: 'bg-sky-100 text-sky-700',
  unlicensed: 'bg-slate-100 text-slate-600',
};

export const REGISTER_STATE_LABELS: Record<string, string> = {
  ok: 'Register: OK',
  warn: 'Register: renewal due',
  grace: 'Register: grace',
  suspended: 'Register: sales blocked',
  trial: 'Register: trial',
  unlicensed: 'Register: unlicensed',
};

interface StatusBadgeProps {
  status: string;
  colors: Record<string, string>;
  label?: string;
}

export default function StatusBadge({ status, colors, label }: StatusBadgeProps) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        colors[status] || 'bg-slate-100 text-slate-600'
      }`}
    >
      {label ?? status.replace('_', ' ')}
    </span>
  );
}

/** Small coloured dot for health cells. */
export function HealthDot({ status }: { status: HealthStatus }) {
  const color =
    status === 'up' ? 'bg-green-500' : status === 'down' ? 'bg-red-500' : 'bg-slate-300';
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${color}`}
      title={status === 'up' ? 'Healthy' : status === 'down' ? 'Down' : 'Unknown'}
    />
  );
}
