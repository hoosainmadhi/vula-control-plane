import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { env } from '../config/env.js';
import {
  assertApplicationAllowed,
  assertCreatedApplicationScope,
  assertStagingCreationScope,
} from '../services/applicationGuard.js';

const original = {
  stagingMode: env.stagingMode,
  stagingProjectUuid: env.stagingProjectUuid,
  stagingServerUuid: env.stagingServerUuid,
  stagingDestinationUuid: env.stagingDestinationUuid,
  stagingAppPrefixes: [...env.stagingAppPrefixes],
  stagingDomainPrefix: env.stagingDomainPrefix,
  stagingDomainSuffix: env.stagingDomainSuffix,
  allowedAppUuids: [...env.allowedAppUuids],
};

const app = (over: Partial<{ uuid: string; name: string; fqdn: string }> = {}) => ({
  uuid: 'test-app-uuid',
  name: 'za-pos-m4-store-a',
  fqdn: 'https://m4-store-a.vula-app.co.za',
  build_pack: 'dockerimage',
  project_uuid: 'project-m4',
  ...over,
});

const scope = {
  projectUuid: 'project-m4',
  serverUuid: 'server-m4',
  destinationUuid: 'destination-m4',
  expectedName: 'za-pos-m4-store-a',
  domain: 'm4-store-a.vula-app.co.za',
};

beforeEach(() => {
  env.stagingMode = true;
  env.stagingProjectUuid = 'project-m4';
  env.stagingServerUuid = 'server-m4';
  env.stagingDestinationUuid = 'destination-m4';
  env.stagingAppPrefixes = ['za-pos-m4-', 'vula-m4-'];
  env.stagingDomainPrefix = 'm4-';
  env.stagingDomainSuffix = '.vula-app.co.za';
  env.allowedAppUuids = ['test-app-uuid'];
});

afterEach(() => {
  env.stagingMode = original.stagingMode;
  env.stagingProjectUuid = original.stagingProjectUuid;
  env.stagingServerUuid = original.stagingServerUuid;
  env.stagingDestinationUuid = original.stagingDestinationUuid;
  env.stagingAppPrefixes = [...original.stagingAppPrefixes];
  env.stagingDomainPrefix = original.stagingDomainPrefix;
  env.stagingDomainSuffix = original.stagingDomainSuffix;
  env.allowedAppUuids = [...original.allowedAppUuids];
});

describe('staging application creation boundary', () => {
  it('accepts the approved project, server, destination, name and domain', () => {
    expect(() => assertStagingCreationScope(scope)).not.toThrow();
  });

  it('refuses a different Coolify project', () => {
    expect(() => assertStagingCreationScope({ ...scope, projectUuid: 'other-project' })).toThrow(
      /staging_project_refused/,
    );
  });

  it('refuses a different Coolify server', () => {
    expect(() => assertStagingCreationScope({ ...scope, serverUuid: 'other-server' })).toThrow(
      /staging_server_refused/,
    );
  });

  it('refuses a different destination', () => {
    expect(() =>
      assertStagingCreationScope({ ...scope, destinationUuid: 'other-destination' }),
    ).toThrow(/staging_destination_refused/);
  });

  it('refuses an app name outside the staging prefixes', () => {
    expect(() =>
      assertStagingCreationScope({ ...scope, expectedName: 'za-pos-prod-store' }),
    ).toThrow(/staging_name_refused/);
  });

  it('refuses a domain outside the staging pattern', () => {
    expect(() =>
      assertStagingCreationScope({ ...scope, domain: 'super-stores-jhb.vula-app.co.za' }),
    ).toThrow(/staging_domain_refused/);
  });

  it('refuses a missing staging scope rather than silently allowing it', () => {
    env.stagingProjectUuid = null;
    expect(() => assertStagingCreationScope(scope)).toThrow(/staging_scope_missing/);
  });
});

describe('staging created-application verification', () => {
  it('accepts only the exact created name, kind, project and domain', () => {
    expect(() =>
      assertCreatedApplicationScope({
        expectedName: scope.expectedName,
        domain: scope.domain,
        application: app(),
      }),
    ).not.toThrow();
  });

  it('refuses a name changed by Coolify', () => {
    expect(() =>
      assertCreatedApplicationScope({
        expectedName: scope.expectedName,
        domain: scope.domain,
        application: app({ name: 'za-pos-m4-other' }),
      }),
    ).toThrow(/staging_app_name_mismatch/);
  });

  it('refuses a Dockerfile app created instead of a Docker Image app', () => {
    expect(() =>
      assertCreatedApplicationScope({
        expectedName: scope.expectedName,
        domain: scope.domain,
        application: { ...app(), build_pack: 'dockerfile' },
      }),
    ).toThrow(/staging_app_kind_mismatch/);
  });

  it('refuses an app placed in another project', () => {
    expect(() =>
      assertCreatedApplicationScope({
        expectedName: scope.expectedName,
        domain: scope.domain,
        application: { ...app(), project_uuid: 'other-project' },
      }),
    ).toThrow(/staging_project_refused/);
  });

  it('refuses a domain not reported by Coolify', () => {
    expect(() =>
      assertCreatedApplicationScope({
        expectedName: scope.expectedName,
        domain: scope.domain,
        application: app({ fqdn: 'https://other.vula-app.co.za' }),
      }),
    ).toThrow(/staging_domain_mismatch/);
  });
});

describe('staging existing-application allowlist', () => {
  it('requires a non-empty allowlist even outside NODE_ENV=production', () => {
    env.allowedAppUuids = [];
    expect(() => assertApplicationAllowed('store', app())).toThrow(/application_allowlist_missing/);
  });

  it('refuses an application not in the exact allowlist', () => {
    expect(() => assertApplicationAllowed('store', app())).not.toThrow();
    expect(() => assertApplicationAllowed('store', app({ uuid: 'production-app-uuid' }))).toThrow(
      /application_not_allowlisted/,
    );
  });

  it('refuses a Vula-looking app outside the staging name/domain pattern', () => {
    expect(() => assertApplicationAllowed('store', app({ name: 'za-pos-demo-general' }))).toThrow(
      /staging_name_refused/,
    );
    expect(() =>
      assertApplicationAllowed('store', app({ fqdn: 'https://super-stores-jhb.vula-app.co.za' })),
    ).toThrow(/staging_domain_refused/);
  });
});
