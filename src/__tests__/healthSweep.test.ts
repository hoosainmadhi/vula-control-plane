import {
  createCompany,
  createPanel,
  createStore,
  getPanelById,
  getStoreById,
  getRegistryDb,
  resetRegistryDb,
  setStoreCompany,
} from '../config/registryDb.js';
import { runHealthSweep } from '../services/healthSweep.js';
import { jsonResponse } from './helpers.js';

/**
 * The sweep is the recovery mechanism for licence delivery: the production
 * review (2026-09-23) found a paid-up store could drift into offline expiry
 * because nothing re-issued a licence after the first push, and a failed
 * delivery was never retried. The sweep now delivers when the last push failed
 * or when the licence is past half its offline window — and leaves everything
 * else alone, because a licence must not be re-signed every ten minutes for no
 * reason.
 */

const app = undefined as never; // the sweep is exercised as a service, not over HTTP
void app;

const TOKEN = 'd'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

let fetchMock: jest.SpyInstance;
let licenceCalls: string[];

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY).toISOString().slice(0, 19).replace('T', ' ');

beforeEach(() => {
  resetRegistryDb();
  licenceCalls = [];
  fetchMock = jest.spyOn(globalThis, 'fetch');
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('down-store')) throw new TypeError('fetch failed');
    if (u.endsWith('/api/internal/status')) {
      return jsonResponse(200, { ok: true, subscription: { sequence: 1 } });
    }
    if (u.endsWith('/api/internal/telemetry')) {
      return jsonResponse(200, {
        ok: true,
        app: 'vula',
        version: '1.0.0',
        environment: 'development',
        schemaVersion: null,
        generatedAt: new Date().toISOString(),
        sync: { lastSyncAt: null, pendingEvents: null, failedEvents: null },
        terminals: [],
      });
    }
    if (u.endsWith('/api/internal/licence')) {
      licenceCalls.push(u);
      return jsonResponse(200, { ok: true });
    }
    if (u.endsWith('/health')) return jsonResponse(200, { status: 'ok', version: '1.0.0' });
    throw new TypeError(`fetch failed: ${u}`);
  });
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const setLicenceState = (
  table: 'stores' | 'panels',
  id: number,
  pushStatus: 'ok' | 'failed' | 'pending',
  issuedAt: string | null,
): void => {
  getRegistryDb()
    .prepare(`UPDATE ${table} SET licence_push_status = ?, licence_issued_at = ? WHERE id = ?`)
    .run(pushStatus, issuedAt, id);
};

const makeStore = (slug: string): number => {
  const company = createCompany({ name: 'Sweep Client', slug: `sweep-${slug}` });
  const store = createStore(
    {
      name: `Sweep ${slug}`,
      slug: `sweep-${slug}`,
      terminalCount: 2,
      baseUrl: `http://${slug}.localhost:3245`,
    },
    TOKEN,
  );
  setStoreCompany(store.id, company.id);
  return store.id;
};

describe('the sweep as licence recovery', () => {
  it('re-delivers a licence whose last push failed', async () => {
    const id = makeStore('retry-me');
    setLicenceState('stores', id, 'failed', isoDaysAgo(1));

    const summary = await runHealthSweep();

    expect(summary.licencesRefreshed).toBe(1);
    expect(summary.licenceFailures).toBe(0);
    expect(licenceCalls).toHaveLength(1);
    expect(getStoreById(id)!.licence_push_status).toBe('ok');
  });

  it('leaves a store whose licence is fresh and delivered', async () => {
    const id = makeStore('fresh');
    setLicenceState('stores', id, 'ok', isoDaysAgo(1));

    const summary = await runHealthSweep();

    expect(summary.licencesRefreshed).toBe(0);
    expect(licenceCalls).toHaveLength(0);
  });

  it('refreshes a licence past half its offline window, before it can expire', async () => {
    // maxOfflineUntil is stamped at signing: 8 of 14 days spent means less than
    // half the window remains, which is the refresh point.
    const id = makeStore('stale');
    setLicenceState('stores', id, 'ok', isoDaysAgo(8));

    const summary = await runHealthSweep();

    expect(summary.licencesRefreshed).toBe(1);
    expect(licenceCalls).toHaveLength(1);
    expect(getStoreById(id)!.licence_push_status).toBe('ok');
  });

  it('never pushes a licence to a store that did not answer', async () => {
    const id = makeStore('down-store');
    setLicenceState('stores', id, 'failed', null);

    const summary = await runHealthSweep();

    expect(summary.downCount).toBe(1);
    expect(summary.licencesRefreshed).toBe(0);
    expect(licenceCalls).toHaveLength(0);
    expect(getStoreById(id)!.last_health_status).toBe('down');
  });

  it('recovers a Head Office panel the same way', async () => {
    const company = createCompany({ name: 'Sweep HO Client', slug: 'sweep-ho' });
    const panel = createPanel({
      companyId: company.id,
      slug: 'sweep-ho-panel',
      name: 'Sweep Head Office',
      baseUrl: 'http://sweep-ho.localhost:3260',
      controlPlaneToken: TOKEN,
    });
    setLicenceState('panels', panel.id, 'failed', null);

    const summary = await runHealthSweep();

    expect(summary.licencesRefreshed).toBe(1);
    expect(licenceCalls).toHaveLength(1);
    expect(getPanelById(panel.id)!.licence_push_status).toBe('ok');
  });
});
