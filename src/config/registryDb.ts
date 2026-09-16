import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { env, logger } from './env.js';

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical =
  'general' | 'clothing' | 'spares' | 'hardware' | 'pharmacy' | 'restaurant' | 'custom';

/** Deployment environment of the store (SPOG §5/§44). */
export type StoreEnvironment = 'production' | 'staging' | 'demo' | 'development';
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
  'custom',
];

export const STORE_ENVIRONMENTS: readonly StoreEnvironment[] = [
  'production',
  'staging',
  'demo',
  'development',
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
  environment: StoreEnvironment;
  status: StoreStatus;
  last_config_status: ConfigStatus;
  last_config_at: string | null;
  last_config_snapshot_json: string | null;
  /** Why the last push failed — survives refresh so a red badge explains itself. */
  last_config_error: string | null;
  last_health_at: string | null;
  last_health_status: HealthStatus;
  /** Why the last health check went down — survives refresh (F1). */
  last_health_error: string | null;
  /** Monotonic licence counter — a store rejects a licence older than the one it holds. */
  /** Custom per-till names (Till 1..N when null) — pushed on every configure. */
  terminal_names_json: string | null;
  /** Last telemetry snapshot (technical only) + derived fields, from /api/internal/telemetry. */
  app_version: string | null;
  schema_version: number | null;
  last_heartbeat_at: string | null;
  last_telemetry_json: string | null;
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
    environment            TEXT    NOT NULL DEFAULT 'development'
      CHECK (environment IN ('production', 'staging', 'demo', 'development')),
    status                 TEXT    NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'paused')),
    last_config_status     TEXT    NOT NULL DEFAULT 'pending'
      CHECK (last_config_status IN ('pending', 'ok', 'failed')),
    last_config_at         TEXT,
    last_config_snapshot_json TEXT,
    last_config_error      TEXT,
    last_health_at         TEXT,
    last_health_status     TEXT    NOT NULL DEFAULT 'unknown'
      CHECK (last_health_status IN ('up', 'down', 'unknown')),
    last_health_error      TEXT,
    terminal_names_json    TEXT,
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

/**
 * Invoices. The breakdown columns are the evidence for the amount, not a second
 * source of truth for it: `terminal_count × terminal_price_cents` is the
 * recurring line as it stood when the invoice was raised (the rate is a
 * snapshot, so editing the plan afterwards cannot rewrite an issued invoice),
 * and `setup_fee_cents` is the once-off onboarding charge when the invoice
 * carried it. Renewals never carry the setup fee.
 */
const INVOICES_DDL = `
  CREATE TABLE IF NOT EXISTS invoices (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_number       TEXT    NOT NULL UNIQUE,
    amount_cents         INTEGER NOT NULL,
    terminal_count       INTEGER,
    terminal_price_cents INTEGER,
    setup_fee_cents      INTEGER,
    description          TEXT,
    -- The plan the subscription was on when the invoice was raised: a snapshot, so
    -- renaming a plan never restates what an issued invoice says.
    plan_code            TEXT,
    plan_name            TEXT,
    -- For a mid-period increase: the paid period this charge covered, so the same
    -- increase cannot be billed twice for one period.
    pro_rata_period      TEXT,
    -- The tax split of amount_cents, which is VAT-INCLUSIVE (owner decision,
    -- 2026-09-16). Held as three columns rather than derived on read: a rate
    -- change must never rewrite a document that has already been issued.
    subtotal_cents       INTEGER,
    vat_cents            INTEGER,
    vat_rate             INTEGER,
    status               TEXT    NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
    due_date             TEXT,
    paid_date            TEXT,
    emailed_at           TEXT,
    emailed_to           TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
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

/**
 * The control plane's OWN settings — the vendor's identity and the mailer it
 * sends from. Distinct from `billing_settings` (per client) and from the
 * tenant's per-store `settings`: nothing a merchant owns lives here.
 *
 * A real singleton (`CHECK (id = 1)`), so "the settings row" is a fact of the
 * schema rather than a convention the code has to keep.
 */
const OFFICE_SETTINGS_DDL = `
  CREATE TABLE IF NOT EXISTS office_settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    office_name       TEXT    NOT NULL DEFAULT 'Vula',
    office_email      TEXT    NOT NULL DEFAULT '',
    office_phone      TEXT    NOT NULL DEFAULT '',
    office_address    TEXT    NOT NULL DEFAULT '',
    invoice_due_days  INTEGER NOT NULL DEFAULT 14
      CHECK (invoice_due_days BETWEEN 1 AND 180),
    invoice_footer    TEXT    NOT NULL DEFAULT '',
    -- The vendor's own VAT registration and the rate its (VAT-inclusive) prices
    -- are quoted at. Nothing here is a merchant's tax data — that stays off this
    -- plane entirely (§40).
    vat_reg_no        TEXT    NOT NULL DEFAULT '',
    vat_rate          INTEGER NOT NULL DEFAULT 15
      CHECK (vat_rate BETWEEN 0 AND 100),
    smtp_host         TEXT    NOT NULL DEFAULT '',
    smtp_port         INTEGER NOT NULL DEFAULT 587,
    smtp_user         TEXT    NOT NULL DEFAULT '',
    smtp_pass         TEXT    NOT NULL DEFAULT '',
    smtp_from         TEXT    NOT NULL DEFAULT '',
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  )`;

/**
 * Invoice numbers are a monotonic per-year sequence (`VULA-2026-000001`), not a
 * date plus random digits: two invoices raised in the same second used to be able
 * to collide on the UNIQUE index, and the loser surfaced as a raw database error
 * instead of a retry. The counter is a row in SQLite, so it survives restarts and
 * is incremented inside the statement that reads it.
 */
const INVOICE_SEQUENCES_DDL = `
  CREATE TABLE IF NOT EXISTS invoice_sequences (
    year       INTEGER PRIMARY KEY,
    last_value INTEGER NOT NULL
  )`;

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

/**
 * The error feed (§30, observability). A store row keeps only the *latest*
 * failure (`last_health_error`, `last_config_error`), which cannot answer the
 * questions the Errors page exists for: how often, since when, how many stores.
 * One row per fingerprint × source × entity, incremented when the same fault
 * recurs, so the table grows with the number of distinct problems rather than
 * with the number of probes.
 *
 * `entity_type`/`entity_id` rather than nullable `store_id`/`panel_id`: SQLite
 * treats NULLs as distinct in a unique index, so a nullable column would break
 * the upsert and silently write a row per occurrence.
 *
 * Recovery never deletes rows — this is a timeline, and freshness is
 * `last_seen`. Nothing business-shaped is stored: the message is the control
 * plane's own technical summary, never a merchant payload (§40).
 */
const ERROR_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS error_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL,
    source      TEXT NOT NULL
      CHECK (source IN ('health', 'config', 'licence', 'deploy')),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('store', 'panel')),
    entity_id   INTEGER NOT NULL,
    message     TEXT NOT NULL,
    app_version TEXT,
    environment TEXT,
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

let registry: Database.Database | null = null;

/**
 * Subscription plans. Seeded with four editable SA-retail tiers; the operator can
 * change every value, because the first ten customers each want something slightly
 * different. A plan grants a store-count cap, a per-store terminal ceiling, a
 * feature set and its pricing: a rate per licensed terminal, or `custom` when the
 * deal is negotiated (never auto-calculated).
 */
const PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS plans (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    code                    TEXT    NOT NULL UNIQUE,
    name                    TEXT    NOT NULL,
    max_stores              INTEGER NOT NULL DEFAULT 1,
    max_terminals_per_store INTEGER NOT NULL DEFAULT 2,
    features_json           TEXT    NOT NULL DEFAULT '[]',
    pricing_mode            TEXT    NOT NULL DEFAULT 'per_terminal'
      CHECK (pricing_mode IN ('per_terminal', 'custom')),
    terminal_price_cents    INTEGER NOT NULL DEFAULT 0 CHECK (terminal_price_cents >= 0),
    -- A custom plan's agreed charge per billing period (0 = negotiated per
    -- client, so the control plane refuses to invoice without an explicit
    -- amount). Ignored on a per_terminal plan, where the rate applies.
    custom_amount_cents     INTEGER NOT NULL DEFAULT 0 CHECK (custom_amount_cents >= 0),
    setup_fee_cents         INTEGER NOT NULL DEFAULT 0 CHECK (setup_fee_cents >= 0),
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

/** How the once-off onboarding charge stands for a client. */
export type SetupFeeStatus = 'not_invoiced' | 'invoiced' | 'paid' | 'waived';

export const SETUP_FEE_STATUSES: readonly SetupFeeStatus[] = [
  'not_invoiced',
  'invoiced',
  'paid',
  'waived',
];

/**
 * What a client actually purchased. The plan says what a client MAY have; this
 * says what it pays for: a quantity of licensed terminals and the state of the
 * once-off onboarding charge. One row per company — the company *is* the
 * subscription (it holds the plan and the paid-through date), so this table
 * carries only the commercial facts that have no other home.
 *
 * Billing reads `licensed_terminal_count`; it is never derived from configured
 * tills, device bindings, open sessions or heartbeats (§11/§12).
 */
const COMPANY_SUBSCRIPTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS company_subscriptions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id              INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
    licensed_terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (licensed_terminal_count >= 0),
    setup_fee_status        TEXT    NOT NULL DEFAULT 'not_invoiced'
      CHECK (setup_fee_status IN ('not_invoiced', 'invoiced', 'paid', 'waived')),
    -- THE AGREED PRICE TERMS (2026-09-16). Copied from the plan when the client is
    -- onboarded, when the office moves them to another plan, or when the office
    -- explicitly re-prices them — never re-read from the plan afterwards, so
    -- editing a plan cannot silently re-price the clients already on it.
    -- A NULL priced_at means no agreement has been recorded yet: the quote then
    -- falls back to the plan and says so.
    pricing_mode            TEXT,
    rate_cents              INTEGER,
    custom_amount_cents     INTEGER,
    setup_fee_cents         INTEGER,
    billing_period          TEXT,
    priced_at               TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

/**
 * Where the purchased terminal licences sit. A store's signed licence carries
 * its allocation, and the tenant refuses device claims beyond it. Invariant,
 * enforced in services/terminalLicences.ts: the sum of a client's allocations
 * never exceeds its subscription's licensed count, and no single allocation
 * exceeds the plan's per-store ceiling.
 */
const STORE_TERMINAL_LICENCES_DDL = `
  CREATE TABLE IF NOT EXISTS store_terminal_licences (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    store_id                INTEGER NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
    licensed_terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (licensed_terminal_count >= 0),
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
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

/**
 * The four seeded tiers — a starting catalogue, not a closed one. Pricing is a
 * rate per licensed terminal per period plus a once-off onboarding fee; the
 * Enterprise tier is `custom`, so the control plane never invents a figure for a
 * negotiated deal. Every value is editable from the control plane.
 */
const SEED_PLANS: Array<{
  code: string;
  name: string;
  maxStores: number;
  maxTerminals: number;
  features: string[];
  pricingMode: PlanPricingMode;
  terminalPriceCents: number;
  setupFeeCents: number;
  sortOrder: number;
}> = [
  // Codes are derived from the names (Vula Start -> vula-start). Renaming a tier
  // means renaming its code too, via `renamePlansToNameCodes` below.
  {
    code: 'vula-start',
    name: 'Vula Start',
    maxStores: 1,
    maxTerminals: 1,
    features: [],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 1,
  },
  {
    code: 'vula-grow',
    name: 'Vula Grow',
    maxStores: 1,
    maxTerminals: 3,
    features: ['customer_credit', 'advanced_reports'],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 2,
  },
  {
    code: 'vula-branch',
    name: 'Vula Branch',
    maxStores: 3,
    maxTerminals: 2,
    features: ['customer_credit', 'advanced_reports', 'multi_store'],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 3,
  },
  {
    code: 'vula-network',
    name: 'Vula Network',
    maxStores: 5,
    maxTerminals: 3,
    features: ['customer_credit', 'advanced_reports', 'multi_store', 'stock_transfers'],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 4,
  },
  {
    code: 'vula-market',
    name: 'Vula Market',
    maxStores: 1,
    maxTerminals: 10,
    features: ['customer_credit', 'advanced_reports', 'ecommerce_bridges'],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 5,
  },
  {
    code: 'vula-market-plus',
    name: 'Vula Market Plus',
    maxStores: 10,
    maxTerminals: 15,
    features: [
      'customer_credit',
      'advanced_reports',
      'multi_store',
      'stock_transfers',
      'ecommerce_bridges',
    ],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 6,
  },
  {
    code: 'vula-market-enterprise',
    name: 'Vula Market Enterprise',
    maxStores: 50,
    maxTerminals: 20,
    features: [
      'customer_credit',
      'advanced_reports',
      'multi_store',
      'stock_transfers',
      'ecommerce_bridges',
      'ai_assistant',
    ],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 7,
  },
  {
    code: 'vula-spares-network',
    name: 'Vula Spares Network',
    maxStores: 50,
    maxTerminals: 5,
    features: ['customer_credit', 'advanced_reports', 'multi_store', 'stock_transfers'],
    pricingMode: 'per_terminal',
    terminalPriceCents: 50_000,
    setupFeeCents: 1_000_000,
    sortOrder: 8,
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
  db.exec(COMPANY_SUBSCRIPTIONS_DDL);
  db.exec(STORE_TERMINAL_LICENCES_DDL);
  db.exec(PANELS_DDL);
  db.exec(INVOICES_DDL);
  db.exec(INVOICE_SEQUENCES_DDL);
  db.exec(PAYMENTS_DDL);
  db.exec(BILLING_SETTINGS_DDL);
  db.exec(OFFICE_SETTINGS_DDL);
  // The singleton exists from the first boot, so every reader gets a row with
  // the defaults rather than having to invent one.
  db.exec('INSERT OR IGNORE INTO office_settings (id) VALUES (1)');
  db.exec(DEPLOYMENT_JOBS_DDL);
  db.exec(DEPLOYMENT_JOB_STEPS_DDL);
  db.exec(AUDIT_LOGS_DDL);
  db.exec(ERROR_EVENTS_DDL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deployment_jobs_company ON deployment_jobs(company_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_deployment_job_steps_job ON deployment_job_steps(job_id)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id)');
  // The group key the recorder upserts on, and the sort the feed reads by.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_error_events_group ON error_events(fingerprint, source, entity_type, entity_id)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_error_events_last_seen ON error_events(last_seen)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_store_terminal_licences_company ON store_terminal_licences(company_id)',
  );

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
  addColumn('last_config_error', 'last_config_error TEXT');
  addColumn('last_health_error', 'last_health_error TEXT');
  addColumn('terminal_names_json', 'terminal_names_json TEXT');
  addColumn('environment', "environment TEXT NOT NULL DEFAULT 'development'");
  addColumn('app_version', 'app_version TEXT');
  addColumn('schema_version', 'schema_version INTEGER');
  addColumn('last_heartbeat_at', 'last_heartbeat_at TEXT');
  addColumn('last_telemetry_json', 'last_telemetry_json TEXT');
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

  const stepCols = db.prepare('PRAGMA table_info(deployment_job_steps)').all() as Array<{
    name: string;
  }>;
  if (!stepCols.some((c) => c.name === 'warnings_json')) {
    db.exec('ALTER TABLE deployment_job_steps ADD COLUMN warnings_json TEXT');
  }

  // Recording that an invoice was emailed, so the Billing page can show it and a
  // resend is a deliberate act rather than an accident.
  const invoiceCols = db.prepare('PRAGMA table_info(invoices)').all() as Array<{ name: string }>;
  const addInvoiceColumn = (name: string, ddl: string) => {
    if (!invoiceCols.some((c) => c.name === name))
      db.exec(`ALTER TABLE invoices ADD COLUMN ${ddl}`);
  };
  addInvoiceColumn('emailed_at', 'emailed_at TEXT');
  addInvoiceColumn('emailed_to', 'emailed_to TEXT');
  // What the charge is for — required on a manually-priced invoice, so a client
  // is never sent a bare "amount due".
  addInvoiceColumn('description', 'description TEXT');
  // The tax split. NULL on invoices raised before it existed: those documents
  // were issued without a split, and inventing one now would state a tax
  // breakdown that was never on them.
  // The plan is snapshotted per invoice: an issued document must not change its
  // story when a plan is renamed.
  addInvoiceColumn('plan_code', 'plan_code TEXT');
  addInvoiceColumn('plan_name', 'plan_name TEXT');
  addInvoiceColumn('pro_rata_period', 'pro_rata_period TEXT');
  addInvoiceColumn('subtotal_cents', 'subtotal_cents INTEGER');
  addInvoiceColumn('vat_cents', 'vat_cents INTEGER');
  addInvoiceColumn('vat_rate', 'vat_rate INTEGER');

  const subCols = db.prepare('PRAGMA table_info(company_subscriptions)').all() as Array<{
    name: string;
  }>;
  const addSubColumn = (name: string, ddl: string) => {
    if (!subCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE company_subscriptions ADD COLUMN ${ddl}`);
    }
  };
  // Existing clients keep NULLs here on purpose: the control plane does not
  // invent an agreed price for a deal it never recorded. The quote falls back to
  // the plan and reports that, and the office stamps the agreement with one
  // action (or it happens automatically the next time they change the plan).
  addSubColumn('pricing_mode', 'pricing_mode TEXT');
  addSubColumn('rate_cents', 'rate_cents INTEGER');
  addSubColumn('custom_amount_cents', 'custom_amount_cents INTEGER');
  addSubColumn('setup_fee_cents', 'setup_fee_cents INTEGER');
  addSubColumn('billing_period', 'billing_period TEXT');
  addSubColumn('priced_at', 'priced_at TEXT');

  const officeCols = db.prepare('PRAGMA table_info(office_settings)').all() as Array<{
    name: string;
  }>;
  const addOfficeColumn = (name: string, ddl: string) => {
    if (!officeCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE office_settings ADD COLUMN ${ddl}`);
    }
  };
  addOfficeColumn('vat_reg_no', "vat_reg_no TEXT NOT NULL DEFAULT ''");
  addOfficeColumn('vat_rate', 'vat_rate INTEGER NOT NULL DEFAULT 15');

  migratePlanCustomAmount(db);
  restructurePlans(db);
  widenPlanBillingPeriod(db);
  renameRetailPlanToBusiness(db);
  renamePlansToNameCodes(db);
  seedPlans(db);
  refreshSeedPlanDefaults(db);
  migrateInvoiceLines(db);
  migrateSubscriptions(db);
  migrateBillingSettingsToPerCompany(db);
  return registry;
};

/**
 * Column lists used by the table-rebuild migrations, kept next to their DDL so a
 * rebuild cannot silently drop a column.
 */
const PLAN_COLUMNS =
  'id, code, name, max_stores, max_terminals_per_store, features_json, pricing_mode, terminal_price_cents, custom_amount_cents, setup_fee_cents, billing_period, is_active, sort_order, created_at, updated_at';
const COMPANY_COLUMNS =
  'id, name, slug, billing_email, plan_id, paid_through, trial_ends_at, status, created_at, updated_at';

/** Idempotent plan seed: insert only tiers that do not exist yet, by code. */
const seedPlans = (db: Database.Database): void => {
  const has = db.prepare('SELECT id FROM plans WHERE code = ?');
  const insert = db.prepare(
    `INSERT INTO plans (code, name, max_stores, max_terminals_per_store, features_json,
                        pricing_mode, terminal_price_cents, setup_fee_cents, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        plan.pricingMode,
        plan.terminalPriceCents,
        plan.setupFeeCents,
        plan.sortOrder,
      );
    }
  });
  seed();
};

/**
 * Fill in the recommended commercial values on seeded tiers that were never
 * priced, so an existing development database picks up the R500 / R10,000 model
 * without touching anything the operator configured. A plan is treated as
 * "never priced" only when it is `per_terminal` with a zero rate: a plan that
 * carries a price (the old flat model included) is left exactly as it is and
 * shows as `custom` until the operator sets a per-terminal rate.
 */
const refreshSeedPlanDefaults = (db: Database.Database): void => {
  const unpriced = db.prepare(
    `SELECT id FROM plans WHERE code = ? AND pricing_mode = 'per_terminal' AND terminal_price_cents = 0`,
  );
  const refresh = db.prepare(
    `UPDATE plans SET terminal_price_cents = ?, setup_fee_cents = ?,
                      max_stores = ?, max_terminals_per_store = ?, updated_at = datetime('now')
       WHERE id = ?`,
  );
  const run = db.transaction(() => {
    for (const seed of SEED_PLANS) {
      const row = unpriced.get(seed.code) as { id: number } | undefined;
      if (!row) continue;
      refresh.run(
        seed.terminalPriceCents,
        seed.setupFeeCents,
        seed.maxStores,
        seed.maxTerminals,
        row.id,
      );
    }
  });
  run();
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
 *
 * `sourceSelect` lets a rebuild also RENAME or reshape columns: it is the SELECT
 * list feeding `targetColumns` (one expression per target column, in order).
 */
const rebuildTable = (
  db: Database.Database,
  name: string,
  columns: string,
  ddl: string,
  sourceSelect: string = columns,
): void => {
  const temp = `${name}_rebuild`;
  const tempDdl = ddl.replace(/CREATE TABLE IF NOT EXISTS\s+\w+/i, `CREATE TABLE ${temp}`);

  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    const run = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${temp}`);
      db.exec(tempDdl);
      db.exec(`INSERT INTO ${temp} (${columns}) SELECT ${sourceSelect} FROM ${name}`);
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

/** The column names of a table ([] when it does not exist). */
const tableColumns = (db: Database.Database, name: string): Set<string> =>
  new Set(
    (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map((c) => c.name),
  );

/**
 * `custom` plans may carry an agreed charge (2026-09-13): the office states the
 * negotiated amount once and invoices follow from it, rather than the control
 * plane inventing a figure. Additive column; a 0 keeps the strict behaviour
 * (an amountless invoice is refused).
 */
const migratePlanCustomAmount = (db: Database.Database): void => {
  if (!tableExists(db, 'plans')) return;
  if (tableColumns(db, 'plans').has('custom_amount_cents')) return;
  db.exec('ALTER TABLE plans ADD COLUMN custom_amount_cents INTEGER NOT NULL DEFAULT 0');
};

/**
 * Plans gain the licensed-terminal pricing model (2026-09-13): `pricing_mode`
 * (`per_terminal` | `custom`), `terminal_price_cents` and `setup_fee_cents`
 * replace the flat `price_cents`, and the never-used bundled fields
 * (`included_terminals`, `extra_terminal_price_cents`,
 * `additional_store_onboarding_cents`, `head_office_included`) go.
 *
 * The old flat price is deliberately NOT carried into `terminal_price_cents`: a
 * flat client price is not a per-terminal rate, and copying it would silently
 * multiply live customers' bills by their till count. A plan that carried a flat
 * price becomes `custom` — the office sets the per-terminal rate deliberately,
 * and nothing auto-calculates until it does. Column detection is dynamic so any
 * intermediate development shape migrates cleanly.
 */
const restructurePlans = (db: Database.Database): void => {
  if (!tableExists(db, 'plans')) return;
  const ddl = storedDdl(db, 'plans');
  if (ddl && ddl.includes('pricing_mode')) return; // already the new shape

  const cols = tableColumns(db, 'plans');
  const legacyModel = cols.has('pricing_model');
  const legacyFlatPrice = cols.has('price_cents');

  const modeExpr = legacyModel
    ? `CASE WHEN code = 'enterprise' THEN 'custom'
            WHEN pricing_model = 'per_terminal' THEN 'per_terminal'
            ELSE 'custom' END`
    : legacyFlatPrice
      ? `CASE WHEN code = 'enterprise' OR COALESCE(price_cents, 0) > 0 THEN 'custom'
              ELSE 'per_terminal' END`
      : `'per_terminal'`;

  const rateExpr = legacyModel
    ? `CASE WHEN pricing_model = 'per_terminal' THEN COALESCE(price_cents, 0) ELSE 0 END`
    : '0';

  const setupExpr = cols.has('onboarding_fee_cents') ? 'COALESCE(onboarding_fee_cents, 0)' : '0';

  const sourceSelect = [
    'id',
    'code',
    'name',
    'max_stores',
    'max_terminals_per_store',
    'features_json',
    modeExpr,
    rateExpr,
    // Present on any database that has already booted this build (the additive
    // migration above runs first); a legacy shape arrives with 0.
    cols.has('custom_amount_cents') ? 'COALESCE(custom_amount_cents, 0)' : '0',
    setupExpr,
    cols.has('billing_period') ? 'billing_period' : `'monthly'`,
    'is_active',
    'sort_order',
    'created_at',
    'updated_at',
  ].join(', ');

  rebuildTable(db, 'plans', PLAN_COLUMNS, PLANS_DDL, sourceSelect);
};

/**
 * Invoices carry their own pricing evidence: `terminal_count`,
 * `terminal_price_cents` (a rate snapshot, so a later plan edit cannot rewrite
 * an issued invoice) and `setup_fee_cents`. The flat-model columns
 * (`base_amount_cents`, `terminal_amount_cents`, `onboarding_fee_cents`,
 * `additional_store_onboarding_cents`) are folded in where they still mean
 * something and dropped.
 */
const migrateInvoiceLines = (db: Database.Database): void => {
  if (!tableExists(db, 'invoices')) return;
  const cols = tableColumns(db, 'invoices');

  for (const [name, ddl] of [
    ['terminal_count', 'terminal_count INTEGER'],
    ['terminal_price_cents', 'terminal_price_cents INTEGER'],
    ['setup_fee_cents', 'setup_fee_cents INTEGER'],
  ] as const) {
    if (!cols.has(name)) db.exec(`ALTER TABLE invoices ADD COLUMN ${ddl}`);
  }

  // The once-off onboarding charge keeps its meaning under the new name. A zero
  // is not a charge — those rows stay NULL ("this invoice carried no onboarding").
  if (cols.has('onboarding_fee_cents')) {
    db.exec(
      `UPDATE invoices SET setup_fee_cents = onboarding_fee_cents
        WHERE setup_fee_cents IS NULL AND COALESCE(onboarding_fee_cents, 0) > 0`,
    );
  }

  for (const legacy of [
    'base_amount_cents',
    'terminal_amount_cents',
    'onboarding_fee_cents',
    'additional_store_onboarding_cents',
  ]) {
    if (cols.has(legacy)) db.exec(`ALTER TABLE invoices DROP COLUMN ${legacy}`);
  }
};

/**
 * Subscription backfill for databases that predate the licensed-terminal model.
 * Every company gets a subscription row carrying the terminals its stores were
 * already configured for, and every assigned store an allocation of the same
 * size — so a live fleet keeps working, its licences keep permitting the tills
 * it runs, and the office sees a purchased quantity it can edit. Unassigned
 * stores get no allocation: they are unlicensed and stay unpoliced.
 *
 * The superseded `companies.onboarding_fee_charged` flag is read once (a
 * charged onboarding fee is settled history → `paid`) and then dropped.
 */
const migrateSubscriptions = (db: Database.Database): void => {
  if (!tableExists(db, 'companies')) return;
  const companyCols = tableColumns(db, 'companies');
  const hadOnboardingFlag = companyCols.has('onboarding_fee_charged');

  const setupFeeExpr = hadOnboardingFlag
    ? `CASE WHEN COALESCE(c.onboarding_fee_charged, 0) = 1 THEN 'paid' ELSE 'not_invoiced' END`
    : `'not_invoiced'`;

  const subs = db
    .prepare(
      `INSERT INTO company_subscriptions (company_id, licensed_terminal_count, setup_fee_status)
       SELECT c.id,
              COALESCE((SELECT SUM(s.terminal_count) FROM stores s WHERE s.company_id = c.id), 0),
              ${setupFeeExpr}
         FROM companies c
        WHERE NOT EXISTS (SELECT 1 FROM company_subscriptions cs WHERE cs.company_id = c.id)`,
    )
    .run();

  const allocations = db
    .prepare(
      `INSERT INTO store_terminal_licences (company_id, store_id, licensed_terminal_count)
       SELECT s.company_id, s.id, s.terminal_count
         FROM stores s
        WHERE s.company_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM store_terminal_licences l WHERE l.store_id = s.id)`,
    )
    .run();

  if (hadOnboardingFlag) {
    db.exec('ALTER TABLE companies DROP COLUMN onboarding_fee_charged');
  }

  if (subs.changes > 0 || allocations.changes > 0) {
    logger.info(
      `Registry migration: ${subs.changes} subscription row(s) and ${allocations.changes} terminal allocation(s) backfilled`,
    );
  }
};

/** The DDL stored for a table, or null. */
const storedDdl = (db: Database.Database, name: string): string | null =>
  (
    (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      { sql: string } | undefined) ?? null
  )?.sql ?? null;

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
/**
 * Plan codes are derived from their names, so `starter`/`business`/`multi-store`/
 * `enterprise` were retired in favour of `vula-start`/`vula-grow`/`vula-network`/
 * `vula-market-enterprise`. A registry seeded before that change renames its rows
 * rather than gaining a second catalogue beside them — ids are untouched, so
 * every company's plan reference survives.
 *
 * Only renames when the target code is absent, so a registry that has already
 * been reseeded is left alone.
 */
const renamePlansToNameCodes = (db: Database.Database): void => {
  if (!tableExists(db, 'plans')) return;
  const has = db.prepare('SELECT 1 FROM plans WHERE code = ?');
  const rename = db.prepare(
    "UPDATE plans SET code = ?, updated_at = datetime('now') WHERE code = ?",
  );
  const RETIRED: ReadonlyArray<readonly [string, string]> = [
    ['starter', 'vula-start'],
    ['business', 'vula-grow'],
    ['multi-store', 'vula-network'],
    ['enterprise', 'vula-market-enterprise'],
  ];
  for (const [from, to] of RETIRED) {
    if (has.get(from) && !has.get(to)) rename.run(to, from);
  }
};

const renameRetailPlanToBusiness = (db: Database.Database): void => {
  if (!tableExists(db, 'plans')) return;
  const hasRetail = db.prepare('SELECT 1 FROM plans WHERE code = ?').get('retail');
  if (!hasRetail) return;
  const hasBusiness = db.prepare('SELECT 1 FROM plans WHERE code = ?').get('business');
  if (hasBusiness) {
    // A business tier already exists (operator-created): keep it, retire retail quietly.
    db.prepare("UPDATE plans SET name = ?, updated_at = datetime('now') WHERE code = ?").run(
      'Business',
      'retail',
    );
    return;
  }
  db.prepare(
    "UPDATE plans SET code = 'business', name = 'Business', updated_at = datetime('now') WHERE code = 'retail'",
  ).run();
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
  environment?: StoreEnvironment;
}

export const createStore = (input: CreateStoreInput, controlPlaneToken: string): StoreRecord => {
  const db = getRegistryDb();
  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO stores (name, slug, vertical, terminal_count, base_url, control_plane_token, environment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.slug,
        input.vertical ?? 'general',
        input.terminalCount,
        input.baseUrl,
        controlPlaneToken,
        input.environment ?? 'development',
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
  environment?: StoreEnvironment;
  /** Custom per-till names; null reverts to "Till N" defaults. */
  terminalNames?: string[] | null;
  /**
   * Replaces the store's push credential. Only for reconciling a store whose
   * deployment holds a different value — it is never read back out.
   */
  controlPlaneToken?: string;
}

/** Absent = keep. */
export const updateStore = (id: number, input: UpdateStoreInput): StoreRecord | null => {
  const db = getRegistryDb();
  const current = getStoreById(id);
  if (!current) return null;
  db.prepare(
    `UPDATE stores SET
       name = COALESCE(?, name),
       vertical = COALESCE(?, vertical),
       terminal_count = COALESCE(?, terminal_count),
       base_url = COALESCE(?, base_url),
       environment = COALESCE(?, environment),
       control_plane_token = COALESCE(?, control_plane_token),
       terminal_names_json = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.vertical ?? null,
    input.terminalCount ?? null,
    input.baseUrl ?? null,
    input.environment ?? null,
    input.controlPlaneToken ?? null,
    input.terminalNames === undefined
      ? current.terminal_names_json
      : input.terminalNames === null
        ? null
        : JSON.stringify(input.terminalNames.map((n) => n.trim())),
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
  meta?: { coolifyUuid?: string; volumeName?: string; adminEmail?: string; error?: string },
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
  if (status === 'failed') {
    const store = getStoreById(id);
    recordErrorEvent({
      source: 'deploy',
      entityType: 'store',
      entityId: id,
      message: meta?.error ?? 'provisioning failed',
      appVersion: store?.app_version ?? null,
      environment: store?.environment ?? null,
    });
  }
  return getStoreById(id);
};

export interface ConfigResultRecord {
  status: 'ok' | 'failed';
  snapshot?: unknown;
  /** Failure reason recorded on 'failed'; cleared on 'ok'. */
  error?: string | null;
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
       last_config_error = ?,
       applied_config_version = CASE WHEN ? THEN COALESCE(desired_config_version, 1) ELSE applied_config_version END,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    result.status,
    result.status === 'ok' ? 1 : 0,
    result.status === 'ok' ? JSON.stringify(result.snapshot ?? null) : null,
    result.status === 'ok' ? null : (result.error ?? 'push failed').slice(0, 500),
    result.status === 'ok' ? 1 : 0,
    id,
  );
  if (result.status === 'failed') {
    recordErrorEvent({
      source: 'config',
      entityType: 'store',
      entityId: id,
      message: result.error ?? 'push failed',
      appVersion: store.app_version,
      environment: store.environment,
    });
  }
  return getStoreById(id);
};

export const advanceDesiredConfigVersion = (id: number): void => {
  getRegistryDb()
    .prepare(
      "UPDATE stores SET desired_config_version = COALESCE(desired_config_version, 0) + 1, updated_at = datetime('now') WHERE id = ?",
    )
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

export const recordLicencePush = (
  id: number,
  status: ConfigStatus,
  error?: string | null,
): StoreRecord | null => {
  const store = getStoreById(id);
  getRegistryDb()
    .prepare(
      `UPDATE stores SET
         licence_push_status = ?,
         licence_pushed_at = CASE WHEN ? THEN datetime('now') ELSE licence_pushed_at END,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, status === 'ok' ? 1 : 0, id);
  if (status === 'failed') {
    // The failure reason used to be dropped on the floor here, leaving a red
    // badge with nothing behind it — the reason the feed exists.
    recordErrorEvent({
      source: 'licence',
      entityType: 'store',
      entityId: id,
      message: error ?? 'licence push failed',
      appVersion: store?.app_version ?? null,
      environment: store?.environment ?? null,
    });
  }
  return getStoreById(id);
};

export const recordHealthResult = (
  id: number,
  status: 'up' | 'down',
  error?: string | null,
): StoreRecord | null => {
  const db = getRegistryDb();
  const store = getStoreById(id);
  if (!store) return null;
  db.prepare(
    `UPDATE stores SET
       last_health_status = ?,
       last_health_at = datetime('now'),
       last_health_error = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(status, status === 'up' ? null : (error ?? 'unreachable').slice(0, 500), id);
  if (status === 'down') {
    recordErrorEvent({
      source: 'health',
      entityType: 'store',
      entityId: id,
      message: error ?? 'unreachable',
      appVersion: store.app_version,
      environment: store.environment,
    });
  }
  return getStoreById(id);
};

/**
 * The per-till roster this store should be pushed with: custom names when the
 * operator set them (padded/truncated to the terminal count), "Till N"
 * otherwise. Names live on the registry row so topology re-pushes and health
 * rides never clobber them.
 */
export const terminalRoster = (store: {
  terminal_count: number;
  terminal_names_json: string | null;
}): Array<{ till: number; name: string }> => {
  let custom: string[] = [];
  if (store.terminal_names_json) {
    try {
      const parsed = JSON.parse(store.terminal_names_json);
      if (Array.isArray(parsed)) custom = parsed.filter((n): n is string => typeof n === 'string');
    } catch {
      // Corrupt JSON falls back to defaults.
    }
  }
  return Array.from({ length: store.terminal_count }, (_, i) => ({
    till: i + 1,
    name: custom[i]?.trim() || `Till ${i + 1}`,
  }));
};

export interface TelemetryRecordInput {
  version?: string | null;
  schemaVersion?: number | null;
  generatedAt?: string | null;
  telemetry: unknown;
}

/** Persists a store's last telemetry snapshot (F1/SPOG: version, heartbeat, sync, tills). */
export const recordTelemetry = (id: number, input: TelemetryRecordInput): StoreRecord | null => {
  getRegistryDb()
    .prepare(
      `UPDATE stores SET
         app_version = ?,
         schema_version = ?,
         last_heartbeat_at = ?,
         last_telemetry_json = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(
      input.version ?? null,
      input.schemaVersion ?? null,
      input.generatedAt ?? null,
      JSON.stringify(input.telemetry),
      id,
    );
  return getStoreById(id);
};

// --- Plans -------------------------------------------------------------------

/**
 * How a plan prices its clients. `per_terminal` multiplies the rate by the
 * licensed terminal quantity; `custom` means the deal is negotiated and the
 * control plane never auto-calculates an amount for it.
 */
export type PlanPricingMode = 'per_terminal' | 'custom';

export const PLAN_PRICING_MODES: readonly PlanPricingMode[] = ['per_terminal', 'custom'];

export interface PlanRecord {
  id: number;
  code: string;
  name: string;
  max_stores: number;
  max_terminals_per_store: number;
  features_json: string;
  pricing_mode: PlanPricingMode;
  /** Rate per licensed terminal per billing period (0 on a custom plan). */
  terminal_price_cents: number;
  /** A custom plan's agreed charge per billing period (0 = nothing agreed yet). */
  custom_amount_cents: number;
  /** Once-off onboarding charge for the client (and its first store). */
  setup_fee_cents: number;
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
  pricingMode?: PlanPricingMode;
  terminalPriceCents?: number;
  customAmountCents?: number;
  setupFeeCents?: number;
  billingPeriod?: PlanPeriod;
}

export const PLAN_PERIODS: readonly PlanPeriod[] = ['monthly', 'annual', 'once-off'];

export const createPlan = (input: PlanInput): PlanRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO plans (code, name, max_stores, max_terminals_per_store, features_json,
                          pricing_mode, terminal_price_cents, custom_amount_cents, setup_fee_cents,
                          billing_period, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM plans), 1))`,
    )
    .run(
      input.code,
      input.name,
      input.maxStores,
      input.maxTerminalsPerStore,
      JSON.stringify(input.features),
      input.pricingMode ?? 'per_terminal',
      input.terminalPriceCents ?? 0,
      input.customAmountCents ?? 0,
      input.setupFeeCents ?? 0,
      input.billingPeriod ?? 'monthly',
    );
  return getPlanById(Number(info.lastInsertRowid))!;
};

export const updatePlan = (
  id: number,
  input: Partial<PlanInput> & { isActive?: boolean },
): PlanRecord | null => {
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
         pricing_mode = COALESCE(?, pricing_mode),
         terminal_price_cents = COALESCE(?, terminal_price_cents),
         custom_amount_cents = COALESCE(?, custom_amount_cents),
         setup_fee_cents = COALESCE(?, setup_fee_cents),
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
      input.pricingMode ?? null,
      input.terminalPriceCents ?? null,
      input.customAmountCents ?? null,
      input.setupFeeCents ?? null,
      input.billingPeriod ?? null,
      input.isActive === undefined ? null : input.isActive ? 1 : 0,
      id,
    );
  return getPlanById(id);
};

export const countCompaniesForPlan = (planId: number): number =>
  (
    getRegistryDb()
      .prepare('SELECT COUNT(*) AS c FROM companies WHERE plan_id = ?')
      .get(planId) as { c: number }
  ).c;

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
  /** Licensed terminals billed on the recurring line; null on a manual invoice. */
  terminal_count: number | null;
  /** The plan's per-terminal rate when the invoice was raised (a snapshot). */
  terminal_price_cents: number | null;
  /** Once-off onboarding charge, when this invoice carried it. Never on renewals. */
  setup_fee_cents: number | null;
  /** What the charge is for. Required on a manually-priced invoice. */
  description: string | null;
  /** The plan at the time of issue (a snapshot); null on a hand-priced invoice. */
  plan_code: string | null;
  plan_name: string | null;
  /** The paid period a mid-period increase covered (null on other invoices). */
  pro_rata_period: string | null;
  /** `amount_cents` exclusive of VAT — the split, stored on the document. */
  subtotal_cents: number | null;
  /** The VAT portion of `amount_cents`, which is VAT-inclusive. */
  vat_cents: number | null;
  /** The rate applied when the invoice was raised. */
  vat_rate: number | null;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  due_date: string | null;
  paid_date: string | null;
  /** When the invoice was last emailed, and to whom. Null until it is sent. */
  emailed_at: string | null;
  emailed_to: string | null;
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
  (getRegistryDb().prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRecord) ??
  null;

export const getCompanyBySlug = (slug: string): CompanyRecord | null =>
  (getRegistryDb().prepare('SELECT * FROM companies WHERE slug = ?').get(slug) as CompanyRecord) ??
  null;

export const countStoresForCompany = (companyId: number): number =>
  (
    getRegistryDb()
      .prepare('SELECT COUNT(*) AS c FROM stores WHERE company_id = ?')
      .get(companyId) as {
      c: number;
    }
  ).c;

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
    .prepare("UPDATE stores SET company_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(companyId, storeId);
  return getStoreById(storeId);
};

// --- Subscriptions & terminal allocations -------------------------------------

export interface CompanySubscriptionRecord {
  id: number;
  company_id: number;
  licensed_terminal_count: number;
  setup_fee_status: SetupFeeStatus;
  /** The agreed terms; all NULL until an agreement is recorded (`priced_at`). */
  pricing_mode: PlanPricingMode | null;
  rate_cents: number | null;
  custom_amount_cents: number | null;
  setup_fee_cents: number | null;
  billing_period: PlanPeriod | null;
  priced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionPricing {
  pricingMode: PlanPricingMode;
  rateCents: number;
  customAmountCents: number;
  setupFeeCents: number;
  billingPeriod: PlanPeriod | null;
}

/**
 * Records the price a client has agreed to. Called when they are onboarded, when
 * the office moves them to another plan, and when the office explicitly re-prices
 * them — the three moments a price is actually agreed.
 */
export const setSubscriptionPricing = (
  companyId: number,
  pricing: SubscriptionPricing,
): CompanySubscriptionRecord => {
  ensureSubscription(companyId);
  getRegistryDb()
    .prepare(
      `UPDATE company_subscriptions
          SET pricing_mode = ?, rate_cents = ?, custom_amount_cents = ?, setup_fee_cents = ?,
              billing_period = ?, priced_at = datetime('now'), updated_at = datetime('now')
        WHERE company_id = ?`,
    )
    .run(
      pricing.pricingMode,
      pricing.rateCents,
      pricing.customAmountCents,
      pricing.setupFeeCents,
      pricing.billingPeriod,
      companyId,
    );
  return getSubscription(companyId)!;
};

export interface StoreTerminalLicenceRecord {
  id: number;
  company_id: number;
  store_id: number;
  licensed_terminal_count: number;
  created_at: string;
  updated_at: string;
}

export const getSubscription = (companyId: number): CompanySubscriptionRecord | null =>
  (getRegistryDb()
    .prepare('SELECT * FROM company_subscriptions WHERE company_id = ?')
    .get(companyId) as CompanySubscriptionRecord) ?? null;

/** The subscription row for a company, created empty (0 licensed) if absent. */
export const ensureSubscription = (companyId: number): CompanySubscriptionRecord => {
  const db = getRegistryDb();
  const existing = getSubscription(companyId);
  if (existing) return existing;
  db.prepare('INSERT OR IGNORE INTO company_subscriptions (company_id) VALUES (?)').run(companyId);
  return getSubscription(companyId)!;
};

export const setLicensedTerminalCount = (
  companyId: number,
  licensedTerminalCount: number,
): CompanySubscriptionRecord => {
  ensureSubscription(companyId);
  getRegistryDb()
    .prepare(
      `UPDATE company_subscriptions SET licensed_terminal_count = ?, updated_at = datetime('now')
        WHERE company_id = ?`,
    )
    .run(licensedTerminalCount, companyId);
  return getSubscription(companyId)!;
};

export const setSetupFeeStatus = (
  companyId: number,
  status: SetupFeeStatus,
): CompanySubscriptionRecord => {
  if (!SETUP_FEE_STATUSES.includes(status)) throw new Error('Invalid setup fee status');
  ensureSubscription(companyId);
  getRegistryDb()
    .prepare(
      `UPDATE company_subscriptions SET setup_fee_status = ?, updated_at = datetime('now')
        WHERE company_id = ?`,
    )
    .run(status, companyId);
  return getSubscription(companyId)!;
};

export const listAllocations = (companyId: number): StoreTerminalLicenceRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM store_terminal_licences WHERE company_id = ? ORDER BY store_id')
    .all(companyId) as StoreTerminalLicenceRecord[];

/** The allocation for a store — one row per store, whichever client owns it. */
export const getAllocationForStore = (storeId: number): StoreTerminalLicenceRecord | null =>
  (getRegistryDb()
    .prepare('SELECT * FROM store_terminal_licences WHERE store_id = ?')
    .get(storeId) as StoreTerminalLicenceRecord) ?? null;

export const setAllocation = (
  companyId: number,
  storeId: number,
  licensedTerminalCount: number,
): StoreTerminalLicenceRecord => {
  const db = getRegistryDb();
  db.prepare(
    `INSERT INTO store_terminal_licences (company_id, store_id, licensed_terminal_count)
     VALUES (?, ?, ?)
     ON CONFLICT (store_id) DO UPDATE SET
       company_id = excluded.company_id,
       licensed_terminal_count = excluded.licensed_terminal_count,
       updated_at = datetime('now')`,
  ).run(companyId, storeId, licensedTerminalCount);
  return getAllocationForStore(storeId)!;
};

export const deleteAllocationForStore = (storeId: number): boolean =>
  getRegistryDb().prepare('DELETE FROM store_terminal_licences WHERE store_id = ?').run(storeId)
    .changes > 0;

/** Terminal licences allocated across a client's stores. */
export const allocatedTerminalCount = (companyId: number): number =>
  (
    getRegistryDb()
      .prepare(
        'SELECT COALESCE(SUM(licensed_terminal_count), 0) AS n FROM store_terminal_licences WHERE company_id = ?',
      )
      .get(companyId) as { n: number }
  ).n;

/** The quantity the client pays for — 0 when it has no subscription yet. */
export const licensedTerminalCount = (companyId: number): number =>
  getSubscription(companyId)?.licensed_terminal_count ?? 0;

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
  getRegistryDb()
    .prepare('SELECT * FROM panels WHERE company_id = ?')
    .all(companyId) as PanelRecord[];

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
  error?: string | null,
): PanelRecord | null => {
  const panel = getPanelById(id);
  if (!panel) return null;
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
  if (status === 'down') {
    recordErrorEvent({
      source: 'health',
      entityType: 'panel',
      entityId: id,
      message: error ?? 'unreachable',
      appVersion: panel.app_version,
    });
  }
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

export const recordPanelLicencePush = (
  id: number,
  status: ConfigStatus,
  error?: string | null,
): PanelRecord | null => {
  const panel = getPanelById(id);
  getRegistryDb()
    .prepare(
      `UPDATE panels SET
         licence_push_status = ?,
         licence_pushed_at = CASE WHEN ? THEN datetime('now') ELSE licence_pushed_at END,
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(status, status === 'ok' ? 1 : 0, id);
  if (status === 'failed') {
    recordErrorEvent({
      source: 'licence',
      entityType: 'panel',
      entityId: id,
      message: error ?? 'licence push failed',
      appVersion: panel?.app_version ?? null,
    });
  }
  return getPanelById(id);
};

export const setPanelDeployStatus = (
  id: number,
  status: 'not_deployed' | 'provisioning' | 'deployed' | 'failed',
  meta?: { coolifyUuid?: string; volumeName?: string; error?: string },
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
  if (status === 'failed') {
    const panel = getPanelById(id);
    recordErrorEvent({
      source: 'deploy',
      entityType: 'panel',
      entityId: id,
      message: meta?.error ?? 'provisioning failed',
      appVersion: panel?.app_version ?? null,
    });
  }
  return getPanelById(id);
};

/**
 * Stores a branch's dedicated Head Office credential. Generated by the control
 * plane during topology wiring; the merchant's Head Office registers the same
 * value so the two always agree. Distinct from the vendor CP token by design.
 */
export const setStoreHeadOfficeToken = (id: number, token: string): StoreRecord | null => {
  getRegistryDb()
    .prepare(`UPDATE stores SET head_office_token = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(token, id);
  return getStoreById(id);
};

// --- Invoices -----------------------------------------------------------------

export const listInvoices = (companyId?: number): InvoiceRecord[] => {
  const db = getRegistryDb();
  const query = companyId
    ? db
        .prepare('SELECT * FROM invoices WHERE company_id = ? ORDER BY created_at DESC, id DESC')
        .all(companyId)
    : db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, id DESC').all();
  return query as InvoiceRecord[];
};

export const getInvoiceById = (id: number): InvoiceRecord | null => {
  const row = getRegistryDb().prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  return row ? (row as InvoiceRecord) : null;
};

export const getInvoiceByNumber = (invoiceNumber: string): InvoiceRecord | null => {
  const row = getRegistryDb()
    .prepare('SELECT * FROM invoices WHERE invoice_number = ?')
    .get(invoiceNumber);
  return row ? (row as InvoiceRecord) : null;
};

export interface InvoiceLines {
  terminalCount?: number | null;
  terminalPriceCents?: number | null;
  setupFeeCents?: number | null;
  /** Human-readable label for the charge; see `createInvoiceForCompany`. */
  description?: string | null;
  /** The plan the subscription was on, snapshotted onto the document. */
  planCode?: string | null;
  planName?: string | null;
  /** The paid period this mid-period charge covers. */
  proRataPeriod?: string | null;
  /** The tax split of `amountCents` (which is VAT-inclusive). */
  subtotalCents?: number | null;
  vatCents?: number | null;
  vatRate?: number | null;
}

/** `VULA-2026-000001` — what the office writes on a document. */
export const formatInvoiceNumber = (year: number, sequence: number): string =>
  `VULA-${year}-${String(sequence).padStart(6, '0')}`;

/**
 * Allocates the next invoice number for a year and returns it. Monotonic, unique
 * and gapless until a number is used: the increment happens in the same statement
 * that reads the value, so two invoices raised at once cannot share one.
 *
 * A year's counter starts from the highest number already written for that year,
 * so a registry that has issued invoices under this scheme continues from where
 * it left off rather than reusing a number.
 */
export const nextInvoiceNumber = (now: Date = new Date()): string => {
  const db = getRegistryDb();
  const year = now.getUTCFullYear();
  return db.transaction((): string => {
    db.prepare('INSERT OR IGNORE INTO invoice_sequences (year, last_value) VALUES (?, 0)').run(
      year,
    );
    const seeded = db
      .prepare('SELECT last_value FROM invoice_sequences WHERE year = ?')
      .get(year) as {
      last_value: number;
    };
    if (seeded.last_value === 0) {
      const highest = db
        .prepare(
          'SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1',
        )
        .get(`VULA-${year}-%`) as { invoice_number: string } | undefined;
      const from = highest ? Number(highest.invoice_number.slice(-6)) || 0 : 0;
      if (from > 0) {
        db.prepare('UPDATE invoice_sequences SET last_value = ? WHERE year = ?').run(from, year);
      }
    }
    const next = db
      .prepare(
        'UPDATE invoice_sequences SET last_value = last_value + 1 WHERE year = ? RETURNING last_value',
      )
      .get(year) as { last_value: number };
    return formatInvoiceNumber(year, next.last_value);
  })();
};

export const createInvoice = (
  companyId: number,
  amountCents: number,
  dueDate: Date,
  invoiceNumber?: string,
  lines?: InvoiceLines,
): InvoiceRecord => {
  const db = getRegistryDb();
  const info = db
    .prepare(
      `INSERT INTO invoices (company_id, invoice_number, amount_cents, due_date, status,
                             terminal_count, terminal_price_cents, setup_fee_cents, description,
                             plan_code, plan_name, pro_rata_period,
                             subtotal_cents, vat_cents, vat_rate)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      companyId,
      // The sequence is the default; a number may still be supplied (tests, and
      // the historical rows this replaced).
      invoiceNumber || nextInvoiceNumber(),
      amountCents,
      dueDate.toISOString().slice(0, 10),
      lines?.terminalCount ?? null,
      lines?.terminalPriceCents ?? null,
      lines?.setupFeeCents ?? null,
      lines?.description ?? null,
      lines?.planCode ?? null,
      lines?.planName ?? null,
      lines?.proRataPeriod ?? null,
      lines?.subtotalCents ?? null,
      lines?.vatCents ?? null,
      lines?.vatRate ?? null,
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
    .prepare(
      `UPDATE invoices SET ${updatesList.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(...values);

  return getInvoiceById(id);
};

/**
 * Records that the invoice was emailed. Written only after the mail server
 * accepted the message, so the stamp means "sent", never "attempted".
 */
export const recordInvoiceEmail = (id: number, recipient: string): InvoiceRecord | null => {
  if (!getInvoiceById(id)) return null;
  getRegistryDb()
    .prepare(
      `UPDATE invoices
          SET emailed_at = datetime('now'), emailed_to = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(recipient, id);
  return getInvoiceById(id);
};

// --- Payments -----------------------------------------------------------------

export const listPayments = (companyId?: number): PaymentRecord[] => {
  const db = getRegistryDb();
  const query = companyId
    ? db
        .prepare('SELECT * FROM payments WHERE company_id = ? ORDER BY created_at DESC, id DESC')
        .all(companyId)
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
  // A payment row is only ever written when an operator (or, later, a provider
  // webhook) confirms money arrived — so it is `completed`, not `processing`.
  // The invoice/pending → payment/confirmed → invoice/paid flow is §27's.
  const info = db
    .prepare(
      `INSERT INTO payments (invoice_id, company_id, amount_cents, method, status, transaction_id)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
    )
    .run(invoiceId, companyId, amountCents, method, transactionId || null);
  return getPaymentById(Number(info.lastInsertRowid))!;
};

export const updatePayment = (
  id: number,
  updates: {
    status?: PaymentRecord['status'];
    transactionId?: string;
  },
): PaymentRecord | null => {
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
    .prepare(
      `UPDATE payments SET ${updatesList.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    )
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

  const autoRenew =
    settings.auto_renew !== undefined ? (settings.auto_renew ? 1 : 0) : (existing?.auto_renew ?? 1);
  const emailInvoice =
    settings.email_invoice !== undefined
      ? settings.email_invoice
        ? 1
        : 0
      : (existing?.email_invoice ?? 1);
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

// --- Office settings (the control plane's own identity & mailer) ---------------

export interface OfficeSettingsRecord {
  id: number;
  office_name: string;
  office_email: string;
  office_phone: string;
  office_address: string;
  invoice_due_days: number;
  invoice_footer: string;
  /** The vendor's own VAT registration (`''` = not registered → not a tax invoice). */
  vat_reg_no: string;
  /** The rate its VAT-inclusive prices are quoted at. */
  vat_rate: number;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;
  smtp_from: string;
  updated_at: string;
}

/** The singleton. Created on first boot, so this always returns a row. */
export const getOfficeSettings = (): OfficeSettingsRecord =>
  getRegistryDb()
    .prepare('SELECT * FROM office_settings WHERE id = 1')
    .get() as OfficeSettingsRecord;

export const updateOfficeSettings = (
  patch: Partial<Omit<OfficeSettingsRecord, 'id' | 'updated_at'>>,
): OfficeSettingsRecord => {
  const current = getOfficeSettings();
  const next = { ...current, ...patch };
  getRegistryDb()
    .prepare(
      `UPDATE office_settings
          SET office_name = ?, office_email = ?, office_phone = ?, office_address = ?,
              invoice_due_days = ?, invoice_footer = ?, vat_reg_no = ?, vat_rate = ?,
              smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ?, smtp_from = ?,
              updated_at = datetime('now')
        WHERE id = 1`,
    )
    .run(
      next.office_name,
      next.office_email,
      next.office_phone,
      next.office_address,
      next.invoice_due_days,
      next.invoice_footer,
      next.vat_reg_no,
      next.vat_rate,
      next.smtp_host,
      next.smtp_port,
      next.smtp_user,
      next.smtp_pass,
      next.smtp_from,
    );
  return getOfficeSettings();
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
  (getRegistryDb()
    .prepare('SELECT * FROM deployment_jobs WHERE id = ?')
    .get(id) as DeploymentJobRecord) ?? null;

export const listDeploymentJobsForCompany = (companyId: number): DeploymentJobRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM deployment_jobs WHERE company_id = ? ORDER BY id DESC')
    .all(companyId) as DeploymentJobRecord[];

/** Every job in the fleet, newest first — the Releases > Deployments view (§33). */
export const listAllDeploymentJobs = (): DeploymentJobRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM deployment_jobs ORDER BY id DESC')
    .all() as DeploymentJobRecord[];

export interface DeploymentStepCounts {
  total: number;
  failed: number;
  complete: number;
  skipped: number;
}

/**
 * Per-job step tallies in one query, so the fleet's Deployments list does not
 * run a step query per job.
 */
export const deploymentStepCounts = (): Map<number, DeploymentStepCounts> => {
  const rows = getRegistryDb()
    .prepare(
      `SELECT job_id AS job_id,
              COUNT(*)                                       AS total,
              SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
              SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
         FROM deployment_job_steps
        GROUP BY job_id`,
    )
    .all() as Array<{
    job_id: number;
    total: number;
    failed: number;
    complete: number;
    skipped: number;
  }>;
  return new Map(
    rows.map((r) => [
      r.job_id,
      { total: r.total, failed: r.failed, complete: r.complete, skipped: r.skipped },
    ]),
  );
};

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
    .run(
      jobId,
      stepKey,
      resourceType,
      resourceId ?? null,
      metadata ? JSON.stringify(metadata) : null,
    );
  return (
    (db
      .prepare('SELECT * FROM deployment_job_steps WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as DeploymentJobStepRecord) ?? null
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
    DeploymentJobStepRecord | undefined;
  if (!current) return null;

  const metadataJson =
    updates.metadata !== undefined ? JSON.stringify(updates.metadata) : current.metadata_json;
  const warningsJson =
    updates.warnings !== undefined ? JSON.stringify(updates.warnings) : current.warnings_json;

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
  return db
    .prepare('SELECT * FROM deployment_job_steps WHERE id = ?')
    .get(id) as DeploymentJobStepRecord;
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
  return db
    .prepare('SELECT * FROM audit_logs WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as AuditLogRecord;
};

export const listAuditLogs = (limit = 100): AuditLogRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(limit) as AuditLogRecord[];

// --- Error feed (§30) --------------------------------------------------------

export type ErrorSource = 'health' | 'config' | 'licence' | 'deploy';

export const ERROR_SOURCES: readonly ErrorSource[] = ['health', 'config', 'licence', 'deploy'];

export type ErrorEntityType = 'store' | 'panel';

export interface ErrorEventRecord {
  id: number;
  fingerprint: string;
  source: ErrorSource;
  entity_type: ErrorEntityType;
  entity_id: number;
  message: string;
  app_version: string | null;
  environment: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
}

export interface ErrorEventInput {
  source: ErrorSource;
  entityType: ErrorEntityType;
  entityId: number;
  message: string;
  appVersion?: string | null;
  environment?: string | null;
}

/** Longest message kept — the same bound the per-store error columns use. */
const ERROR_MESSAGE_LIMIT = 500;

/**
 * Normalises a failure message into a stable class and hashes it. Two
 * occurrences of one fault differ in the parts that identify a single event —
 * a store's timeout milliseconds, a sequence number, a URL — so those are
 * replaced before hashing. Everything else is kept, so two genuinely different
 * faults do not collapse into one group.
 */
export const errorFingerprint = (message: string): string => {
  const normalised = message
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}[t ][\d:.]+z?/g, '<ts>')
    .replace(/https?:\/\/\S+/g, '<url>')
    // No trailing \b: the volatile part is usually a quantity with a unit
    // ("timed out after 5000ms"), and a boundary would not match inside it.
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(normalised).digest('hex').slice(0, 16);
};

export const getErrorEventById = (id: number): ErrorEventRecord | null =>
  (getRegistryDb()
    .prepare('SELECT * FROM error_events WHERE id = ?')
    .get(id) as ErrorEventRecord) ?? null;

/**
 * Records a failure, grouping it with earlier occurrences of the same fault for
 * the same store or panel. Never throws for a caller's benefit — an error while
 * recording an error must not replace the real failure the caller is reporting.
 */
export const recordErrorEvent = (input: ErrorEventInput): ErrorEventRecord | null => {
  try {
    const db = getRegistryDb();
    const message = input.message.slice(0, ERROR_MESSAGE_LIMIT);
    const fingerprint = errorFingerprint(message);
    const existing = db
      .prepare(
        `SELECT id FROM error_events
          WHERE fingerprint = ? AND source = ? AND entity_type = ? AND entity_id = ?`,
      )
      .get(fingerprint, input.source, input.entityType, input.entityId) as
      { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE error_events SET
           message = ?,
           app_version = COALESCE(?, app_version),
           environment = COALESCE(?, environment),
           occurrences = occurrences + 1,
           last_seen = datetime('now')
         WHERE id = ?`,
      ).run(message, input.appVersion ?? null, input.environment ?? null, existing.id);
      return getErrorEventById(existing.id);
    }

    const info = db
      .prepare(
        `INSERT INTO error_events
           (fingerprint, source, entity_type, entity_id, message, app_version, environment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fingerprint,
        input.source,
        input.entityType,
        input.entityId,
        message,
        input.appVersion ?? null,
        input.environment ?? null,
      );
    return getErrorEventById(Number(info.lastInsertRowid));
  } catch (err) {
    // The feed is diagnostic: losing an entry must never replace or mask the
    // failure the caller is in the middle of reporting.
    logger.warn(`Could not record error event (${input.source}): ${String(err)}`);
    return null;
  }
};

export interface ErrorGroupRecord {
  fingerprint: string;
  /** The most recent occurrence's message — the row an operator reads. */
  message: string;
  sources: ErrorSource[];
  occurrences: number;
  /** Distinct stores + panels affected, counted apart because ids collide. */
  entityCount: number;
  storeCount: number;
  panelCount: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * The feed: one row per distinct fault, newest first. The message is taken from
 * the latest occurrence so the row shows what the fault looks like now, not
 * what it looked like the first time.
 */
export const listErrorGroups = (limit = 100): ErrorGroupRecord[] => {
  const rows = getRegistryDb()
    .prepare(
      `SELECT
         g.fingerprint  AS fingerprint,
         g.occurrences  AS occurrences,
         g.entity_count AS entity_count,
         g.store_count  AS store_count,
         g.panel_count  AS panel_count,
         g.sources      AS sources,
         g.first_seen   AS first_seen,
         g.last_seen    AS last_seen,
         e.message      AS message
       FROM (
         SELECT
           fingerprint,
           SUM(occurrences) AS occurrences,
           COUNT(DISTINCT entity_type || ':' || entity_id) AS entity_count,
           COUNT(DISTINCT CASE WHEN entity_type = 'store' THEN entity_id END) AS store_count,
           COUNT(DISTINCT CASE WHEN entity_type = 'panel' THEN entity_id END) AS panel_count,
           GROUP_CONCAT(DISTINCT source) AS sources,
           MIN(first_seen) AS first_seen,
           MAX(last_seen)  AS last_seen
         FROM error_events
         GROUP BY fingerprint
       ) g
       JOIN error_events e ON e.id = (
         SELECT e2.id FROM error_events e2
          WHERE e2.fingerprint = g.fingerprint
          ORDER BY e2.last_seen DESC, e2.id DESC
          LIMIT 1
       )
       ORDER BY g.last_seen DESC, g.occurrences DESC, g.fingerprint ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    fingerprint: string;
    occurrences: number;
    entity_count: number;
    store_count: number;
    panel_count: number;
    sources: string | null;
    first_seen: string;
    last_seen: string;
    message: string;
  }>;

  return rows.map((r) => ({
    fingerprint: r.fingerprint,
    message: r.message,
    sources: (r.sources ?? '').split(',').filter(Boolean) as ErrorSource[],
    occurrences: r.occurrences,
    entityCount: r.entity_count,
    storeCount: r.store_count,
    panelCount: r.panel_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
};

/** Every occurrence behind one group, newest first. */
export const listErrorEvents = (fingerprint: string): ErrorEventRecord[] =>
  getRegistryDb()
    .prepare('SELECT * FROM error_events WHERE fingerprint = ? ORDER BY last_seen DESC, id DESC')
    .all(fingerprint) as ErrorEventRecord[];
