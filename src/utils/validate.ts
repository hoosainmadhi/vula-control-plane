import { HttpError } from './errors.js';
import { env } from '../config/env.js';

/** Thrown by validation helpers; the global error handler maps it to 400 { error }. */
export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'ValidationError';
  }
}

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SLUG_LENGTH = 40;
const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Reads a trimmed non-empty string field from the body. */
export const requireString = (body: unknown, key: string, maxLength = MAX_NAME_LENGTH): string => {
  if (!isRecord(body) || typeof body[key] !== 'string') {
    throw new ValidationError(`${key} is required`);
  }
  const value = (body[key] as string).trim();
  if (!value) throw new ValidationError(`${key} is required`);
  if (value.length > maxLength)
    throw new ValidationError(`${key} must be ${maxLength} characters or fewer`);
  return value;
};

/** Reads an optional string field: absent → undefined, empty string → null (clear). */
export const optionalString = (
  body: unknown,
  key: string,
  maxLength = MAX_NAME_LENGTH,
): string | null | undefined => {
  if (!isRecord(body) || body[key] === undefined || body[key] === null) return undefined;
  if (typeof body[key] !== 'string') throw new ValidationError(`${key} must be a string`);
  const value = (body[key] as string).trim();
  if (!value) return null;
  if (value.length > maxLength)
    throw new ValidationError(`${key} must be ${maxLength} characters or fewer`);
  return value;
};

export const requireSlug = (body: unknown): string => {
  const slug = requireString(body, 'slug', MAX_SLUG_LENGTH);
  if (!SLUG_REGEX.test(slug)) {
    throw new ValidationError(
      'slug must start with a lowercase letter or digit and contain only lowercase letters, digits and dashes',
    );
  }
  return slug;
};

export const requireTerminalCount = (body: unknown): number => {
  if (!isRecord(body)) throw new ValidationError('terminalCount is required');
  const value = body['terminalCount'];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('terminalCount must be a whole number');
  }
  if (value < 1 || value > 99) throw new ValidationError('terminalCount must be between 1 and 99');
  return value;
};

const ipv4ToInt = (value: string): number | null => {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
};

const inIpv4Cidr = (n: number, base: string, bits: number): boolean => {
  const b = ipv4ToInt(base);
  if (b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
};

/**
 * Ranges that are not the public internet. Dialling any of them from this
 * server is SSRF by construction: loopback and RFC1918 are whatever else runs
 * here, link-local carries the cloud metadata service at 169.254.169.254, and
 * CGNAT is how some hosts front their own internal networks.
 */
const RESERVED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True when `host` is a literal address the control plane must never dial. */
export const isReservedAddress = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) {
    // ::ffff:10.0.0.1 is the same address as 10.0.0.1, so classify it as one.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)?.[1];
    if (mapped) return isReservedAddress(mapped);
    if (h === '::' || h === '::1') return true;
    if (/^f[cd]/.test(h)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    return false;
  }
  const n = ipv4ToInt(h);
  if (n === null) return false;
  return RESERVED_V4.some(([base, bits]) => inIpv4Cidr(n, base, bits));
};

/** Hostnames that name a metadata service rather than a machine. */
const METADATA_HOSTNAMES = ['metadata.google.internal', 'metadata.goog'];
const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost'];

/**
 * The one entry point for every URL this server is asked to dial while holding
 * a secret — store and Head Office base URLs alike. Individual routes must not
 * re-implement it: the review found four copies, and the two edit routes had
 * none of the checks the create routes had.
 *
 * This is the synchronous half — shape and literal addresses. The DNS half
 * lives in `assertManagedEndpoint`, because a public hostname can point at a
 * private address and only resolution reveals that.
 *
 * The address policy is production-only on purpose: the dev fleet and the whole
 * test suite register deployments on loopback, so a blanket refusal would break
 * the system it is meant to protect.
 */
export const requireBaseUrl = (body: unknown, production = env.isProduction): string => {
  let url = requireString(body, 'baseUrl', MAX_URL_LENGTH);
  url = url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new ValidationError('baseUrl must start with http:// or https://');
  }
  const parsed = new URL(url);
  if (!parsed.hostname) throw new ValidationError('baseUrl must name a host');
  // Credentials embedded in the URL would be forwarded to wherever it points.
  if (parsed.username || parsed.password) {
    throw new ValidationError('baseUrl must not carry credentials');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_HOSTNAMES.includes(host) || host.endsWith('.google.internal')) {
    throw new ValidationError('baseUrl points at a cloud metadata service');
  }
  if (production) {
    if (parsed.protocol === 'http:') {
      throw new ValidationError(
        'baseUrl must use https:// in production — every push to it carries a secret token',
      );
    }
    if (isReservedAddress(host)) {
      throw new ValidationError(
        'baseUrl is a private, loopback or link-local address, which the control plane will not call in production',
      );
    }
    if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new ValidationError(
        'baseUrl names an internal hostname, which the control plane will not call in production',
      );
    }
  }
  return url;
};

export const requireEmail = (body: unknown): string => {
  const email = requireString(body, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError('email is not a valid address');
  return email;
};

export const requirePassword = (body: unknown): string => requireString(body, 'password', 200);

export const requireInt = (
  body: unknown,
  key: string,
  options?: { min?: number; max?: number },
): number => {
  if (!isRecord(body) || body[key] === undefined || body[key] === null) {
    throw new ValidationError(`${key} is required`);
  }
  const value = Number(body[key]);
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${key} must be an integer`);
  }
  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(`${key} must be at least ${options.min}`);
  }
  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(`${key} must be at most ${options.max}`);
  }
  return value;
};

export const optionalInt = (
  body: unknown,
  key: string,
  options?: { min?: number; max?: number },
): number | undefined => {
  if (!isRecord(body) || body[key] === undefined || body[key] === null || body[key] === '') {
    return undefined;
  }
  const value = Number(body[key]);
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${key} must be an integer`);
  }
  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(`${key} must be at least ${options.min}`);
  }
  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(`${key} must be at most ${options.max}`);
  }
  return value;
};

export const parseIdParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid store id');
  return id;
};

/** Reads an optional boolean: absent → undefined. Accepts true/false only. */
export const optionalBool = (body: unknown, key: string): boolean | undefined => {
  if (!isRecord(body) || body[key] === undefined || body[key] === null) return undefined;
  if (typeof body[key] !== 'boolean') throw new ValidationError(`${key} must be true or false`);
  return body[key] as boolean;
};
