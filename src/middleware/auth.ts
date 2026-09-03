import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export type TokenKind = 'office';

export interface OfficeTokenPayload {
  kind: TokenKind;
  email: string;
  role: 'office';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: OfficeTokenPayload;
    }
  }
}

export const signOfficeToken = (email: string): string =>
  jwt.sign({ kind: 'office', email, role: 'office' } satisfies OfficeTokenPayload, env.jwtSecret, {
    expiresIn: `${env.jwtTtlHours}h`,
  });

export const verifyToken = (token: string): OfficeTokenPayload | null => {
  try {
    const payload = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload &
      Partial<OfficeTokenPayload>;
    return payload.kind === 'office' && typeof payload.email === 'string'
      ? { kind: 'office', email: payload.email, role: 'office' }
      : null;
  } catch {
    return null;
  }
};

/** Guards a route with a Bearer token of the given kind. */
export const requireKind =
  (kind: TokenKind): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload || payload.kind !== kind) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.auth = payload;
    next();
  };

export const requireOffice = requireKind('office');
