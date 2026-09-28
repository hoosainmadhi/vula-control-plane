import {
  listStores,
  recordHealthResult,
  recordTelemetry,
  listPanels,
  recordPanelHealth,
  getRegistryDb,
  recordLicencePush,
  recordPanelLicencePush,
  type StoreRecord,
  type PanelRecord,
} from '../config/registryDb.js';
import { fetchTelemetry, ping } from './storeClient.js';
import { deliverPanelLicence, deliverStoreLicence } from './licenceDelivery.js';
import { env, logger } from '../config/env.js';

export interface HealthSweepSummary {
  storesChecked: number;
  panelsChecked: number;
  upCount: number;
  downCount: number;
  /** Licences re-delivered by this sweep (failed push retried, or nearing offline expiry). */
  licencesRefreshed: number;
  /** Licence deliveries that failed during this sweep; the next sweep retries. */
  licenceFailures: number;
  errors: string[];
}

/**
 * Does this fleet member need its licence (re)delivered?
 *
 * Two cases, both from the production review (2026-09-23): the last delivery
 * failed — CONTEXT has promised "the next sweep retries" since the L4 work while
 * nothing did — and the licence is drifting towards its offline expiry, because
 * `maxOfflineUntil` is stamped when the licence is signed, so a perfectly
 * paid-up store fails offline checks once that date passes. Half the offline
 * window spent is the refresh point, which keeps a delivered licence at most
 * half a window stale without re-issuing every sweep.
 */
const licenceNeedsDelivery = (rec: {
  licence_push_status: string;
  licence_issued_at: string | null;
}): boolean => {
  if (rec.licence_push_status !== 'ok') return true; // failed, or never attempted
  if (!rec.licence_issued_at) return true;
  // datetime('now') writes UTC without a zone marker; say so before parsing.
  const issued = new Date(`${rec.licence_issued_at.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(issued)) return true;
  const windowMs = env.licenceOfflineDays * 24 * 60 * 60 * 1000;
  return Date.now() - issued >= windowMs / 2;
};

/**
 * Scan all active stores and panels, probe responsiveness, and update health/latency (§23).
 */
export async function runHealthSweep(): Promise<HealthSweepSummary> {
  const stores = listStores().filter((s) => s.status === 'active');
  const panels = listPanels().filter((p) => p.status === 'active');

  const summary: HealthSweepSummary = {
    storesChecked: 0,
    panelsChecked: 0,
    upCount: 0,
    downCount: 0,
    licencesRefreshed: 0,
    licenceFailures: 0,
    errors: [],
  };

  // 1. Stores health sweep
  for (const store of stores) {
    summary.storesChecked++;
    const start = Date.now();
    try {
      await ping(store, { timeoutMs: 5000 });
      const latencyMs = Date.now() - start;
      recordHealthResult(store.id, 'up');
      // Telemetry rides the sweep so Version/Sync/Terminal fields stay fresh
      // without operator action.
      try {
        const telemetry = await fetchTelemetry(store, { timeoutMs: 5000 });
        recordTelemetry(store.id, {
          version: telemetry.version,
          schemaVersion: telemetry.schemaVersion ?? null,
          generatedAt: telemetry.generatedAt,
          telemetry,
        });
      } catch {
        // Best-effort only.
      }
      getRegistryDb()
        .prepare('UPDATE stores SET latency_ms = ? WHERE id = ?')
        .run(latencyMs, store.id);
      // Licence delivery rides the sweep: the review found a paid-up store could
      // drift into offline expiry because nothing re-issued after the first
      // push, and a failed delivery was never retried. The delivery reconciles
      // its own sequence; failure is recorded and the next sweep retries.
      if (licenceNeedsDelivery(store)) {
        try {
          await deliverStoreLicence(store);
          recordLicencePush(store.id, 'ok');
          summary.licencesRefreshed++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          recordLicencePush(store.id, 'failed', reason);
          summary.licenceFailures++;
          summary.errors.push(`Store ${store.slug} licence refresh failed: ${reason}`);
        }
      }
      summary.upCount++;
    } catch (err) {
      recordHealthResult(store.id, 'down', err instanceof Error ? err.message : String(err));
      getRegistryDb()
        .prepare('UPDATE stores SET latency_ms = NULL WHERE id = ?')
        .run(store.id);
      summary.downCount++;
      const msg = `Store ${store.slug} health down: ${err instanceof Error ? err.message : String(err)}`;
      summary.errors.push(msg);
    }
  }

  // 2. Panels health sweep
  for (const panel of panels) {
    summary.panelsChecked++;
    try {
      const url = `${panel.base_url.replace(/\/+$/, '')}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { version?: string } | null;
        recordPanelHealth(panel.id, 'up', json?.version ?? null);
        if (licenceNeedsDelivery(panel)) {
          try {
            await deliverPanelLicence(panel);
            recordPanelLicencePush(panel.id, 'ok');
            summary.licencesRefreshed++;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            recordPanelLicencePush(panel.id, 'failed', reason);
            summary.licenceFailures++;
            summary.errors.push(`Panel ${panel.slug} licence refresh failed: ${reason}`);
          }
        }
        summary.upCount++;
      } else {
        recordPanelHealth(panel.id, 'down', null, `Panel /health answered HTTP ${res.status}`);
        summary.downCount++;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      recordPanelHealth(panel.id, 'down', null, reason);
      summary.downCount++;
      summary.errors.push(`Panel ${panel.slug} health down: ${reason}`);
    }
  }

  logger.info(
    `Health sweep complete: ${summary.upCount} up, ${summary.downCount} down across ${summary.storesChecked} stores & ${summary.panelsChecked} panels`,
  );
  return summary;
}
