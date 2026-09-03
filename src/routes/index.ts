import { Router } from 'express';
import { authRouter } from './auth.js';
import { storesRouter } from './stores.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/stores', storesRouter);
