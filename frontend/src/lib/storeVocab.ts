/** Shared vocabulary + small utilities for the store SPOG surfaces. */
import type {
  ConfigState,
  HealthState,
  Store,
  StoreEnvironment,
  StoreFormValues,
  StoreStatus,
  StoreVertical,
} from '../types';

export const EMPTY_FORM: StoreFormValues = {
  name: '',
  slug: '',
  vertical: 'general',
  baseUrl: '',
  terminalCount: '1',
  environment: undefined as unknown as StoreEnvironment,
  controlPlaneToken: '',
  companyId: '',
};

export type NoticeKind = 'ok' | 'error';
export type Notice = { kind: NoticeKind; text: string } | null;

export type ModalState = { mode: 'create' } | { mode: 'edit'; store: Store } | null;

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** SQLite datetimes arrive in UTC ("YYYY-MM-DD HH:MM:SS"); show them locally. */
export const fmtTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/** "4 sec ago" style relative times for heartbeat/sync lines (SPOG §7). */
export const fmtAgo = (value: string | null | undefined): string => {
  if (!value) return '—';
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec} sec ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
};

export const HEALTH_STATE_LABELS: Record<HealthState, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Unknown',
};

export const HEALTH_STATE_COLORS: Record<HealthState, string> = {
  healthy: 'bg-green-50 text-green-700 border-green-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  degraded: 'bg-orange-50 text-orange-700 border-orange-200',
  offline: 'bg-rose-50 text-rose-700 border-rose-200',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

export const CONFIG_STATE_LABELS: Record<ConfigState, string> = {
  current: '✓ Current',
  pending: '⚠ Pending',
  failed: '✕ Failed',
  unknown: 'Unknown',
};

/**
 * The once-off charge's invoice line, mirroring `SETUP_FEE_LINE_LABEL` in the
 * server's `services/billing.ts`. The two cannot share a module across the
 * build, so the wording is kept identical by hand — the client must read the
 * same words in the preview as on the document it receives.
 */
export const SETUP_FEE_LABEL = 'Vula onboarding and deployment';

export const CONFIG_STATE_COLORS: Record<ConfigState, string> = {
  current: 'bg-green-50 text-green-700 border-green-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

/** Licence vocabulary (SPOG §15) — mapped from the register states. */
export const LICENCE_LABELS: Record<string, string> = {
  ok: 'Active',
  trial: 'Trial',
  warn: 'Expiring',
  grace: 'Grace',
  suspended: 'Suspended',
  unlicensed: 'Unlicensed',
};

export const ENVIRONMENT_LABELS: Record<StoreEnvironment, string> = {
  production: 'Production',
  staging: 'Staging',
  demo: 'Demo',
  development: 'Development',
};

export const ENVIRONMENT_COLORS: Record<StoreEnvironment, string> = {
  production: 'bg-brand-50 text-brand-700 border-brand-200',
  staging: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  demo: 'bg-purple-50 text-purple-700 border-purple-200',
  development: 'bg-slate-100 text-slate-600 border-slate-200',
};

export const STATUS_LABELS: Record<StoreStatus, string> = {
  active: 'Active',
  paused: 'Paused',
};

/** Store-type labels: short for chips, fuller for the form select (title = full). */
export const VERTICAL_LABELS: Record<StoreVertical, string> = {
  general: 'General',
  clothing: 'Clothing',
  spares: 'Spares',
  hardware: 'Hardware',
  pharmacy: 'Pharmacy',
  restaurant: 'Restaurant',
  custom: 'Custom',
};

export const VERTICAL_OPTIONS: Array<{ value: StoreVertical; label: string }> = [
  { value: 'general', label: 'General retail, convenience & spaza' },
  { value: 'clothing', label: 'Clothing & footwear' },
  { value: 'spares', label: 'Motor spares & parts' },
  { value: 'hardware', label: 'Hardware & building supplies' },
  { value: 'pharmacy', label: 'Pharmacy & wellness' },
  { value: 'restaurant', label: 'Restaurant & quick service' },
  { value: 'custom', label: 'Custom (no starter pack)' },
];
