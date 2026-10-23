import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { licencePublicKey, licenceKeyId } from './licenceSigner.js';
import {
  imageNameFor,
  imageReferenceFor,
  imageTagFor,
  type ImageRelease,
} from './releaseCatalog.js';
import { assertCreatedApplicationScope, assertStagingCreationScope } from './applicationGuard.js';

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
  /** Optional exact destination for staging isolation. */
  destinationUuid: string | null;
}

export const readCoolifyConfig = (): CoolifyConfig | null => {
  const apiUrl = process.env.COOLIFY_API_URL?.replace(/\/+$/, '');
  const apiToken = process.env.COOLIFY_API_TOKEN;
  const projectUuid = process.env.COOLIFY_PROJECT_UUID;
  const serverUuid = process.env.COOLIFY_SERVER_UUID;
  const githubAppUuid = process.env.COOLIFY_GITHUB_APP_UUID;
  const destinationUuid = process.env.COOLIFY_DESTINATION_UUID?.trim() || null;
  if (!apiUrl || !apiToken || !projectUuid || !serverUuid || !githubAppUuid) return null;
  return { apiUrl, apiToken, projectUuid, serverUuid, githubAppUuid, destinationUuid };
};

export const isCoolifyConfigured = (): boolean => readCoolifyConfig() !== null;

export const generateSecureSecret = (bytes = 32): string =>
  crypto.randomBytes(bytes).toString('hex');

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
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      method,
      // redirect: 'error' — the Coolify API token must never follow a redirect
      // to another destination.
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // undici reports a refused redirect as TypeError "fetch failed" with the
    // real reason in cause.message ("unexpected redirect") — check both.
    const cause = (err as { cause?: { message?: string } } | null)?.cause?.message ?? '';
    if (/redirect/i.test(detail) || /redirect/i.test(cause)) {
      throw new CoolifyError(
        `Coolify ${method} ${path} refused to follow a redirect — the API token is never forwarded to another destination`,
      );
    }
    throw err;
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error body
  }
  if (!res.ok) {
    const body = data as {
      message?: string;
      detail?: string;
      errors?: Record<string, string[]>;
    } | null;
    const detail = body?.message ?? body?.detail ?? `HTTP ${res.status}`;
    // Laravel validation failures carry the failing fields in `errors` —
    // without them a 422 reports only "Validation failed.", naming no rule.
    const fields = body?.errors
      ? Object.entries(body.errors)
          .map(([field, msgs]) => `${field}: ${msgs.join('; ')}`)
          .join(' | ')
      : null;
    throw new CoolifyError(
      `Coolify ${method} ${path} failed: ${detail}${fields ? ` (${fields})` : ''}`,
    );
  }
  return data;
};

// The tenant's real GitHub repo — its local clone is ~/apps/za-pos but the
// repo itself is vula-app; the old default named a repo that does not exist,
// and every store deployment died on create ("Repository not found").
const ZA_POS_REPO_URL =
  process.env.COOLIFY_ZA_POS_REPO_URL || 'https://github.com/hoosainmadhi/vula-app.git';
const ZA_POS_REPO_BRANCH = process.env.COOLIFY_ZA_POS_BRANCH || 'main';
const STORE_INTERNAL_PORT = '3000';

/** Root of the host-side data tree the fleet's bind-backed volumes live under. */
export const vulaDataRoot = (): string => process.env.VULA_DATA_ROOT || '/data/apps/vula-app';

/**
 * Where a deployment's `/data` lives on the host (migrated 2026-10-06):
 *   clients/<client>/stores/<store>/  ·  clients/<client>/head-office/
 * The volume NAME stays Coolify's storage key; this path is the bind target
 * `scripts/vula-bind-storage.sh` points that volume at, because Coolify
 * 4.3.23's API refuses to create binds itself.
 */
export const vulaHostPath = (kind: 'store' | 'ho', clientSlug: string, slug: string): string =>
  kind === 'ho'
    ? `${vulaDataRoot()}/clients/${clientSlug}/head-office`
    : `${vulaDataRoot()}/clients/${clientSlug}/stores/${slug}`;

/**
 * A Coolify-safe application name from the name the office typed.
 *
 * Lowercase, ASCII-ish, dashes between words, capped so a long merchant name
 * does not overflow Coolify's field. An empty result (a name made only of
 * punctuation, say) falls back to the slug at the call site.
 */
export const deploymentSlug = (name: string | undefined | null): string =>
  (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

export interface CreateServiceResult {
  coolifyUuid: string;
  volumeName: string;
  /** Canonical host directory for this deployment's `/data` (see vulaHostPath). */
  hostPath: string;
  controlPlaneToken: string;
  jwtSecret: string;
  /** Present on the shared-image path; absent on the legacy Dockerfile path. */
  deploymentUuid?: string | null;
}

interface DeploymentSpec {
  slug: string;
  domain: string;
  /**
   * The human name the office gave the deployment (a store's own name, or the
   * Head Office's). Used for the Coolify application name so the fleet reads
   * `za-pos-johannesburg`, not `za-pos-super-stores-1`; the slug stays the
   * stable key for the domain, volume and directory.
   */
  deploymentName?: string;
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
  // Coolify's display name, from the name the office typed. The slug remains
  // the key for the domain, volume and host directory — renaming a store later
  // must never move its database — but a fleet named `super-stores-1` tells an
  // operator nothing about which branch is which.
  const deployment = deploymentSlug(spec.deploymentName) || slug;

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
  // The volume name is what Coolify keys storage by, so it must be unique and
  // stable; the host path is where the bind lives once the volume is pointed at
  // it (see vulaHostPath and scripts/vula-bind-storage.sh).
  const volumeName = `vula-${spec.kind}-${slug}-sqlite-db`;
  const hostPath = vulaHostPath(spec.kind, spec.clientSlug, slug);
  try {
    await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/storages`, {
      type: 'persistent',
      name: volumeName,
      mount_path: '/data',
      host_path: hostPath,
    });
  } catch (err) {
    // Coolify 4.3.23 refuses API-created bind mounts outright ("host_path is
    // not allowed"), so persistence comes from the named volume, and a host
    // step points that volume at the client tree:
    //   scripts/vula-bind-storage.sh <app-uuid> <volume-name> <host-path>
    if (!(err instanceof CoolifyError)) throw err;
    logger.warn(
      `Coolify refused a host-path volume for ${slug} — named volume ${volumeName} created; ` +
        `run scripts/vula-bind-storage.sh ${coolifyUuid} ${volumeName} ${hostPath} on the host`,
    );
    await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/storages`, {
      type: 'persistent',
      name: volumeName,
      mount_path: '/data',
    });
  }

  // Trigger deployment
  await request(
    config,
    'POST',
    `${API_VERSION_PATH}/deploy?uuid=${encodeURIComponent(coolifyUuid)}&force=false`,
    { force: false },
  );

  logger.info(`Provisioned Coolify deployment ${coolifyUuid} for ${slug} (${cleanDomain})`);
  return { coolifyUuid, volumeName, hostPath, controlPlaneToken, jwtSecret };
};

/**
 * Provisions a new store container deployment in Coolify (the store POS image,
 * built from the repo-root Dockerfile).
 */
export async function createStoreDeployment(input: {
  slug: string;
  domain: string;
  deploymentName?: string;
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
    deploymentName: input.deploymentName,
    kind: 'store',
    clientSlug: input.clientSlug,
    appName: 'za-pos',
    // Coolify 4.3.23 validates dockerfile_location as a path: the bare
    // 'Dockerfile' the 4.3.10-era payload sent is refused 422.
    dockerfileLocation: '/Dockerfile',
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
  deploymentName?: string;
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
    deploymentName: input.deploymentName,
    kind: 'ho',
    clientSlug: input.clientSlug,
    appName: 'vula-ho',
    dockerfileLocation: '/head-office/Dockerfile',
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
export async function triggerDeploy(coolifyUuid: string, force = false): Promise<string | null> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  const body = (await request(
    config,
    'POST',
    `${API_VERSION_PATH}/deploy?uuid=${encodeURIComponent(coolifyUuid)}&force=${force ? 'true' : 'false'}`,
    { force },
  )) as {
    deployments?: Array<{ deployment_uuid?: string }>;
    deployment_uuid?: string;
  } | null;
  return body?.deployments?.[0]?.deployment_uuid ?? body?.deployment_uuid ?? null;
}

/** Connectivity probe for scripts/coolify-probe.ts — verifies URL, token and
 *  that the API answers, before the first provisioning depends on them. The
 *  optimed control plane ships the same check (`npm run probe`); without it a
 *  misconfigured Coolify integration surfaces only mid-onboarding, as a failed
 *  store deployment. */
export const probeCoolify = async (): Promise<{ version: string | null; message: string }> => {
  const config = readCoolifyConfig();
  if (!config) {
    return {
      version: null,
      message:
        'Coolify is not configured (COOLIFY_API_URL / COOLIFY_API_TOKEN / COOLIFY_PROJECT_UUID / COOLIFY_SERVER_UUID / COOLIFY_GITHUB_APP_UUID)',
    };
  }
  try {
    // /api/v1/version returns a plain-text version (e.g. "4.3.10"), not JSON.
    const res = await fetch(`${config.apiUrl}${API_VERSION_PATH}/version`, {
      redirect: 'error',
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    if (!res.ok) return { version: null, message: `HTTP ${res.status}` };
    const version = (await res.text()).trim();
    return { version, message: 'Connected' };
  } catch (err) {
    // undici reports a refused redirect as TypeError "fetch failed" with the
    // real reason in cause.message ("unexpected redirect") — check both, and
    // name the policy rather than the transport failure.
    const message = err instanceof Error ? err.message : 'Probe failed';
    const cause = (err as { cause?: { message?: string } } | null)?.cause?.message ?? '';
    return {
      version: null,
      message:
        /redirect/i.test(message) || /redirect/i.test(cause)
          ? 'Refused to follow a redirect — the API token is never forwarded to another destination'
          : message,
    };
  }
};

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

// --- Shared-image (GHCR digest) deployments ---------------------------------

export interface ImageDeploymentResult extends CreateServiceResult {
  imageDigest: string;
  imageTag: string;
  /** Coolify's deployment queue id, used to verify the actual deployment. */
  deploymentUuid: string | null;
}

interface ImageDeploymentSpec {
  kind: 'store' | 'ho';
  slug: string;
  domain: string;
  deploymentName?: string;
  clientSlug: string;
  release: ImageRelease;
  controlPlaneToken?: string;
  jwtSecret?: string;
  /** Called immediately after the app UUID exists, before env/storage. */
  onCreated?: (created: { coolifyUuid: string; volumeName: string; hostPath: string }) => void;
}

const imageEnvVars = (
  spec: ImageDeploymentSpec,
  controlPlaneToken: string,
  jwtSecret: string,
): Array<{ key: string; value: string }> => {
  const common = [
    { key: 'PORT', value: '3000' },
    { key: 'NODE_ENV', value: 'production' },
    { key: 'JWT_SECRET', value: jwtSecret },
    { key: 'CONTROL_PLANE_TOKEN', value: controlPlaneToken },
    { key: 'LEASE_PUBLIC_KEY', value: licencePublicKey() },
    { key: 'LEASE_KEY_ID', value: licenceKeyId() },
    { key: 'APP_URL', value: `https://${spec.domain.replace(/^https?:\/\//, '')}` },
    { key: 'TRUST_PROXY', value: '1' },
  ];
  if (spec.kind === 'store') {
    return [
      ...common,
      { key: 'DB_PATH', value: '/data/za-pos.db' },
      { key: 'BACKUP_DIR', value: '/data/backups' },
      { key: 'IMAGE_DIR', value: '/data/images' },
    ];
  }
  return [
    ...common,
    { key: 'HO_DB_PATH', value: '/data/head-office.db' },
    { key: 'HO_JWT_SECRET', value: jwtSecret },
  ];
};

/**
 * Create a Docker Image application from an immutable GHCR digest. This is the
 * shared-image path: no Git repository, no Dockerfile, no build context and no
 * tenant environment passed as a build argument. The image is pinned by the
 * digest in the image name; the tag field is not used for a moving tag.
 */
const deployImageFromSpec = async (spec: ImageDeploymentSpec): Promise<ImageDeploymentResult> => {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');

  const controlPlaneToken = spec.controlPlaneToken || generateSecureSecret(32);
  const jwtSecret = spec.jwtSecret || generateSecureSecret(32);
  const cleanDomain = spec.domain.replace(/^https?:\/\//, '');
  const deployment = deploymentSlug(spec.deploymentName) || spec.slug;
  const appName = spec.kind === 'store' ? 'za-pos' : 'vula';
  const expectedName = `${appName}-${deployment}`;

  assertStagingCreationScope({
    projectUuid: config.projectUuid,
    serverUuid: config.serverUuid,
    destinationUuid: config.destinationUuid,
    expectedName,
    domain: cleanDomain,
  });

  const created = (await request(config, 'POST', `${API_VERSION_PATH}/applications/dockerimage`, {
    project_uuid: config.projectUuid,
    server_uuid: config.serverUuid,
    ...(config.destinationUuid ? { destination_uuid: config.destinationUuid } : {}),
    environment_name: 'production',
    name: expectedName,
    docker_registry_image_name: imageReferenceFor(spec.release),
    ports_exposes: STORE_INTERNAL_PORT,
    domains: `https://${cleanDomain}`,
    autogenerate_domain: false,
    health_check_enabled: true,
    health_check_type: 'http',
    health_check_path: '/health',
    health_check_port: 3000,
    health_check_host: '127.0.0.1',
    health_check_method: 'GET',
    health_check_scheme: 'http',
    health_check_return_code: 200,
    health_check_start_period: 5,
    health_check_interval: 5,
    health_check_timeout: 5,
    health_check_retries: 10,
    is_auto_deploy_enabled: false,
    is_force_https_enabled: true,
    instant_deploy: false,
  })) as { uuid?: string };

  const coolifyUuid = created.uuid;
  if (!coolifyUuid) throw new CoolifyError('Coolify create dockerimage returned no uuid');
  const volumeName = `vula-${spec.kind}-${spec.slug}-sqlite-db`;
  const hostPath = vulaHostPath(spec.kind, spec.clientSlug, spec.slug);
  spec.onCreated?.({ coolifyUuid, volumeName, hostPath });

  // Persist the UUID first (so a retry cannot create a duplicate), then prove
  // that Coolify created the expected name/domain/kind in the staging project.
  if (env.stagingMode) {
    assertCreatedApplicationScope({
      expectedName,
      domain: cleanDomain,
      application: await getApplication(coolifyUuid),
    });
  }

  const values = imageEnvVars(spec, controlPlaneToken, jwtSecret).map((item) => ({
    ...item,
    is_runtime: true,
    is_buildtime: false,
    is_preview: false,
  }));
  await request(config, 'PATCH', `${API_VERSION_PATH}/applications/${coolifyUuid}/envs/bulk`, {
    data: values,
  });

  try {
    await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/storages`, {
      type: 'persistent',
      name: volumeName,
      mount_path: '/data',
      host_path: hostPath,
    });
  } catch (err) {
    if (!(err instanceof CoolifyError)) throw err;
    logger.warn(
      `Coolify refused a host-path volume for ${spec.slug} — named volume ${volumeName} created; ` +
        `run scripts/vula-bind-storage.sh ${coolifyUuid} ${volumeName} ${hostPath} on the host`,
    );
    await request(config, 'POST', `${API_VERSION_PATH}/applications/${coolifyUuid}/storages`, {
      type: 'persistent',
      name: volumeName,
      mount_path: '/data',
    });
  }

  logger.info(
    `Created shared-image ${spec.kind} ${coolifyUuid} for ${spec.slug} ` +
      `(${spec.release.tag} / ${spec.release.digest.slice(0, 19)}…); deploy is a separate step`,
  );
  return {
    coolifyUuid,
    volumeName,
    hostPath,
    controlPlaneToken,
    jwtSecret,
    imageDigest: spec.release.digest,
    imageTag: spec.release.tag,
    deploymentUuid: null,
  };
};

export async function createStoreImageDeployment(input: {
  slug: string;
  domain: string;
  deploymentName?: string;
  clientSlug: string;
  release: ImageRelease;
  controlPlaneToken?: string;
  jwtSecret?: string;
  onCreated?: (created: { coolifyUuid: string; volumeName: string; hostPath: string }) => void;
}): Promise<ImageDeploymentResult> {
  return deployImageFromSpec({ ...input, kind: 'store' });
}

export async function createHeadOfficeImageDeployment(input: {
  slug: string;
  domain: string;
  deploymentName?: string;
  clientSlug: string;
  release: ImageRelease;
  controlPlaneToken?: string;
  jwtSecret?: string;
  onCreated?: (created: { coolifyUuid: string; volumeName: string; hostPath: string }) => void;
}): Promise<ImageDeploymentResult> {
  return deployImageFromSpec({ ...input, kind: 'ho' });
}

export interface CoolifyApplicationSummary {
  uuid: string;
  name?: string;
  status?: string;
  build_pack: string;
  fqdn?: string | null;
  project_uuid?: string | null;
  environment_id?: number | null;
  destination_id?: number | null;
  docker_registry_image_name: string | null;
  docker_registry_image_tag: string | null;
}

export async function getApplication(coolifyUuid: string): Promise<CoolifyApplicationSummary> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  return (await request(
    config,
    'GET',
    `${API_VERSION_PATH}/applications/${coolifyUuid}`,
  )) as CoolifyApplicationSummary;
}

export interface ApplicationStorageSummary {
  type: 'persistent' | 'file';
  mount_path: string;
  name?: string | null;
  is_directory?: boolean;
}

/**
 * The storages attached to an application. Used before an image change to prove
 * the tenant's `/data` volume still exists; without it a new image could start
 * against an empty directory and create a replacement database.
 */
export async function getApplicationStorages(
  coolifyUuid: string,
): Promise<ApplicationStorageSummary[]> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  const body = (await request(
    config,
    'GET',
    `${API_VERSION_PATH}/applications/${coolifyUuid}/storages`,
  )) as {
    persistent_storages?: Array<{ mount_path?: string; name?: string | null }>;
    file_storages?: Array<{ mount_path?: string; is_directory?: boolean }>;
  } | null;
  return [
    ...(body?.persistent_storages ?? []).map((s) => ({
      type: 'persistent' as const,
      mount_path: s.mount_path ?? '',
      name: s.name ?? null,
    })),
    ...(body?.file_storages ?? []).map((s) => ({
      type: 'file' as const,
      mount_path: s.mount_path ?? '',
      is_directory: s.is_directory,
    })),
  ];
}

export interface CoolifyDeploymentSummary {
  deployment_uuid: string;
  status: string;
  finished_at?: string | null;
}

/**
 * The deployment record Coolify keeps. A 200 from POST /deploy only means the
 * job was accepted; the controller must read this until a terminal status.
 */
export async function getDeployment(deploymentUuid: string): Promise<CoolifyDeploymentSummary> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  return (await request(
    config,
    'GET',
    `${API_VERSION_PATH}/deployments/${deploymentUuid}`,
  )) as CoolifyDeploymentSummary;
}

/** Latest deployment records for an application, used to recover a lost trigger id. */
export async function getApplicationDeployments(
  coolifyUuid: string,
): Promise<CoolifyDeploymentSummary[]> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  const body = (await request(
    config,
    'GET',
    `${API_VERSION_PATH}/deployments/applications/${coolifyUuid}`,
  )) as CoolifyDeploymentSummary[] | { deployments?: CoolifyDeploymentSummary[] } | null;
  if (Array.isArray(body)) return body;
  return body?.deployments ?? [];
}

/**
 * Pin an existing application to a release digest. The application must already
 * be a Docker Image app; converting a Dockerfile app in place is refused (the
 * caller must use a blue/green migration) so a live database is never attached
 * to a half-switched deployment.
 */
export async function updateApplicationImage(
  coolifyUuid: string,
  release: ImageRelease,
): Promise<void> {
  const config = readCoolifyConfig();
  if (!config) throw new CoolifyError('Coolify is not configured');
  // Coolify normalises a digest reference to `<name>@sha256` plus the hex tag.
  // Sending a plain repository name makes it pull `<name>:<hex>`, which does not
  // exist for a digest-only release.
  const digestName = `${imageNameFor(release.kind).split('@')[0]}@sha256`;
  await request(config, 'PATCH', `${API_VERSION_PATH}/applications/${coolifyUuid}`, {
    docker_registry_image_name: digestName,
    docker_registry_image_tag: imageTagFor(release),
  });
}

/** The exact image reference a tenant would pull for this release. */
export const releaseImageReference = (release: ImageRelease): string => imageReferenceFor(release);
