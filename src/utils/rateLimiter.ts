import type { NextFunction, Request, RequestHandler, Response } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Short label included in the bucket key, e.g. 'login'. */
  label: string;
  /**
   * Derives the account dimension of the key, usually the submitted email. When
   * present the limit is enforced on the IP and on the account separately, and
   * both must pass — a combined key alone would let an attacker rotate accounts
   * from one IP and never fill a bucket (production review, 2026-09-23).
   */
  accountKey?: (req: Request) => string | undefined;
}

interface Bucket {
  hits: number[];
  lastHit: number;
}

const buckets = new Map<string, Bucket>();

/** Requests between sweeps of expired buckets, so memory stays bounded. */
const SWEEP_EVERY = 500;
let sinceSweep = 0;

const prune = (hits: number[], windowMs: number, now: number): number[] =>
  hits.filter((t) => now - t < windowMs);

const sweep = (windowMs: number, now: number): void => {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastHit >= windowMs) buckets.delete(key);
  }
};

/**
 * In-memory sliding-window rate limiter.
 *
 * `req.ip` honours the Express `trust proxy` setting configured in app.ts, so
 * behind a load balancer the key is the real client rather than the proxy —
 * without that, one bad actor locks out every user behind the proxy address.
 *
 * Storage is per-process: a restart clears the counters, and two replicas do
 * not share them. That is enough for a single office login endpoint today;
 * shared storage (Redis) is the upgrade path if the control plane is ever run
 * more than one way.
 */
export const rateLimiter = (options: RateLimitOptions): RequestHandler => {
  const { windowMs, max, label, accountKey } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      sweep(windowMs, now);
    }

    const account = accountKey?.(req);
    const keys = [`ip:${label}:${req.ip ?? 'unknown'}`];
    if (account) keys.push(`account:${label}:${account}`);

    // Check every dimension before recording the hit, so a refused request does
    // not extend the window it is being refused for.
    for (const key of keys) {
      const bucket = buckets.get(key);
      const hits = bucket ? prune(bucket.hits, windowMs, now) : [];
      if (hits.length >= max) {
        if (bucket) {
          bucket.hits = hits;
          buckets.set(key, bucket);
        }
        res.status(429).json({ error: 'Too many attempts — please try again later' });
        return;
      }
    }
    for (const key of keys) {
      const bucket = buckets.get(key) ?? { hits: [], lastHit: now };
      bucket.hits = [...prune(bucket.hits, windowMs, now), now];
      bucket.lastHit = now;
      buckets.set(key, bucket);
    }
    next();
  };
};

/** Test seam: drops every bucket so a suite does not inherit another's counts. */
export const resetRateLimits = (): void => {
  buckets.clear();
  sinceSweep = 0;
};