import { Router } from 'express';
import { authRouter } from './auth.js';
import { storesRouter } from './stores.js';
import { companiesRouter, plansRouter } from './companies.js';
import { panelsRouter } from './panels.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/stores', storesRouter);
apiRouter.use('/plans', plansRouter);
apiRouter.use('/companies', companiesRouter);
apiRouter.use('/panels', panelsRouter);
