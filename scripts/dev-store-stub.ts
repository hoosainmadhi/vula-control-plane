import crypto from 'crypto';
import express from 'express';
import { logger } from '../src/utils/logger.js';

/**
 * Dev stub of a Vula store's tenant-side internal API (/api/internal/*).
 *
 * A stand-in for a real za-pos deployment in local dev (the tenant shipped
 * its own routes 2026-09-03); point CP stores at this stub to exercise
 * push / health / reset-admin end to end. Never used in production.
 *
 *   CONTROL_PLANE_TOKEN=smoke-token-1 npx tsx scripts/dev-store-stub.ts
 */

const PORT = Number(process.env.STUB_PORT || 3299);
const TOKEN = process.env.CONTROL_PLANE_TOKEN || 'smoke-token-1';

const VERTICALS = ['general', 'clothing', 'spares', 'hardware', 'pharmacy', 'restaurant'];

const app = express();
app.use(express.json({ limit: '100kb' }));

interface Till {
  till: number;
  name: string;
}

let configuredTerminals: Till[] = [];
let configuredVertical = process.env.STUB_VERTICAL || 'general';

const requireToken = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void => {
  if (req.headers['x-control-plane-token'] !== TOKEN) {
    res.status(401).json({ error: 'Invalid control plane token' });
    return;
  }
  next();
};

app.get('/api/internal/status', requireToken, (_req, res) => {
  res.json({
    ok: true,
    storeName: process.env.STUB_STORE_NAME || 'Stub Demo Store',
    vatRegNo: process.env.STUB_VAT_REG_NO || '4530211828',
    vertical: configuredVertical,
    version: '0.0.0-stub',
    terminalCount: configuredTerminals.length,
    terminals: configuredTerminals,
  });
});

app.post('/api/internal/configure', requireToken, (req, res) => {
  const body = req.body as { terminalCount?: unknown; terminals?: unknown; vertical?: unknown };
  const terminalCount = body.terminalCount;
  const terminals = body.terminals;
  if (
    !Number.isInteger(terminalCount) ||
    (terminalCount as number) < 1 ||
    (terminalCount as number) > 99
  ) {
    res.status(400).json({ error: 'terminalCount must be a whole number between 1 and 99' });
    return;
  }
  if (body.vertical !== undefined) {
    if (typeof body.vertical !== 'string' || !VERTICALS.includes(body.vertical)) {
      res.status(400).json({ error: `vertical must be one of: ${VERTICALS.join(', ')}` });
      return;
    }
    configuredVertical = body.vertical;
  }
  configuredTerminals = Array.isArray(terminals) ? (terminals as Till[]) : [];
  logger.info(
    `stub: configured ${configuredTerminals.length} terminals (vertical ${configuredVertical})`,
  );
  res.json({ ok: true, applied: { terminalCount, terminals: configuredTerminals } });
});

app.post('/api/internal/admin/reset', requireToken, (_req, res) => {
  const tempPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);
  logger.info('stub: admin password reset');
  res.json({ ok: true, tempPassword });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'za-pos-dev-store-stub' });
});

app.listen(PORT, () => {
  logger.info(`Store stub (tenant internal API) listening on :${PORT} — token "${TOKEN}"`);
});
