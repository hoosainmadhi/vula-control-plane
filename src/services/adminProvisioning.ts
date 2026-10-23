/**
 * The first admin's login, retried until the deployment can accept it.
 *
 * A Coolify build takes minutes; the onboarding job reaches a store's admin
 * endpoint seconds after the application is created. The first attempt is
 * therefore usually refused ("fetch failed", "store not accepting yet") — and
 * the old orchestrator recorded that as a warning and never tried again, so the
 * merchant received no credentials at all. This service is the retry: poll the
 * deployment's internal status until it answers, then bootstrap the first admin
 * and email the one-time password.
 *
 * It is deliberately in-process and fire-and-forget: the onboarding request must
 * not block for the length of a container build, and the reset-admin action
 * remains the durable fallback if the control plane restarts mid-retry. The
 * password is never stored; it exists only in the message sent to the merchant.
 */
import { getPanelById, getStoreById } from '../config/registryDb.js';
import { logger } from '../utils/logger.js';
import { bootstrapHeadOfficeAdmin, ping, pingPanel } from './storeClient.js';
import { bootstrapStoreAdmin, generateAdminPassword } from './storeProvisioning.js';
import { trySendAdminCredentialsEmail } from './mailer.js';

export type AdminHolderKind = 'store' | 'panel';

export interface AdminProvisionOptions {
  /** How long to keep trying. Default 15 minutes — a slow image build, not an outage. */
  timeoutMs?: number;
  /** Delay between probes. Default 15 seconds. */
  intervalMs?: number;
}

/** The outcomes one attempt can have. `retry` is the only one that loops. */
export type AdminProvisionOutcome = 'ok' | 'already-exists' | 'not-ready' | 'retry';

const envMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref` so a pending retry never keeps a shutting-down process (or a test
    // run) alive; the work resumes on the next boot only if it is still needed.
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

const isReady = async (kind: AdminHolderKind, id: number): Promise<boolean> => {
  if (kind === 'store') {
    const store = getStoreById(id);
    if (!store) return false;
    try {
      await ping(store);
      return true;
    } catch {
      return false;
    }
  }
  const panel = getPanelById(id);
  if (!panel) return false;
  try {
    await pingPanel(panel);
    return true;
  } catch {
    return false;
  }
};

/**
 * One bootstrap attempt. The health probe is separate from the bootstrap because
 * a store that answers `/api/internal/status` is also one whose database and
 * admin endpoint are up — the build is finished.
 */
export const attemptAdminProvisioning = async (
  kind: AdminHolderKind,
  id: number,
  adminEmail: string,
): Promise<AdminProvisionOutcome> => {
  if (!(await isReady(kind, id))) return 'not-ready';

  const tempPassword = generateAdminPassword();
  let surface: string;
  let loginUrl: string;
  let slug: string;

  if (kind === 'store') {
    const store = getStoreById(id);
    if (!store) return 'retry';
    surface = store.name;
    loginUrl = store.base_url;
    slug = store.slug;
    const created = await bootstrapStoreAdmin(store, adminEmail, tempPassword, { silent: true });
    // The store answers 201 only when it creates the admin. A false here can be
    // a lost response or a transient refusal, so keep trying until the deadline.
    if (!created) return 'retry';
  } else {
    const panel = getPanelById(id);
    if (!panel) return 'retry';
    surface = panel.name;
    loginUrl = panel.base_url;
    slug = panel.slug;
    try {
      await bootstrapHeadOfficeAdmin(panel, {
        name: 'Head Office Administrator',
        email: adminEmail,
        password: tempPassword,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The panel refuses a second bootstrap once any user exists. That is not a
      // failure to retry: an admin (and its email) already landed.
      if (/already exists|administrator already/i.test(message)) return 'already-exists';
      return 'retry';
    }
  }

  const delivery = await trySendAdminCredentialsEmail({
    surface,
    loginUrl,
    adminEmail,
    tempPassword,
  });
  if (delivery.emailed) {
    logger.info(`Initial admin bootstrapped for ${slug} (${adminEmail}); credentials emailed`);
  } else {
    logger.warn(
      `Initial admin bootstrapped for ${slug} (${adminEmail}); credentials email failed: ${delivery.emailError}`,
    );
  }
  return 'ok';
};

/**
 * Polls until the deployment is ready, then bootstraps and emails. Exported so
 * the retry can be tested directly with a short interval; production callers
 * use `scheduleAdminProvisioning`.
 */
export const provisionAdminWhenReady = async (
  kind: AdminHolderKind,
  id: number,
  adminEmail: string,
  options: AdminProvisionOptions = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? envMs('ADMIN_PROVISION_TIMEOUT_MS', 15 * 60 * 1000);
  const intervalMs = options.intervalMs ?? envMs('ADMIN_PROVISION_INTERVAL_MS', 15 * 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const wait = Math.min(Math.max(intervalMs, 1), Math.max(deadline - Date.now(), 1));
    await delay(wait);
    const outcome = await attemptAdminProvisioning(kind, id, adminEmail);
    if (outcome === 'ok' || outcome === 'already-exists') return;
  }

  logger.error(
    `Admin bootstrap for ${kind} ${id} still pending after ${timeoutMs}ms — ` +
      'the credentials email was not sent; use the reset-admin action to re-issue it',
  );
};

/** One retry loop per deployment, so a job retry cannot stack three pollers. */
const scheduled = new Set<string>();

/**
 * Fire-and-forget retry from the onboarding job. Disabled under Jest (the tests
 * exercise `provisionAdminWhenReady` directly) and by `ADMIN_PROVISION_RETRY=off`
 * for an operator who wants the reset action to be the only path.
 */
export const scheduleAdminProvisioning = (
  kind: AdminHolderKind,
  id: number,
  adminEmail: string,
): void => {
  if (process.env.NODE_ENV === 'test' || process.env.ADMIN_PROVISION_RETRY === 'off') return;
  const key = `${kind}:${id}`;
  if (scheduled.has(key)) return;
  scheduled.add(key);
  void provisionAdminWhenReady(kind, id, adminEmail)
    .catch((err) => {
      logger.error(
        `Admin provisioning retry for ${kind} ${id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    })
    .finally(() => scheduled.delete(key));
};
