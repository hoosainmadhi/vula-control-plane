import { env } from './src/config/env.js';
import { getRegistryDb } from './src/config/registryDb.js';
import { createApp } from './src/app.js';
import { logger } from './src/utils/logger.js';
import { startHealthSweep } from './src/services/sweepScheduler.js';
import { startScheduledTask } from './src/services/scheduler.js';
import { runBillingTick } from './src/services/billing.js';

getRegistryDb();
const app = createApp();
app.listen(env.port, () => {
  logger.info(
    `Vula Control Plane listening on :${env.port} (${env.isProduction ? 'production' : 'development'})`,
  );
  // Keep health, version and latency honest without an operator clicking. Set
  // HEALTH_SWEEP_INTERVAL_MINUTES=0 to run it by hand only.
  startHealthSweep(env.healthSweepMinutes);
  // Mark lapsed invoices overdue and raise renewal invoices. The tick never
  // settles anything — only an explicit settlement moves paid_through. Set
  // BILLING_TICK_INTERVAL_MINUTES=0 to run it by hand only.
  startScheduledTask('billing tick', env.billingTickMinutes, async () => {
    await runBillingTick();
  });
});
