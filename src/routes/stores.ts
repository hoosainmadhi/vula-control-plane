import { Router } from 'express';
import crypto from 'crypto';
import type { ConfigStatus, HealthStatus, StoreRecord } from '../config/registryDb.js';
import {
  createStore,
  getStoreById,
  getStoreBySlug,
  listStores,
  recordConfigResult,
  recordHealthResult,
  setStoreStatus,
  updateStore,
} from '../config/registryDb.js';
import { resetAdmin, pushTerminals, ping, StoreClientError } from '../services/storeClient.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  ValidationError,
  optionalString,
  parseIdParam,
  requireBaseUrl,
  requireSlug,
  requireString,
  requireTerminalCount,
} from '../utils/validate.js';

export const storesRouter = Router();
storesRouter.use(requireOffice);

// --- Wire types (mirrored in frontend/src/types.ts) ---

export interface StoreOut {
  id: number;
  slug: string;
  name: string;
  vatRegNo: string | null;
  terminalCount: number;
  baseUrl: string;
  status: StoreRecord['status'];
  lastConfigStatus: ConfigStatus;
  lastConfigAt: string | null;
  lastHealthAt: string | null;
  lastHealthStatus: HealthStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalPreview {
  till: number;
  name: string;
  /** True when the last successful push covered this terminal. */
  configured: boolean;
}

export interface StoreDetail extends StoreOut {
  lastConfigSnapshot: unknown;
  terminals: TerminalPreview[];
}

export interface PushOutcome {
  ok: boolean;
  lastConfigStatus: 'ok' | 'failed';
  pushedAt: string | null;
  snapshot?: unknown;
  error?: string;
}

export interface HealthOutcome {
  ok: boolean;
  healthStatus: 'up' | 'down';
  checkedAt: string | null;
  detail?: unknown;
  error?: string;
}

const storeToOut = (store: StoreRecord): StoreOut => ({
  id: store.id,
  slug: store.slug,
  name: store.name,
  vatRegNo: store.vat_reg_no,
  terminalCount: store.terminal_count,
  baseUrl: store.base_url,
  status: store.status,
  lastConfigStatus: store.last_config_status,
  lastConfigAt: store.last_config_at,
  lastHealthAt: store.last_health_at,
  lastHealthStatus: store.last_health_status,
  createdAt: store.created_at,
  updatedAt: store.updated_at,
});

const parseSnapshot = (store: StoreRecord): unknown => {
  if (!store.last_config_snapshot_json) return null;
  try {
    return JSON.parse(store.last_config_snapshot_json);
  } catch {
    return null;
  }
};

/** Terminals covered by the last successful push (snapshot applied count). */
const snapshotTerminalCount = (store: StoreRecord): number => {
  const snapshot = parseSnapshot(store) as { applied?: { terminalCount?: unknown } } | null;
  const count = snapshot?.applied?.terminalCount;
  return typeof count === 'number' && Number.isInteger(count) && count >= 1 ? count : 0;
};

const terminalsFor = (store: StoreRecord): TerminalPreview[] => {
  const applied = store.last_config_status === 'ok' ? snapshotTerminalCount(store) : 0;
  return Array.from({ length: store.terminal_count }, (_, i) => ({
    till: i + 1,
    name: `Till ${i + 1}`,
    configured: i < applied,
  }));
};

const requireStore = (id: number): StoreRecord => {
  const store = getStoreById(id);
  if (!store) {
    throw new HttpError(404, 'Store not found');
  }
  return store;
};

/** Parses and validates the :id param, loading the store or 404ing. */
const storeFromParams = (raw: string): StoreRecord => requireStore(parseIdParam(raw));

/** Attempts a terminal push and records ok/failed in the registry. Never throws. */
const attemptPush = async (store: StoreRecord): Promise<PushOutcome> => {
  try {
    const body = await pushTerminals(store);
    const updated = recordConfigResult(store.id, { status: 'ok', snapshot: body });
    return {
      ok: true,
      lastConfigStatus: 'ok',
      pushedAt: updated?.last_config_at ?? null,
      snapshot: body,
    };
  } catch (err) {
    recordConfigResult(store.id, { status: 'failed' });
    if (!(err instanceof StoreClientError))
      logger.error(`Push to store ${store.id} failed unexpectedly: ${String(err)}`);
    return {
      ok: false,
      lastConfigStatus: 'failed',
      pushedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// --- Routes ---

storesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listStores().map(storeToOut));
  }),
);

storesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body, 'name');
    const slug = requireSlug(req.body);
    const vatRegNo = optionalString(req.body, 'vatRegNo', 20) ?? null;
    const terminalCount = requireTerminalCount(req.body);
    const baseUrl = requireBaseUrl(req.body);
    if (getStoreBySlug(slug)) {
      res.status(409).json({ error: `A store with slug "${slug}" already exists` });
      return;
    }
    // The operator may supply the token their store env already holds (64 hex
    // chars); otherwise one is generated. The token never leaves the server.
    const supplied = optionalString(req.body, 'controlPlaneToken', 64);
    let controlPlaneToken: string;
    if (supplied === undefined || supplied === null) {
      controlPlaneToken = crypto.randomBytes(32).toString('hex');
    } else if (supplied.length === 64 && /^[0-9a-f]+$/.test(supplied)) {
      controlPlaneToken = supplied;
    } else {
      throw new ValidationError(
        'controlPlaneToken must be 64 lowercase hex characters when supplied',
      );
    }
    const store = createStore({ name, slug, vatRegNo, terminalCount, baseUrl }, controlPlaneToken);
    // Attempt the first push right away; a failed attempt never fails creation.
    const firstPush = await attemptPush(store);
    const updated = getStoreById(store.id)!;
    res.status(201).json({ store: storeToOut(updated), firstPush });
  }),
);

storesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    const detail: StoreDetail = {
      ...storeToOut(store),
      lastConfigSnapshot: parseSnapshot(store),
      terminals: terminalsFor(store),
    };
    res.json(detail);
  }),
);

storesRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    const input: {
      name?: string;
      vatRegNo?: string | null;
      terminalCount?: number;
      baseUrl?: string;
    } = {};
    const body = req.body as Record<string, unknown>;
    if (body['name'] !== undefined) input.name = requireString(body, 'name');
    if (body['vatRegNo'] !== undefined)
      input.vatRegNo = optionalString(body, 'vatRegNo', 20) ?? null;
    if (body['terminalCount'] !== undefined) input.terminalCount = requireTerminalCount(body);
    if (body['baseUrl'] !== undefined) input.baseUrl = requireBaseUrl(body);
    const updated = updateStore(store.id, input) ?? store;
    res.json(storeToOut(updated));
  }),
);

storesRouter.patch(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    res.json(storeToOut(setStoreStatus(store.id, 'paused')!));
  }),
);

storesRouter.patch(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    res.json(storeToOut(setStoreStatus(store.id, 'active')!));
  }),
);

storesRouter.post(
  '/:id/push',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    if (store.status === 'paused') {
      res.status(409).json({ error: 'Store is paused — resume before pushing terminals' });
      return;
    }
    res.json(await attemptPush(store));
  }),
);

storesRouter.post(
  '/:id/health',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    try {
      const detail = await ping(store);
      const updated = recordHealthResult(store.id, 'up');
      const outcome: HealthOutcome = {
        ok: true,
        healthStatus: 'up',
        checkedAt: updated?.last_health_at ?? null,
        detail,
      };
      res.json(outcome);
    } catch (err) {
      const updated = recordHealthResult(store.id, 'down');
      const outcome: HealthOutcome = {
        ok: false,
        healthStatus: 'down',
        checkedAt: updated?.last_health_at ?? null,
        error: err instanceof Error ? err.message : String(err),
      };
      res.json(outcome);
    }
  }),
);

storesRouter.post(
  '/:id/reset-admin',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    if (store.status === 'paused') {
      res
        .status(409)
        .json({ error: 'Store is paused — resume before resetting the admin password' });
      return;
    }
    const { tempPassword } = await resetAdmin(store); // StoreClientError → 502 via error handler
    res.json({ ok: true, tempPassword, note: 'Shown once — the control plane does not store it.' });
  }),
);
