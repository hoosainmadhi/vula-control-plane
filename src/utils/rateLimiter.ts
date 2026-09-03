import type { NextFunction, Request, RequestHandler, Response } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Short label included in the bucket key, e.g. 'login'. */
  label: string;
}

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

const prune = (hits: number[], windowMs: number, now: number): number[] =>
  hits.filter((t) => now - t < windowMs);

/** In-memory sliding-window rate limiter keyed by label + client IP. */
export const rateLimiter = (options: RateLimitOptions): RequestHandler => {
  const { windowMs, max, label } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${label}:${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const bucket = buckets.get(key) ?? { hits: [] };
    bucket.hits = prune(bucket.hits, windowMs, now);
    if (bucket.hits.length >= max) {
      buckets.set(key, bucket);
      res.status(429).json({ error: 'Too many attempts — please try again later' });
      return;
    }
    bucket.hits.push(now);
    buckets.set(key, bucket);
    next();
  };
};
