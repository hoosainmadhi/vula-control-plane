/**
 * Rebuild the demo fleet's control-plane registry from the deployments that
 * actually exist on this machine.
 *
 * Owner workflow (2026-09-14): "remove all plans and stores and reseed with new
 * data, use the same company names, no Unassigned — no client."
 *
 * The registry is the vendor-side record; the stores are the real deployments.
 * So nothing here is invented: for each store it reads
 *
 *   ~/vula-store-data/env/<env>.env      its PORT and its CONTROL_PLANE_TOKEN
 *   ~/vula-store-data/vula-<env>.db      its store name, vertical, till count
 *
 * and recreates the registry rows so the panel and the store agree. Adopting the
 * env's existing token is the point — a minted token would 401 every push and
 * leave the whole fleet "Offline" while every store API was healthy.
 *
 * Run it against a FRESH registry (see the recipe below), with the stores up:
 *
 *   ./scripts/fleet.sh stop-cp
 *   mv data/control-plane.db data/control-plane.pre-reseed.db   # + -wal/-shm
 *   ./scripts/fleet.sh cp                                        # fresh schema + seeded plans
 *   npx tsx scripts/reseed-fleet.ts            # add --dry-run to preview
 *
 * It refuses to run against a registry that already holds stores unless --force.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const CP_URL = process.env.CP_URL ?? 'http://control-plane.localhost:3240';
const EMAIL = process.env.OFFICE_ADMIN_EMAIL ?? 'admin@za-pos.local';
const PASSWORD = process.env.OFFICE_ADMIN_PASSWORD ?? 'temp123';
const DATA_DIR = process.env.VULA_DATA_DIR ?? path.join(os.homedir(), 'vula-store-data');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

/** Which client owns each store, and the plan that client buys. */
interface StoreSpec {
  /** Control-plane slug (must match fleet.sh's STORES). */
  cpSlug: string;
  /** Name of the env file and database under ~/vula-store-data. */
  envSlug: string;
  /** Client slug (the merchant that owns it). */
  client: string;
}

/** One merchant = one client account = one plan. Slugs are kept from the old
 *  registry so existing links, licences and the Head Office panels still line up. */
const CLIENTS: Array<{ slug: string; name: string; plan: string; billingEmail: string }> = [
  { slug: 'urban-threads', name: 'Urban Threads Retail Group', plan: 'multi-store', billingEmail: 'ops@urban-threads.test' },
  { slug: 'hm-spares', name: 'HM Spares', plan: 'starter', billingEmail: 'ops@hm-spares.test' },
  { slug: 'everyday-retail', name: 'Everyday Retail', plan: 'enterprise', billingEmail: 'ops@everyday-retail.test' },
  { slug: 'brake-bolt-spares', name: 'Brake & Bolt Spares', plan: 'business', billingEmail: 'ops@brake-bolt.test' },
  { slug: 'builders-hardware', name: 'Builders Hardware', plan: 'business', billingEmail: 'ops@builders-hardware.test' },
  { slug: 'medisave-pharmacy', name: 'MediSave Pharmacy', plan: 'business', billingEmail: 'ops@medisave.test' },
  { slug: 'mydiner', name: 'myDiner', plan: 'starter', billingEmail: 'ops@mydiner.test' },
  // Kept as client names: they hold a Head Office panel but no local store.
  { slug: 'kloof-autu-spares', name: 'Kloof Auto Spares', plan: 'starter', billingEmail: 'ops@kloof-auto.test' },
  { slug: 'cresta-grocers', name: 'Cresta Grocers', plan: 'starter', billingEmail: 'ops@cresta-grocers.test' },
  { slug: 'ahk-spares', name: 'AHK Spares', plan: 'starter', billingEmail: 'ops@ahk-spares.test' },
];

const STORES: StoreSpec[] = [
  { cpSlug: 'everyday-retail', envSlug: 'everyday-retail', client: 'everyday-retail' },
  { cpSlug: 'urban-threads-jhb', envSlug: 'urban-threads', client: 'urban-threads' },
  { cpSlug: 'urban-threads-dbn', envSlug: 'urban-threads-dbn', client: 'urban-threads' },
  { cpSlug: 'urban-threads-cpt', envSlug: 'urban-threads-cpt', client: 'urban-threads' },
  { cpSlug: 'brake-bolt-spares', envSlug: 'brake-bolt-spares', client: 'brake-bolt-spares' },
  { cpSlug: 'builders-hardware', envSlug: 'builders-hardware', client: 'builders-hardware' },
  { cpSlug: 'medisave-pharmacy', envSlug: 'medisave-pharmacy', client: 'medisave-pharmacy' },
  { cpSlug: 'hm-spares', envSlug: 'hm-spares', client: 'hm-spares' },
  { cpSlug: 'mydiner', envSlug: 'mydiner', client: 'mydiner' },
];

/** Head Offices. The two local ones get .localhost hostnames; the rest keep the
 *  production URLs their merchants were registered with. */
const PANELS: Array<{ slug: string; name: string; client: string; baseUrl: string }> = [
  { slug: 'urban-threads-ho', name: 'Urban Threads Head Office', client: 'urban-threads', baseUrl: 'http://urban-threads-ho.localhost:3260' },
  { slug: 'hm-spares-ho', name: 'HM Spares HO', client: 'hm-spares', baseUrl: 'http://hm-spares-ho.localhost:3262' },
  { slug: 'kloof-autu-spares-ho', name: 'Kloof Autu Spares Head Office', client: 'kloof-autu-spares', baseUrl: 'https://kloof-auto-spares-ho.vula-app.co.za' },
  { slug: 'cresta-grocers-ho', name: 'Cresta Grocers Head Office', client: 'cresta-grocers', baseUrl: 'https://cresta-grocers-ho.vula-app.co.za' },
  { slug: 'ahk-spares-ho', name: 'AHK Spares Head Office', client: 'ahk-spares', baseUrl: 'https://ahk-spares-ho.vula-app.co.za' },
];

// --- Reading the deployments -------------------------------------------------

const envFile = (slug: string): string => path.join(DATA_DIR, 'env', `${slug}.env`);
const dbFile = (slug: string): string => path.join(DATA_DIR, `vula-${slug}.db`);

const readEnv = (slug: string): { token: string; port: number } => {
  const file = envFile(slug);
  if (!fs.existsSync(file)) throw new Error(`No env file for '${slug}': ${file}`);
  const text = fs.readFileSync(file, 'utf-8');
  const token = /^CONTROL_PLANE_TOKEN=(.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const port = Number(/^PORT=(.*)$/m.exec(text)?.[1]?.trim() ?? '');
  if (!token) throw new Error(`${file} has no CONTROL_PLANE_TOKEN`);
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(`${file}: token is not 64 lowercase hex characters (the control plane refuses those)`);
  }
  if (!port) throw new Error(`${file} has no PORT`);
  return { token, port };
};

/** The store's own view of itself — the name and vertical a demo will see in the
 *  POS, and the tills it is configured to run. */
const readStoreDb = (slug: string): { name: string; vertical: string; tills: number } => {
  const file = dbFile(slug);
  if (!fs.existsSync(file)) throw new Error(`No store database for '${slug}': ${file}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT store_name, vertical FROM settings WHERE id = 1').get() as
      | { store_name: string; vertical: string }
      | undefined;
    const tills = (db.prepare('SELECT COUNT(*) AS n FROM terminals').get() as { n: number }).n;
    if (!row) throw new Error(`No settings row in ${file}`);
    return { name: row.store_name, vertical: row.vertical, tills };
  } finally {
    db.close();
  }
};

// --- Control-plane API -------------------------------------------------------

let token = '';

const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${CP_URL}/api${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail = parsed && typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
    throw new Error(`${method} ${route} -> ${res.status} ${detail}`);
  }
  return parsed as T;
};

const login = async (): Promise<void> => {
  const out = await api<{ token: string }>('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  token = out.token;
};

interface PlanOut {
  id: number;
  code: string;
  name: string;
  maxTerminalsPerStore: number;
}
interface StoreOut {
  id: number;
  slug: string;
  name: string;
  companyId: number | null;
  terminalCount: number;
  lastConfigStatus: string;
  lastHealthStatus: string;
}
interface CompanyOut {
  id: number;
  name: string;
  slug: string;
  licensedTerminalCount?: number;
}

const main = async (): Promise<void> => {
  await login();

  const existing = await api<StoreOut[]>('GET', '/stores');
  // --dry-run previews against any state: it writes nothing, so a populated
  // registry is fine to look at (that is how you check the plan before wiping).
  if (existing.length > 0 && !FORCE && !DRY_RUN) {
    console.error(
      `Refusing to reseed: the registry already holds ${existing.length} store(s).\n` +
        `Start from a fresh registry (see this script's header) or pass --force.`,
    );
    process.exit(1);
  }
  if (existing.length > 0) {
    console.log(`Note: the registry currently holds ${existing.length} store(s); this run will add to them.\n`);
  }

  const plans = await api<PlanOut[]>('GET', '/plans');
  const planByCode = new Map(plans.map((p) => [p.code, p]));

  // 1. Work out the shape from the deployments before writing anything.
  const resolved = STORES.map((spec) => {
    const { token: storeToken, port } = readEnv(spec.envSlug);
    const store = readStoreDb(spec.envSlug);
    return { ...spec, storeToken, port, ...store, baseUrl: `http://${spec.cpSlug}.localhost:${port}` };
  });

  const tillsByClient = new Map<string, number>();
  for (const s of resolved) tillsByClient.set(s.client, (tillsByClient.get(s.client) ?? 0) + s.tills);

  // A plan's per-store ceiling has to cover the store's tills, or the allocation
  // is refused and the push would be rejected as over the ceiling.
  const ceiling = (code: string): number => planByCode.get(code)?.maxTerminalsPerStore ?? 0;
  const tooBig = resolved.filter((s) => {
    const plan = CLIENTS.find((c) => c.slug === s.client)?.plan ?? 'starter';
    return s.tills > ceiling(plan);
  });
  if (tooBig.length > 0) {
    console.error('These stores have more tills than their plan allows:');
    for (const s of tooBig) {
      const plan = CLIENTS.find((c) => c.slug === s.client)?.plan;
      console.error(`  ${s.cpSlug}: ${s.tills} tills, plan '${plan}' ceiling ${ceiling(plan!)}`);
    }
    console.error('Raise the plan (or the plan’s per-store ceiling) and re-run.');
    process.exit(1);
  }

  console.log(`Control plane: ${CP_URL}`);
  console.log(`\nClients (${CLIENTS.length}) and their licensed terminals:`);
  for (const c of CLIENTS) {
    const tills = tillsByClient.get(c.slug) ?? 0;
    const n = STORES.filter((s) => s.client === c.slug).length;
    console.log(`  ${c.name.padEnd(30)} ${c.plan.padEnd(12)} ${String(tills).padStart(3)} licensed · ${n} store(s)`);
  }
  console.log(`\nStores (${resolved.length}):`);
  for (const s of resolved) {
    console.log(
      `  ${s.cpSlug.padEnd(20)} ${s.name.padEnd(22)} ${s.vertical.padEnd(11)} ${String(s.tills).padStart(2)} tills  ${s.baseUrl}`,
    );
  }
  console.log(`\nHead Offices (${PANELS.length}):`);
  for (const p of PANELS) console.log(`  ${p.slug.padEnd(22)} ${p.client.padEnd(20)} ${p.baseUrl}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  // 2. Clients — created before their stores, each with the terminals it needs.
  const companyIdBySlug = new Map<string, number>();
  for (const c of CLIENTS) {
    const plan = planByCode.get(c.plan);
    if (!plan) throw new Error(`Plan '${c.plan}' is not seeded — is the registry fresh?`);
    const company = await api<CompanyOut>('POST', '/companies', {
      name: c.name,
      slug: c.slug,
      billingEmail: c.billingEmail,
      planId: plan.id,
    });
    companyIdBySlug.set(c.slug, company.id);
    const licensed = tillsByClient.get(c.slug) ?? 0;
    await api('PUT', `/clients/${company.id}`, { licensedTerminalCount: licensed });
    console.log(`  ✓ client ${c.name} (plan ${c.plan}, ${licensed} licensed terminals)`);
  }

  // 3. Stores — adopting each deployment's own token so pushes authenticate.
  for (const s of resolved) {
    const companyId = companyIdBySlug.get(s.client);
    if (!companyId) throw new Error(`No client '${s.client}' for store '${s.cpSlug}'`);
    const created = await api<{ store: StoreOut }>('POST', '/stores', {
      name: s.name,
      slug: s.cpSlug,
      vertical: s.vertical,
      terminalCount: s.tills,
      baseUrl: s.baseUrl,
      companyId,
      environment: 'development',
      controlPlaneToken: s.storeToken,
    });
    const store = created.store;
    console.log(
      `  ✓ store ${s.cpSlug.padEnd(20)} config=${store.lastConfigStatus} (push to the live store)`,
    );
  }

  // 4. Head Offices.
  for (const p of PANELS) {
    const companyId = companyIdBySlug.get(p.client);
    if (!companyId) throw new Error(`No client '${p.client}' for panel '${p.slug}'`);
    await api('POST', '/panels', { name: p.name, slug: p.slug, companyId, baseUrl: p.baseUrl });
    console.log(`  ✓ panel ${p.slug}`);
  }

  const [stores, panels] = await Promise.all([
    api<StoreOut[]>('GET', '/stores'),
    api<unknown[]>('GET', '/panels'),
  ]);
  const orphan = stores.filter((s) => s.companyId === null);
  console.log(
    `\nDone: ${stores.length} stores, ${panels.length} Head Offices, ${CLIENTS.length} clients. ` +
      `Unassigned stores: ${orphan.length}.`,
  );
  if (orphan.length > 0) {
    console.error('Unexpected: some stores have no client.');
    process.exit(1);
  }
};

main().catch((err) => {
  console.error(`\nreseed-fleet failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
