import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { env } from './env.js';

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical = 'general' | 'clothing' | 'spares' | 'hardware' | 'pharmacy';
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
];

export interface StoreRecord {
  id: number;
  slug: string;
  name: string;
  vat_reg_no: string | null;
  vertical: StoreVertical;
  terminal_count: number;
  base_url: string;
  control_plane_token: string;
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
  created_at: string;
  updated_at: string;
}

const STORES_DDL = `
  CREATE TABLE IF NOT EXISTS stores (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                   TEXT    NOT NULL UNIQUE,
    name                   TEXT    NOT NULL,
    vat_reg_no             TEXT,
    vertical               TEXT    NOT NULL DEFAULT 'general',
    terminal_count         INTEGER NOT NULL DEFAULT 1
      CHECK (terminal_count BETWEEN 1 AND 99),
    base_url               TEXT    NOT NULL
      CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
    control_plane_token    TEXT    NOT NULL,
    status                 TEXT    NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'paused')),
    last_config_status     TEXT    NOT NULL DEFAULT 'pending'
      CHECK (last_config_status IN ('pending', 'ok', 'failed')),
    last_config_at         TEXT,
    last_config_snapshot_json TEXT,
    last_health_at         TEXT,
    last_health_status     TEXT    NOT NULL DEFAULT 'unknown'
      CHECK (last_health_status IN ('up', 'down', 'unknown')),
    created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
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
    code: 'retail',
    name: 'Retail',
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
  // Lightweight auto-migrations for pre-existing databases.
  const storeCols = db.prepare('PRAGMA table_info(stores)').all() as Array<{ name: string }>;
  const addColumn = (name: string, ddl: string) => {
    if (!storeCols.some((c) => c.name === name)) db.exec(`ALTER TABLE stores ADD COLUMN ${ddl}`);
  };
  addColumn('vat_reg_no', 'vat_reg_no TEXT');
  addColumn('vertical', "vertical TEXT NOT NULL DEFAULT 'general'");
  addColumn('control_plane_token', `control_plane_token TEXT NOT NULL DEFAULT ''`);
  addColumn('licence_sequence', 'licence_sequence INTEGER NOT NULL DEFAULT 0');
  addColumn('licence_issued_at', 'licence_issued_at TEXT');
  addColumn('licence_push_status', "licence_push_status TEXT NOT NULL DEFAULT 'pending'");
  addColumn('licence_pushed_at', 'licence_pushed_at TEXT');
  // A store belongs to a merchant. Nullable so pre-existing rows keep working.
  addColumn('company_id', 'company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL');

  widenPlanBillingPeriod(db);
  seedPlans(db);
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
  vatRegNo?: string | null;
  vertical?: StoreVertical;
  terminalCount: number;
  baseUrl: string;
}

export const createStore = (input: CreateStoreInput, controlPlaneToken: string): StoreRecord => {
  const db = getRegistryDb();
  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO stores (name, slug, vat_reg_no, vertical, terminal_count, base_url, control_plane_token)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.slug,
        input.vatRegNo ?? null,
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
  vatRegNo?: string | null;
  vertical?: StoreVertical;
  terminalCount?: number;
  baseUrl?: string;
}

/** Absent = keep; explicit null clears (vatRegNo only). */
export const updateStore = (id: number, input: UpdateStoreInput): StoreRecord | null => {
  const db = getRegistryDb();
  const current = getStoreById(id);
  if (!current) return null;
  db.prepare(
    `UPDATE stores SET
       name = COALESCE(?, name),
       vat_reg_no = ?,
       vertical = COALESCE(?, vertical),
       terminal_count = COALESCE(?, terminal_count),
       base_url = COALESCE(?, base_url),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.vatRegNo === undefined ? current.vat_reg_no : input.vatRegNo,
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
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    result.status,
    result.status === 'ok' ? 1 : 0,
    result.status === 'ok' ? JSON.stringify(result.snapshot ?? null) : null,
    id,
  );
  return getStoreById(id);
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
