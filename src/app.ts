import fs from 'fs';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

const APP_NAME = 'za-pos-control-plane';
const APP_VERSION = '1.0.0';

const securityHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  );
  next();
};

export const createApp = (): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', apiRouter);

  // Locate the built SPA. Candidate order: module-relative (works when running
  // compiled dist under CJS and under tsx ESM via src/), then cwd-relative
  // (Docker WORKDIR /app). In dev the Vite server proxies /api here instead.
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(path.join(__dirname, '..', '..', 'frontend', 'dist'));
  }
  candidates.push(path.join(process.cwd(), 'frontend', 'dist'));
  const distDir = candidates.find((dir) => fs.existsSync(dir));
  if (distDir) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api\/|health).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    app.get(/^\/(?!api\/|health).*/, (_req, res) => {
      res.status(404).json({ error: 'Frontend not built — run npm run build in the repo root' });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
