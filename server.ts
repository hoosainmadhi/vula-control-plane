import { env } from './src/config/env.js';
import { getRegistryDb } from './src/config/registryDb.js';
import { createApp } from './src/app.js';
import { logger } from './src/utils/logger.js';

getRegistryDb();
const app = createApp();
app.listen(env.port, () => {
  logger.info(
    `Vula Control Plane listening on :${env.port} (${env.isProduction ? 'production' : 'development'})`,
  );
});
