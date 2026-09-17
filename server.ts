import { env } from './src/config/env.js';
import { getRegistryDb } from './src/config/registryDb.js';
import { createApp } from './src/app.js';
import { logger } from './src/utils/logger.js';
import { startHealthSweep } from './src/services/sweepScheduler.js';

getRegistryDb();
const app = createApp();
app.listen(env.port, () => {
  logger.info(
    `Vula Control Plane listening on :${env.port} (${env.isProduction ? 'production' : 'development'})`,
  );
  // Keep health, version and latency honest without an operator clicking. Set
  // HEALTH_SWEEP_INTERVAL_MINUTES=0 to run it by hand only.
  startHealthSweep(env.healthSweepMinutes);
});
