/** Indent for the assembled card body (extracted verbatim from the page). */
import { Link } from 'react-router-dom';
import { HeartPulse, LifeBuoy, Loader2, Pencil, Rocket, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import StatusBadge, { REGISTER_STATE_COLORS, STORE_COLORS, VERTICAL_COLORS } from './StatusBadge';
import { TerminalRoster, ActionButton } from './storeUi';
import {
  CONFIG_STATE_COLORS,
  CONFIG_STATE_LABELS,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_LABELS,
  HEALTH_STATE_COLORS,
  HEALTH_STATE_LABELS,
  LICENCE_LABELS,
  STATUS_LABELS,
  VERTICAL_LABELS,
  fmtAgo,
} from '../lib/storeVocab';
import type { Store } from '../types';

export interface StoreCardProps {
  store: Store;
  busy: boolean;
  confirmRemove: boolean;
  /** When set, the store name deep-links to the store detail page. */
  nameHref?: string;
  onConfigure: () => void;
  onPush: () => void;
  onDiagnostics: () => void;
  onSupport: () => void;
  onPauseResume: () => void;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
}

export function StoreCard({
  store,
  busy,
  confirmRemove,
  nameHref,
  onConfigure,
  onPush,
  onDiagnostics,
  onSupport,
  onPauseResume,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: StoreCardProps) {
  const terminalsPushed = store.terminalCount > 0 && store.lastConfigStatus === 'ok';
  return (
              <div
                key={store.id}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex flex-col gap-4 px-5 py-4 xl:flex-row xl:items-start xl:gap-8">
                  {/* Identity */}
                  <div className="min-w-0 xl:w-72 xl:shrink-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {nameHref ? (
                        <Link
                          to={nameHref}
                          className="truncate text-base font-bold text-slate-900 hover:text-brand-700"
                          title={`Open ${store.name}`}
                        >
                          {store.name}
                        </Link>
                      ) : (
                        <span
                          className="truncate text-base font-bold text-slate-900"
                          title={store.name}
                        >
                          {store.name}
                        </span>
                      )}
                      <StatusBadge
                        status={store.status}
                        colors={STORE_COLORS}
                        label={STATUS_LABELS[store.status]}
                      />
                      {store.deployStatus === 'provisioning' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-700 animate-pulse">
                          <Loader2 className="h-3 w-3 animate-spin" /> Provisioning
                        </span>
                      ) : store.deployStatus === 'deployed' ? (
                        <span className="inline-flex items-center rounded-full bg-teal-50 border border-teal-200 px-2 py-0.5 text-[10px] font-bold text-teal-700">
                          Auto-deployed
                        </span>
                      ) : store.deployStatus === 'failed' ? (
                        <span className="inline-flex items-center rounded-full bg-rose-50 border border-rose-200 px-2 py-0.5 text-[10px] font-bold text-rose-700">
                          Deploy failed
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className="truncate font-mono text-xs text-slate-400"
                        title={store.slug}
                      >
                        {store.slug}
                      </span>
                      <StatusBadge
                        status={store.vertical}
                        colors={VERTICAL_COLORS}
                        label={VERTICAL_LABELS[store.vertical]}
                      />
                      <StatusBadge
                        status={store.environment}
                        colors={ENVIRONMENT_COLORS}
                        label={ENVIRONMENT_LABELS[store.environment]}
                      />
                    </div>
                  </div>

                  {/* Details as labelled columns (SPOG §7/§8) */}
                  <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Client
                      </div>
                      {store.companyId !== null ? (
                        <Link
                          to={`/clients/${store.companyId}`}
                          className="mt-0.5 block truncate text-xs font-semibold text-slate-700 hover:text-brand-700"
                          title={`Open client ${store.companyName}`}
                        >
                          {store.companyName || 'Unassigned'}
                        </Link>
                      ) : (
                        <div
                          className="mt-0.5 truncate text-xs font-semibold text-slate-700"
                          title="Unassigned"
                        >
                          Unassigned
                        </div>
                      )}
                      <div className="text-[11px] text-slate-400">{store.planName}</div>
                    </div>

                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Domain
                      </div>
                      <a
                        href={store.baseUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={store.baseUrl}
                        className="mt-0.5 block truncate font-mono text-xs text-brand-600 hover:underline"
                      >
                        {store.baseUrl.replace(/^https?:\/\//, '')}
                      </a>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Health
                      </div>
                      <div className="mt-0.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                            HEALTH_STATE_COLORS[store.healthState]
                          }`}
                        >
                          {HEALTH_STATE_LABELS[store.healthState]}
                        </span>
                      </div>
                      <div
                        className="text-[11px] text-slate-400"
                        title={`Heartbeat ${fmtAgo(store.lastHeartbeatAt)}`}
                      >
                        {store.lastHeartbeatAt
                          ? `Last seen ${fmtAgo(store.lastHeartbeatAt)}`
                          : store.lastHealthStatus === 'unknown'
                            ? 'Never checked'
                            : fmtAgo(store.lastHealthAt)}
                      </div>
                      {store.healthState === 'offline' && store.lastHealthError && (
                        <div
                          className="max-w-[16rem] truncate text-[11px] text-rose-500"
                          title={store.lastHealthError}
                        >
                          {store.lastHealthError}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Version
                      </div>
                      <div className="mt-0.5 font-mono text-xs font-semibold text-slate-700">
                        {store.appVersion ?? '—'}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {store.schemaVersion != null ? `schema v${store.schemaVersion}` : 'schema —'}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Config
                      </div>
                      <div className="mt-0.5">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                            CONFIG_STATE_COLORS[store.configState]
                          }`}
                        >
                          {CONFIG_STATE_LABELS[store.configState]}
                        </span>
                      </div>
                      <div
                        className="text-[11px] text-slate-400"
                        title={`Expected v${store.configVersion.expected} · applied v${store.configVersion.applied}`}
                      >
                        v{store.configVersion.expected}
                        {store.configState === 'pending'
                          ? ` · applied v${store.configVersion.applied}`
                          : ''}
                      </div>
                      {store.configState === 'failed' && store.lastConfigError && (
                        <div
                          className="max-w-[16rem] truncate text-[11px] text-rose-500"
                          title={store.lastConfigError}
                        >
                          {store.lastConfigError}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Licence
                      </div>
                      <div
                        className="mt-0.5"
                        title="What the store's register shows for the subscription"
                      >
                        <StatusBadge
                          status={store.registerState}
                          colors={REGISTER_STATE_COLORS}
                          label={LICENCE_LABELS[store.registerState] ?? store.registerState}
                        />
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {store.tradingBlocked ? 'New sales refused' : 'Trading normally'}
                      </div>
                    </div>
                  </div>

                </div>

              {/* Actions — their own row so the columns can spread out */}
              <div className="relative flex flex-wrap items-center justify-end gap-1.5 border-t border-slate-100 px-5 py-3">
                    {busy ? (
                      <span className="inline-flex items-center gap-2 py-1.5 text-xs font-semibold text-slate-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Working…
                      </span>
                    ) : (
                      <>
                        <ActionButton
                          icon={HeartPulse}
                          label="Diagnostics"
                          title="Run diagnostics against this store"
                          onClick={onDiagnostics}
                          className="border-sky-200 text-sky-700 hover:bg-sky-50"
                        />
                        <ActionButton
                          icon={Pencil}
                          label="Configure"
                          title="Edit this store's configuration"
                          onClick={onConfigure}
                        />
                        <ActionButton
                          icon={Rocket}
                          label="Push Config"
                          title="Push Till 1..N and settings to this store now"
                          onClick={onPush}
                        />
                        <ActionButton
                          icon={LifeBuoy}
                          label="Support"
                          title="Start an audited support session"
                          onClick={onSupport}
                          className="border-violet-200 text-violet-700 hover:bg-violet-50"
                        />
                        <ActionButton
                          icon={store.status === 'active' ? ToggleRight : ToggleLeft}
                          label={store.status === 'active' ? 'Pause Store' : 'Resume Store'}
                          title={
                            store.status === 'active'
                              ? 'Pause the control-plane relationship (the store keeps trading offline)'
                              : 'Resume the control-plane relationship'
                          }
                          onClick={onPauseResume}
                          className={
                            store.status === 'active'
                              ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                              : 'border-green-200 text-green-700 hover:bg-green-50'
                          }
                        />
                        {confirmRemove ? (
                          <>
                            <ActionButton
                              label="Confirm remove"
                              onClick={onConfirmRemove}
                              className="border-red-600 bg-red-600 text-white hover:bg-red-500"
                            />
                            <ActionButton label="Cancel" onClick={onCancelRemove} />
                          </>
                        ) : (
                          <ActionButton
                            icon={Trash2}
                            label="Remove"
                            title="Remove this store from the control plane (pause it first)"
                            onClick={onRequestRemove}
                            className="border-red-200 text-red-600 hover:bg-red-50"
                          />
                        )}
                      </>
                    )}
              </div>

                {/* Entitlement needs attention (over cap, overdue, unassigned) */}
                {store.entitlementNote ? (
                  <div className="border-t border-amber-100 bg-amber-50/60 px-5 py-2 text-[11px] font-medium text-amber-800">
                    {store.entitlementNote}
                  </div>
                ) : null}

                {/* Terminal roster — every till, laid out across the full card width */}
                <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-3">
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Terminals
                    </span>
                    <span
                      className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700"
                      title="Licensed — purchased and paid for. The register refuses device claims beyond this."
                    >
                      {store.licensedTerminalCount ?? store.terminalCount} licensed
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                        terminalsPushed
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-200 text-slate-600'
                      }`}
                      title="Configured · claimed · session open"
                    >
                      {store.telemetry
                        ? `${store.telemetry.terminals.configured} configured · ${store.telemetry.terminals.claimed} claimed · ${store.telemetry.terminals.open} open`
                        : `${store.terminalCount} configured`}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      Sync: {store.telemetry?.sync.lastSyncAt ? fmtAgo(store.telemetry.sync.lastSyncAt) : 'no device sync yet'}
                    </span>
                  </div>
                  <TerminalRoster store={store} />
                </div>
              </div>
  );
}
