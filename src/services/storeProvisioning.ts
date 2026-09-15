import crypto from 'node:crypto';
import {
  getStoreById,
  setStoreDeployStatus,
  type StoreRecord,
} from '../config/registryDb.js';
import {
  createStoreDeployment,
  isCoolifyConfigured,
  triggerDeploy,
  CoolifyError,
} from './coolify.js';
import { pushTerminals, pushLicence } from './storeClient.js';
import { issueLicence } from './licenceSigner.js';
import { entitlementsFor } from './subscriptions.js';
import { terminalAllowance } from './terminalLicences.js';
import { getCompanyById, nextLicenceSequence, recordLicencePush, recordConfigResult } from '../config/registryDb.js';

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
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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

  try {
    // 1. Create Coolify Application & Storage volume if not already created
    if (!coolifyUuid) {
      const deployResult = await createStoreDeployment({
        slug: store.slug,
        domain: store.base_url,
        // Deployments live under the client that owns them, so a single-store
        // client that later becomes multi-store grows a subtree rather than
        // moving its existing data. A store with no client is its own directory.
        clientSlug: clientSlugFor(store.company_id, store.slug),
        controlPlaneToken: store.control_plane_token,
      });
      coolifyUuid = deployResult.coolifyUuid;
      volumeName = deployResult.volumeName;
      setStoreDeployStatus(storeId, 'provisioning', { coolifyUuid, volumeName });
    } else {
      // Re-trigger deploy on existing Coolify app
      await triggerDeploy(coolifyUuid);
    }

    // 2. Poll for health
    const isUp = await waitForStoreHealth(store.base_url);
    if (!isUp) {
      throw new Error(`Store ${store.slug} timed out waiting for health check at ${store.base_url}`);
    }

    // 3. Bootstrap initial store admin user if email was specified
    if (adminEmail) {
      const tempPass = generateAdminPassword();
      const adminCreated = await bootstrapStoreAdmin(store, adminEmail, tempPass);
      if (adminCreated) {
        logger.info(`Initial admin bootstrapped for ${store.slug} (${adminEmail})`);
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
      const company = store.company_id ? getCompanyById(store.company_id) : null;
      const ent = entitlementsFor(company);
      const seq = nextLicenceSequence(store.id);
      const signed = issueLicence({
        sequence: seq,
        storeSlug: store.slug,
        storeName: store.name,
        companyId: ent.companyId,
        companyName: ent.companyName,
        planCode: ent.planCode,
        planName: ent.planName,
        features: ent.features,
        maxStores: ent.maxStores,
        maxTerminalsPerStore: ent.maxTerminalsPerStore,
        // The store's own licence allowance (its allocation, or what it is
        // already configured for before a subscription exists).
        maxTerminals: terminalAllowance(store).count,
        paidThrough: ent.paidThrough,
        billingState: ent.billingState,
      });
      await pushLicence(store, signed.token);
      recordLicencePush(store.id, 'ok');
    } catch (e) {
      logger.warn(`Initial licence push for ${store.slug} pending: ${e}`);
    }

    setStoreDeployStatus(storeId, 'deployed');
    logger.info(`Store ${store.slug} successfully provisioned and deployed via Coolify!`);
  } catch (err: any) {
    logger.error(`Coolify provisioning failed for store ${store.slug}: ${err?.message || err}`);
    setStoreDeployStatus(storeId, 'failed', { error: err?.message ? String(err.message) : String(err) });
  }
}
