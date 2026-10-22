import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { getStoreById, setStoreDeployStatus, type StoreRecord } from '../config/registryDb.js';
import {
  createStoreDeployment,
  createStoreImageDeployment,
  isCoolifyConfigured,
  triggerDeploy,
  CoolifyError,
} from './coolify.js';
import {
  recordProvisionedRelease,
  resolveDefaultRelease,
  setTenantReleaseState,
  type ImageRelease,
} from './releaseCatalog.js';
import { verifyImageDeployment } from './releaseOrchestrator.js';
import { pushTerminals } from './storeClient.js';
import { deliverStoreLicence } from './licenceDelivery.js';
import { trySendAdminCredentialsEmail } from './mailer.js';
import { getCompanyById, recordLicencePush, recordConfigResult } from '../config/registryDb.js';

/** The host directory a deployment belongs under: its client's slug, or its own. */
const clientSlugFor = (companyId: number | null, fallback: string): string =>
  (companyId ? (getCompanyById(companyId)?.slug ?? fallback) : fallback);
import { logger } from '../utils/logger.js';

const HEALTH_POLL_INTERVAL_MS = 10000; // 10s
const HEALTH_POLL_TIMEOUT_MS = 480000;  // 8 minutes

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Generate 12-char CSPRNG temporary password */
export function generateAdminPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

/**
 * Polls the store's public /health endpoint until it reports healthy.
 */
async function waitForStoreHealth(baseUrl: string, timeoutMs = HEALTH_POLL_TIMEOUT_MS): Promise<boolean> {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { status?: string; app?: string } | null;
        if (data?.status === 'ok' || data?.app === 'vula') {
          return true;
        }
      }
    } catch {
      // Container still booting / building
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Calls the store's internal API to bootstrap the initial admin user.
 */
export async function bootstrapStoreAdmin(
  store: StoreRecord,
  adminEmail: string,
  tempPassword: string,
): Promise<boolean> {
  const cleanBase = store.base_url.replace(/\/+$/, '');
  const url = `${cleanBase}/api/internal/admin/init`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      // redirect: 'error' — this call carries the control-plane credential AND
      // the temporary admin password; neither may follow a redirect to a host
      // the managed-endpoint policy has not validated.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Control-Plane-Token': store.control_plane_token,
      },
      body: JSON.stringify({
        name: 'Store Administrator',
        email: adminEmail,
        password: tempPassword,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 201;
  } catch (err) {
    logger.error(`Failed to bootstrap admin for store ${store.slug}: ${err}`);
    return false;
  }
}

/**
 * Full automated provisioning background workflow.
 * Executes without blocking the initial HTTP response.
 */
export async function runStoreProvisioning(
  storeId: number,
  adminEmail?: string | null,
): Promise<void> {
  const store = getStoreById(storeId);
  if (!store) return;

  if (!isCoolifyConfigured()) {
    logger.warn(`Coolify is not configured; skipping auto-provisioning for ${store.slug}`);
    setStoreDeployStatus(storeId, 'not_deployed');
    return;
  }

  setStoreDeployStatus(storeId, 'provisioning', { adminEmail: adminEmail ?? undefined });
  logger.info(`Starting background provisioning for store ${store.slug} (${store.base_url})`);

  let coolifyUuid = store.coolify_uuid;
  let volumeName = store.volume_name;
  let imageRelease: ImageRelease | null = null;
  let imageDeploymentUuid: string | null = null;

  try {
    // 1. Create Coolify Application & Storage volume if not already created.
    // A default stable GHCR release makes this a shared-image deployment with
    // no Git/build step. A production tenant requires an approved stable
    // release; the legacy Dockerfile path remains only for non-production
    // development/demo onboarding until those tenants are migrated.
    if (!coolifyUuid) {
      const clientSlug = clientSlugFor(store.company_id, store.slug);
      const release = resolveDefaultRelease('store');
      if (
        !release &&
        (store.environment === 'production' || !env.allowLegacyDockerfileOnboarding)
      ) {
        throw new Error(
          'No approved stable Store release is registered; refusing to create a new tenant from a Dockerfile build',
        );
      }
      const deployResult = release
        ? await createStoreImageDeployment({
            slug: store.slug,
            domain: store.base_url,
            deploymentName: store.deployment_name ?? `${clientSlug}-${store.name}`,
            clientSlug,
            release,
            controlPlaneToken: store.control_plane_token,
            onCreated: ({ coolifyUuid: createdUuid, volumeName: createdVolume }) => {
              coolifyUuid = createdUuid;
              volumeName = createdVolume;
              imageRelease = release;
              setStoreDeployStatus(storeId, 'provisioning', {
                coolifyUuid: createdUuid,
                volumeName: createdVolume,
              });
              recordProvisionedRelease('store', storeId, release, createdUuid, createdVolume);
            },
          })
        : await createStoreDeployment({
            slug: store.slug,
            domain: store.base_url,
            deploymentName: store.deployment_name ?? `${clientSlug}-${store.name}`,
            // Deployments live under the client that owns them, so a single-store
            // client that later becomes multi-store grows a subtree rather than
            // moving its existing data. A store with no client is its own directory.
            clientSlug,
            controlPlaneToken: store.control_plane_token,
          });
      coolifyUuid = deployResult.coolifyUuid;
      volumeName = deployResult.volumeName;
      setStoreDeployStatus(storeId, 'provisioning', { coolifyUuid, volumeName });
      if (release) {
        imageRelease = release;
        recordProvisionedRelease('store', storeId, release, coolifyUuid, volumeName);
        imageDeploymentUuid = await triggerDeploy(coolifyUuid, true);
      }
    } else {
      // Re-trigger deploy on existing Coolify app
      await triggerDeploy(coolifyUuid);
    }

    // 2. Verify the deployment the image path actually started. The public
    // health endpoint alone is not proof: the release's version/revision must
    // be the one the new container reports.
    if (imageRelease) {
      await verifyImageDeployment(coolifyUuid, imageRelease, imageDeploymentUuid, store.base_url);
    } else {
      const isUp = await waitForStoreHealth(store.base_url);
      if (!isUp) {
        throw new Error(
          `Store ${store.slug} timed out waiting for health check at ${store.base_url}`,
        );
      }
    }

    // 3. Bootstrap initial store admin user if email was specified — the
    // outlet receives the one-time password by email when SMTP allows; it is
    // never stored, so a failed delivery is logged for the operator to re-issue.
    if (adminEmail) {
      const tempPass = generateAdminPassword();
      const adminCreated = await bootstrapStoreAdmin(store, adminEmail, tempPass);
      if (adminCreated) {
        const delivery = await trySendAdminCredentialsEmail({
          surface: store.name,
          loginUrl: store.base_url,
          adminEmail,
          tempPassword: tempPass,
        });
        logger.info(
          delivery.emailed
            ? `Initial admin bootstrapped for ${store.slug} (${adminEmail}); credentials emailed`
            : `Initial admin bootstrapped for ${store.slug} (${adminEmail}); credentials email pending: ${delivery.emailError}`,
        );
      }
    }

    // 4. Initial configure & licence push
    try {
      const cfgBody = await pushTerminals(store);
      recordConfigResult(store.id, { status: 'ok', snapshot: cfgBody });
    } catch (e) {
      recordConfigResult(store.id, {
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
      logger.warn(`Initial terminal push for ${store.slug} pending: ${e}`);
    }

    try {
      await deliverStoreLicence(store);
      recordLicencePush(store.id, 'ok');
    } catch (e) {
      logger.warn(`Initial licence push for ${store.slug} pending: ${e}`);
    }

    setStoreDeployStatus(storeId, 'deployed');
    if (imageRelease) setTenantReleaseState('store', storeId, 'healthy');
    logger.info(`Store ${store.slug} successfully provisioned and deployed via Coolify!`);
  } catch (err: any) {
    logger.error(`Coolify provisioning failed for store ${store.slug}: ${err?.message || err}`);
    setStoreDeployStatus(storeId, 'failed', {
      error: err?.message ? String(err.message) : String(err),
    });
    if (imageRelease) setTenantReleaseState('store', storeId, 'failed');
  }
}
