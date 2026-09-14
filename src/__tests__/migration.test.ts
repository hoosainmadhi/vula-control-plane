import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { getRegistryDb, resetRegistryDb } from '../config/registryDb.js';

/**
 * Migration regression: widening plans.billing_period must not damage the tables
 * that reference plans.
 *
 * The first attempt at this migration renamed `plans` to `plans_old` with foreign
 * keys ENABLED. Two things then went wrong, and both are asserted below:
 *  1. SQLite rewrote `companies.plan_id` to reference `"plans_old"`, so dropping the
 *     temporary table left companies pointing at a table that no longer existed —
 *     every later write failed with "no such table: main.plans_old".
 *  2. Dropping the old table fired ON DELETE SET NULL, silently wiping every
 *     company's plan assignment.
 */

/** The schema as it was BEFORE 'once-off' was added to the CHECK. */
const OLD_SCHEMA = `
  CREATE TABLE stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    vertical TEXT NOT NULL DEFAULT 'general',
    terminal_count INTEGER NOT NULL DEFAULT 1,
    base_url TEXT NOT NULL,
    control_plane_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_config_status TEXT NOT NULL DEFAULT 'pending',
    last_config_at TEXT,
    last_config_snapshot_json TEXT,
    last_health_at TEXT,
    last_health_status TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    max_stores INTEGER NOT NULL DEFAULT 1,
    max_terminals_per_store INTEGER NOT NULL DEFAULT 2,
    features_json TEXT NOT NULL DEFAULT '[]',
    price_cents INTEGER NOT NULL DEFAULT 0,
    billing_period TEXT NOT NULL DEFAULT 'monthly'
      CHECK (billing_period IN ('monthly', 'annual')),
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    billing_email TEXT NOT NULL DEFAULT '',
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    paid_through TEXT,
    trial_ends_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    control_plane_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_health_status TEXT NOT NULL DEFAULT 'unknown',
    last_health_at TEXT,
    app_version TEXT,
    licence_sequence INTEGER NOT NULL DEFAULT 0,
    licence_issued_at TEXT,
    licence_push_status TEXT NOT NULL DEFAULT 'pending',
    licence_pushed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE billing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    auto_renew INTEGER NOT NULL DEFAULT 1,
    auto_renew_subscription_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    email_invoice INTEGER NOT NULL DEFAULT 1,
    invoice_email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

describe('plans billing_period migration', () => {
  let dbFile: string;
  const originalDbPath = env.dbPath;

  beforeEach(() => {
    dbFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vula-cp-migration-')),
      'registry.db',
    );

    // Build a database as it existed before 'once-off', with real data in it.
    const seed = new Database(dbFile);
    seed.exec(OLD_SCHEMA);
    seed
      .prepare(
        `INSERT INTO plans (id, code, name, max_stores, max_terminals_per_store, features_json, billing_period, sort_order)
         VALUES (1, 'vula-start', 'Starter', 1, 2, '[]', 'monthly', 1),
                (2, 'retail', 'Retail', 1, 8, '["customer_credit"]', 'monthly', 2),
                (3, 'vula-network', 'Multi-Store', 10, 25, '["multi_store"]', 'annual', 3)`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO companies (id, name, slug, plan_id, paid_through)
         VALUES (1, 'Urban Threads Retail Group', 'urban-threads', 3, '2026-12-31')`,
      )
      .run();

    seed
      .prepare(
        `INSERT INTO billing_settings (company_id, auto_renew, email_invoice, invoice_email)
         VALUES (1, 0, 1, 'accounts@urban-threads.co.za')`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO panels (id, company_id, slug, name, base_url, control_plane_token)
         VALUES (1, 1, 'urban-threads-ho', 'Urban Threads Head Office', 'http://localhost:3260', 'tok')`,
      )
      .run();
    seed
      .prepare("INSERT INTO stores (id, slug, name, base_url, control_plane_token) VALUES (1,'branch','Branch','http://localhost:3246','t')")
      .run();
    seed.close();

    // Point the registry singleton at this file and let it migrate.
    (env as { dbPath: string }).dbPath = dbFile;
    resetRegistryDb();
  });

  afterEach(() => {
    resetRegistryDb();
    (env as { dbPath: string }).dbPath = originalDbPath;
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  const ddlFor = (name: string): string =>
    ((getRegistryDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) as { sql: string } | undefined)?.sql ?? '');

  it('widens the CHECK to accept once-off', () => {
    getRegistryDb();
    expect(ddlFor('plans')).toContain('once-off');

    // And the widened table really accepts the value.
    expect(() =>
      getRegistryDb()
        .prepare(
          `INSERT INTO plans (code, name, max_stores, max_terminals_per_store, features_json, billing_period)
           VALUES ('perpetual', 'Perpetual', 1, 1, '[]', 'once-off')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('leaves no temporary table behind', () => {
    getRegistryDb();
    const leftovers = (
      getRegistryDb()
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'plans_old%'")
        .get() as { c: number }
    ).c;
    expect(leftovers).toBe(0);
  });

  it('keeps companies referencing plans, never the dropped temp table', () => {
    getRegistryDb();
    // The exact bug: companies.plan_id pointed at "plans_old", so every later
    // write failed with "no such table: main.plans_old".
    expect(ddlFor('companies')).not.toContain('plans_old');
    expect(ddlFor('companies')).toMatch(/REFERENCES\s+"?plans"?\s*\(id\)/i);
  });

  it('preserves plan assignments rather than nulling them', () => {
    getRegistryDb();
    const company = getRegistryDb()
      .prepare('SELECT plan_id FROM companies WHERE slug = ?')
      .get('urban-threads') as { plan_id: number | null };
    // The old code dropped the old table with foreign keys on, which fired
    // ON DELETE SET NULL and silently wiped this.
    expect(company.plan_id).toBe(3);
  });

  it('preserves existing rows and their values through the rebuild', () => {
    getRegistryDb();
    const db = getRegistryDb();

    // The pre-existing tiers keep their ids and periods. (Seeding legitimately adds
    // the tiers my fixture omitted, so only these two rows are asserted.)
    const starter = db.prepare("SELECT name, billing_period FROM plans WHERE code = 'vula-start'").get() as
      | { name: string; billing_period: string }
      | undefined;
    const multi = db.prepare("SELECT name, billing_period FROM plans WHERE code = 'vula-network'").get() as
      | { name: string; billing_period: string }
      | undefined;
    expect(starter).toEqual({ name: 'Starter', billing_period: 'monthly' });
    expect(multi).toEqual({ name: 'Multi-Store', billing_period: 'annual' });

    const count = (t: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    expect(count('companies')).toBe(1);
    expect(count('panels')).toBe(1);
    expect(count('stores')).toBe(1);
  });

  it('is idempotent — a second boot changes nothing', () => {
    getRegistryDb();
    resetRegistryDb();
    getRegistryDb();

    expect(ddlFor('companies')).not.toContain('plans_old');
    const company = getRegistryDb()
      .prepare('SELECT plan_id FROM companies WHERE slug = ?')
      .get('urban-threads') as { plan_id: number | null };
    expect(company.plan_id).toBe(3);
  });

  it('repairs a database already damaged by the faulty rebuild', () => {
    // Simulate the wreckage: companies referencing a plans_old that is gone.
    resetRegistryDb();
    const damaged = new Database(dbFile);
    damaged.pragma('foreign_keys = OFF');
    damaged.exec('ALTER TABLE companies RENAME TO companies_tmp');
    damaged.exec(
      `CREATE TABLE companies (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, billing_email TEXT NOT NULL DEFAULT '',
         plan_id INTEGER REFERENCES "plans_old"(id) ON DELETE SET NULL,
         paid_through TEXT, trial_ends_at TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    damaged.exec(
      'INSERT INTO companies (id, name, slug, plan_id, paid_through) SELECT id, name, slug, plan_id, paid_through FROM companies_tmp',
    );
    damaged.exec('DROP TABLE companies_tmp');
    damaged.close();

    // Booting must heal it rather than throwing on every write.
    expect(() => getRegistryDb().prepare('SELECT 1 AS ok').get()).not.toThrow();
    expect(ddlFor('companies')).not.toContain('plans_old');
    expect(ddlFor('companies')).toMatch(/REFERENCES\s+"?plans"?\s*\(id\)/i);
  });

  it('migrates billing_settings from the singleton shape to per-company rows', () => {
    getRegistryDb();
    const ddl = ddlFor('billing_settings');
    expect(ddl).not.toContain('CHECK (id = 1)');

    // The existing merchant's settings survived the rebuild.
    const settings = getRegistryDb()
      .prepare('SELECT company_id, auto_renew, invoice_email FROM billing_settings')
      .all() as Array<{ company_id: number; auto_renew: number; invoice_email: string }>;
    expect(settings).toEqual([
      { company_id: 1, auto_renew: 0, invoice_email: 'accounts@urban-threads.co.za' },
    ]);

    // A SECOND company can now have settings — the original bug.
    const db = getRegistryDb();
    const second = db
      .prepare('INSERT INTO companies (name, slug) VALUES (?, ?)')
      .run('PharmaCrest', 'pharmacrest');
    expect(() =>
      db
        .prepare(
          'INSERT INTO billing_settings (company_id, auto_renew, email_invoice, invoice_email) VALUES (?, 1, 0, NULL)',
        )
        .run(Number(second.lastInsertRowid)),
    ).not.toThrow();
  });

  it('renames the Retail tier to Business and leaves the rest alone', () => {
    getRegistryDb();
    const codes = getRegistryDb()
      .prepare('SELECT code, name FROM plans ORDER BY sort_order')
      .all() as Array<{ code: string; name: string }>;
    expect(codes.map((p) => p.code)).toContain('vula-grow');
    expect(codes.map((p) => p.code)).not.toContain('retail');
    const business = codes.find((p) => p.code === 'vula-grow')!;
    expect(business.name).toBe('Business');
  });
});

/**
 * The licensed-terminal pricing model (2026-09-13) against the exact shape a
 * development registry had reached: flat `price_cents`, the short-lived bundled
 * columns, per-company onboarding flag and invoice breakdown columns.
 *
 * The load-bearing rule: a FLAT price is not a per-terminal rate, and carrying it
 * over would have multiplied live clients' bills by their till count. Such a plan
 * becomes `custom` instead — the office sets the rate deliberately.
 */
const FLAT_PRICE_SCHEMA = `
  CREATE TABLE stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    vertical TEXT NOT NULL DEFAULT 'general',
    terminal_count INTEGER NOT NULL DEFAULT 1,
    base_url TEXT NOT NULL,
    control_plane_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_config_status TEXT NOT NULL DEFAULT 'pending',
    last_health_status TEXT NOT NULL DEFAULT 'unknown',
    company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    max_stores INTEGER NOT NULL DEFAULT 1,
    max_terminals_per_store INTEGER NOT NULL DEFAULT 2,
    features_json TEXT NOT NULL DEFAULT '[]',
    price_cents INTEGER NOT NULL DEFAULT 0,
    billing_period TEXT NOT NULL DEFAULT 'monthly'
      CHECK (billing_period IN ('monthly', 'annual', 'once-off')),
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    included_terminals INTEGER NOT NULL DEFAULT 0,
    extra_terminal_price_cents INTEGER NOT NULL DEFAULT 0,
    onboarding_fee_cents INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    billing_email TEXT NOT NULL DEFAULT '',
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    paid_through TEXT,
    trial_ends_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    onboarding_fee_charged INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT,
    paid_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    base_amount_cents INTEGER,
    terminal_amount_cents INTEGER,
    terminal_count INTEGER,
    onboarding_fee_cents INTEGER,
    additional_store_onboarding_cents INTEGER
  );
  CREATE TABLE panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    control_plane_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_health_status TEXT NOT NULL DEFAULT 'unknown',
    licence_sequence INTEGER NOT NULL DEFAULT 0,
    licence_push_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE billing_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    auto_renew INTEGER NOT NULL DEFAULT 1,
    email_invoice INTEGER NOT NULL DEFAULT 1,
    invoice_email TEXT,
    auto_renew_subscription_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

describe('licensed-terminal pricing migration', () => {
  let dbFile: string;
  const originalDbPath = env.dbPath;

  beforeEach(() => {
    dbFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'vula-cp-pricing-migration-')),
      'registry.db',
    );

    const seed = new Database(dbFile);
    seed.exec(FLAT_PRICE_SCHEMA);
    // A priced flat tier with tills the client already runs, an unpriced seeded
    // tier, and the Enterprise tier (custom by convention).
    seed
      .prepare(
        `INSERT INTO plans (id, code, name, max_stores, max_terminals_per_store, features_json, price_cents, onboarding_fee_cents, sort_order)
         VALUES (1, 'starter', 'Starter', 1, 2, '[]', 0, 0, 1),
                (2, 'business', 'Business', 1, 5, '["customer_credit"]', 300000, 0, 2),
                (3, 'multi-store', 'Multi-Store', 10, 5, '["multi_store"]', 500000, 0, 3),
                (4, 'enterprise', 'Enterprise', 50, 99, '["multi_store"]', 0, 0, 4)`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO companies (id, name, slug, plan_id, paid_through, onboarding_fee_charged)
         VALUES (1, 'Urban Threads Retail Group', 'urban-threads', 3, '2026-12-31', 1)`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO stores (id, slug, name, terminal_count, base_url, control_plane_token, company_id)
         VALUES (1, 'urban-threads-cpt', 'Cape Town', 3, 'http://localhost:3246', 't', 1),
                (2, 'urban-threads-dbn', 'Durban', 3, 'http://localhost:3247', 't', 1),
                (3, 'urban-threads-jhb', 'Johannesburg', 3, 'http://localhost:3248', 't', 1),
                (4, 'unassigned-store', 'Lonely', 5, 'http://localhost:3249', 't', NULL)`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO invoices (id, company_id, invoice_number, amount_cents, base_amount_cents, terminal_amount_cents, terminal_count, onboarding_fee_cents, additional_store_onboarding_cents)
         VALUES (1, 1, 'INV-OLD-1', 800000, 500000, 300000, 9, 0, 0)`,
      )
      .run();
    seed.close();

    (env as { dbPath: string }).dbPath = dbFile;
    resetRegistryDb();
  });

  afterEach(() => {
    resetRegistryDb();
    (env as { dbPath: string }).dbPath = originalDbPath;
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it('reshapes plans without ever reinterpreting a flat price as a rate', () => {
    const db = getRegistryDb();
    const rows = db
      .prepare('SELECT code, pricing_mode, terminal_price_cents, setup_fee_cents FROM plans ORDER BY id')
      .all() as Array<{
      code: string;
      pricing_mode: string;
      terminal_price_cents: number;
      setup_fee_cents: number;
    }>;

    // A plan that carried a flat price is custom — NOT R3,000 × 9 terminals.
    const business = rows.find((r) => r.code === 'vula-grow')!;
    expect(business.pricing_mode).toBe('custom');
    expect(business.terminal_price_cents).toBe(0);

    const multi = rows.find((r) => r.code === 'vula-network')!;
    expect(multi.pricing_mode).toBe('custom');
    expect(multi.terminal_price_cents).toBe(0);

    // Enterprise was already custom.
    expect(rows.find((r) => r.code === 'vula-market-enterprise')!.pricing_mode).toBe('custom');

    // The never-priced seeded tier picks up the recommended model.
    const starter = rows.find((r) => r.code === 'vula-start')!;
    expect(starter.pricing_mode).toBe('per_terminal');
    expect(starter.terminal_price_cents).toBe(50_000);
    expect(starter.setup_fee_cents).toBe(1_000_000);

    // The dead bundled columns are gone.
    const planColumns = (db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(planColumns).not.toContain('price_cents');
    expect(planColumns).not.toContain('included_terminals');
    expect(planColumns).not.toContain('extra_terminal_price_cents');
    expect(planColumns).not.toContain('onboarding_fee_cents');
  });

  it('backfills a subscription and per-store allocations from what the stores already run', () => {
    const db = getRegistryDb();
    const sub = db
      .prepare('SELECT * FROM company_subscriptions WHERE company_id = 1')
      .get() as { licensed_terminal_count: number; setup_fee_status: string };
    expect(sub.licensed_terminal_count).toBe(9);
    // The superseded `onboarding_fee_charged = 1` meant the charge was settled.
    expect(sub.setup_fee_status).toBe('paid');

    const allocations = db
      .prepare('SELECT store_id, licensed_terminal_count FROM store_terminal_licences ORDER BY store_id')
      .all() as Array<{ store_id: number; licensed_terminal_count: number }>;
    expect(allocations).toEqual([
      { store_id: 1, licensed_terminal_count: 3 },
      { store_id: 2, licensed_terminal_count: 3 },
      { store_id: 3, licensed_terminal_count: 3 },
    ]);
    // An unassigned store is not licensed by anyone — no allocation row.
    expect(db.prepare('SELECT COUNT(*) AS c FROM store_terminal_licences').get()).toEqual({ c: 3 });

    // The superseded company flag is gone.
    const companyColumns = (
      db.prepare('PRAGMA table_info(companies)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(companyColumns).not.toContain('onboarding_fee_charged');
    expect(db.prepare('SELECT COUNT(*) AS c FROM companies').get()).toEqual({ c: 1 });
  });

  it('carries invoice lines over: onboarding keeps its meaning, dead columns go', () => {
    const db = getRegistryDb();
    const columns = (db.prepare('PRAGMA table_info(invoices)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain('terminal_price_cents');
    expect(columns).toContain('setup_fee_cents');
    expect(columns).not.toContain('base_amount_cents');
    expect(columns).not.toContain('terminal_amount_cents');
    expect(columns).not.toContain('onboarding_fee_cents');
    expect(columns).not.toContain('additional_store_onboarding_cents');

    const invoice = db
      .prepare('SELECT amount_cents, terminal_count, terminal_price_cents, setup_fee_cents FROM invoices WHERE id = 1')
      .get() as {
      amount_cents: number;
      terminal_count: number;
      terminal_price_cents: number | null;
      setup_fee_cents: number | null;
    };
    // The amount is history and stays exactly as issued.
    expect(invoice.amount_cents).toBe(800_000);
    expect(invoice.terminal_count).toBe(9);
    expect(invoice.terminal_price_cents).toBeNull();
    expect(invoice.setup_fee_cents).toBeNull();
  });

  it('is idempotent and leaves no rebuild artifacts behind', () => {
    getRegistryDb();
    const first = getRegistryDb()
      .prepare('SELECT licensed_terminal_count, setup_fee_status FROM company_subscriptions')
      .all();
    resetRegistryDb();
    getRegistryDb();
    const second = getRegistryDb()
      .prepare('SELECT licensed_terminal_count, setup_fee_status FROM company_subscriptions')
      .all();
    expect(second).toEqual(first);

    expect(
      getRegistryDb()
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE '%_rebuild%' OR name LIKE '%plans_old%'")
        .get(),
    ).toEqual({ c: 0 });
    expect(
      getRegistryDb()
        .prepare('SELECT COUNT(*) AS c FROM store_terminal_licences')
        .get(),
    ).toEqual({ c: 3 });
    expect((getRegistryDb().prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);
  });

  it('boots cleanly a second time against a database already at the new shape', () => {
    getRegistryDb();
    resetRegistryDb();
    expect(() => getRegistryDb().prepare('SELECT 1 AS ok').get()).not.toThrow();
    const columns = (
      getRegistryDb().prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain('pricing_mode');
    expect(columns).toContain('terminal_price_cents');
    expect(columns).not.toContain('price_cents');
    expect(columns).not.toContain('extra_terminal_price_cents');
  });
});
