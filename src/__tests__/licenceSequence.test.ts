import request from 'supertest';
import { createApp } from '../app.js';
import {
  createCompany,
  createPanel,
  createStore,
  getCompanyById,
  getPanelById,
  getRegistryDb,
  getStoreById,
  listAuditLogs,
  resetRegistryDb,
  setStoreCompany,
} from '../config/registryDb.js';
import { reportedLicenceSequence } from '../services/storeClient.js';
import { pushLicencesForCompany } from '../services/billing.js';
import { authHeader, jsonResponse, loginAsOffice } from './helpers.js';

/**
 * The licence sequence is a mirror, not a counter.
 *
 * A deployment refuses any licence whose `sequence` is below the one it already
 * holds. The control plane's own number lives in the registry, which can be
 * rebuilt, restored from an older backup or re-seeded — every path that resets it
 * to 0 while the deployments keep counting. When that happens the CP can never
 * catch up on its own: each push increments by one, is refused, and the licence
 * stays stale for ever. The repair is to ask the deployment what it holds before
 * issuing (`GET /api/internal/status` reports it: `subscription.sequence` for a
 * store, `licence.sequence` for a Head Office).
 *
 * These tests reproduce the live failure — Urban Threads' Head Office held 10
 * while the registry held 6 — and pin both the repair and the cases where the
 * number must NOT be touched.
 */

const app = createApp();
const TOKEN = 'b'.repeat(64);

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

type StatusMode = 'reports' | 'unreachable' | 'unauthorized' | 'bare';

interface TenantState {
  /** The sequence the deployment holds — the authority the CP has to respect. */
  held: number;
  /** Every sequence this deployment accepted, in order. */
  accepted: number[];
}

/**
 * A tenant that behaves like the real thing: it reports the licence it holds, and
 * it refuses an older one with the store's own wording and a 409.
 */
const installTenant = (opts: {
  held: number;
  /** Which block the status payload reports the sequence under. */
  field: 'subscription' | 'licence';
  status?: StatusMode;
}): TenantState => {
  const mode = opts.status ?? 'reports';
  const state: TenantState = { held: opts.held, accepted: [] };

  fetchMock.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;

    if (path.endsWith('/api/internal/status')) {
      if (mode === 'unreachable') throw new TypeError('fetch failed');
      if (mode === 'unauthorized')
        return jsonResponse(401, { error: 'Invalid control plane token' });
      if (mode === 'bare') return jsonResponse(200, { ok: true, storeName: 'Older build' });
      return jsonResponse(200, {
        ok: true,
        [opts.field]: { sequence: state.held },
      });
    }

    if (path.endsWith('/api/internal/licence')) {
      const token = (JSON.parse((init as FetchInit).body as string) as { token: string }).token;
      const payload = token.split('.')[0] ?? '';
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        sequence: number;
      };
      if (claims.sequence < state.held) {
        return jsonResponse(409, {
          error: `Licence sequence ${claims.sequence} is older than the stored ${state.held}`,
        });
      }
      state.held = claims.sequence;
      state.accepted.push(claims.sequence);
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(200, { ok: true });
  });

  return state;
};

let fetchMock: jest.SpyInstance;
let token = '';

beforeAll(async () => {
  token = await loginAsOffice(app);
});

beforeEach(() => {
  resetRegistryDb();
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock?.mockRestore();
});

const auth = (): Record<string, string> => authHeader(token);

/**
 * The fleet as it was when the owner hit this: client 1 with its own Head Office
 * and a store, both deployments holding a licence the registry has lost track of.
 */
const seedClient = () => {
  const company = createCompany({ name: 'Urban Threads Retail Group', slug: 'urban-threads' });
  const created = createStore(
    {
      name: 'Urban Threads CPT',
      slug: 'urban-threads-cpt',
      terminalCount: 2,
      baseUrl: 'http://urban-threads-cpt.localhost:3252',
    },
    TOKEN,
  );
  // A store belongs to its client: without the assignment the client has no fleet,
  // which is what a company-wide re-push reads.
  const store = setStoreCompany(created.id, company.id)!;
  const panel = createPanel({
    companyId: company.id,
    slug: 'urban-threads-ho',
    name: 'Urban Threads Head Office',
    baseUrl: 'http://urban-threads-ho.localhost:3260',
    controlPlaneToken: TOKEN,
  });
  return { company, store, panel };
};

/** Write the counter straight into the registry — a rebuilt/restored database. */
const setCounter = (table: 'stores' | 'panels', id: number, sequence: number): void => {
  getRegistryDb()
    .prepare(`UPDATE ${table} SET licence_sequence = ? WHERE id = ?`)
    .run(sequence, id);
};

const pushStoreLicence = (id: number) => request(app).post(`/api/stores/${id}/licence`).set(auth());

const pushPanelLicence = (id: number) => request(app).post(`/api/panels/${id}/licence`).set(auth());

/** Decode a signed licence's claims without verifying it. */
const claimsOf = (licenceToken: string): { sequence: number; maxTerminals?: number } => {
  const payload = licenceToken.split('.')[0] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sequence: number;
    maxTerminals?: number;
  };
};

describe('licence sequence — a deployment that is ahead of us', () => {
  it('catches up to a store instead of issuing a stale licence for ever', async () => {
    const { store } = seedClient();
    setCounter('stores', store.id, 5);
    const tenant = installTenant({ held: 10, field: 'subscription' });

    const res = await pushStoreLicence(store.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sequence: 11,
      reconciled: { from: 5, to: 10, reported: 10 },
    });
    // The deployment accepted it, and the registry now remembers where it really is.
    expect(tenant.accepted).toEqual([11]);
    expect(getStoreById(store.id)!.licence_sequence).toBe(11);
    expect(getStoreById(store.id)!.licence_push_status).toBe('ok');
  });

  it('catches up to a Head Office, reading licence.sequence rather than subscription.sequence', async () => {
    const { panel } = seedClient();
    setCounter('panels', panel.id, 6);
    const tenant = installTenant({ held: 10, field: 'licence' });

    const res = await pushPanelLicence(panel.id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sequence: 11,
      reconciled: { from: 6, to: 10, reported: 10 },
    });
    expect(tenant.accepted).toEqual([11]);
    expect(getPanelById(panel.id)!.licence_sequence).toBe(11);
  });

  it('records the repair in the audit trail, attributing it to the control plane', async () => {
    const { panel } = seedClient();
    setCounter('panels', panel.id, 6);
    installTenant({ held: 10, field: 'licence' });

    await pushPanelLicence(panel.id);

    const row = listAuditLogs(50).find((r) => r.action === 'licence_sequence_reconciled');
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      actor: 'control-plane',
      target_type: 'panel',
      target_id: panel.id,
    });
    // The audit row has to say what moved, or it cannot answer "why did this jump?".
    expect(JSON.parse(row!.before_json ?? '{}')).toEqual({ sequence: 6 });
    expect(JSON.parse(row!.after_json ?? '{}')).toEqual({ sequence: 10 });
  });
});

describe('licence sequence — numbers that must not move', () => {
  it('never lowers the counter when the deployment is behind us', async () => {
    const { store } = seedClient();
    setCounter('stores', store.id, 5);
    const tenant = installTenant({ held: 2, field: 'subscription' });

    const res = await pushStoreLicence(store.id);

    expect(res.status).toBe(200);
    expect(res.body.sequence).toBe(6);
    expect(res.body.reconciled).toBeUndefined();
    expect(getStoreById(store.id)!.licence_sequence).toBe(6);
    expect(tenant.accepted).toEqual([6]);
  });

  it('treats a deployment holding no licence at all as no floor', async () => {
    // A Head Office with no licence reports sequence 0. Reading that as a target
    // would be harmless here and wrong in principle: 0 means "nothing installed".
    const { panel } = seedClient();
    setCounter('panels', panel.id, 5);
    const tenant = installTenant({ held: 0, field: 'licence' });

    const res = await pushPanelLicence(panel.id);

    expect(res.body.sequence).toBe(6);
    expect(res.body.reconciled).toBeUndefined();
    expect(getPanelById(panel.id)!.licence_sequence).toBe(6);
    expect(tenant.accepted).toEqual([6]);
  });

  it('pushes as before when the deployment reports no sequence (an older build)', async () => {
    // The deployment holds nothing the CP can learn (it does not report a
    // sequence), so the push carries on from our own counter exactly as before.
    const { store } = seedClient();
    setCounter('stores', store.id, 5);
    const tenant = installTenant({ held: 0, field: 'subscription', status: 'bare' });

    const res = await pushStoreLicence(store.id);

    expect(res.status).toBe(200);
    expect(res.body.sequence).toBe(6);
    expect(res.body.reconciled).toBeUndefined();
    expect(tenant.accepted).toEqual([6]);
  });

  it('pushes as before when the status call fails', async () => {
    const { store } = seedClient();
    setCounter('stores', store.id, 5);
    const tenant = installTenant({ held: 0, field: 'subscription', status: 'unreachable' });

    const res = await pushStoreLicence(store.id);

    expect(res.status).toBe(200);
    expect(res.body.sequence).toBe(6);
    expect(tenant.accepted).toEqual([6]);
  });

  it('pushes as before when the status call is refused', async () => {
    const { store } = seedClient();
    setCounter('stores', store.id, 5);
    const tenant = installTenant({ held: 0, field: 'subscription', status: 'unauthorized' });

    const res = await pushStoreLicence(store.id);

    expect(res.body.sequence).toBe(6);
    expect(tenant.accepted).toEqual([6]);
  });

  it('still reports the refusal when the deployment cannot be asked', async () => {
    // The honest limit: an unreachable deployment cannot be reconciled, so the
    // stale refusal surfaces with its own wording rather than being papered over.
    const { store } = seedClient();
    setCounter('stores', store.id, 5);
    installTenant({ held: 10, field: 'subscription', status: 'unreachable' });

    const res = await pushStoreLicence(store.id);

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('older than the stored 10');
    expect(getStoreById(store.id)!.licence_push_status).toBe('failed');
  });
});

describe('licence sequence — every path that issues a licence, not just the buttons', () => {
  it('repairs a whole client fleet when a payment or plan change re-pushes it', async () => {
    // Recording a payment re-pushes every store and the Head Office. If the repair
    // lived only in the two Push Licence routes, this path would still issue a
    // stale licence and still report a failure on the same client.
    const { company, store, panel } = seedClient();
    setCounter('stores', store.id, 5);
    setCounter('panels', panel.id, 6);

    // Two deployments, each with its own persisted counter: a single shared one
    // would let the first push mask the second, which is the whole point here.
    const held = new Map<string, number>([
      [new URL(store.base_url).host, 10],
      [new URL(panel.base_url).host, 10],
    ]);
    const accepted: number[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      const { host, pathname } = new URL(String(url));
      const current = held.get(host) ?? 0;
      if (pathname.endsWith('/api/internal/status')) {
        return jsonResponse(200, {
          ok: true,
          subscription: { sequence: current },
          licence: { sequence: current },
        });
      }
      if (pathname.endsWith('/api/internal/licence')) {
        const token = (JSON.parse((init as FetchInit).body as string) as { token: string }).token;
        const claims = claimsOf(token);
        if (claims.sequence < current) {
          return jsonResponse(409, {
            error: `Licence sequence ${claims.sequence} is older than the stored ${current}`,
          });
        }
        held.set(host, claims.sequence);
        accepted.push(claims.sequence);
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { ok: true });
    });

    const summary = await pushLicencesForCompany(company.id);

    expect(summary).toMatchObject({ storesUpdated: 1, panelsUpdated: 1, errors: [] });
    // Each deployment caught up from its own 10, independently of the other.
    expect(accepted).toEqual([11, 11]);
    expect(getStoreById(store.id)!.licence_sequence).toBe(11);
    expect(getPanelById(panel.id)!.licence_sequence).toBe(11);
  });
});

describe('licence claims — the two variants stay distinct', () => {
  it('carries the store own terminal allowance, and no such claim on a Head Office', async () => {
    const { store, panel } = seedClient();
    const seen: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/api/internal/status')) {
        return jsonResponse(200, {
          ok: true,
          subscription: { sequence: 0 },
          licence: { sequence: 0 },
        });
      }
      if (path.endsWith('/api/internal/licence')) {
        seen.push((JSON.parse((init as FetchInit).body as string) as { token: string }).token);
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { ok: true });
    });

    await pushStoreLicence(store.id);
    await pushPanelLicence(panel.id);

    expect(seen).toHaveLength(2);
    // The register gates new device claims on this store's own allowance.
    expect(typeof claimsOf(seen[0]!).maxTerminals).toBe('number');
    // A Head Office has no terminals of its own: the claim is absent, not zero.
    expect(claimsOf(seen[1]!).maxTerminals).toBeUndefined();
  });
});

describe('reportedLicenceSequence', () => {
  it('reads the store and panel shapes', () => {
    expect(reportedLicenceSequence('store', { subscription: { sequence: 10 } })).toBe(10);
    expect(reportedLicenceSequence('panel', { licence: { sequence: 10 } })).toBe(10);
    expect(reportedLicenceSequence('store', { subscription: { sequence: 0 } })).toBe(0);
  });

  it('returns null rather than guessing when the field is absent or unusable', () => {
    expect(reportedLicenceSequence('store', {})).toBeNull();
    expect(reportedLicenceSequence('store', null)).toBeNull();
    expect(reportedLicenceSequence('store', 'nope')).toBeNull();
    expect(reportedLicenceSequence('store', { subscription: null })).toBeNull();
    expect(reportedLicenceSequence('store', { subscription: {} })).toBeNull();
    expect(reportedLicenceSequence('store', { licence: { sequence: 4 } })).toBeNull();
    expect(reportedLicenceSequence('panel', { subscription: { sequence: 4 } })).toBeNull();
    expect(reportedLicenceSequence('store', { subscription: { sequence: '10' } })).toBeNull();
    expect(reportedLicenceSequence('store', { subscription: { sequence: -1 } })).toBeNull();
    expect(reportedLicenceSequence('store', { subscription: { sequence: 1.5 } })).toBeNull();
    expect(reportedLicenceSequence('store', { subscription: { sequence: Number.NaN } })).toBeNull();
  });
});
