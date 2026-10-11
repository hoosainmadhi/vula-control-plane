// The production boot gates are process.exit(1) at import time, so they are
// proven the way they run: a real child boot of src/config/env.ts with
// NODE_ENV=production, toggling the variable under test. Everything else the
// production gate checks is supplied, so only the variable under test can
// flip the outcome.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(__dirname, '..', '..');
const tsxCli = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const bootExitCode = (managedSuffixes: string | undefined): number => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-boot-'));
  const entry = path.join(dir, 'import-env.mts');
  fs.writeFileSync(
    entry,
    `await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/config/env.js')).href)});\n`,
  );
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'production',
    CP_DB_PATH: ':memory:',
    LOG_LEVEL: 'error',
    OFFICE_ADMIN_EMAIL: 'office@test.local',
    OFFICE_ADMIN_PASSWORD: 'not-the-placeholder',
    JWT_SECRET: 'a-production-jwt-secret-of-reasonable-length',
    BILLING_SIMULATE_RENEWAL_SETTLEMENT: 'false',
    LEASE_PRIVATE_KEY: 'ZmFrZS1rZXk',
    LEASE_KEY_ID: 'k1',
    ...(managedSuffixes === undefined ? {} : { MANAGED_ENDPOINT_SUFFIXES: managedSuffixes }),
  };
  try {
    const res = spawnSync(tsxCli, [entry], {
      env: childEnv,
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });
    return res.status ?? -1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('production boot gate', () => {
  jest.setTimeout(60000);

  it('refuses to boot in production without MANAGED_ENDPOINT_SUFFIXES', () => {
    expect(bootExitCode(undefined)).toBe(1);
  });

  it('refuses a whitespace-only allowlist', () => {
    expect(bootExitCode('   ')).toBe(1);
  });

  it('boots in production when the allowlist is set', () => {
    expect(bootExitCode('.vula-app.co.za')).toBe(0);
  });
});
