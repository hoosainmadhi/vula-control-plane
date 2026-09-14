import { Router } from 'express';
import { listCompanies } from '../config/registryDb.js';
import { listFleetDevices } from '../services/fleetView.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const devicesRouter = Router();
devicesRouter.use(requireOffice);

/**
 * Every device in the fleet (SPOG §25): each store's configured tills —
 * claimed or not — plus one entry per Head Office. Read-only by design: the
 * tenant exposes no per-device command API, so there is nothing to act on here
 * yet (see tidbits.md).
 */
devicesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const companyNames = new Map(listCompanies().map((c) => [c.id, c.name]));
    res.json(listFleetDevices(companyNames));
  }),
);
