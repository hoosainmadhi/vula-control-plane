import { Router } from 'express';
import bcrypt from 'bcrypt';
import { env } from '../config/env.js';
import { signOfficeToken } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimiter } from '../utils/rateLimiter.js';
import { requireEmail, requirePassword } from '../utils/validate.js';

export const authRouter = Router();

// Hash once at boot; env password is never stored or compared per request.
const officeAdminHash = bcrypt.hashSync(env.officeAdminPassword, 10);

authRouter.post(
  '/login',
  rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    label: 'office-login',
    // Enforced per source address and per account, both. Account-only would let
    // one IP hammer unlimited addresses; IP-only would let a shared NAT address
    // or a distributed attempt lock out the legitimate admin.
    accountKey: (req) =>
      typeof req.body?.email === 'string' && req.body.email
        ? String(req.body.email).trim().toLowerCase()
        : undefined,
  }),
  asyncHandler(async (req, res) => {
    const email = requireEmail(req.body);
    const password = requirePassword(req.body);
    const valid = email === env.officeAdminEmail && bcrypt.compareSync(password, officeAdminHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    res.json({
      token: signOfficeToken(email),
      user: { email, role: 'office' },
    });
  }),
);
