import { env } from '../config/env.js';
import { HttpError } from '../utils/errors.js';

export type ApplicationKind = 'store' | 'ho';

export interface ApplicationIdentity {
  uuid: string;
  name?: string | null;
  fqdn?: string | null;
  build_pack?: string | null;
  project_uuid?: string | null;
}

interface StagingCreationScope {
  projectUuid: string;
  serverUuid: string;
  destinationUuid: string | null;
  expectedName: string;
  domain: string;
}

const normaliseHost = (domain: string): string =>
  new URL(/^https?:\/\//.test(domain) ? domain : `https://${domain}`).hostname.toLowerCase();

const fqdnHosts = (fqdn: string | null | undefined): string[] =>
  (fqdn ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return normaliseHost(value);
      } catch {
        return '';
      }
    })
    .filter(Boolean);

const assertStagingDomain = (domain: string, label: string): void => {
  if (!env.stagingDomainSuffix) {
    throw new HttpError(
      409,
      'staging_scope_missing: VULA_STAGING_DOMAIN_SUFFIX is not configured; refusing to create or modify a staging application',
      'staging_scope_missing',
    );
  }
  if (!env.stagingDomainPrefix) {
    throw new HttpError(
      409,
      'staging_scope_missing: VULA_STAGING_DOMAIN_PREFIX is not configured; refusing to create or modify a staging application',
      'staging_scope_missing',
    );
  }
  const host = normaliseHost(domain);
  const suffix = env.stagingDomainSuffix.replace(/^\./, '').toLowerCase();
  const first = host.split('.')[0] ?? '';
  if (
    (host !== suffix && !host.endsWith(`.${suffix}`)) ||
    !first.startsWith(env.stagingDomainPrefix)
  ) {
    throw new HttpError(
      409,
      `staging_domain_refused: ${label} ${host} is outside the approved staging domain pattern (*${env.stagingDomainSuffix} with ${env.stagingDomainPrefix}* prefix)`,
      'staging_domain_refused',
    );
  }
};

const assertStagingName = (name: string | null | undefined, label: string): void => {
  if (!env.stagingAppPrefixes.length) {
    throw new HttpError(
      409,
      'staging_scope_missing: VULA_STAGING_APP_PREFIXES is not configured; refusing to create or modify a staging application',
      'staging_scope_missing',
    );
  }
  if (!name || !env.stagingAppPrefixes.some((prefix) => name.startsWith(prefix))) {
    throw new HttpError(
      409,
      `staging_name_refused: ${label} ${name ?? '(no name)'} is outside the approved staging app prefixes (${env.stagingAppPrefixes.join(', ')})`,
      'staging_name_refused',
    );
  }
};

/**
 * Guard the Coolify call that creates a staging application. The checks are
 * deliberately local to the inputs and the configured Coolify scope; they do
 * not prove ownership after creation. `assertCreatedApplicationScope` does that.
 */
export const assertStagingCreationScope = (scope: StagingCreationScope): void => {
  if (!env.stagingMode) return;
  if (!env.stagingProjectUuid || !env.stagingServerUuid || !env.stagingDestinationUuid) {
    throw new HttpError(
      409,
      'staging_scope_missing: VULA_STAGING_PROJECT_UUID, VULA_STAGING_SERVER_UUID and VULA_STAGING_DESTINATION_UUID are required in staging mode',
      'staging_scope_missing',
    );
  }
  if (scope.projectUuid !== env.stagingProjectUuid) {
    throw new HttpError(
      409,
      `staging_project_refused: Coolify is configured for project ${scope.projectUuid}, not the approved staging project ${env.stagingProjectUuid}`,
      'staging_project_refused',
    );
  }
  if (scope.serverUuid !== env.stagingServerUuid) {
    throw new HttpError(
      409,
      `staging_server_refused: Coolify is configured for server ${scope.serverUuid}, not the approved staging server ${env.stagingServerUuid}`,
      'staging_server_refused',
    );
  }
  if (scope.destinationUuid !== env.stagingDestinationUuid) {
    throw new HttpError(
      409,
      'staging_destination_refused: COOLIFY_DESTINATION_UUID does not match VULA_STAGING_DESTINATION_UUID',
      'staging_destination_refused',
    );
  }
  assertStagingName(scope.expectedName, 'application');
  assertStagingDomain(scope.domain, 'domain');
};

/** Verify what Coolify actually created, after the UUID is persisted. */
export const assertCreatedApplicationScope = (input: {
  expectedName: string;
  domain: string;
  application: ApplicationIdentity;
}): void => {
  if (!env.stagingMode) return;
  if (input.application.name !== input.expectedName) {
    throw new HttpError(
      409,
      `staging_app_name_mismatch: Coolify created "${input.application.name ?? '(no name)'}", expected "${input.expectedName}"`,
      'staging_app_name_mismatch',
    );
  }
  if (input.application.build_pack !== 'dockerimage') {
    throw new HttpError(
      409,
      `staging_app_kind_mismatch: ${input.application.uuid} is a ${input.application.build_pack ?? 'unknown'} app, not a Docker Image app`,
      'staging_app_kind_mismatch',
    );
  }
  if (input.application.project_uuid && input.application.project_uuid !== env.stagingProjectUuid) {
    throw new HttpError(
      409,
      'staging_project_refused: Coolify placed the application outside the approved staging project',
      'staging_project_refused',
    );
  }
  const hosts = fqdnHosts(input.application.fqdn);
  if (!hosts.includes(normaliseHost(input.domain))) {
    throw new HttpError(
      409,
      `staging_domain_mismatch: Coolify reports ${input.application.fqdn ?? '(no domain)'}, expected ${input.domain}`,
      'staging_domain_mismatch',
    );
  }
  assertStagingName(input.application.name, 'application');
  assertStagingDomain(input.domain, 'domain');
};

/**
 * The UUID allowlist is the subsequent-modification boundary. In staging it is
 * mandatory even when NODE_ENV is not production, and the application must also
 * match the approved staging name/domain pattern.
 */
export const assertApplicationAllowed = (
  kind: ApplicationKind,
  application: ApplicationIdentity,
): void => {
  if ((env.isProduction || env.stagingMode) && env.allowedAppUuids.length === 0) {
    throw new HttpError(
      409,
      'application_allowlist_missing: VULA_ALLOWED_APP_UUIDS is not configured; refusing to modify an existing Coolify application',
      'application_allowlist_missing',
    );
  }
  if (env.allowedAppUuids.length && !env.allowedAppUuids.includes(application.uuid)) {
    throw new HttpError(
      409,
      `application_not_allowlisted: Coolify application ${application.uuid} is not in VULA_ALLOWED_APP_UUIDS; refusing to modify it`,
      'application_not_allowlisted',
    );
  }
  const prefix = kind === 'store' ? 'za-pos-' : 'vula-';
  if (!application.name || !application.name.startsWith(prefix)) {
    throw new HttpError(
      409,
      `application_not_vula: Coolify application ${application.uuid} is not a recognised ${kind === 'store' ? 'store' : 'Head Office'} app (${application.name ?? 'no name'}); refusing to modify it`,
      'application_not_vula',
    );
  }
  if (env.stagingMode) {
    assertStagingName(application.name, 'application');
    if (!application.fqdn) {
      throw new HttpError(
        409,
        `staging_domain_missing: ${application.uuid} has no reported FQDN; refusing to modify it in staging`,
        'staging_domain_missing',
      );
    }
    for (const host of fqdnHosts(application.fqdn)) assertStagingDomain(host, 'domain');
  }
};
