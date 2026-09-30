import dotenv from 'dotenv';
import { probeCoolify } from '../src/services/coolify.js';
import { logger } from '../src/utils/logger.js';

dotenv.config();

/**
 * Verifies control-plane → Coolify connectivity and token validity.
 * Run before first provisioning: `npm run probe`.
 *
 * The optimed control plane ships the same check — without it, a wrong API URL
 * or token surfaces only mid-onboarding, as a failed store deployment.
 */
const main = async (): Promise<void> => {
  const result = await probeCoolify();
  if (result.version) {
    logger.info(`[probe] Connected to Coolify — API version: ${result.version}`);
  } else {
    logger.warn(`[probe] ${result.message}`);
    logger.warn(
      '[probe] Check COOLIFY_API_URL / COOLIFY_API_TOKEN / COOLIFY_PROJECT_UUID / COOLIFY_SERVER_UUID / COOLIFY_GITHUB_APP_UUID',
    );
    process.exit(1);
  }
};

main().catch((err) => {
  logger.error(`[probe] Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
