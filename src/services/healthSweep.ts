import {
  listStores,
  recordHealthResult,
  listPanels,
  recordPanelHealth,
  getRegistryDb,
  type StoreRecord,
  type PanelRecord,
} from '../config/registryDb.js';
import { ping } from './storeClient.js';
import { logger } from '../config/env.js';

export interface HealthSweepSummary {
  storesChecked: number;
  panelsChecked: number;
  upCount: number;
  downCount: number;
  errors: string[];
}

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
      getRegistryDb()
        .prepare('UPDATE stores SET latency_ms = ? WHERE id = ?')
        .run(latencyMs, store.id);
      summary.upCount++;
    } catch (err) {
      recordHealthResult(store.id, 'down');
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
        summary.upCount++;
      } else {
        recordPanelHealth(panel.id, 'down');
        summary.downCount++;
      }
    } catch (err) {
      recordPanelHealth(panel.id, 'down');
      summary.downCount++;
      summary.errors.push(`Panel ${panel.slug} health down: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info(
    `Health sweep complete: ${summary.upCount} up, ${summary.downCount} down across ${summary.storesChecked} stores & ${summary.panelsChecked} panels`,
  );
  return summary;
}
