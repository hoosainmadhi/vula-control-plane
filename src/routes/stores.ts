import { Router } from 'express';
import crypto from 'crypto';
import type {
  ConfigStatus,
  HealthStatus,
  StoreRecord,
  StoreVertical,
} from '../config/registryDb.js';
import {
  STORE_VERTICALS,
  createStore,
  deleteStore,
  getStoreById,
  getStoreBySlug,
  getCompanyById,
  listStores,
  nextLicenceSequence,
  setStoreCompany,
  recordConfigResult,
  recordHealthResult,
  recordLicencePush,
  setStoreStatus,
  updateStore,
} from '../config/registryDb.js';
import {
  resetAdmin,
  pushTerminals,
  pushLicence,
  ping,
  probeAppKind,
  StoreClientError,
} from '../services/storeClient.js';
import { issueLicence, isEphemeralKey, licenceKeyId, licencePublicKey } from '../services/licenceSigner.js';
import {
  canAddStore,
  canUseTerminals,
  entitlementsFor,
  type Entitlements,
} from '../services/subscriptions.js';
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
  vertical: StoreVertical;
  terminalCount: number;
  baseUrl: string;
  status: StoreRecord['status'];
  lastConfigStatus: ConfigStatus;
  lastConfigAt: string | null;
  lastHealthAt: string | null;
  lastHealthStatus: HealthStatus;
  licenceSequence: number;
  licenceIssuedAt: string | null;
  licencePushStatus: ConfigStatus;
  licencePushedAt: string | null;
  companyId: number | null;
  companyName: string;
  planCode: string;
  planName: string;
  billingState: Entitlements['billingState'];
  /** '' when nothing needs the operator's attention. */
  entitlementNote: string;
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

/** Entitlements for a store, resolved from its owning company (or unassigned). */
const entitlementsForStore = (store: StoreRecord): Entitlements =>
  entitlementsFor(store.company_id ? getCompanyById(store.company_id) : null);

const storeToOut = (store: StoreRecord): StoreOut => ({
  id: store.id,
  slug: store.slug,
  name: store.name,
  vatRegNo: store.vat_reg_no,
  vertical: store.vertical,
  terminalCount: store.terminal_count,
  baseUrl: store.base_url,
  status: store.status,
  lastConfigStatus: store.last_config_status,
  lastConfigAt: store.last_config_at,
  lastHealthAt: store.last_health_at,
  lastHealthStatus: store.last_health_status,
  licenceSequence: store.licence_sequence,
  licenceIssuedAt: store.licence_issued_at,
  licencePushStatus: store.licence_push_status,
  licencePushedAt: store.licence_pushed_at,
  ...(() => {
    const ent = entitlementsForStore(store);
    return {
      companyId: ent.companyId,
      companyName: ent.companyName,
      planCode: ent.planCode,
      planName: ent.planName,
      billingState: ent.billingState,
      entitlementNote: ent.note,
    };
  })(),
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

/** Parses an optional vertical (absent = keep the current one / default on create). */
const optionalVertical = (body: Record<string, unknown>): StoreVertical | undefined => {
  const raw = body['vertical'];
  if (raw === undefined) return undefined;
  const value = String(raw);
  if (!(STORE_VERTICALS as readonly string[]).includes(value)) {
    throw new ValidationError(`vertical must be one of: ${STORE_VERTICALS.join(', ')}`);
  }
  return value as StoreVertical;
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

/**
 * Signs a fresh licence for the store and delivers it. The store verifies the
 * signature, so a failure here records the failure and leaves the store on its
 * previous (still valid) licence rather than losing entitlement.
 */
const attemptLicencePush = async (
  store: StoreRecord,
): Promise<{ ok: boolean; licencePushStatus: ConfigStatus; error?: string; sequence?: number }> => {
  try {
    const sequence = nextLicenceSequence(store.id);
    const ent = entitlementsForStore(store);
    const signed = issueLicence({
      sequence,
      storeSlug: store.slug,
      storeName: store.name,
      companyId: ent.companyId,
      companyName: ent.companyName,
      planCode: ent.planCode,
      planName: ent.planName,
      features: ent.features,
      maxStores: ent.maxStores,
      maxTerminalsPerStore: ent.maxTerminalsPerStore,
      paidThrough: ent.paidThrough,
      billingState: ent.billingState,
    });
    await pushLicence(store, signed.token);
    recordLicencePush(store.id, 'ok');
    return { ok: true, licencePushStatus: 'ok', sequence };
  } catch (err) {
    recordLicencePush(store.id, 'failed');
    if (!(err instanceof StoreClientError)) {
      logger.error(`Licence push to store ${store.id} failed unexpectedly: ${String(err)}`);
    }
    return {
      ok: false,
      licencePushStatus: 'failed',
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
    const vertical = optionalVertical(req.body);
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
    let generatedToken: string | null = null;
    if (supplied === undefined || supplied === null) {
      controlPlaneToken = crypto.randomBytes(32).toString('hex');
      // Shown once, in this response only: without it the operator cannot put the
      // value into the deployment's env, and every push would fail on a token
      // mismatch they had no way to resolve.
      generatedToken = controlPlaneToken;
    } else if (supplied.length === 64 && /^[0-9a-f]+$/.test(supplied)) {
      controlPlaneToken = supplied;
    } else {
      throw new ValidationError(
        'controlPlaneToken must be 64 lowercase hex characters when supplied',
      );
    }
    // A store row must point at a store. Pointing it at a Head Office can never
    // authenticate, so refuse while the URL is reachable and identifies as one.
    const probe = await probeAppKind(baseUrl);
    if (probe.reachable && probe.kind === 'head-office') {
      res.status(409).json({
        error: `${baseUrl} is a Head Office deployment, not a store. Register it on the Head Offices page instead.`,
        code: 'wrong_app_kind',
      });
      return;
    }

    // One deployment, one registry row. Two rows on the same URL would each push
    // config and licences at it, and each would count a till separately.
    const normalised = baseUrl.replace(/\/+$/, '');
    const clash = listStores().find((s) => s.base_url.replace(/\/+$/, '') === normalised);
    if (clash) {
      res.status(409).json({
        error: `That URL is already registered as "${clash.slug}" (${clash.name}). One deployment has one registry row — edit that store, or deploy a separate store for a new branch.`,
        code: 'base_url_in_use',
        existing: { id: clash.id, slug: clash.slug, name: clash.name },
      });
      return;
    }
    // Cap checks run before anything is written: an over-cap attempt must fail
    // loudly with an upgrade path, never quietly succeed and be billed later.
    const companyIdRaw = req.body?.['companyId'];
    let companyId: number | null = null;
    if (companyIdRaw !== undefined && companyIdRaw !== null) {
      const parsed = Number(companyIdRaw);
      const company = Number.isInteger(parsed) && parsed > 0 ? getCompanyById(parsed) : null;
      if (!company) throw new ValidationError('companyId does not match a known company');
      const addOk = canAddStore(company);
      if (!addOk.ok) {
        res.status(402).json({ error: addOk.reason, code: 'store_cap_reached' });
        return;
      }
      const termOk = canUseTerminals(company, terminalCount);
      if (!termOk.ok) {
        res.status(402).json({ error: termOk.reason, code: 'terminal_cap_exceeded' });
        return;
      }
      companyId = company.id;
    }

    const store = createStore(
      { name, slug, vatRegNo, vertical, terminalCount, baseUrl },
      controlPlaneToken,
    );
    if (companyId !== null) setStoreCompany(store.id, companyId);
    // Attempt the first push right away; a failed attempt never fails creation.
    const firstPush = await attemptPush(store);
    const firstLicence = await attemptLicencePush(getStoreById(store.id)!);
    const updated = getStoreById(store.id)!;
    res.status(201).json({
      store: storeToOut(updated),
      firstPush,
      firstLicence,
      // Present only when we generated one. Never returned by list or detail.
      ...(generatedToken ? { generatedControlPlaneToken: generatedToken } : {}),
    });
  }),
);

/**
 * The control-plane verification key. Operators copy this into each store's
 * LEASE_PUBLIC_KEY env. Public by design — it can only verify, never mint.
 */
storesRouter.get(
  '/licence/key',
  asyncHandler(async (_req, res) => {
    res.json({
      keyId: licenceKeyId(),
      algorithm: 'ES256',
      publicKey: licencePublicKey(),
      ephemeral: isEphemeralKey(),
    });
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
      vertical?: StoreVertical;
      terminalCount?: number;
      baseUrl?: string;
    } = {};
    const body = req.body as Record<string, unknown>;
    if (body['name'] !== undefined) input.name = requireString(body, 'name');
    if (body['vatRegNo'] !== undefined)
      input.vatRegNo = optionalString(body, 'vatRegNo', 20) ?? null;
    if (body['vertical'] !== undefined) input.vertical = optionalVertical(body);
    if (body['terminalCount'] !== undefined) input.terminalCount = requireTerminalCount(body);
    if (body['baseUrl'] !== undefined) input.baseUrl = requireBaseUrl(body);

    // Reassign the store to another merchant, or clear the link with null.
    if (body['companyId'] !== undefined) {
      if (body['companyId'] === null) {
        setStoreCompany(store.id, null);
      } else {
        const parsed = Number(body['companyId']);
        const company = Number.isInteger(parsed) && parsed > 0 ? getCompanyById(parsed) : null;
        if (!company) throw new ValidationError('companyId does not match a known company');
        setStoreCompany(store.id, company.id);
      }
    }
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
    // A push could raise the till count past the plan's per-store ceiling.
    const termOk = canUseTerminals(
      store.company_id ? getCompanyById(store.company_id) : null,
      store.terminal_count,
    );
    if (!termOk.ok) {
      res.status(402).json({ error: termOk.reason, code: 'terminal_cap_exceeded' });
      return;
    }
    res.json(await attemptPush(store));
  }),
);

/**
 * Re-issues and delivers a licence. Used when a plan, payment or terminal count
 * changes, and available to the operator as a manual repair action.
 */
storesRouter.post(
  '/:id/licence',
  asyncHandler(async (req, res) => {
    const store = requireStore(parseIdParam(req.params.id));
    const outcome = await attemptLicencePush(store);
    const updated = getStoreById(store.id)!;
    if (!outcome.ok) {
      res.status(502).json({ ok: false, store: storeToOut(updated), error: outcome.error });
      return;
    }
    res.json({ ok: true, sequence: outcome.sequence, store: storeToOut(updated) });
  }),
);

/**
 * Store teardown, pause-first. An active store must be paused before it can be
 * removed, so a live trading site cannot be dropped from the fleet in one click.
 *
 * This deletes the registry row only. The deployment itself keeps running and keeps
 * its data; the control plane simply stops managing it. Re-adding it later works,
 * provided the token still matches.
 */
storesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);

    if (store.status === 'active') {
      res.status(409).json({
        error: `${store.slug} is active. Pause it first, then remove it — that keeps a live till from disappearing from the fleet in a single click.`,
        code: 'store_active',
      });
      return;
    }

    deleteStore(store.id);
    logger.info(`store removed from the registry: ${store.slug} (id ${store.id})`);
    res.json({
      ok: true,
      message: `${store.name} removed from the control plane. Its deployment and data are untouched.`,
    });
  }),
);

storesRouter.post(
  '/:id/health',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    try {
      const detail = await ping(store);
      const updated = recordHealthResult(store.id, 'up');
      // A reachable store is a chance to keep entitlement fresh — the plan calls
      // for the licence to ride along with health checks.
      await attemptLicencePush(getStoreById(store.id)!);
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
