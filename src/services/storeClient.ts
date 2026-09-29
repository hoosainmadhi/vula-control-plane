import { terminalRoster, type StoreRecord } from '../config/registryDb.js';
import { env } from '../config/env.js';
import { isReservedAddress } from '../utils/validate.js';
import { promises as dns } from 'node:dns';

/**
 * Client for a store's tenant-side internal API (/api/internal/*). Every call
 * is guarded by the store's CONTROL_PLANE_TOKEN via the X-Control-Plane-Token
 * header and fails fast after STORE_REQUEST_TIMEOUT_MS.
 *
 * The wire contract these calls implement is CP-authored — see CONTEXT.md
 * "Internal API contract" — the tenant workstream implements /api/internal/*
 * to match.
 */

export class StoreClientError extends Error {
  status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'StoreClientError';
  }
}

interface CallOptions {
  timeoutMs?: number;
}

/** Normalizes a store base URL: strips any trailing slashes. */
export const resolveBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

export const terminalNames = (count: number): Array<{ till: number; name: string }> =>
  Array.from({ length: count }, (_, i) => ({ till: i + 1, name: `Till ${i + 1}` }));

/** Which side of the fleet a licence is being delivered to. */
export type LicenceHolderKind = 'store' | 'panel';

/**
 * The licence sequence a deployment says it holds, read out of its own
 * `GET /api/internal/status` body: stores report it under `subscription.sequence`,
 * Head Offices under `licence.sequence`.
 *
 * This is the licence's anti-replay number, echoed back — not merchant business
 * data (§40) — and it is the only thing the CP reads out of a status payload
 * besides liveness. It is the authority on how high the CP's own counter must be:
 * a store refuses a licence below the one it holds, so the counter has to stay
 * ahead of this value rather than ahead of whatever the registry remembers.
 *
 * Returns null when the field is absent or not a number: an older build that does
 * not report it is left alone rather than guessed at.
 */
export const reportedLicenceSequence = (kind: LicenceHolderKind, body: unknown): number | null => {
  if (body === null || typeof body !== 'object') return null;
  const block = (body as Record<string, unknown>)[kind === 'store' ? 'subscription' : 'licence'];
  if (block === null || typeof block !== 'object') return null;
  const value = (block as Record<string, unknown>).sequence;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
};

interface StoreResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

const readBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const detailFrom = (body: unknown): string => {
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
  ) {
    return (body as { error: string }).error;
  }
  if (typeof body === 'string' && body.length <= 200) return body;
  return `HTTP ${body === null ? 'empty response' : 'non-JSON response'}`;
};

const request = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<StoreResponse> => {
  const timeoutMs = options.timeoutMs ?? env.storeRequestTimeoutMs;
  const url = `${resolveBase(store.base_url)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Control-Plane-Token': store.control_plane_token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string } | null | undefined)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new StoreClientError(`Store call timed out after ${timeoutMs}ms (${method} ${path})`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new StoreClientError(`Store unreachable (${method} ${path}): ${detail}`);
  }
  const parsed = await readBody(res);
  if (!res.ok) {
    throw new StoreClientError(`Store ${method} ${path} failed: ${detailFrom(parsed)}`);
  }
  return { ok: true, status: res.status, body: parsed };
};

/**
 * Pushes the store configuration (vertical + terminal count, Till 1..N) to
 * POST /api/internal/configure.
 */
export const pushTerminals = async (
  store: Pick<
    StoreRecord,
    'base_url' | 'control_plane_token' | 'terminal_count' | 'vertical' | 'terminal_names_json'
  >,
  options: CallOptions = {},
  extra: Record<string, unknown> = {},
): Promise<unknown> => {
  const { body } = await request(
    store,
    'POST',
    '/api/internal/configure',
    {
      terminalCount: store.terminal_count,
      vertical: store.vertical,
      terminals: terminalRoster(store),
      ...extra,
    },
    options,
  );
  return body;
};

/**
 * What kind of Vula application answers at this URL?
 *
 * Both apps identify themselves on their PUBLIC /health, so this needs no token —
 * which matters when the control plane has just generated one and would only get
 * a 401 back. Used to stop a store row being pointed at a Head Office, or a Head
 * Office row at a store: the two are different products and a mismatch can never
 * authenticate.
 */
export type AppKind = 'store' | 'head-office' | 'unknown';

export const probeAppKind = async (
  baseUrl: string,
  timeoutMs = env.storeRequestTimeoutMs,
): Promise<{ reachable: boolean; kind: AppKind; detail?: string }> => {
  try {
    const res = await fetch(`${resolveBase(baseUrl)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let body: { app?: unknown; service?: unknown } | null = null;
    try {
      body = raw ? (JSON.parse(raw) as { app?: unknown; service?: unknown }) : null;
    } catch {
      // Non-JSON health response: reachable, but we cannot identify it.
    }
    if (body?.service === 'vula-head-office') return { reachable: true, kind: 'head-office' };
    if (body?.app === 'vula') return { reachable: true, kind: 'store' };
    return { reachable: true, kind: 'unknown' };
  } catch (err) {
    return {
      reachable: false,
      kind: 'unknown',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};

export type ManagedKind = 'store' | 'head-office';

export interface EndpointCheck {
  ok: boolean;
  /** Present when `ok` is false. */
  code?: 'endpoint_private' | 'endpoint_unreachable' | 'wrong_app_kind';
  error?: string;
  /** HTTP status to answer with; 409 is a genuine conflict, 400 a policy refusal. */
  status: number;
  kind?: AppKind;
}

/**
 * The asynchronous half of the managed-endpoint policy. `requireBaseUrl` has
 * already refused the shape and any literal private address; this resolves the
 * hostname — a public name can still point inward, and only resolution reveals
 * that — and confirms the deployment identifies as the kind of application the
 * row claims to point at.
 *
 * Refusing an unreachable URL is production-only, because a registry row is
 * normally created before its container is deployed. In production that ordering
 * is not acceptable for a URL this server will dial while holding a secret: the
 * token goes out on the first push, so the host must prove it is live and the
 * right product before the row is saved.
 *
 * Residual risk, stated rather than hidden: resolution here and the later
 * `fetch` are independent, so a fast-rebinding DNS record could differ between
 * the two. Closing that needs the resolved address pinned into the connection
 * (a custom dispatcher), which is deliberately out of scope for this pass.
 */
export const assertManagedEndpoint = async (
  baseUrl: string,
  expected: ManagedKind,
  production = env.isProduction,
): Promise<EndpointCheck> => {
  const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (production) {
    if (isReservedAddress(host)) {
      return {
        ok: false,
        status: 400,
        code: 'endpoint_private',
        error: `${host} is a private, loopback or link-local address, which the control plane will not call in production`,
      };
    }
    try {
      const answers = await dns.lookup(host, { all: true, verbatim: true });
      const inward = answers.find((a) => isReservedAddress(a.address));
      if (inward) {
        return {
          ok: false,
          status: 400,
          code: 'endpoint_private',
          error: `${host} resolves to ${inward.address}, which is not a public address — the control plane will not call it in production`,
        };
      }
    } catch {
      // Unresolvable falls through to the probe, which reports it unreachable.
    }
  }

  const probe = await probeAppKind(baseUrl);
  if (!probe.reachable) {
    if (production) {
      return {
        ok: false,
        status: 400,
        code: 'endpoint_unreachable',
        error: `${baseUrl} does not answer (${probe.detail ?? 'no response'}). In production a managed URL must be live before it is registered — otherwise the first licence push sends a secret token to a host that cannot identify itself.`,
      };
    }
    return { ok: true, status: 200, kind: probe.kind };
  }

  const mismatched =
    (expected === 'store' && probe.kind === 'head-office') ||
    (expected === 'head-office' && probe.kind === 'store');
  if (mismatched) {
    const found = probe.kind === 'store' ? 'a store deployment' : 'a Head Office deployment';
    const wanted = expected === 'store' ? 'a store' : 'a Head Office';
    const elsewhere = expected === 'store' ? 'the Head Offices page' : 'the Stores page';
    return {
      ok: false,
      status: 409,
      code: 'wrong_app_kind',
      error: `${baseUrl} is ${found}, not ${wanted}. Register it on ${elsewhere} instead.`,
      kind: probe.kind,
    };
  }
  return { ok: true, status: 200, kind: probe.kind };
};

/** Pings GET /api/internal/status; resolves with the store's status body. */
export const ping = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(store, 'GET', '/api/internal/status', undefined, options);
  return body;
};

/** Fleet telemetry payload (internal API v0.4.0). Technical metadata only. */
export interface StoreTelemetry {
  ok: boolean;
  app: string;
  version: string;
  environment?: string;
  schemaVersion?: number | null;
  generatedAt: string;
  sync: { lastSyncAt: string | null; pendingEvents: number | null; failedEvents: number | null };
  terminals: Array<{
    till: number;
    name: string;
    claimed: boolean;
    deviceId: string | null;
    sessionOpen: boolean;
    lastSeenAt: string | null;
  }>;
}

/**
 * Fetches the store's telemetry snapshot (GET /api/internal/telemetry) —
 * app/schema version, heartbeat, per-till claim state and sync liveness.
 * Version / Sync / terminal-online on the store card come from here.
 */
export const fetchTelemetry = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  options: CallOptions = {},
): Promise<StoreTelemetry> => {
  const { body } = await request(store, 'GET', '/api/internal/telemetry', undefined, options);
  return body as StoreTelemetry;
};

/**
 * Pings a Company Control Panel's own token-guarded status endpoint. The panel
 * exposes operational metadata only (version, health) — the control plane reads
 * nothing inside it but liveness and the licence sequence the panel already
 * holds (`reportedLicenceSequence`), both of which are licence-technical rather
 * than merchant business data (§40).
 */
export const pingPanel = async (
  panel: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(panel, 'GET', '/api/internal/status', undefined, options);
  return body;
};

/** Delivers a signed licence to a panel's POST /api/internal/licence. */
export const pushLicenceToPanel = async (
  panel: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  token: string,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(panel, 'POST', '/api/internal/licence', { token }, options);
  return body;
};

/**
 * Registers/updates a branch in the merchant Head Office's roster
 * (POST /api/internal/branches). The control plane owns the store↔HO topology:
 * it tells each branch where its Head Office is AND the Head Office which
 * branches belong to it, carrying the same per-branch credential both ways.
 */
export const registerBranchWithPanel = async (
  panel: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  branch: {
    slug: string;
    name: string;
    baseUrl: string;
    headOfficeToken: string | null;
    vertical?: string;
  },
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(
    panel,
    'POST',
    '/api/internal/branches',
    {
      slug: branch.slug,
      name: branch.name,
      baseUrl: branch.baseUrl,
      headOfficeToken: branch.headOfficeToken,
      vertical: branch.vertical,
    },
    options,
  );
  return body;
};

/**
 * Hands the merchant's whole intended branch list to its Head Office
 * (POST /api/internal/branches/roster).
 *
 * Distinct from `registerBranchWithPanel`, which activates one branch. This is
 * the *intended* set — including stores the merchant has not registered yet — so
 * the panel can show a merchant the branches the control plane knows about, minus
 * the ones it already has. Without it those two lists drift silently.
 */
export const pushBranchRosterToPanel = async (
  panel: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  branches: Array<{
    slug: string;
    name: string;
    baseUrl: string;
    vertical?: string;
    headOfficeToken: string | null;
  }>,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(
    panel,
    'POST',
    '/api/internal/branches/roster',
    { branches },
    options,
  );
  return body;
};

/**
 * Bootstraps the Head Office's first admin user (POST /api/internal/admin/init).
 * The temporary password is generated by the caller and discarded — the
 * operator gets a working login through the reveal-once reset, never a stored
 * secret.
 */
export const bootstrapHeadOfficeAdmin = async (
  panel: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  admin: { name: string; email: string; password: string },
  options: CallOptions = {},
): Promise<void> => {
  await request(panel, 'POST', '/api/internal/admin/init', admin, options);
};

/**
 * Delivers a signed licence to POST /api/internal/licence. The store verifies it
 * against the control-plane public key before accepting, so a failed push leaves
 * the previous licence in force rather than clearing entitlement.
 */
export const pushLicence = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  token: string,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(store, 'POST', '/api/internal/licence', { token }, options);
  return body;
};

export interface AdminResetResult {
  tempPassword: string;
}

/**
 * Asks the store to reset its admin password over POST /api/internal/admin/reset.
 * The store generates the one-time temp password and returns it — the control
 * plane only proxies it to the office user and never persists it.
 */
export const resetAdmin = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  options: CallOptions = {},
): Promise<AdminResetResult> => {
  const { body } = await request(store, 'POST', '/api/internal/admin/reset', undefined, options);
  const record = body as Partial<AdminResetResult> | null;
  if (!record || typeof record.tempPassword !== 'string' || !record.tempPassword) {
    throw new StoreClientError('Store reset response did not include a tempPassword');
  }
  return { tempPassword: record.tempPassword };
};
