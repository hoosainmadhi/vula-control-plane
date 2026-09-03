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
  rateLimiter({ windowMs: 15 * 60 * 1000, max: 20, label: 'office-login' }),
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
