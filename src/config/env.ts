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
};

export { logger };
