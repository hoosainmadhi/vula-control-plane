import dotenv from 'dotenv';
import { logger } from '../utils/logger.js';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Boot-time config validation: production refuses to run with unset or
 * placeholder secrets. Dev boots with insecure defaults and a warning.
 */
const requireEnv = (name: string, fallback: string, placeholderHint?: string): string => {
  const value = process.env[name] || fallback;
  if (isProduction) {
    if (!process.env[name] || (placeholderHint && value === placeholderHint)) {
      logger.error(`FATAL: ${name} must be set in production`);
      process.exit(1);
    }
  } else if (!process.env[name]) {
    logger.warn(`WARNING: ${name} not set — using insecure dev default`);
  }
  return value;
};

const OFFICE_PASSWORD_PLACEHOLDER = 'change-me-please';
if (isProduction && process.env.OFFICE_ADMIN_PASSWORD === OFFICE_PASSWORD_PLACEHOLDER) {
  logger.error('FATAL: OFFICE_ADMIN_PASSWORD must not be the placeholder in production');
  process.exit(1);
}

/**
 * The renewal sweep can simulate settlements so a demo fleet shows the whole
 * billing flow — which must be impossible where real money is involved: a
 * simulated settlement records a payment nobody made and extends a real
 * customer's subscription (the exact fabrication the 2026-09-12 review removed
 * from the sweep itself). Refusing at boot, like every other insecure default.
 */
if (isProduction && process.env.BILLING_SIMULATE_RENEWAL_SETTLEMENT === 'true') {
  logger.error(
    'FATAL: BILLING_SIMULATE_RENEWAL_SETTLEMENT must not be enabled in production — the sweep would record settlements that never happened',
  );
  process.exit(1);
}

/**
 * The licence signing key is checked at boot, not only on first use. `loadKeys()`
 * refuses too, but it refuses lazily: a control plane could start, pass its
 * healthcheck and look healthy, then die the moment it issues its first licence —
 * which is when a client is being onboarded. Refusing to start is the kinder
 * failure. (`loadKeys()` keeps its own check as defence in depth.)
 */
if (
  isProduction &&
  !process.env.LEASE_PRIVATE_KEY?.trim() &&
  !process.env.LEASE_KEY_FILE?.trim()
) {
  logger.error(
    'FATAL: LEASE_PRIVATE_KEY (or LEASE_KEY_FILE) must be set in production — the control plane signs store licences with it',
  );
  process.exit(1);
}

export interface Env {
  port: number;
  isProduction: boolean;
  logLevel: string;
  dbPath: string;
  officeAdminEmail: string;
  officeAdminPassword: string;
  jwtSecret: string;
  jwtTtlHours: number;
  storeRequestTimeoutMs: number;
  /**
   * Licence signing material. The private key never leaves this process; stores
   * receive only the public key and verify what the control plane signs.
   * Both are base64url-encoded DER: PKCS#8 for the private key, SPKI for the public.
   */
  licencePrivateKey: string | null;
  licencePublicKey: string | null;
  licenceKeyId: string;
  licenceOfflineDays: number;
  licenceGraceDays: number;
  licenceKeyFile: string | null;
  /**
   * Minutes between automatic health sweeps, or 0 to disable the schedule (the
   * manual route stays available either way). Without it the panel reports health,
   * version and latency from the last time somebody looked.
   */
  healthSweepMinutes: number;
  /**
   * How many proxy hops sit in front of this server. Express trusts the
   * X-Forwarded-For chain only that far, so `req.ip` is the real client rather
   * than the load balancer. Zero (the default) trusts no proxy at all, which is
   * the safe answer when the deployment is directly exposed: an untrusted
   * X-Forwarded-For lets any caller choose the address the login limiter keys
   * on, and trusting too many lets one spoofed hop collapse every client into
   * one bucket.
   */
  trustProxyHops: number;
}

export const env: Env = {
  port: Number(process.env.PORT || 3240),
  isProduction,
  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath: process.env.CP_DB_PATH || process.env.DB_PATH || 'data/control-plane.db',
  officeAdminEmail: requireEnv('OFFICE_ADMIN_EMAIL', 'admin@za-pos.local').toLowerCase(),
  officeAdminPassword: requireEnv('OFFICE_ADMIN_PASSWORD', 'temp123', OFFICE_PASSWORD_PLACEHOLDER),
  jwtSecret: requireEnv('JWT_SECRET', 'dev-secret-change-me', 'your-64-char-random-secret-here'),
  jwtTtlHours: Number(process.env.JWT_TTL_HOURS || 168),
  storeRequestTimeoutMs: Number(process.env.STORE_REQUEST_TIMEOUT_MS || 5000),
  // Not required at boot: when unset the signer generates a dev keypair (and, in
  // production, refuses to serve licences until a real key is configured).
  licencePrivateKey: process.env.LEASE_PRIVATE_KEY?.trim() || null,
  licencePublicKey: process.env.LEASE_PUBLIC_KEY?.trim() || null,
  licenceKeyId: process.env.LEASE_KEY_ID?.trim() || 'k1',
  licenceOfflineDays: Number(process.env.LICENCE_OFFLINE_DAYS || 14),
  licenceGraceDays: Number(process.env.LICENCE_GRACE_DAYS || 3),
  licenceKeyFile: process.env.LEASE_KEY_FILE?.trim() || null,
  // `|| 10` rather than `?? 10` so an empty variable means "the default", not
  // "zero", which would silently switch the schedule off.
  healthSweepMinutes: Number(process.env.HEALTH_SWEEP_INTERVAL_MINUTES || 10),
  trustProxyHops: Math.max(0, Number(process.env.CP_TRUST_PROXY_HOPS || 0)),
};

export { logger };
