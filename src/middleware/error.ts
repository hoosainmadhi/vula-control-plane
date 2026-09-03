import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../utils/logger.js';

export const notFoundHandler: RequestHandler = (req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
};

export const errorHandler: ErrorRequestHandler = (
  err: { message?: string; status?: number },
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
) => {
  const status = err.status ?? 500;
  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} failed: ${err.message ?? 'unknown error'}`);
  }
  res.status(status).json({ error: err.message || 'Internal server error' });
};
