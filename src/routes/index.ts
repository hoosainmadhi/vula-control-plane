import { Router } from 'express';
import { authRouter } from './auth.js';
import { storesRouter } from './stores.js';
import { companiesRouter, plansRouter } from './companies.js';
import { panelsRouter } from './panels.js';
import { billingRouter } from './billing.js';
import { clientsRouter } from './clients.js';
import { errorsRouter } from './errors.js';
import { devicesRouter } from './devices.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/clients', clientsRouter);
apiRouter.use('/stores', storesRouter);
apiRouter.use('/plans', plansRouter);
apiRouter.use('/companies', companiesRouter);
apiRouter.use('/panels', panelsRouter);
apiRouter.use('/billing', billingRouter);
apiRouter.use('/errors', errorsRouter);
apiRouter.use('/devices', devicesRouter);

