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
};

export { logger };
