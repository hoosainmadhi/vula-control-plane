import type { StoreRecord } from '../config/registryDb.js';
import { env } from '../config/env.js';

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

/** Pushes the terminal configuration (Till 1..N) to POST /api/internal/configure. */
export const pushTerminals = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token' | 'terminal_count'>,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(
    store,
    'POST',
    '/api/internal/configure',
    { terminalCount: store.terminal_count, terminals: terminalNames(store.terminal_count) },
    options,
  );
  return body;
};

/** Pings GET /api/internal/status; resolves with the store's status body. */
export const ping = async (
  store: Pick<StoreRecord, 'base_url' | 'control_plane_token'>,
  options: CallOptions = {},
): Promise<unknown> => {
  const { body } = await request(store, 'GET', '/api/internal/status', undefined, options);
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
