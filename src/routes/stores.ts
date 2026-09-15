import { Router } from 'express';
import crypto from 'crypto';
import type {
  ConfigStatus,
  HealthStatus,
  StoreRecord,
  StoreEnvironment,
  StoreVertical,
  CompanyRecord,
} from '../config/registryDb.js';
import {
  STORE_ENVIRONMENTS,
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
  recordTelemetry,
  terminalRoster,
  recordLicencePush,
  setStoreStatus,
  updateStore,
} from '../config/registryDb.js';
import {
  resetAdmin,
  pushTerminals,
  pushLicence,
  ping,
  fetchTelemetry,
  probeAppKind,
  StoreClientError,
} from '../services/storeClient.js';
import { runStoreProvisioning } from '../services/storeProvisioning.js';
import { setStoreDeployStatus, listAuditLogs, recordAuditLog } from '../config/registryDb.js';
import { runHealthSweep } from '../services/healthSweep.js';
import { wireStoreToHeadOffice } from '../services/topology.js';
import {
  issueLicence,
  isEphemeralKey,
  licenceKeyId,
  licencePublicKey,
} from '../services/licenceSigner.js';
import {
  canAddStore,
  deriveBillingState,
  entitlementsForStore as entitlementsForStoreService,
  registerEnforcementFor,
  type Entitlements,
  type RegisterEnforcement,
} from '../services/subscriptions.js';
import { configStateFor, healthStateFor, telemetrySummary } from '../services/fleetView.js';
import {
  allocateTerminals,
  checkAllocation,
  checkConfiguredTerminals,
  checkNewStoreAllocation,
  releaseStoreAllocation,
  terminalAllowance,
} from '../services/terminalLicences.js';
import { requireOffice } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  ValidationError,
  optionalInt,
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
  vertical: StoreVertical;
  /** Terminal slots this store is configured to run (pushed as Till 1..N). */
  terminalCount: number;
  /**
   * Terminal licences this store holds on its client's subscription — what its
   * signed licence permits the register to bind devices to. Equals the store's
   * own number; never billing usage (the client's licensed total is).
   */
  licensedTerminalCount: number;
  baseUrl: string;
  status: StoreRecord['status'];
  lastConfigStatus: ConfigStatus;
  lastConfigAt: string | null;
  lastConfigError: string | null;
  lastHealthError: string | null;
  /** Resolved per-till names ("Till N" where unset) — for the edit modal. */
  terminalNames: string[];
  environment: StoreEnvironment;
  /** Operator-facing technical health (SPOG §9/§10) — administrative state is separate. */
  healthState: 'healthy' | 'warning' | 'degraded' | 'offline' | 'unknown';
  /** Versioned configuration state (SPOG §12). */
  configState: 'current' | 'pending' | 'failed' | 'unknown';
  configVersion: { expected: number; applied: number };
  latencyMs: number | null;
  /** Fleet telemetry (SPOG card): version, heartbeat, sync and till state. */
  appVersion: string | null;
  schemaVersion: number | null;
  lastHeartbeatAt: string | null;
  telemetry: {
    version: string | null;
    generatedAt: string | null;
    sync: { lastSyncAt: string | null; pendingEvents: number | null; failedEvents: number | null };
    terminals: { configured: number; claimed: number; open: number; online: number };
  } | null;
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
  /** How the register will present the subscription (mirrors the licence the store holds). */
  registerState: RegisterEnforcement['registerState'];
  /** True when the register refuses new sales for this store's company. */
  tradingBlocked: boolean;
  deployStatus: 'not_deployed' | 'provisioning' | 'deployed' | 'failed';
  coolifyUuid: string | null;
  adminEmail: string | null;
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
const entitlementsForStore = (store: StoreRecord): Entitlements => entitlementsForStoreService(store);

export const storeToOut = (store: StoreRecord): StoreOut => {
  const ent = entitlementsForStore(store);
  const enforcement = registerEnforcementFor(ent);
  return {
  id: store.id,
  slug: store.slug,
  name: store.name,
  vertical: store.vertical,
  terminalCount: store.terminal_count,
  licensedTerminalCount: ent.maxTerminals ?? terminalAllowance(store).count,
  baseUrl: store.base_url,
  status: store.status,
  lastConfigStatus: store.last_config_status,
  lastConfigAt: store.last_config_at,
  lastConfigError: store.last_config_error,
  lastHealthError: store.last_health_error,
  terminalNames: terminalRoster(store).map((t) => t.name),
  environment: store.environment,
  healthState: healthStateFor(store, enforcement.registerState),
  configState: configStateFor(store),
  configVersion: {
    expected: store.desired_config_version ?? 1,
    applied: store.applied_config_version ?? 0,
  },
  latencyMs: store.latency_ms ?? null,
  appVersion: store.app_version,
  schemaVersion: store.schema_version,
  lastHeartbeatAt: store.last_heartbeat_at,
  telemetry: telemetrySummary(store),
  lastHealthAt: store.last_health_at,
  lastHealthStatus: store.last_health_status,
  licenceSequence: store.licence_sequence,
  licenceIssuedAt: store.licence_issued_at,
  licencePushStatus: store.licence_push_status,
  licencePushedAt: store.licence_pushed_at,
  companyId: ent.companyId,
  companyName: ent.companyName,
  planCode: ent.planCode,
  planName: ent.planName,
  billingState: ent.billingState,
  entitlementNote: ent.note,
  ...enforcement,
  deployStatus: store.deploy_status ?? 'not_deployed',
  coolifyUuid: store.coolify_uuid ?? null,
  adminEmail: store.admin_email ?? null,
  createdAt: store.created_at,
  updatedAt: store.updated_at,
  };
};

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
  return terminalRoster(store).map((t, i) => ({
    till: t.till,
    name: t.name,
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

const optionalEnvironment = (body: Record<string, unknown>): StoreEnvironment | undefined => {
  const raw = body['environment'];
  if (raw === undefined) return undefined;
  const value = String(raw);
  if (!(STORE_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new ValidationError(`environment must be one of: ${STORE_ENVIRONMENTS.join(', ')}`);
  }
  return value as StoreEnvironment;
};

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
    recordConfigResult(store.id, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
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
      // This store's own allowance — the register gates new device claims on it.
      maxTerminals: ent.maxTerminals ?? store.terminal_count,
      paidThrough: ent.paidThrough,
      billingState: ent.billingState,
    });
    await pushLicence(store, signed.token);
    recordLicencePush(store.id, 'ok');
    return { ok: true, licencePushStatus: 'ok', sequence };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordLicencePush(store.id, 'failed', message);
    if (!(err instanceof StoreClientError)) {
      logger.error(`Licence push to store ${store.id} failed unexpectedly: ${String(err)}`);
    }
    return {
      ok: false,
      licencePushStatus: 'failed',
      error: message,
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
  '/health-sweep',
  asyncHandler(async (_req, res) => {
    const summary = await runHealthSweep();
    res.json({ ok: true, summary });
  }),
);

storesRouter.get(
  '/audit-logs',
  asyncHandler(async (_req, res) => {
    const logs = listAuditLogs(100);
    res.json({ ok: true, logs });
  }),
);

/** Recent audited actions for ONE store (target_type 'store'), newest first. */
storesRouter.get(
  '/:id/audit',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    const logs = listAuditLogs(200).filter(
      (l) => l.target_type === 'store' && l.target_id === store.id,
    );
    res.json({ ok: true, logs });
  }),
);

storesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body, 'name');
    const slug = requireSlug(req.body);
    const vertical = optionalVertical(req.body);
    const terminalCount = requireTerminalCount(req.body);
    const baseUrl = requireBaseUrl(req.body);
    // Default the store's environment to the control plane's own (SPOG §5).
    const environment =
      optionalEnvironment(req.body) ?? (env.isProduction ? 'production' : 'development');
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
    /** When the store joins a client, the licences to place on it. */
    let allocation: { company: CompanyRecord; count: number } | null = null;
    if (companyIdRaw !== undefined && companyIdRaw !== null) {
      const parsed = Number(companyIdRaw);
      const company = Number.isInteger(parsed) && parsed > 0 ? getCompanyById(parsed) : null;
      if (!company) throw new ValidationError('companyId does not match a known company');
      // A suspended subscription blocks new sales — a new store is new capacity,
      // so it is refused the same way. Stores that exist keep trading history.
      if (deriveBillingState(company) === 'suspended') {
        res.status(402).json({
          error: `${company.name} is suspended — new stores are refused until the subscription is settled. Existing stores keep trading their data.`,
          code: 'subscription_suspended',
        });
        return;
      }
      const addOk = canAddStore(company);
      if (!addOk.ok) {
        res.status(402).json({ error: addOk.reason, code: 'store_cap_reached' });
        return;
      }
      // Terminal licences are a purchased quantity: the store must be allocated
      // its terminals out of what the client pays for (`terminalCount`, unless
      // the caller allocates a different number). A client with no licensed
      // terminals is refused rather than silently given capacity.
      const requestedAllocation = optionalInt(req.body, 'licensedTerminalCount') ?? terminalCount;
      const termOk = checkNewStoreAllocation(company, requestedAllocation);
      if (!termOk.ok) {
        res.status(402).json({ error: termOk.reason, code: termOk.code });
        return;
      }
      const ceilingOk = checkNewStoreAllocation(company, terminalCount);
      if (!ceilingOk.ok) {
        res.status(402).json({ error: ceilingOk.reason, code: ceilingOk.code });
        return;
      }
      allocation = { company, count: requestedAllocation };
      companyId = company.id;
    }

    const store = createStore(
      { name, slug, vertical, terminalCount, baseUrl, environment },
      controlPlaneToken,
    );
    if (companyId !== null) setStoreCompany(store.id, companyId);
    // Place the client's licences on the store BEFORE the first licence push, so
    // the licence it receives already permits its own terminal count.
    if (allocation) allocateTerminals(allocation.company, store.id, allocation.count);

    const provision = Boolean(req.body?.provision);
    const adminEmail =
      typeof req.body?.adminEmail === 'string' && req.body.adminEmail.trim()
        ? req.body.adminEmail.trim().toLowerCase()
        : null;

    if (provision) {
      setStoreDeployStatus(store.id, 'provisioning', { adminEmail: adminEmail ?? undefined });
      void runStoreProvisioning(store.id, adminEmail);
    }

    // Attempt the first push right away; a failed attempt never fails creation.
    const firstPush = await attemptPush(store);
    const firstLicence = await attemptLicencePush(getStoreById(store.id)!);

    // Pair the branch with its merchant's Head Office when it has one. Without
    // this, a branch added outside the client wizard never reaches the panel's
    // roster, and the panel reports a perfectly healthy branch as Offline. Like
    // the first push, a failure here is reported rather than fatal — the store
    // exists either way.
    let headOfficeWiring: string;
    try {
      headOfficeWiring = await wireStoreToHeadOffice(getStoreById(store.id)!);
    } catch (err) {
      headOfficeWiring = `failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`Head Office wiring for ${store.slug} failed: ${headOfficeWiring}`);
    }

    const updated = getStoreById(store.id)!;
    res.status(201).json({
      store: storeToOut(updated),
      firstPush,
      firstLicence,
      headOfficeWiring,
      provisioning: provision,
      // Present only when we generated one. Never returned by list or detail.
      ...(generatedToken ? { generatedControlPlaneToken: generatedToken } : {}),
    });
  }),
);

storesRouter.post(
  '/:id/redeploy',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    void runStoreProvisioning(store.id, store.admin_email);
    res.json({ ok: true, message: `Redeployment triggered for ${store.name}` });
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
      vertical?: StoreVertical;
      terminalCount?: number;
      baseUrl?: string;
      environment?: StoreEnvironment;
      terminalNames?: string[] | null;
    } = {};
    const body = req.body as Record<string, unknown>;
    if (body['name'] !== undefined) input.name = requireString(body, 'name');
    if (body['vertical'] !== undefined) input.vertical = optionalVertical(body);
    if (body['terminalCount'] !== undefined) input.terminalCount = requireTerminalCount(body);
    if (body['baseUrl'] !== undefined) input.baseUrl = requireBaseUrl(body);
    if (body['environment'] !== undefined) input.environment = optionalEnvironment(body);
    if (body['terminalNames'] !== undefined) {
      if (body['terminalNames'] === null) {
        input.terminalNames = null;
      } else {
        if (!Array.isArray(body['terminalNames'])) {
          throw new ValidationError('terminalNames must be an array of strings or null');
        }
        const names = (body['terminalNames'] as unknown[]).map((n) => {
          if (typeof n !== 'string') {
            throw new ValidationError('terminalNames must be an array of strings or null');
          }
          const trimmed = n.trim();
          if (trimmed.length > 60) {
            throw new ValidationError('terminal names must be 60 characters or fewer');
          }
          return trimmed;
        });
        const count = input.terminalCount ?? store.terminal_count;
        if (names.length > count) {
          throw new ValidationError(`terminalNames must hold at most ${count} entries`);
        }
        input.terminalNames = names;
      }
    }

    // Raising the till count is new capacity: refused while the owning company
    // is suspended, exactly like a new store. Same-count pushes stay allowed so
    // config and licence delivery keep working — that is how a store learns it
    // has been unsuspended.
    if (
      input.terminalCount !== undefined &&
      store.company_id !== null &&
      input.terminalCount > store.terminal_count
    ) {
      const company = getCompanyById(store.company_id);
      if (company && deriveBillingState(company) === 'suspended') {
        res.status(402).json({
          error: `${company.name} is suspended — adding terminals is refused until the subscription is settled.`,
          code: 'subscription_suspended',
        });
        return;
      }
    }

    // Reassign the store to another client, or clear the link with null. The
    // licences travel with the store: its allocation is validated against the
    // NEW client's purchased quantity, then written (or released on unassign).
    const nextCount = input.terminalCount ?? store.terminal_count;
    let reassign: { company: CompanyRecord; count: number } | null = null;
    let release = false;
    if (body['companyId'] !== undefined) {
      if (body['companyId'] === null) {
        release = true;
      } else {
        const parsed = Number(body['companyId']);
        const company = Number.isInteger(parsed) && parsed > 0 ? getCompanyById(parsed) : null;
        if (!company) throw new ValidationError('companyId does not match a known company');
        const requestedAllocation =
          optionalInt(req.body, 'licensedTerminalCount') ?? nextCount;
        const check = checkAllocation(company, store.id, requestedAllocation);
        if (!check.ok) {
          res.status(402).json({ error: check.reason, code: check.code });
          return;
        }
        if (company.id !== store.company_id || requestedAllocation !== terminalAllowance(store).count) {
          reassign = { company, count: requestedAllocation };
        }
      }
    }

    // A store may not be CONFIGURED for more tills than it is licensed for, so
    // the POS slots and the signed licence cannot drift apart.
    if (input.terminalCount !== undefined) {
      const owningCompany = reassign
        ? reassign.company
        : store.company_id
          ? getCompanyById(store.company_id)
          : null;
      const check = checkConfiguredTerminals(owningCompany, store, input.terminalCount);
      if (!check.ok) {
        res.status(402).json({ error: check.reason, code: check.code });
        return;
      }
    }

    if (release) {
      setStoreCompany(store.id, null);
      releaseStoreAllocation(store.id);
    }
    if (reassign) {
      setStoreCompany(store.id, reassign.company.id);
      allocateTerminals(reassign.company, store.id, reassign.count);
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
    // A push could raise the till count past the plan's per-store ceiling or the
    // store's own licence allowance.
    const termOk = checkConfiguredTerminals(
      store.company_id ? getCompanyById(store.company_id) : null,
      store,
      store.terminal_count,
    );
    if (!termOk.ok) {
      res.status(402).json({ error: termOk.reason, code: termOk.code });
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
      // A reachable store is a chance to refresh telemetry (version, heartbeat,
      // sync, till claim state) — the SPOG card fields come from here.
      try {
        const telemetry = await fetchTelemetry(getStoreById(store.id)!);
        recordTelemetry(store.id, {
          version: telemetry.version,
          schemaVersion: telemetry.schemaVersion ?? null,
          generatedAt: telemetry.generatedAt,
          telemetry,
        });
      } catch {
        // Telemetry is best-effort; the health result already recorded up.
      }
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
      const updated = recordHealthResult(
        store.id,
        'down',
        err instanceof Error ? err.message : String(err),
      );
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
  '/:id/support',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    // Support sessions are audited (SPOG §18/§38): who opened one, and why.
    recordAuditLog('office', 'support_session_started', 'store', store.id, {
      reason: optionalString(req.body, 'reason', 300) ?? 'No reason given',
      after: { durationMinutes: 30, access: 'technical diagnostics only' },
    });
    res.json({
      ok: true,
      store: store.slug,
      access: 'Technical diagnostics only',
      durationMinutes: 30,
      note: 'Session recorded in the audit trail.',
    });
  }),
);

storesRouter.post(
  '/:id/support/end',
  asyncHandler(async (req, res) => {
    const store = storeFromParams(req.params.id);
    recordAuditLog('office', 'support_session_ended', 'store', store.id, {
      reason: 'Support session closed by the office user',
    });
    res.json({ ok: true });
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
    recordAuditLog('office', 'reset_store_admin', 'store', store.id, {
      reason: 'Temporary store password issued from the Support panel',
    });
    res.json({ ok: true, tempPassword, note: 'Shown once — the control plane does not store it.' });
  }),
);
