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
import crypto from 'crypto';
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

/**
 * The plan catalogue (owner, 2026-09-14): eight tiers, house-default pricing.
 *
 * These are the control plane's own seeded plans (SEED_PLANS in
 * src/config/registryDb.ts), so a fresh registry already holds all eight and this
 * only refreshes their values — nothing is created here. The codes are derived
 * from the names; an older registry renames its retired bootstrap codes through
 * the `renamePlansToNameCodes` migration on the next boot.
 */
interface PlanSpec {
  /** Existing bootstrap code, or a new one. */
  code: string;
  name: string;
  maxStores: number;
  maxTillsPerStore: number;
  features: string[];
}

const HOUSE = { pricingMode: 'per_terminal' as const, terminalPriceCents: 50_000, setupFeeCents: 1_000_000 };

const PLANS: PlanSpec[] = [
  { code: 'vula-start', name: 'Vula Start', maxStores: 1, maxTillsPerStore: 1, features: [] },
  { code: 'vula-grow', name: 'Vula Grow', maxStores: 1, maxTillsPerStore: 3, features: ['customer_credit', 'advanced_reports'] },
  { code: 'vula-branch', name: 'Vula Branch', maxStores: 3, maxTillsPerStore: 2, features: ['customer_credit', 'advanced_reports', 'multi_store'] },
  { code: 'vula-network', name: 'Vula Network', maxStores: 5, maxTillsPerStore: 3, features: ['customer_credit', 'advanced_reports', 'multi_store', 'stock_transfers'] },
  { code: 'vula-market', name: 'Vula Market', maxStores: 1, maxTillsPerStore: 10, features: ['customer_credit', 'advanced_reports', 'ecommerce_bridges'] },
  { code: 'vula-market-plus', name: 'Vula Market Plus', maxStores: 10, maxTillsPerStore: 15, features: ['customer_credit', 'advanced_reports', 'ecommerce_bridges', 'multi_store', 'stock_transfers'] },
  { code: 'vula-market-enterprise', name: 'Vula Market Enterprise', maxStores: 50, maxTillsPerStore: 20, features: ['customer_credit', 'advanced_reports', 'ecommerce_bridges', 'multi_store', 'stock_transfers', 'ai_assistant'] },
  { code: 'vula-spares-network', name: 'Vula Spares Network', maxStores: 50, maxTillsPerStore: 5, features: ['customer_credit', 'advanced_reports', 'multi_store', 'stock_transfers'] },
];

/** Which client owns each store, and the plan that client buys. */
interface StoreSpec {
  /** Control-plane slug (must match fleet.sh's STORES). */
  cpSlug: string;
  /** Name of the env file and database under ~/vula-store-data. */
  envSlug: string;
  /** Client slug (the merchant that owns it). */
  client: string;
  /** Cap the store's tills at this (the plan ceiling), pushing it down if it is
   *  configured for more. Owner-approved for Everyday Retail: 25 -> 20. */
  maxTills?: number;
}

/** One merchant = one client account = one plan. Slugs are kept from the old
 *  registry so existing links, licences and the Head Office panels still line up. */
const CLIENTS: Array<{ slug: string; name: string; plan: string; billingEmail: string }> = [
  { slug: 'urban-threads', name: 'Urban Threads Retail Group', plan: 'vula-network', billingEmail: 'ops@urban-threads.test' },
  { slug: 'hm-spares', name: 'HM Spares', plan: 'vula-start', billingEmail: 'ops@hm-spares.test' },
  { slug: 'everyday-retail', name: 'Everyday Retail', plan: 'vula-market-enterprise', billingEmail: 'ops@everyday-retail.test' },
  { slug: 'brake-bolt-spares', name: 'Brake & Bolt Spares', plan: 'vula-spares-network', billingEmail: 'ops@brake-bolt.test' },
  { slug: 'builders-hardware', name: 'Builders Hardware', plan: 'vula-grow', billingEmail: 'ops@builders-hardware.test' },
  { slug: 'medisave-pharmacy', name: 'MediSave Pharmacy', plan: 'vula-market', billingEmail: 'ops@medisave.test' },
  { slug: 'mydiner', name: 'myDiner', plan: 'vula-branch', billingEmail: 'ops@mydiner.test' },
  // Kept as client names: they hold a Head Office panel but no local store.
  { slug: 'kloof-autu-spares', name: 'Kloof Auto Spares', plan: 'vula-spares-network', billingEmail: 'ops@kloof-auto.test' },
  { slug: 'cresta-grocers', name: 'Cresta Grocers', plan: 'vula-market-plus', billingEmail: 'ops@cresta-grocers.test' },
  { slug: 'ahk-spares', name: 'AHK Spares', plan: 'vula-spares-network', billingEmail: 'ops@ahk-spares.test' },
];

const STORES: StoreSpec[] = [
  { cpSlug: 'everyday-retail', envSlug: 'everyday-retail', client: 'everyday-retail', maxTills: 20 },
  { cpSlug: 'urban-threads-jhb', envSlug: 'urban-threads', client: 'urban-threads' },
  { cpSlug: 'urban-threads-dbn', envSlug: 'urban-threads-dbn', client: 'urban-threads' },
  { cpSlug: 'urban-threads-cpt', envSlug: 'urban-threads-cpt', client: 'urban-threads' },
  { cpSlug: 'brake-bolt-spares', envSlug: 'brake-bolt-spares', client: 'brake-bolt-spares' },
  { cpSlug: 'builders-hardware', envSlug: 'builders-hardware', client: 'builders-hardware' },
  { cpSlug: 'medisave-pharmacy', envSlug: 'medisave-pharmacy', client: 'medisave-pharmacy' },
  { cpSlug: 'hm-spares', envSlug: 'hm-spares', client: 'hm-spares' },
  { cpSlug: 'mydiner', envSlug: 'mydiner', client: 'mydiner' },
];

/**
 * Head Offices — one per merchant, and **all local** in dev: `<slug>.localhost`
 * on an even port, never a vula-app.co.za production domain. Ports run
 * 3260, 3262, 3264, 3266, 3268; the odd neighbours stay free for a panel's
 * `npm run dev:ho` Vite server. Keep this list in step with HOS in fleet.sh.
 */
const PANELS: Array<{ slug: string; name: string; client: string; port: number }> = [
  { slug: 'urban-threads-ho', name: 'Urban Threads Head Office', client: 'urban-threads', port: 3260 },
  { slug: 'hm-spares-ho', name: 'HM Spares HO', client: 'hm-spares', port: 3262 },
  { slug: 'kloof-autu-spares-ho', name: 'Kloof Autu Spares Head Office', client: 'kloof-autu-spares', port: 3264 },
  { slug: 'cresta-grocers-ho', name: 'Cresta Grocers Head Office', client: 'cresta-grocers', port: 3266 },
  { slug: 'ahk-spares-ho', name: 'AHK Spares Head Office', client: 'ahk-spares', port: 3268 },
];

const panelUrl = (p: { slug: string; port: number }): string =>
  `http://${p.slug}.localhost:${p.port}`;

/** Where a store's/panel's env template for each key lives. */
const setEnvValue = (text: string, key: string, value: string): string =>
  new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;

/**
 * Create a Head Office instance if it does not exist yet: its own env file with
 * a distinct port, database and JWT secret, so `fleet.sh ho <slug>` can run it.
 * Two panels must never share a secret or a branch registry.
 *
 * Idempotent in the way that matters: an existing env file is left untouched, so
 * re-running never rotates a live panel's secret. Everything else (the CP token
 * and the licence public key) is inherited from the head-office.env template —
 * same control plane, same keys, this machine.
 */
const ensureHoInstance = (panel: { slug: string; port: number }): 'exists' | 'created' => {
  const file = envFile(panel.slug);
  if (fs.existsSync(file)) return 'exists';
  const template = envFile('head-office');
  let text = fs.existsSync(template)
    ? fs.readFileSync(template, 'utf-8')
    : 'NODE_ENV=production\nLOG_LEVEL=error\nLEASE_KEY_ID=k1\n';
  text = setEnvValue(text, 'PORT', String(panel.port));
  text = setEnvValue(text, 'HO_DB_PATH', path.join(DATA_DIR, `vula-${panel.slug}.db`));
  text = setEnvValue(text, 'HO_JWT_SECRET', crypto.randomBytes(32).toString('hex'));
  // A panel in NODE_ENV=production seeds no users, so a fresh instance would have
  // no way in. These are local demo panels: seed the executive.
  text = setEnvValue(text, 'SEED_DEMO_DATA', 'true');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return 'created';
};

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

  // The plan catalogue first: clients are created against these codes.
  const before = await api<PlanOut[]>('GET', '/plans');
  const existingPlan = new Map(before.map((p) => [p.code, p]));
  console.log('Plan catalogue:');
  for (const spec of PLANS) {
    const body = {
      name: spec.name,
      maxStores: spec.maxStores,
      maxTerminalsPerStore: spec.maxTillsPerStore,
      features: spec.features,
      pricingMode: HOUSE.pricingMode,
      terminalPriceCents: HOUSE.terminalPriceCents,
      setupFeeCents: HOUSE.setupFeeCents,
      billingPeriod: 'monthly',
    };
    const current = existingPlan.get(spec.code);
    if (DRY_RUN) {
      console.log(`  ${spec.code.padEnd(22)} ${spec.name.padEnd(24)} ${spec.maxStores} store(s) · ${spec.maxTillsPerStore} tills/store`);
      continue;
    }
    if (!current) {
      throw new Error(`Plan '${spec.code}' is not in a fresh registry's seed — expected SEED_PLANS to carry it`);
    }
    await api('PUT', `/plans/${current.id}`, body);
    console.log(`  ✓ updated ${spec.code.padEnd(22)} ${spec.name}`);
  }

  const plans = await api<PlanOut[]>('GET', '/plans');
  const planByCode = new Map(plans.map((p) => [p.code, p]));

  // 1. Work out the shape from the deployments before writing anything.
  const resolved = STORES.map((spec) => {
    const { token: storeToken, port } = readEnv(spec.envSlug);
    const fromDb = readStoreDb(spec.envSlug);
    const tills = spec.maxTills !== undefined ? Math.min(fromDb.tills, spec.maxTills) : fromDb.tills;
    return { ...spec, storeToken, port, ...fromDb, tills, baseUrl: `http://${spec.cpSlug}.localhost:${port}` };
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
  for (const p of PANELS) console.log(`  ${p.slug.padEnd(22)} ${p.client.padEnd(20)} ${panelUrl(p)}`);

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

  // 4. Head Offices — instance first (env file), then the registry row.
  //
  // Adopt the original single-HO file for the primary panel rather than minting a
  // second one: its database path is where the running panel's branch registry
  // already lives, and a fresh secret would log every executive out for no gain.
  const legacy = envFile('head-office');
  const primaryFile = envFile(PANELS[0]!.slug);
  if (fs.existsSync(legacy) && !fs.existsSync(primaryFile)) {
    fs.renameSync(legacy, primaryFile);
    console.log(`  ✓ adopted head-office.env as ${PANELS[0]!.slug}.env`);
  }
  for (const p of PANELS) {
    const companyId = companyIdBySlug.get(p.client);
    if (!companyId) throw new Error(`No client '${p.client}' for panel '${p.slug}'`);
    const instance = ensureHoInstance(p);
    await api('POST', '/panels', { name: p.name, slug: p.slug, companyId, baseUrl: panelUrl(p) });
    console.log(`  ✓ panel ${p.slug.padEnd(22)} instance ${instance === 'created' ? 'created' : 'already present'}`);
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
