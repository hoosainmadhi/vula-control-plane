import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { env } from './env.js';

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical =
  | 'general'
  | 'clothing'
  | 'spares'
  | 'hardware'
  | 'pharmacy'
  | 'restaurant';
/** How a plan's price recurs. 'once-off' is a perpetual licence, not a subscription. */
export type PlanPeriod = 'monthly' | 'annual' | 'once-off';

export const STORE_STATUSES: readonly StoreStatus[] = ['active', 'paused'];
export const CONFIG_STATUSES: readonly ConfigStatus[] = ['pending', 'ok', 'failed'];
export const HEALTH_STATUSES: readonly HealthStatus[] = ['up', 'down', 'unknown'];
export const STORE_VERTICALS: readonly StoreVertical[] = [
  'general',
  'clothing',
  'spares',
  'hardware',
  'pharmacy',
  'restaurant',
];

export interface StoreRecord {
  id: number;
  slug: string;
  name: string;
  vertical: StoreVertical;
  terminal_count: number;
  base_url: string;
  control_plane_token: string;
  /** Per-branch credential the merchant's Head Office uses to call this store. */
  head_office_token: string | null;
  status: StoreStatus;
  last_config_status: ConfigStatus;
  last_config_at: string | null;
  last_config_snapshot_json: string | null;
  last_health_at: string | null;
  last_health_status: HealthStatus;
  /** Monotonic licence counter — a store rejects a licence older than the one it holds. */
  licence_sequence: number;
  licence_issued_at: string | null;
  licence_push_status: ConfigStatus;
  licence_pushed_at: string | null;
  /** Owning merchant, if assigned. Nullable for rows predating companies. */
  company_id: number | null;
  /** Deployment status for Coolify container provisioning */
  deploy_status: 'not_deployed' | 'provisioning' | 'deployed' | 'failed';
  coolify_uuid: string | null;
  volume_name: string | null;
  admin_email: string | null;
  desired_config_version?: number;
  applied_config_version?: number;
  latency_ms?: number | null;
  created_at: string;
  updated_at: string;
}

const STORES_DDL = `
  CREATE TABLE IF NOT EXISTS stores (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                   TEXT    NOT NULL UNIQUE,
    name                   TEXT    NOT NULL,
    vertical               TEXT    NOT NULL DEFAULT 'general',
    terminal_count         INTEGER NOT NULL DEFAULT 1
      CHECK (terminal_count BETWEEN 1 AND 99),
    base_url               TEXT    NOT NULL
      CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
    control_plane_token    TEXT    NOT NULL,
    head_office_token      TEXT,
    status                 TEXT    NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'paused')),
    last_config_status     TEXT    NOT NULL DEFAULT 'pending'
      CHECK (last_config_status IN ('pending', 'ok', 'failed')),
    last_config_at         TEXT,
    last_config_snapshot_json TEXT,
    last_health_at         TEXT,
    last_health_status     TEXT    NOT NULL DEFAULT 'unknown'
      CHECK (last_health_status IN ('up', 'down', 'unknown')),
    licence_push_status    TEXT    NOT NULL DEFAULT 'pending',
    licence_pushed_at      TEXT,
    company_id             INTEGER REFERENCES companies(id) ON DELETE SET NULL,
    deploy_status          TEXT    NOT NULL DEFAULT 'not_deployed'
      CHECK (deploy_status IN ('not_deployed', 'provisioning', 'deployed', 'failed')),
    coolify_uuid           TEXT,
    volume_name            TEXT,
    admin_email            TEXT,
    created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

const INVOICES_DDL = `
  CREATE TABLE IF NOT EXISTS invoices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_number    TEXT    NOT NULL UNIQUE,
    amount_cents      INTEGER NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
    due_date          TEXT,
    paid_date         TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

const PAYMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS payments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id        INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
    company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    amount_cents      INTEGER NOT NULL,
    method            TEXT    NOT NULL
      CHECK (method IN ('stripe', 'manual', 'bank_transfer', 'credit_card', 'paypal')),
    status            TEXT    NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
    transaction_id    TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

const BILLING_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS billing_settings (
    company_id        INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    auto_renew        INTEGER NOT NULL DEFAULT 1,
    email_invoice     INTEGER NOT NULL DEFAULT 1,
    invoice_email     TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

/** Columns carried across the billing_settings singleton→per-company rebuild. */
const BILLING_SETTINGS_COLUMNS =
  'company_id, auto_renew, email_invoice, invoice_email, created_at, updated_at';

const DEPLOYMENT_JOBS_DDL = `
  CREATE TABLE IF NOT EXISTS deployment_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL,
    company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('pending', 'running', 'complete', 'failed')),
    error        TEXT,
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

const DEPLOYMENT_JOB_STEPS_DDL = `
  CREATE TABLE IF NOT EXISTS deployment_job_steps (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL REFERENCES deployment_jobs(id) ON DELETE CASCADE,
    step_key      TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   INTEGER,
    status        TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    warnings_json TEXT,
    metadata_json TEXT,
    started_at    TEXT,
    completed_at  TEXT
  )`;

const AUDIT_LOGS_DDL = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    actor         TEXT NOT NULL,
    action        TEXT NOT NULL,
    target_type   TEXT NOT NULL,
    target_id     INTEGER,
    before_json   TEXT,
    after_json    TEXT,
    reason        TEXT,
    result        TEXT NOT NULL DEFAULT 'ok',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

let registry: Database.Database | null = null;

/**
 * Subscription plans. Seeded with four editable SA-retail tiers; the operator can
 * change every value, because the first ten customers each want something slightly
 * different. A plan grants a store-count cap, a per-store terminal ceiling, and a
 * feature set.
 */
const PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS plans (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    code                    TEXT    NOT NULL UNIQUE,
    name                    TEXT    NOT NULL,
    max_stores              INTEGER NOT NULL DEFAULT 1,
    max_terminals_per_store INTEGER NOT NULL DEFAULT 2,
    features_json           TEXT    NOT NULL DEFAULT '[]',
    price_cents             INTEGER NOT NULL DEFAULT 0,
    billing_period          TEXT    NOT NULL DEFAULT 'monthly'
      CHECK (billing_period IN ('monthly', 'annual', 'once-off')),
    is_active               INTEGER NOT NULL DEFAULT 1,
    sort_order              INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

/**
 * The merchant account — the unit of billing, and the thing that owns both the
 * branches and the Company Control Panel. Without it, "3 of 10 stores" has
 * nothing to count against.
 */
const COMPANIES_DDL = `
  CREATE TABLE IF NOT EXISTS companies (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    slug           TEXT    NOT NULL UNIQUE,
    billing_email  TEXT    NOT NULL DEFAULT '',
    plan_id        INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    paid_through   TEXT,
    trial_ends_at  TEXT,
    status         TEXT    NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'suspended')),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

/**
 * The merchant's Company Control Panel — a separate application from a store, so
 * it gets its own table rather than a flag on `stores` (different shape: no
 * terminals, no retail vertical). The control plane deploys and monitors it, and
 * may never read inside it.
 */
const PANELS_DDL = `
  CREATE TABLE IF NOT EXISTS panels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    slug                TEXT    NOT NULL UNIQUE,
    name                TEXT    NOT NULL,
    base_url            TEXT    NOT NULL
      CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
    control_plane_token TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'paused')),
    last_health_status  TEXT    NOT NULL DEFAULT 'unknown'
      CHECK (last_health_status IN ('up', 'down', 'unknown')),
    last_health_at      TEXT,
    app_version         TEXT,
    licence_sequence    INTEGER NOT NULL DEFAULT 0,
    licence_issued_at   TEXT,
    licence_push_status TEXT    NOT NULL DEFAULT 'pending',
    licence_pushed_at   TEXT,
    deploy_status       TEXT    NOT NULL DEFAULT 'not_deployed'
      CHECK (deploy_status IN ('not_deployed', 'provisioning', 'deployed', 'failed')),
    coolify_uuid        TEXT,
    volume_name         TEXT,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

/** The four seeded tiers. Every value is editable from the control plane. */
const SEED_PLANS: Array<{
  code: string;
  name: string;
  maxStores: number;
  maxTerminals: number;
  features: string[];
  sortOrder: number;
}> = [
  { code: 'starter', name: 'Starter', maxStores: 1, maxTerminals: 2, features: [], sortOrder: 1 },
  {
    code: 'business',
    name: 'Business',
    maxStores: 1,
    maxTerminals: 8,
    features: ['customer_credit', 'advanced_reports'],
    sortOrder: 2,
  },
  {
    code: 'multi-store',
    name: 'Multi-Store',
    maxStores: 10,
    maxTerminals: 25,
    features: [
      'customer_credit',
      'advanced_reports',
      'multi_store',
      'stock_transfers',
      'ecommerce_bridges',
    ],
    sortOrder: 3,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    maxStores: 50,
    maxTerminals: 99,
    features: [
      'customer_credit',
      'advanced_reports',
      'multi_store',
      'stock_transfers',
      'ecommerce_bridges',
      'ai_assistant',
    ],
    sortOrder: 4,
  },
];

/** Lazy self-initializing singleton for the registry database. */
export const getRegistryDb = (): Database.Database => {
  if (registry) return registry;
  const dbPath = env.dbPath;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  registry = new Database(dbPath);
  const db = registry;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(STORES_DDL);
  db.exec(PLANS_DDL);
  db.exec(COMPANIES_DDL);
  db.exec(PANELS_DDL);
  db.exec(INVOICES_DDL);
  db.exec(PAYMENTS_DDL);
  db.exec(BILLING_SETTINGS_DDL);
  db.exec(DEPLOYMENT_JOBS_DDL);
  db.exec(DEPLOYMENT_JOB_STEPS_DDL);
  db.exec(AUDIT_LOGS_DDL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deployment_jobs_company ON deployment_jobs(company_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deployment_job_steps_job ON deployment_job_steps(job_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id)');

  // Lightweight auto-migrations for pre-existing databases.
  const storeCols = db.prepare('PRAGMA table_info(stores)').all() as Array<{ name: string }>;
  const addColumn = (name: string, ddl: string) => {
    if (!storeCols.some((c) => c.name === name)) db.exec(`ALTER TABLE stores ADD COLUMN ${ddl}`);
  };
  // §40 privacy: the merchant's VAT registration never belonged on the vendor
  // surface — dropped from the DDL and from existing databases.
  if (storeCols.some((c) => c.name === 'vat_reg_no')) {
    db.exec('ALTER TABLE stores DROP COLUMN vat_reg_no');
  }
  addColumn('vertical', "vertical TEXT NOT NULL DEFAULT 'general'");
  addColumn('control_plane_token', `control_plane_token TEXT NOT NULL DEFAULT ''`);
  // Per-branch Head Office credential — distinct from the vendor CP token.
  addColumn('head_office_token', 'head_office_token TEXT');
  addColumn('licence_sequence', 'licence_sequence INTEGER NOT NULL DEFAULT 0');
  addColumn('licence_issued_at', 'licence_issued_at TEXT');
  addColumn('licence_push_status', "licence_push_status TEXT NOT NULL DEFAULT 'pending'");
  addColumn('licence_pushed_at', 'licence_pushed_at TEXT');
  // A store belongs to a merchant. Nullable so pre-existing rows keep working.
  addColumn('company_id', 'company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL');
  addColumn('deploy_status', "deploy_status TEXT NOT NULL DEFAULT 'not_deployed'");
  addColumn('coolify_uuid', 'coolify_uuid TEXT');
  addColumn('volume_name', 'volume_name TEXT');
  addColumn('admin_email', 'admin_email TEXT');
  addColumn('desired_config_version', 'desired_config_version INTEGER NOT NULL DEFAULT 1');
  addColumn('applied_config_version', 'applied_config_version INTEGER NOT NULL DEFAULT 0');
  addColumn('latency_ms', 'latency_ms INTEGER');

  const panelCols = db.prepare('PRAGMA table_info(panels)').all() as Array<{ name: string }>;
  const addPanelColumn = (name: string, ddl: string) => {
    if (!panelCols.some((c) => c.name === name)) db.exec(`ALTER TABLE panels ADD COLUMN ${ddl}`);
  };
  addPanelColumn('deploy_status', "deploy_status TEXT NOT NULL DEFAULT 'not_deployed'");
  addPanelColumn('coolify_uuid', 'coolify_uuid TEXT');
  addPanelColumn('volume_name', 'volume_name TEXT');

  const stepCols = db
    .prepare('PRAGMA table_info(deployment_job_steps)')
    .all() as Array<{ name: string }>;
  if (!stepCols.some((c) => c.name === 'warnings_json')) {
    db.exec('ALTER TABLE deployment_job_steps ADD COLUMN warnings_json TEXT');
  }

  widenPlanBillingPeriod(db);
  renameRetailPlanToBusiness(db);
  seedPlans(db);
  migrateBillingSettingsToPerCompany(db);
  return registry;
};

/**
 * Column lists used by the table-rebuild migrations, kept next to their DDL so a
 * rebuild cannot silently drop a column.
 */
const PLAN_COLUMNS =
  'id, code, name, max_stores, max_terminals_per_store, features_json, price_cents, billing_period, is_active, sort_order, created_at, updated_at';
const COMPANY_COLUMNS =
  'id, name, slug, billing_email, plan_id, paid_through, trial_ends_at, status, created_at, updated_at';

/** Idempotent plan seed: insert only tiers that do not exist yet, by code. */
const seedPlans = (db: Database.Database): void => {
  const has = db.prepare('SELECT id FROM plans WHERE code = ?');
  const insert = db.prepare(
    `INSERT INTO plans (code, name, max_stores, max_terminals_per_store, features_json, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const seed = db.transaction(() => {
    for (const plan of SEED_PLANS) {
      if (has.get(plan.code)) continue;
      insert.run(
        plan.code,
        plan.name,
        plan.maxStores,
        plan.maxTerminals,
        JSON.stringify(plan.features),
        plan.sortOrder,
      );
    }
  });
  seed();
};

/**
 * Rebuild a table in place, following SQLite's documented procedure.
 *
 * Two details are load-bearing and were wrong at first:
 *  - `foreign_keys = OFF` must be set OUTSIDE the transaction. With it on, dropping
 *    the old table fires ON DELETE actions (it silently nulled companies.plan_id)
 *    and the copy can fail.
 *  - `legacy_alter_table = ON` stops RENAME from rewriting *other* tables' FK
 *    clauses to point at the temporary name. Without it, renaming `plans` to
 *    `plans_old` rewrote `companies.plan_id REFERENCES "plans_old"(id)`, and dropping
 *    the temp table left companies referring to a table that no longer existed.
 */
const rebuildTable = (
  db: Database.Database,
  name: string,
  columns: string,
  ddl: string,
): void => {
  const temp = `${name}_rebuild`;
  const tempDdl = ddl.replace(/CREATE TABLE IF NOT EXISTS\s+\w+/i, `CREATE TABLE ${temp}`);

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    const run = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${temp}`);
      db.exec(tempDdl);
      db.exec(`INSERT INTO ${temp} (${columns}) SELECT ${columns} FROM ${name}`);
      db.exec(`DROP TABLE ${name}`);
      db.exec(`ALTER TABLE ${temp} RENAME TO ${name}`);
    });
    run.immediate();
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma('foreign_keys = ON');
  }
};

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** The DDL stored for a table, or null. */
const storedDdl = (db: Database.Database, name: string): string | null =>
  ((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
    | { sql: string }
    | undefined) ?? null)?.sql ?? null;

/**
 * Repair damage from the earlier faulty plans rebuild: any table whose stored DDL
 * still references the dropped `plans_old` is rebuilt against the real `plans`.
 */
const repairPlanReferences = (db: Database.Database): void => {
  const broken = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%plans_old%'")
    .all() as Array<{ name: string }>;
  for (const { name } of broken) {
    if (name === 'companies') rebuildTable(db, 'companies', COMPANY_COLUMNS, COMPANIES_DDL);
  }
};

/**
 * Widen plans.billing_period to allow 'once-off'. A CHECK cannot be altered in
 * place, so the table is rebuilt — safely, and idempotently.
 */
const widenPlanBillingPeriod = (db: Database.Database): void => {
  // Recover an interrupted earlier attempt before doing anything else.
  if (tableExists(db, 'plans_old')) {
    if (!tableExists(db, 'plans')) {
      // The rename landed but the copy never did: put it back.
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      db.exec('ALTER TABLE plans_old RENAME TO plans');
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    } else {
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TABLE plans_old');
      db.pragma('foreign_keys = ON');
    }
  }

  const ddl = storedDdl(db, 'plans');
  if (ddl && !ddl.includes('once-off')) {
    rebuildTable(db, 'plans', PLAN_COLUMNS, PLANS_DDL);
  }

  // Whether or not we just rebuilt, undo any reference left pointing at plans_old.
  repairPlanReferences(db);
};

/**
 * Retail → Business (2026-09-12). "Retail" names a vertical, not a commercial
 * tier — Vula serves clothing, spares, pharmacy, restaurant and general retail,
 * so the tier must not imply one. `code` is the technical identifier licences
 * carry, so the rename migrates existing rows once and the code is immutable
 * from the API afterwards.
 */
const renameRetailPlanToBusiness = (db: Database.Database): void => {
  if (!tableExists(db, 'plans')) return;
  const hasRetail = db.prepare('SELECT 1 FROM plans WHERE code = ?').get('retail');
  if (!hasRetail) return;
  const hasBusiness = db.prepare('SELECT 1 FROM plans WHERE code = ?').get('business');
  if (hasBusiness) {
    // A business tier already exists (operator-created): keep it, retire retail quietly.
    db.prepare('UPDATE plans SET name = ?, updated_at = datetime(\'now\') WHERE code = ?').run(
      'Business',
      'retail',
    );
    return;
  }
  db.prepare("UPDATE plans SET code = 'business', name = 'Business', updated_at = datetime('now') WHERE code = 'retail'").run();
};

/**
 * billing_settings was modelled as a singleton (`CHECK (id = 1)`) but used as
 * per-company data — the second company's settings save violated the CHECK.
 * Rebuilt with company_id as the natural key; the unused
 * auto_renew_subscription_id column is dropped. Idempotent.
 */
const migrateBillingSettingsToPerCompany = (db: Database.Database): void => {
  if (!tableExists(db, 'billing_settings')) return;
  const ddl = storedDdl(db, 'billing_settings');
  if (ddl && ddl.includes('CHECK (id = 1)')) {
    rebuildTable(db, 'billing_settings', BILLING_SETTINGS_COLUMNS, BILLING_SETTINGS_DDL);
  }
};

/** Test helper: close and drop the singleton so the next getRegistryDb() call reopens (e.g. :memory:). */
export const resetRegistryDb = (): void => {
  if (registry) {
    registry.close();
    registry = null;
  }
};

const rowToStore = (row: unknown): StoreRecord => row as StoreRecord;

export const listStores = (): StoreRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM stores ORDER BY created_at DESC, id DESC')
    .all()
    .map(rowToStore);

export const getStoreById = (id: number): StoreRecord | null => {
  const row = getRegistryDb().prepare('SELECT * FROM stores WHERE id = ?').get(id);
  return row ? rowToStore(row) : null;
};

export const getStoreBySlug = (slug: string): StoreRecord | null => {
  const row = getRegistryDb().prepare('SELECT * FROM stores WHERE slug = ?').get(slug);
  return row ? rowToStore(row) : null;
};

export interface CreateStoreInput {
  name: string;
  slug: string;
  vertical?: StoreVertical;
  terminalCount: number;
  baseUrl: string;
}

export const createStore = (input: CreateStoreInput, controlPlaneToken: string): StoreRecord => {
  const db = getRegistryDb();
  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO stores (name, slug, vertical, terminal_count, base_url, control_plane_token)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.slug,
        input.vertical ?? 'general',
        input.terminalCount,
        input.baseUrl,
        controlPlaneToken,
      );
    return Number(info.lastInsertRowid);
  });
  const id = insert();
  return getStoreById(id)!;
};

export interface UpdateStoreInput {
  name?: string;
  vertical?: StoreVertical;
  terminalCount?: number;
  baseUrl?: string;
}

/** Absent = keep. */
export const updateStore = (id: number, input: UpdateStoreInput): StoreRecord | null => {
  const db = getRegistryDb();
  if (!getStoreById(id)) return null;
  db.prepare(
    `UPDATE stores SET
       name = COALESCE(?, name),
       vertical = COALESCE(?, vertical),
       terminal_count = COALESCE(?, terminal_count),
       base_url = COALESCE(?, base_url),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.vertical ?? null,
    input.terminalCount ?? null,
    input.baseUrl ?? null,
    id,
  );
  return getStoreById(id);
};

export const setStoreStatus = (id: number, status: StoreStatus): StoreRecord | null => {
  if (!STORE_STATUSES.includes(status)) throw new Error('Invalid store status');
  getRegistryDb()
    .prepare("UPDATE stores SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
  return getStoreById(id);
};

export const setStoreDeployStatus = (
  id: number,
  status: 'not_deployed' | 'provisioning' | 'deployed' | 'failed',
  meta?: { coolifyUuid?: string; volumeName?: string; adminEmail?: string },
): StoreRecord | null => {
  getRegistryDb()
    .prepare(
      `UPDATE stores SET
         deploy_status = ?,
         coolify_uuid = COALESCE(?, coolify_uuid),
         volume_name = COALESCE(?, volume_name),
         admin_email = COALESCE(?, admin_email),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, meta?.coolifyUuid ?? null, meta?.volumeName ?? null, meta?.adminEmail ?? null, id);
  return getStoreById(id);
};

export interface ConfigResultRecord {
  status: 'ok' | 'failed';
  snapshot?: unknown;
}

/** Records the outcome of a terminal-config push. Snapshot is only kept on success. */
/**
 * Remove a store from the registry. The DEPLOYMENT is untouched — this only drops
 * the control plane's record of it, so nothing running is affected. Callers must
 * enforce the pause-first policy before reaching here.
 */
export const deleteStore = (id: number): boolean => {
  if (!getStoreById(id)) return false;
  getRegistryDb().prepare('DELETE FROM stores WHERE id = ?').run(id);
  return true;
};

export const recordConfigResult = (id: number, result: ConfigResultRecord): StoreRecord | null => {
  const db = getRegistryDb();
  const store = getStoreById(id);
  if (!store) return null;
  db.prepare(
    `UPDATE stores SET
       last_config_status = ?,
       last_config_at = CASE WHEN ? THEN datetime('now') ELSE last_config_at END,
       last_config_snapshot_json = ?,
       applied_config_version = CASE WHEN ? THEN COALESCE(desired_config_version, 1) ELSE applied_config_version END,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    result.status,
    result.status === 'ok' ? 1 : 0,
    result.status === 'ok' ? JSON.stringify(result.snapshot ?? null) : null,
    result.status === 'ok' ? 1 : 0,
    id,
  );
  return getStoreById(id);
};

export const advanceDesiredConfigVersion = (id: number): void => {
  getRegistryDb()
    .prepare('UPDATE stores SET desired_config_version = COALESCE(desired_config_version, 0) + 1, updated_at = datetime(\'now\') WHERE id = ?')
    .run(id);
};

/** Reserve the next monotonic licence sequence for a store. */
export const nextLicenceSequence = (id: number): number => {
  const db = getRegistryDb();
  db.prepare(
    `UPDATE stores SET licence_sequence = licence_sequence + 1, licence_issued_at = datetime('now')
      WHERE id = ?`,
  ).run(id);
  return getStoreById(id)?.licence_sequence ?? 1;
};

export const recordLicencePush = (id: number, status: ConfigStatus): StoreRecord | null => {
  getRegistryDb()
    .prepare(
      `UPDATE stores SET
         licence_push_status = ?,
         licence_pushed_at = CASE WHEN ? THEN datetime('now') ELSE licence_pushed_at END,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, status === 'ok' ? 1 : 0, id);
  return getStoreById(id);
};

export const recordHealthResult = (id: number, status: 'up' | 'down'): StoreRecord | null => {
  const db = getRegistryDb();
  const store = getStoreById(id);
  if (!store) return null;
  db.prepare(
    `UPDATE stores SET
       last_health_status = ?, last_health_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
  ).run(status, id);
  return getStoreById(id);
};

// --- Plans -------------------------------------------------------------------

export interface PlanRecord {
  id: number;
  code: string;
  name: string;
  max_stores: number;
  max_terminals_per_store: number;
  features_json: string;
  price_cents: number;
  billing_period: PlanPeriod;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export const listPlans = (): PlanRecord[] =>
  getRegistryDb().prepare('SELECT * FROM plans ORDER BY sort_order, id').all() as PlanRecord[];

export const getPlanById = (id: number): PlanRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRecord) ?? null;

export const getPlanByCode = (code: string): PlanRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM plans WHERE code = ?').get(code) as PlanRecord) ?? null;

export interface PlanInput {
  code: string;
  name: string;
  maxStores: number;
  maxTerminalsPerStore: number;
  features: string[];
  priceCents?: number;
  billingPeriod?: PlanPeriod;
}

export const PLAN_PERIODS: readonly PlanPeriod[] = ['monthly', 'annual', 'once-off'];

export const createPlan = (input: PlanInput): PlanRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO plans (code, name, max_stores, max_terminals_per_store, features_json, price_cents, billing_period, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM plans), 1))`,
    )
    .run(
      input.code,
      input.name,
      input.maxStores,
      input.maxTerminalsPerStore,
      JSON.stringify(input.features),
      input.priceCents ?? 0,
      input.billingPeriod ?? 'monthly',
    );
  return getPlanById(Number(info.lastInsertRowid))!;
};

export const updatePlan = (id: number, input: Partial<PlanInput> & { isActive?: boolean }): PlanRecord | null => {
  const existing = getPlanById(id);
  if (!existing) return null;
  // `code` is the technical identifier licences and integrations depend on —
  // immutable after creation (2026-09-12). Edit the display name instead.
  getRegistryDb()
    .prepare(
      `UPDATE plans SET
         name = COALESCE(?, name),
         max_stores = COALESCE(?, max_stores),
         max_terminals_per_store = COALESCE(?, max_terminals_per_store),
         features_json = COALESCE(?, features_json),
         price_cents = COALESCE(?, price_cents),
         billing_period = COALESCE(?, billing_period),
         is_active = COALESCE(?, is_active),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      input.name ?? null,
      input.maxStores ?? null,
      input.maxTerminalsPerStore ?? null,
      input.features ? JSON.stringify(input.features) : null,
      input.priceCents ?? null,
      input.billingPeriod ?? null,
      input.isActive === undefined ? null : input.isActive ? 1 : 0,
      id,
    );
  return getPlanById(id);
};

export const countCompaniesForPlan = (planId: number): number =>
  (getRegistryDb().prepare('SELECT COUNT(*) AS c FROM companies WHERE plan_id = ?').get(planId) as { c: number }).c;

export const deletePlan = (id: number): boolean => {
  const db = getRegistryDb();
  const inUse = countCompaniesForPlan(id);
  if (inUse > 0) {
    throw new Error(
      `Cannot delete plan: currently assigned to ${inUse} ${inUse === 1 ? 'company' : 'companies'}. Deactivate the plan instead.`,
    );
  }
  const res = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return res.changes > 0;
};

export const planFeatures = (plan: PlanRecord | null): string[] => {
  if (!plan) return [];
  try {
    const parsed = JSON.parse(plan.features_json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

// --- Companies ---------------------------------------------------------------

export interface CompanyRecord {
  id: number;
  name: string;
  slug: string;
  billing_email: string;
  plan_id: number | null;
  paid_through: string | null;
  trial_ends_at: string | null;
  status: 'active' | 'suspended';
  created_at: string;
  updated_at: string;
}

export interface InvoiceRecord {
  id: number;
  company_id: number;
  invoice_number: string;
  amount_cents: number;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  due_date: string | null;
  paid_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRecord {
  id: number;
  invoice_id: number;
  company_id: number;
  amount_cents: number;
  method: 'stripe' | 'manual' | 'bank_transfer' | 'credit_card' | 'paypal';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
  transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingSettingsRecord {
  company_id: number;
  auto_renew: number;
  email_invoice: number;
  invoice_email: string | null;
  created_at: string;
  updated_at: string;
}

export const listCompanies = (): CompanyRecord[] =>
  getRegistryDb().prepare('SELECT * FROM companies ORDER BY name').all() as CompanyRecord[];

export const getCompanyById = (id: number): CompanyRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRecord) ?? null;

export const getCompanyBySlug = (slug: string): CompanyRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM companies WHERE slug = ?').get(slug) as CompanyRecord) ?? null;

export const countStoresForCompany = (companyId: number): number =>
  (getRegistryDb().prepare('SELECT COUNT(*) AS c FROM stores WHERE company_id = ?').get(companyId) as {
    c: number;
  }).c;

export interface CompanyInput {
  name: string;
  slug: string;
  billingEmail?: string;
  planId?: number | null;
  paidThrough?: string | null;
  trialEndsAt?: string | null;
}

export const createCompany = (input: CompanyInput): CompanyRecord => {
  const info = getRegistryDb()
    .prepare(
      `INSERT INTO companies (name, slug, billing_email, plan_id, paid_through, trial_ends_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.slug,
      input.billingEmail ?? '',
      input.planId ?? null,
      input.paidThrough ?? null,
      input.trialEndsAt ?? null,
    );
  return getCompanyById(Number(info.lastInsertRowid))!;
};

export const updateCompany = (
  id: number,
  input: Partial<CompanyInput> & { status?: 'active' | 'suspended' },
): CompanyRecord | null => {
  if (!getCompanyById(id)) return null;
  getRegistryDb()
    .prepare(
      `UPDATE companies SET
         name = COALESCE(?, name),
         billing_email = COALESCE(?, billing_email),
         plan_id = COALESCE(?, plan_id),
         paid_through = COALESCE(?, paid_through),
         trial_ends_at = COALESCE(?, trial_ends_at),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      input.name ?? null,
      input.billingEmail ?? null,
      input.planId === undefined ? null : input.planId,
      input.paidThrough === undefined ? null : input.paidThrough,
      input.trialEndsAt === undefined ? null : input.trialEndsAt,
      input.status ?? null,
      id,
    );
  return getCompanyById(id);
};

/** Assign a store to a merchant (or clear the link with null). */
export const setStoreCompany = (storeId: number, companyId: number | null): StoreRecord | null => {
  if (!getStoreById(storeId)) return null;
  getRegistryDb()
    .prepare('UPDATE stores SET company_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(companyId, storeId);
  return getStoreById(storeId);
};

// --- Panels (Company Control Panel deployments) -------------------------------

export interface PanelRecord {
  id: number;
  company_id: number;
  slug: string;
  name: string;
  base_url: string;
  control_plane_token: string;
  status: 'active' | 'paused';
  last_health_status: HealthStatus;
  last_health_at: string | null;
  app_version: string | null;
  licence_sequence: number;
  licence_issued_at: string | null;
  licence_push_status: ConfigStatus;
  licence_pushed_at: string | null;
  /** Deployment status for Coolify container provisioning (Head Office image) */
  deploy_status: 'not_deployed' | 'provisioning' | 'deployed' | 'failed';
  coolify_uuid: string | null;
  volume_name: string | null;
  created_at: string;
  updated_at: string;
}

export const listPanels = (): PanelRecord[] =>
  getRegistryDb().prepare('SELECT * FROM panels ORDER BY name').all() as PanelRecord[];

export const getPanelById = (id: number): PanelRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM panels WHERE id = ?').get(id) as PanelRecord) ?? null;

export const getPanelBySlug = (slug: string): PanelRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM panels WHERE slug = ?').get(slug) as PanelRecord) ?? null;

export const listPanelsForCompany = (companyId: number): PanelRecord[] =>
  getRegistryDb().prepare('SELECT * FROM panels WHERE company_id = ?').all(companyId) as PanelRecord[];

export interface PanelInput {
  companyId: number;
  slug: string;
  name: string;
  baseUrl: string;
  controlPlaneToken: string;
}

export const createPanel = (input: PanelInput): PanelRecord => {
  const info = getRegistryDb()
    .prepare(
      `INSERT INTO panels (company_id, slug, name, base_url, control_plane_token)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.companyId, input.slug, input.name, input.baseUrl, input.controlPlaneToken);
  return getPanelById(Number(info.lastInsertRowid))!;
};

export const updatePanel = (
  id: number,
  input: Partial<Pick<PanelInput, 'name' | 'baseUrl'>> & { status?: 'active' | 'paused' },
): PanelRecord | null => {
  if (!getPanelById(id)) return null;
  getRegistryDb()
    .prepare(
      `UPDATE panels SET
         name = COALESCE(?, name),
         base_url = COALESCE(?, base_url),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(input.name ?? null, input.baseUrl ?? null, input.status ?? null, id);
  return getPanelById(id);
};

export const recordPanelHealth = (
  id: number,
  status: 'up' | 'down',
  appVersion?: string | null,
): PanelRecord | null => {
  if (!getPanelById(id)) return null;
  getRegistryDb()
    .prepare(
      `UPDATE panels SET
         last_health_status = ?,
         last_health_at = datetime('now'),
         app_version = COALESCE(?, app_version),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, appVersion ?? null, id);
  return getPanelById(id);
};

export const deletePanel = (id: number): boolean => {
  if (!getPanelById(id)) return false;
  getRegistryDb().prepare('DELETE FROM panels WHERE id = ?').run(id);
  return true;
};

/**
 * Hard-delete a company. Callers must check `companyBlockers` first: the schema
 * cascades panels and nulls store assignments, so an unguarded delete would
 * silently strip a merchant's Head Office and its branches' entitlement.
 */
export const deleteCompany = (id: number): boolean => {
  if (!getCompanyById(id)) return false;
  getRegistryDb().prepare('DELETE FROM companies WHERE id = ?').run(id);
  return true;
};

export interface CompanyBlockers {
  stores: number;
  panels: number;
}

/** What would be silently destroyed if this company were deleted. */
export const companyBlockers = (companyId: number): CompanyBlockers => ({
  stores: countStoresForCompany(companyId),
  panels: listPanelsForCompany(companyId).length,
});

export const nextPanelLicenceSequence = (id: number): number => {
  getRegistryDb()
    .prepare(
      `UPDATE panels SET licence_sequence = licence_sequence + 1, licence_issued_at = datetime('now')
        WHERE id = ?`,
    )
    .run(id);
  return getPanelById(id)?.licence_sequence ?? 1;
};

export const recordPanelLicencePush = (id: number, status: ConfigStatus): PanelRecord | null => {
  getRegistryDb()
    .prepare(
      `UPDATE panels SET
         licence_push_status = ?,
         licence_pushed_at = CASE WHEN ? THEN datetime('now') ELSE licence_pushed_at END,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, status === 'ok' ? 1 : 0, id);
  return getPanelById(id);
};

export const setPanelDeployStatus = (
  id: number,
  status: 'not_deployed' | 'provisioning' | 'deployed' | 'failed',
  meta?: { coolifyUuid?: string; volumeName?: string },
): PanelRecord | null => {
  getRegistryDb()
    .prepare(
      `UPDATE panels SET
         deploy_status = ?,
         coolify_uuid = COALESCE(?, coolify_uuid),
         volume_name = COALESCE(?, volume_name),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, meta?.coolifyUuid ?? null, meta?.volumeName ?? null, id);
  return getPanelById(id);
};

/**
 * Stores a branch's dedicated Head Office credential. Generated by the control
 * plane during topology wiring; the merchant's Head Office registers the same
 * value so the two always agree. Distinct from the vendor CP token by design.
 */
export const setStoreHeadOfficeToken = (id: number, token: string): StoreRecord | null => {
  getRegistryDb()
    .prepare(
      `UPDATE stores SET head_office_token = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(token, id);
  return getStoreById(id);
};

// --- Invoices -----------------------------------------------------------------

export const listInvoices = (companyId?: number): InvoiceRecord[] => {
  const db = getRegistryDb();
  const query = companyId
    ? db.prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY created_at DESC, id DESC').all(companyId)
    : db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, id DESC').all();
  return query as InvoiceRecord[];
};

export const getInvoiceById = (id: number): InvoiceRecord | null => {
  const row = getRegistryDb().prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  return row ? (row as InvoiceRecord) : null;
};

export const getInvoiceByNumber = (invoiceNumber: string): InvoiceRecord | null => {
  const row = getRegistryDb().prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(invoiceNumber);
  return row ? (row as InvoiceRecord) : null;
};

export const createInvoice = (
  companyId: number,
  amountCents: number,
  dueDate: Date,
  invoiceNumber?: string,
): InvoiceRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO invoices (company_id, invoice_number, amount_cents, due_date, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    )
    .run(
      companyId,
      invoiceNumber || `INV-${new Date().toISOString().slice(0, 10)}-${Math.floor(Math.random() * 10000)}`,
      amountCents,
      dueDate.toISOString().slice(0, 10),
    );
  return getInvoiceById(Number(info.lastInsertRowid))!;
};

export const updateInvoice = (
  id: number,
  updates: {
    status?: 'pending' | 'paid' | 'overdue' | 'cancelled';
    paidDate?: Date;
  },
): InvoiceRecord | null => {
  if (!getInvoiceById(id)) return null;
  const updatesList: string[] = [];
  const values: unknown[] = [];

  if (updates.status) {
    updatesList.push('status = ?');
    values.push(updates.status);
  }

  if (updates.paidDate) {
    updatesList.push('paid_date = ?');
    values.push(updates.paidDate.toISOString().slice(0, 10));
  }

  if (updatesList.length === 0) return getInvoiceById(id);

  values.push(id);
  getRegistryDb()
    .prepare(`UPDATE invoices SET ${updatesList.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...values);

  return getInvoiceById(id);
};

// --- Payments -----------------------------------------------------------------

export const listPayments = (companyId?: number): PaymentRecord[] => {
  const db = getRegistryDb();
  const query = companyId
    ? db.prepare('SELECT * FROM payments WHERE company_id = ? ORDER BY created_at DESC, id DESC').all(companyId)
    : db.prepare('SELECT * FROM payments ORDER BY created_at DESC, id DESC').all();
  return query as PaymentRecord[];
};

export const getPaymentById = (id: number): PaymentRecord | null => {
  const row = getRegistryDb().prepare('SELECT * FROM payments WHERE id = ?').get(id);
  return row ? (row as PaymentRecord) : null;
};

export const createPayment = (
  invoiceId: number,
  companyId: number,
  amountCents: number,
  method: PaymentRecord['method'],
  transactionId?: string,
): PaymentRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO payments (invoice_id, company_id, amount_cents, method, status, transaction_id)
       VALUES (?, ?, ?, ?, 'processing', ?)`,
    )
    .run(invoiceId, companyId, amountCents, method, transactionId || null);
  return getPaymentById(Number(info.lastInsertRowid))!;
};

export const updatePayment = (id: number, updates: {
  status?: PaymentRecord['status'];
  transactionId?: string;
}): PaymentRecord | null => {
  if (!getPaymentById(id)) return null;
  const updatesList: string[] = [];
  const values: unknown[] = [];

  if (updates.status) {
    updatesList.push('status = ?');
    values.push(updates.status);
  }

  if (updates.transactionId !== undefined) {
    updatesList.push('transaction_id = ?');
    values.push(updates.transactionId);
  }

  if (updatesList.length === 0) return getPaymentById(id);

  values.push(id);
  getRegistryDb()
    .prepare(`UPDATE payments SET ${updatesList.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...values);

  return getPaymentById(id);
};

// --- Billing Settings ---------------------------------------------------------

export const getBillingSettings = (companyId: number): BillingSettingsRecord | null => {
  const row = getRegistryDb()
    .prepare('SELECT * FROM billing_settings WHERE company_id = ?')
    .get(companyId);
  return row ? (row as BillingSettingsRecord) : null;
};

export const upsertBillingSettings = (
  companyId: number,
  settings: Partial<Pick<BillingSettingsRecord, 'auto_renew' | 'email_invoice' | 'invoice_email'>>,
): BillingSettingsRecord => {
  const db = getRegistryDb();
  const existing = getBillingSettings(companyId);

  const autoRenew = settings.auto_renew !== undefined ? (settings.auto_renew ? 1 : 0) : existing?.auto_renew ?? 1;
  const emailInvoice = settings.email_invoice !== undefined ? (settings.email_invoice ? 1 : 0) : existing?.email_invoice ?? 1;
  const invoiceEmail = settings.invoice_email ?? existing?.invoice_email ?? '';

  db.prepare(
    `INSERT INTO billing_settings (company_id, auto_renew, email_invoice, invoice_email)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (company_id) DO UPDATE SET
       auto_renew = excluded.auto_renew,
       email_invoice = excluded.email_invoice,
       invoice_email = excluded.invoice_email,
       updated_at = datetime('now')`,
  ).run(companyId, autoRenew, emailInvoice, invoiceEmail);

  return getBillingSettings(companyId)!;
};

// --- Deployment Jobs & Steps (§11, §27) ---------------------------------------

export interface DeploymentJobRecord {
  id: number;
  type: string;
  company_id: number;
  status: 'pending' | 'running' | 'complete' | 'failed';
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentJobStepRecord {
  id: number;
  job_id: number;
  step_key: string;
  resource_type: string;
  resource_id: number | null;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
  /** Best-effort operations that did not succeed — the step still completed. */
  warnings_json: string | null;
  metadata_json: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface AuditLogRecord {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: number | null;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  result: string;
  created_at: string;
}

export const createDeploymentJob = (companyId: number, type: string): DeploymentJobRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare('INSERT INTO deployment_jobs (company_id, type, status) VALUES (?, ?, ?)')
    .run(companyId, type, 'running');
  return getDeploymentJobById(Number(info.lastInsertRowid))!;
};

export const updateDeploymentJob = (
  id: number,
  updates: {
    status?: DeploymentJobRecord['status'];
    error?: string | null;
    completedAt?: string | null;
  },
): DeploymentJobRecord | null => {
  const current = getDeploymentJobById(id);
  if (!current) return null;
  getRegistryDb()
    .prepare(
      `UPDATE deployment_jobs SET
         status = COALESCE(?, status),
         error = ?,
         completed_at = COALESCE(?, completed_at),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      updates.status ?? null,
      updates.error === undefined ? current.error : updates.error,
      updates.completedAt ?? null,
      id,
    );
  return getDeploymentJobById(id);
};

export const getDeploymentJobById = (id: number): DeploymentJobRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM deployment_jobs WHERE id = ?').get(id) as DeploymentJobRecord) ?? null;

export const listDeploymentJobsForCompany = (companyId: number): DeploymentJobRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM deployment_jobs WHERE company_id = ? ORDER BY id DESC')
    .all(companyId) as DeploymentJobRecord[];

export const createDeploymentStep = (
  jobId: number,
  stepKey: string,
  resourceType: string,
  resourceId?: number | null,
  metadata?: unknown,
): DeploymentJobStepRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO deployment_job_steps (job_id, step_key, resource_type, resource_id, metadata_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    )
    .run(jobId, stepKey, resourceType, resourceId ?? null, metadata ? JSON.stringify(metadata) : null);
  return (
    (db.prepare('SELECT * FROM deployment_job_steps WHERE id = ?').get(Number(info.lastInsertRowid)) as DeploymentJobStepRecord) ??
    null
  );
};

export const updateDeploymentStep = (
  id: number,
  updates: {
    status?: DeploymentJobStepRecord['status'];
    error?: string | null;
    warnings?: string[];
    resourceId?: number | null;
    metadata?: unknown;
    attempts?: number;
    completed?: boolean;
  },
): DeploymentJobStepRecord | null => {
  const db = getRegistryDb();
  const current = db.prepare('SELECT * FROM deployment_job_steps WHERE id = ?').get(id) as
    | DeploymentJobStepRecord
    | undefined;
  if (!current) return null;

  const metadataJson = updates.metadata !== undefined ? JSON.stringify(updates.metadata) : current.metadata_json;
  const warningsJson = updates.warnings !== undefined ? JSON.stringify(updates.warnings) : current.warnings_json;

  db.prepare(
    `UPDATE deployment_job_steps SET
       status = COALESCE(?, status),
       error = ?,
       warnings_json = ?,
       resource_id = COALESCE(?, resource_id),
       metadata_json = ?,
       attempts = COALESCE(?, attempts),
       completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END
     WHERE id = ?`,
  ).run(
    updates.status ?? null,
    updates.error === undefined ? current.error : updates.error,
    warningsJson,
    updates.resourceId ?? null,
    metadataJson,
    updates.attempts ?? null,
    updates.completed ? 1 : 0,
    id,
  );
  return db.prepare('SELECT * FROM deployment_job_steps WHERE id = ?').get(id) as DeploymentJobStepRecord;
};

export const listStepsForJob = (jobId: number): DeploymentJobStepRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM deployment_job_steps WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as DeploymentJobStepRecord[];

export const recordAuditLog = (
  actor: string,
  action: string,
  targetType: string,
  targetId?: number | null,
  details?: {
    before?: unknown;
    after?: unknown;
    reason?: string;
    result?: string;
  },
): AuditLogRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO audit_logs (actor, action, target_type, target_id, before_json, after_json, reason, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actor,
      action,
      targetType,
      targetId ?? null,
      details?.before ? JSON.stringify(details.before) : null,
      details?.after ? JSON.stringify(details.after) : null,
      details?.reason || null,
      details?.result || 'ok',
    );
  return db.prepare('SELECT * FROM audit_logs WHERE id = ?').get(Number(info.lastInsertRowid)) as AuditLogRecord;
};

export const listAuditLogs = (limit = 100): AuditLogRecord[] =>
  getRegistryDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit) as AuditLogRecord[];

