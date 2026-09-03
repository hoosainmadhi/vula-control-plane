import { HttpError } from './errors.js';

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

/** Normalizes a store base URL: requires http(s) scheme, strips the trailing slash. */
export const requireBaseUrl = (body: unknown): string => {
  let url = requireString(body, 'baseUrl', MAX_URL_LENGTH);
  url = url.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new ValidationError('baseUrl must start with http:// or https://');
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

export const parseIdParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid store id');
  return id;
};
