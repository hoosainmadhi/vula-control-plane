#!/usr/bin/env node
/**
 * Release a tenant image to a Control Plane from a CI release manifest.
 *
 * Usage:
 *   CP_URL=https://staging-cp.vula-app.co.za \
 *   CP_EMAIL=office@staging.vula-app.co.za \
 *   CP_PASSWORD=... \
 *   node scripts/release-tenant.mjs --manifest release-manifest.json
 *
 * Production requires an explicit approval matching the release tag:
 *   ... --environment production --approve v2026.10.24-abc1234
 *
 * The script registers the Store and Head Office digests from the manifest,
 * applies them to the pilot tenants, verifies health/login/sample data, then
 * runs a dry-run and real wave over all image tenants of each kind.
 *
 * It never builds or pushes an image. The CI workflow does that and produces
 * release-manifest.json.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const manifestPath = opt('manifest');
if (!manifestPath) {
  console.error('usage: release-tenant.mjs --manifest <release-manifest.json> [options]');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const environment = opt('environment', 'staging');
const channel = opt('channel', environment === 'production' ? 'stable' : 'beta');
const pilotStoreSlug = opt('pilot-store', 'demo-general');
const pilotHoSlug = opt('pilot-ho', 'demo-ho');
const waveSize = Number(opt('wave-size', '1'));
const onlySlugs = opt('slugs')
  ? new Set(
      opt('slugs')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
const allImage = flag('all-image');
const skipRollout = flag('skip-rollout');
const noDryRun = flag('no-dry-run');
const approve = opt('approve');

const cpUrl = (process.env.CP_URL || '').replace(/\/+$/, '');
const cpEmail = process.env.CP_EMAIL || '';
const cpPassword = process.env.CP_PASSWORD || '';
if (!cpUrl || !cpEmail || !cpPassword) {
  console.error('CP_URL, CP_EMAIL and CP_PASSWORD are required');
  process.exit(1);
}
if (environment === 'production' && approve !== manifest.release) {
  console.error(`Production requires --approve ${manifest.release}`);
  process.exit(1);
}

const storeDigest = manifest?.images?.store?.digest;
const hoDigest = manifest?.images?.ho?.digest;
if (!manifest.release || !manifest.commit || !storeDigest || !hoDigest) {
  console.error('manifest must contain release, commit and both image digests');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const request = async (path, init = {}) => {
  const res = await fetch(`${cpUrl}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(
      `${init.method || 'GET'} ${path}: ${res.status} ${String(body?.error ?? text).slice(0, 300)}`,
    );
  }
  return body;
};

const login = await request('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: cpEmail, password: cpPassword }),
});
const headers = { Authorization: `Bearer ${login.token}` };
const api = (path, init = {}) =>
  request(path, { ...init, headers: { ...headers, ...(init.headers || {}) } });

const me = await api('/auth/me');
if (me.environment !== environment) {
  throw new Error(
    `Control Plane reports environment "${me.environment}", expected "${environment}"`,
  );
}

const fleet = await api('/releases/fleet');
const allTenants = [...(fleet.stores ?? []), ...(fleet.panels ?? [])];
const bySlug = (slug) => allTenants.find((t) => t.slug === slug) ?? null;

const catalog = await api('/releases');
const releases = Array.isArray(catalog) ? catalog : (catalog.releases ?? []);
const ensureRelease = async (kind, digest) => {
  const existing = releases.find((r) => r.kind === kind && r.digest === digest);
  if (existing) {
    if (existing.tag !== manifest.release) {
      console.log(
        `${kind}: reusing existing release ${existing.tag} for digest ${digest.slice(0, 19)}…`,
      );
    }
    return existing;
  }
  const sameTag = releases.find((r) => r.kind === kind && r.tag === manifest.release);
  if (sameTag) {
    throw new Error(`${kind}: tag ${manifest.release} already exists with a different digest`);
  }
  const schema = manifest.schema?.[kind] ?? {};
  const created = await api('/releases', {
    method: 'POST',
    body: JSON.stringify({
      kind,
      tag: manifest.release,
      digest,
      version: manifest.release,
      revision: manifest.commit,
      channel,
      schemaVersion: schema.schemaVersion,
      schemaMin: schema.minSchemaVersion,
      schemaMax: schema.maxSchemaVersion,
      notes: `Automated release from ${manifest.release}`,
    }),
  });
  console.log(`${kind}: registered release ${created.id} (${created.tag}/${created.channel})`);
  releases.push(created);
  return created;
};

const storeRelease = await ensureRelease('store', storeDigest);
const hoRelease = await ensureRelease('ho', hoDigest);

const waitForHealth = async (tenant, attempts = 20) => {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${tenant.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => null);
      const healthy =
        res.ok &&
        (body?.status === 'ok' || body?.ok === true) &&
        body?.version === manifest.release &&
        body?.revision === manifest.commit;
      if (healthy) return body;
    } catch {
      // restarting or certificate
    }
    await sleep(3000);
  }
  throw new Error(`${tenant.slug}: health did not reach ${manifest.release}/${manifest.commit}`);
};

const verifyLogin = async (tenant) => {
  if (!process.env.DEMO_EMAIL || !process.env.DEMO_PASSWORD) return 'login skipped';
  const loginRes = await fetch(`${tenant.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DEMO_EMAIL,
      password: process.env.DEMO_PASSWORD,
    }),
  });
  if (loginRes.status !== 200) throw new Error(`${tenant.slug}: login ${loginRes.status}`);
  const { token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${token}` };
  if (tenant.tenantType === 'store') {
    const res = await fetch(`${tenant.baseUrl}/api/products`, { headers: auth });
    const body = await res.json().catch(() => null);
    const count = Array.isArray(body) ? body.length : body?.products?.length;
    if (!res.ok || !count) throw new Error(`${tenant.slug}: products ${res.status}/${count}`);
    return `login ok, ${count} products`;
  }
  const res = await fetch(`${tenant.baseUrl}/api/dashboard/summary`, { headers: auth });
  if (!res.ok) throw new Error(`${tenant.slug}: dashboard ${res.status}`);
  return 'login ok, dashboard ok';
};

const pilots = [];
if (storeRelease) {
  const pilot = bySlug(pilotStoreSlug);
  if (pilot && pilot.deployMode === 'image') pilots.push({ release: storeRelease, tenant: pilot });
}
if (hoRelease) {
  const pilot = bySlug(pilotHoSlug);
  if (pilot && pilot.deployMode === 'image') pilots.push({ release: hoRelease, tenant: pilot });
}

for (const { release, tenant } of pilots) {
  console.log(`pilot ${tenant.slug}: applying ${manifest.release}`);
  const result = await api(`/releases/tenants/${tenant.tenantType}/${tenant.id}/apply`, {
    method: 'POST',
    body: JSON.stringify({
      releaseId: release.id,
      action: 'upgrade',
      reason: `Automated ${environment} release ${manifest.release}`,
    }),
  });
  if (result?.result?.status === 'failed') {
    throw new Error(`pilot ${tenant.slug} failed: ${result.result.error}`);
  }
  await waitForHealth(tenant);
  console.log(`pilot ${tenant.slug}: ${await verifyLogin(tenant)}`);
}

if (!skipRollout) {
  for (const [kind, release] of [
    ['store', storeRelease],
    ['ho', hoRelease],
  ]) {
    if (!release) continue;
    const pool = allTenants.filter(
      (t) =>
        t.deployMode === 'image' &&
        (kind === 'store' ? t.tenantType === 'store' : t.tenantType === 'panel') &&
        (onlySlugs ? onlySlugs.has(t.slug) : allImage ? true : t.slug.startsWith('demo-')),
    );
    if (pool.length === 0) {
      console.log(`${kind}: no image tenants to roll out`);
      continue;
    }
    if (!onlySlugs && !allImage) {
      console.log(`${kind}: demo scope selected ${pool.length} tenant(s)`);
    }
    const ids = pool.map((t) => t.id);
    if (!noDryRun) {
      const dry = await api(`/releases/${release.id}/rollout`, {
        method: 'POST',
        body: JSON.stringify({
          tenantIds: ids,
          waveSize,
          dryRun: true,
          stopOnFailure: true,
        }),
      });
      console.log(`${kind}: dry run ${dry.batch?.status} (${ids.length} tenants)`);
    }
    const batch = await api(`/releases/${release.id}/rollout`, {
      method: 'POST',
      body: JSON.stringify({
        tenantIds: ids,
        waveSize,
        dryRun: false,
        stopOnFailure: true,
      }),
    });
    const b = batch.batch ?? {};
    console.log(
      `${kind}: rollout ${b.status} succeeded=${b.succeeded} failed=${b.failed} skipped=${b.skipped} total=${b.total}`,
    );
    if (Number(b.failed ?? 0) > 0 || b.status === 'failed') {
      throw new Error(`${kind}: rollout reported failures`);
    }
  }
}

console.log('release complete');
