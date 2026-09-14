/** Typed HTTP error; the global error handler maps `status` onto the response. */
export class HttpError extends Error {
  status: number;
  /** Machine-readable reason, surfaced as `code` alongside `error`. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (code) this.code = code;
  }
}
