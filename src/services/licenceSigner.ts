import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, logger } from '../config/env.js';

/**
 * Store-licence signing (asymmetric).
 *
 * The control plane is the only party that can mint entitlement. Stores hold
 * nothing but the public key, so a tenant cannot extend their own subscription —
 * which is precisely what the previous symmetric scheme (a lease signed with the
 * store's own JWT_SECRET) allowed.
 *
 * Algorithm is ECDSA P-256 / SHA-256 with IEEE-P1363 (raw r||s) signatures,
 * because WebCrypto in the register must verify the same bytes and P-256 is
 * universally supported there.
 */

export type BillingState = 'active' | 'past_due' | 'suspended' | 'trial' | 'unlicensed';

export interface LicenceClaims {
  licenceId: string;
  keyId: string;
  /** Monotonic per store; a store refuses a licence older than the one it holds. */
  sequence: number;
  companyId: number | null;
  companyName: string;
  storeSlug: string;
  storeName: string;
  planCode: string;
  planName: string;
  features: string[];
  maxStores: number;
  maxTerminalsPerStore: number;
  paidThrough: string | null;
  billingState: BillingState;
  issuedAt: string;
  maxOfflineUntil: string;
}

export interface SignedLicence {
  token: string;
  claims: LicenceClaims;
}

interface KeyMaterial {
  privateKey: crypto.KeyObject;
  publicKeySpki: string;
  keyId: string;
  ephemeral: boolean;
}

let cached: KeyMaterial | null = null;

const toB64Url = (buf: Buffer): string => buf.toString('base64url');
const fromB64Url = (s: string): Buffer => Buffer.from(s, 'base64url');

function loadFromFile(file: string): string | null {
  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the signing keypair once. Precedence: LEASE_PRIVATE_KEY, then
 * LEASE_KEY_FILE, then a generated dev keypair (which is loudly warned about and
 * refuses to issue licences in production, so a misconfigured deploy cannot hand
 * out unverifiable entitlement).
 */
function loadKeys(): KeyMaterial {
  if (cached) return cached;

  let pkcs8 = env.licencePrivateKey;
  if (!pkcs8 && env.licenceKeyFile) {
    pkcs8 = loadFromFile(env.licenceKeyFile);
    if (!pkcs8) {
      logger.warn(`LICENCE: LEASE_KEY_FILE ${env.licenceKeyFile} missing or unreadable`);
    }
  }

  if (pkcs8) {
    const privateKey = crypto.createPrivateKey({
      key: fromB64Url(pkcs8),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKeySpki =
      env.licencePublicKey ||
      toB64Url(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
    cached = { privateKey, publicKeySpki, keyId: env.licenceKeyId, ephemeral: false };
    return cached;
  }

  if (env.isProduction) {
    logger.error(
      'FATAL: LEASE_PRIVATE_KEY (or LEASE_KEY_FILE) must be set in production — refusing to issue unverifiable licences',
    );
    process.exit(1);
  }

  // Dev convenience only. Regenerating on each boot invalidates previously
  // issued licences, which is fine for a local demo and impossible to miss.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  logger.warn(
    'LICENCE: LEASE_PRIVATE_KEY not set — generated an ephemeral dev keypair. ' +
      'Set LEASE_PRIVATE_KEY and distribute LEASE_PUBLIC_KEY to stores before any real deployment.',
  );
  cached = {
    privateKey,
    publicKeySpki: toB64Url(publicKey.export({ type: 'spki', format: 'der' })),
    keyId: env.licenceKeyId,
    ephemeral: true,
  };
  return cached;
}

export const licenceKeyId = (): string => loadKeys().keyId;
export const licencePublicKey = (): string => loadKeys().publicKeySpki;
export const isEphemeralKey = (): boolean => loadKeys().ephemeral;

/** Generate a fresh keypair (base64url PKCS#8 + SPKI) for an operator to install. */
export function generateLicenceKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: toB64Url(privateKey.export({ type: 'pkcs8', format: 'der' })),
    publicKey: toB64Url(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

export interface IssueLicenceInput {
  sequence: number;
  storeSlug: string;
  storeName: string;
  companyId?: number | null;
  companyName?: string;
  planCode?: string;
  planName?: string;
  features?: string[];
  maxStores?: number;
  maxTerminalsPerStore?: number;
  paidThrough?: string | null;
  billingState?: BillingState;
  now?: Date;
}

/**
 * Sign a licence. `maxOfflineUntil` is the earlier of the rolling offline window
 * and the paid-through date plus grace — so an unpaid subscription stops granting
 * offline trade even while the machine stays disconnected.
 */
export function issueLicence(input: IssueLicenceInput): SignedLicence {
  const { privateKey, keyId } = loadKeys();
  const now = input.now ?? new Date();

  const rolling = new Date(now.getTime() + env.licenceOfflineDays * 24 * 60 * 60 * 1000);
  let maxOfflineUntil = rolling;
  if (input.paidThrough) {
    const grace = new Date(`${input.paidThrough}T23:59:59.000Z`);
    grace.setUTCDate(grace.getUTCDate() + env.licenceGraceDays);
    if (grace.getTime() < rolling.getTime()) maxOfflineUntil = grace;
  }

  const claims: LicenceClaims = {
    licenceId:
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `lic-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    keyId,
    sequence: input.sequence,
    companyId: input.companyId ?? null,
    companyName: input.companyName ?? '',
    storeSlug: input.storeSlug,
    storeName: input.storeName,
    planCode: input.planCode ?? 'unassigned',
    planName: input.planName ?? 'Unassigned',
    features: input.features ?? [],
    maxStores: input.maxStores ?? 1,
    maxTerminalsPerStore: input.maxTerminalsPerStore ?? 1,
    paidThrough: input.paidThrough ?? null,
    billingState: input.billingState ?? 'active',
    issuedAt: now.toISOString(),
    maxOfflineUntil: maxOfflineUntil.toISOString(),
  };

  const payloadB64 = toB64Url(Buffer.from(JSON.stringify(claims), 'utf-8'));
  const signature = crypto.sign('sha256', Buffer.from(payloadB64), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });

  return { token: `${payloadB64}.${toB64Url(signature)}`, claims };
}

/** Verify a licence the control plane issued (used by tests and diagnostics). */
export function verifyLicenceToken(
  token: string,
): { valid: boolean; claims?: LicenceClaims; error?: string } {
  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return { valid: false, error: 'Malformed licence structure' };

    const ok = crypto.verify(
      'sha256',
      Buffer.from(payloadB64),
      { key: crypto.createPublicKey({ key: fromB64Url(licencePublicKey()), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
      fromB64Url(sigB64),
    );
    if (!ok) return { valid: false, error: 'Invalid licence signature' };

    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as LicenceClaims;
    return { valid: true, claims };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Licence verification failed' };
  }
}

/** Test hook: drop the cached keypair so env changes take effect. */
export function resetLicenceKeys(): void {
  cached = null;
}
