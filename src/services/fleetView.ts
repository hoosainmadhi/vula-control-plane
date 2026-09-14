import {
  listPanels,
  listStores,
  terminalRoster,
  type PanelRecord,
  type StoreEnvironment,
  type StoreRecord,
  type StoreVertical,
} from '../config/registryDb.js';
import type { RegisterEnforcement } from './subscriptions.js';

/**
 * Derived, operator-facing views over registry rows — the SPOG's read model.
 * These live here rather than in a route so the fleet list, the store detail
 * page and the Devices page cannot drift apart on how a state is derived.
 */

/** Operator-facing technical health vocabulary (SPOG §9-§10). */
export type HealthState = 'healthy' | 'warning' | 'degraded' | 'offline' | 'unknown';

/** Versioned configuration state (SPOG §12): desired vs applied, not just "pushed". */
export type ConfigState = 'current' | 'pending' | 'failed' | 'unknown';

interface TelemetrySnapshot {
  version?: string;
  generatedAt?: string;
  sync?: { lastSyncAt: string | null; pendingEvents: number | null; failedEvents: number | null };
  terminals?: Array<{
    till?: number;
    name?: string;
    claimed?: boolean;
    deviceId?: string | null;
    sessionOpen?: boolean;
    lastSeenAt?: string | null;
  }>;
}

/** A till counts as online when its device heartbeat is fresher than this. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export const parseTelemetry = (store: StoreRecord): TelemetrySnapshot | null => {
  if (!store.last_telemetry_json) return null;
  try {
    const parsed = JSON.parse(store.last_telemetry_json) as TelemetrySnapshot;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

/** Derived SPOG telemetry summary from the last stored snapshot (technical only). */
export const telemetrySummary = (store: StoreRecord) => {
  const t = parseTelemetry(store);
  if (!t) return null;
  const list = Array.isArray(t.terminals) ? t.terminals : [];
  return {
    version: t.version ?? null,
    generatedAt: t.generatedAt ?? null,
    sync: {
      lastSyncAt: t.sync?.lastSyncAt ?? null,
      pendingEvents: t.sync?.pendingEvents ?? null,
      failedEvents: t.sync?.failedEvents ?? null,
    },
    terminals: {
      configured: store.terminal_count,
      claimed: list.filter((x) => x.claimed).length,
      open: list.filter((x) => x.sessionOpen).length,
      online: list.filter((x) => isFresh(x.lastSeenAt)).length,
    },
  };
};

export const isFresh = (value: string | null | undefined): boolean =>
  value !== null &&
  value !== undefined &&
  !Number.isNaN(new Date(value).getTime()) &&
  Date.now() - new Date(value).getTime() <= ONLINE_WINDOW_MS;

export const configStateFor = (store: StoreRecord): ConfigState => {
  if (store.last_config_status === 'failed') return 'failed';
  const desired = store.desired_config_version ?? 1;
  const applied = store.applied_config_version ?? 0;
  if (store.last_config_status === 'pending' && applied === 0) return 'unknown';
  return desired === applied ? 'current' : 'pending';
};

export const healthStateFor = (
  store: StoreRecord,
  registerState: RegisterEnforcement['registerState'],
): HealthState => {
  if (store.last_health_status === 'unknown') return 'unknown';
  if (store.last_health_status === 'down') return 'offline';
  // Reachable — raise a warning for drift and entitlement trouble, not outages.
  const drift = configStateFor(store) !== 'current';
  const licenceTrouble =
    registerState === 'warn' || registerState === 'grace' || registerState === 'suspended';
  return drift || licenceTrouble ? 'warning' : 'healthy';
};

// --- Devices (SPOG §25) ------------------------------------------------------

/**
 * A device's status. `claimed`/`unclaimed` are POS-only: a till is claimed by a
 * register that has not yet reported a device heartbeat (`lastSeenAt` is a
 * reserved null in the v0.4.0 telemetry contract until the tenant ships it), so
 * "claimed but not reporting" has to be distinguishable from "offline" rather
 * than being guessed at.
 */
export type DeviceStatus = 'online' | 'offline' | 'claimed' | 'unclaimed' | 'unknown';

export interface DeviceView {
  /** Stable key — store tills and Head Offices live in different id spaces. */
  id: string;
  name: string;
  type: 'pos' | 'office';
  /** The roster position (Till 1, Till 2…), or null for a Head Office. */
  till: number | null;
  storeId: number | null;
  /** The store's name, or a Head Office's own name (it is the app instance). */
  storeName: string;
  storeSlug: string;
  /** The merchant that owns this device's store or Head Office. */
  companyName: string | null;
  environment: StoreEnvironment | null;
  vertical: StoreVertical | null;
  /**
   * The build the device runs. Per-device versions are not reported yet, and
   * every till in a store runs the same build, so this is the store's version.
   */
  version: string | null;
  claimed: boolean;
  sessionOpen: boolean;
  /** The bound register's id, when telemetry reports one. */
  deviceId: string | null;
  /** Per-device heartbeat — null until registers report one. */
  lastSeenAt: string | null;
  /** The store-level heartbeat: the honest fallback while the above is null. */
  lastHeartbeatAt: string | null;
  status: DeviceStatus;
  configState: ConfigState;
  /** Raw store health, not the derived health state — devices don't license. */
  healthStatus: 'up' | 'down' | 'unknown';
}

const posStatus = (
  claimed: boolean,
  lastSeenAt: string | null | undefined,
  storeHealth: 'up' | 'down' | 'unknown',
): DeviceStatus => {
  if (!claimed) return 'unclaimed';
  if (storeHealth === 'down') return 'offline';
  if (isFresh(lastSeenAt)) return 'online';
  if (lastSeenAt) return 'offline';
  return 'claimed';
};

export const devicesForStore = (store: StoreRecord, companyName: string | null): DeviceView[] => {
  const telemetry = parseTelemetry(store);
  // The roster (custom names included) is the source of truth for what tills
  // should exist; telemetry only tells us what state each one is in.
  const roster = terminalRoster(store);
  const reported = new Map<number, NonNullable<TelemetrySnapshot['terminals']>[number]>();
  for (const t of telemetry?.terminals ?? []) {
    if (typeof t.till === 'number') reported.set(t.till, t);
  }

  return roster.map((till) => {
    const t = reported.get(till.till);
    const claimed = Boolean(t?.claimed);
    const lastSeenAt = t?.lastSeenAt ?? null;
    return {
      id: `${store.slug}:till-${till.till}`,
      name: till.name,
      type: 'pos' as const,
      till: till.till,
      storeId: store.id,
      storeName: store.name,
      storeSlug: store.slug,
      companyName,
      environment: store.environment,
      vertical: store.vertical,
      version: store.app_version,
      claimed,
      sessionOpen: Boolean(t?.sessionOpen),
      deviceId: t?.deviceId ?? null,
      lastSeenAt,
      lastHeartbeatAt: store.last_heartbeat_at,
      status: posStatus(claimed, lastSeenAt, store.last_health_status),
      configState: configStateFor(store),
      healthStatus: store.last_health_status,
    };
  });
};

const panelStatus = (panel: PanelRecord): DeviceStatus => {
  if (panel.last_health_status === 'up') return 'online';
  if (panel.last_health_status === 'down') return 'offline';
  return 'unknown';
};

export const panelToDevice = (panel: PanelRecord, companyName: string | null): DeviceView => ({
  id: `panel:${panel.slug}`,
  name: panel.name,
  type: 'office',
  till: null,
  storeId: null,
  storeName: panel.name,
  storeSlug: panel.slug,
  companyName,
  // The Head Office table has no environment column, and an office device has
  // no till state — everything device-shaped here is deliberately false/empty.
  environment: null,
  vertical: null,
  version: panel.app_version,
  claimed: true,
  sessionOpen: false,
  deviceId: null,
  lastSeenAt: panel.last_health_at,
  lastHeartbeatAt: panel.last_health_at,
  status: panelStatus(panel),
  configState: 'unknown',
  healthStatus: panel.last_health_status,
});

/**
 * The whole fleet's devices: every configured till of every store (including
 * the ones no register has claimed) plus one device per Head Office panel.
 * Company names are resolved by the caller so this needs no extra query.
 */
export const listFleetDevices = (companyNames: Map<number, string>): DeviceView[] => {
  const stores = listStores().flatMap((s) =>
    devicesForStore(s, s.company_id ? (companyNames.get(s.company_id) ?? null) : null),
  );
  const panels = listPanels().map((p) => panelToDevice(p, companyNames.get(p.company_id) ?? null));
  return [...stores, ...panels].sort(
    (a, b) =>
      a.storeName.localeCompare(b.storeName) ||
      a.type.localeCompare(b.type) ||
      // Tills read in roster order (Till 1, Till 2…) even when they are renamed
      // — sorting by name would put "Bakery" before "Front counter".
      (a.till ?? 0) - (b.till ?? 0) ||
      a.name.localeCompare(b.name),
  );
};
