import { Router } from 'express';
import { buildVersionsView } from '../services/fleetView.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const versionsRouter = Router();
versionsRouter.use(requireOffice);

/**
 * Fleet version distribution (SPOG §32) — the build each registered member runs,
 * with its member list, plus the schema version spread and the most-deployed
 * version per environment.
 *
 * The spec's "Minimum Supported" line is deliberately absent: no minimum-version
 * policy exists anywhere in the control plane, and inventing one would invent a
 * support commitment. See tidbits.md.
 */
versionsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(buildVersionsView());
  }),
);
