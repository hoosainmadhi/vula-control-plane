import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { licencePublicKey, licenceKeyId } from './licenceSigner.js';

/**
 * Coolify v1 REST API client for automated store & head-office provisioning.
 *
 * When COOLIFY_API_URL and tokens are set, the control plane can auto-deploy
 * new store containers on Coolify with persistent Docker volumes and generated
 * secrets (Phase F2).
 *
 * When unconfigured, the control plane falls back gracefully to manual provisioning.
 */

const API_VERSION_PATH = '/api/v1';

export interface CoolifyConfig {
  apiUrl: string;
  apiToken: string;
  projectUuid: string;
  serverUuid: string;
  githubAppUuid: string;
}

export const readCoolifyConfig = (): CoolifyConfig | null => {
  const apiUrl = process.env.COOLIFY_API_URL?.replace(/\/+$/, '');
  const apiToken = process.env.COOLIFY_API_TOKEN;
  const projectUuid = process.env.COOLIFY_PROJECT_UUID;
  const serverUuid = process.env.COOLIFY_SERVER_UUID;
  const githubAppUuid = process.env.COOLIFY_GITHUB_APP_UUID;
  if (!apiUrl || !apiToken || !projectUuid || !serverUuid || !githubAppUuid) return null;
  return { apiUrl, apiToken, projectUuid, serverUuid, githubAppUuid };
};

export const isCoolifyConfigured = (): boolean => readCoolifyConfig() !== null;

export const generateSecureSecret = (bytes = 32): string => crypto.randomBytes(bytes).toString('hex');

export class CoolifyError extends Error {
  status = 502;
  constructor(message: string) {
    super(message);
    this.name = 'CoolifyError';
  }
}

const request = async (
  config: CoolifyConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> => {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error body
  }
  if (!res.ok) {
    const detail =
      (data as { message?: string; detail?: string })?.message ??
      (data as { detail?: string })?.detail ??
      `HTTP ${res.status}`;
    throw new CoolifyError(`Coolify ${method} ${path} failed: ${detail}`);
  }
  return data;
};

const ZA_POS_REPO_URL = process.env.COOLIFY_ZA_POS_REPO_URL || 'https://github.com/hoosainmadhi/za-pos.git';
const ZA_POS_REPO_BRANCH = process.env.COOLIFY_ZA_POS_BRANCH || 'main';
const STORE_INTERNAL_PORT = '3000';

export interface CreateServiceResult {
  coolifyUuid: string;
  volumeName: string;
  controlPlaneToken: string;
  jwtSecret: string;
}

interface DeploymentSpec {
  slug: string;
  domain: string;
  /**
   * Which subtree of the host tree this deployment belongs to.
   * See `za-pos/prompts/deploy-production-vula-app.md` §2.
   */
  kind: 'store' | 'ho';
  /**
   * The owning client's slug. Deployments are grouped per client so a
   * single-store client that later becomes multi-store simply grows a subtree —
   * its existing branch directory never moves. A store with no client passes its
   * own slug rather than inventing a client name.
   */
  clientSlug: string;
  controlPlaneToken?: string;
  jwtSecret?: string;
  /** App name prefix and volume prefix (`za-pos-<slug>` vs `vula-ho-<slug>`). */
  appName: string;
  /** Dockerfile inside the za-pos repo; both images come from the same repo. */
  dockerfileLocation: string;
  envVars: Array<{ key: string; value: string }>;
}

const deployFromSpec = async (spec: DeploymentSpec): Promise<CreateServiceResult> => {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');

  const { slug, domain } = spec;
  const controlPlaneToken = spec.controlPlaneToken || generateSecureSecret(32);
  const jwtSecret = spec.jwtSecret || generateSecureSecret(32);

  const cleanDomain = domain.replace(/^https?:\/\//, '');

  const created = (await request(
    config,
    'POST',
    `${API_VERSION_PATH}/applications/private-github-app`,
    {
      project_uuid: config.projectUuid,
      server_uuid: config.serverUuid,
      environment_name: 'production',
      github_app_uuid: config.githubAppUuid,
      git_repository: ZA_POS_REPO_URL,
      git_branch: ZA_POS_REPO_BRANCH,
      build_pack: 'dockerfile',
      dockerfile_location: spec.dockerfileLocation,
      ports_exposes: STORE_INTERNAL_PORT,
      domains: `https://${cleanDomain}`,
      name: `${spec.appName}-${slug}`,
      is_auto_deploy_enabled: true,
    },
  )) as { uuid: string };

  const coolifyUuid = created.uuid;
  if (!coolifyUuid) throw new CoolifyError('Coolify create application returned no uuid');

  const envVars = [
    ...spec.envVars,
    { key: 'LEASE_PUBLIC_KEY', value: licencePublicKey() },
    { key: 'LEASE_KEY_ID', value: licenceKeyId() },
    { key: 'APP_URL', value: `https://${cleanDomain}` },
  ];

  for (const env of envVars) {
    await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/envs`, {
      key: env.key,
      value: env.value,
      is_preview: false,
      is_literal: true,
    });
  }

  // Persistent volume mount
  // One directory per deployment, under the client that owns it, named for the
  // convention already on the host (`optimed-<slug>-sqlite-db`). The volume name
  // is what Coolify keys storage by, so it must be unique and stable.
  const volumeName = `vula-${spec.kind}-${slug}-sqlite-db`;
  const hostPath = `/data/apps/vula-app/${spec.kind}/${spec.clientSlug}/${slug}-sqlite-db`;
  await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/storages`, {
    type: 'persistent',
    name: volumeName,
    mount_path: '/data',
    host_path: hostPath,
  });

  // Trigger deployment
  await request(
    config,
    'POST',
    `${API_VERSION_PATH}/deploy?uuid=${encodeURIComponent(coolifyUuid)}&force=false`,
    { force: false },
  );

  logger.info(`Provisioned Coolify deployment ${coolifyUuid} for ${slug} (${cleanDomain})`);
  return { coolifyUuid, volumeName, controlPlaneToken, jwtSecret };
};

/**
 * Provisions a new store container deployment in Coolify (the store POS image,
 * built from the repo-root Dockerfile).
 */
export async function createStoreDeployment(input: {
  slug: string;
  domain: string;
  /** The owning client's slug (the store's own slug when it has no client). */
  clientSlug: string;
  controlPlaneToken?: string;
  jwtSecret?: string;
}): Promise<CreateServiceResult> {
  const { slug, domain } = input;
  const controlPlaneToken = input.controlPlaneToken || generateSecureSecret(32);
  const jwtSecret = input.jwtSecret || generateSecureSecret(32);

  return deployFromSpec({
    slug,
    domain,
    kind: 'store',
    clientSlug: input.clientSlug,
    appName: 'za-pos',
    dockerfileLocation: 'Dockerfile',
    controlPlaneToken,
    jwtSecret,
    envVars: [
      { key: 'PORT', value: '3000' },
      { key: 'NODE_ENV', value: 'production' },
      { key: 'DB_PATH', value: '/data/za-pos.db' },
      // Snapshots go where BACKUP_DIR points: without it they resolve inside the
      // container and the next rebuild destroys them, which is worse than having
      // no backups at all because the store believes it has them.
      { key: 'BACKUP_DIR', value: '/data/backups' },
      { key: 'JWT_SECRET', value: jwtSecret },
      { key: 'CONTROL_PLANE_TOKEN', value: controlPlaneToken },
    ],
  });
}

/**
 * Provisions the merchant's Head Office container (built from
 * head-office/Dockerfile in the same za-pos repo — a different application from
 * the store POS, with its own database and env).
 */
export async function createHeadOfficeDeployment(input: {
  slug: string;
  domain: string;
  /** The merchant this panel belongs to. */
  clientSlug: string;
  controlPlaneToken?: string;
  jwtSecret?: string;
}): Promise<CreateServiceResult> {
  const { slug, domain } = input;
  const controlPlaneToken = input.controlPlaneToken || generateSecureSecret(32);
  const jwtSecret = input.jwtSecret || generateSecureSecret(32);

  return deployFromSpec({
    slug,
    domain,
    kind: 'ho',
    clientSlug: input.clientSlug,
    appName: 'vula-ho',
    dockerfileLocation: 'head-office/Dockerfile',
    controlPlaneToken,
    jwtSecret,
    envVars: [
      { key: 'PORT', value: '3000' },
      { key: 'NODE_ENV', value: 'production' },
      { key: 'HO_DB_PATH', value: '/data/head-office.db' },
      { key: 'HO_JWT_SECRET', value: jwtSecret },
      { key: 'CONTROL_PLANE_TOKEN', value: controlPlaneToken },
    ],
  });
}

/** Re-triggers deployment for an existing application. */
export async function triggerDeploy(coolifyUuid: string): Promise<void> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  await request(
    config,
    'POST',
    `${API_VERSION_PATH}/deploy?uuid=${encodeURIComponent(coolifyUuid)}&force=false`,
    { force: false },
  );
}

/** Stops an application container. */
export async function stopApplication(coolifyUuid: string): Promise<void> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/stop`);
}

/** Starts an application container. */
export async function startApplication(coolifyUuid: string): Promise<void> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/start`);
}

/** Deletes an application in Coolify. */
export async function deleteApplication(coolifyUuid: string): Promise<void> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  await request(config, 'DELETE', `${API_VERSION_PATH}/applications/${coolifyUuid}`);
}
