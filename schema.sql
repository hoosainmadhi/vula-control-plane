-- Vula Control Plane registry schema.
-- Source of truth: src/config/registryDb.ts (embedded DDL). Keep both in sync.

-- One row per store deployment. Licence columns are appended by the
-- auto-migration in registryDb.ts so pre-existing databases upgrade in place.
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
  licence_sequence       INTEGER NOT NULL DEFAULT 0,
  licence_issued_at      TEXT,
  licence_push_status    TEXT    NOT NULL DEFAULT 'pending',
  licence_pushed_at      TEXT,
  company_id             INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  deploy_status          TEXT    NOT NULL DEFAULT 'not_deployed'
    CHECK (deploy_status IN ('not_deployed', 'provisioning', 'deployed', 'failed')),
  coolify_uuid           TEXT,
  volume_name            TEXT,
  admin_email            TEXT,
  terminal_names_json    TEXT,
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Subscription plans (four SA-retail tiers seeded; every value editable).
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
);

-- The merchant account: the unit of billing, and the owner of both the branches
-- and the Company Control Panel.
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
);

-- One Company Control Panel per merchant. A separate application from a store, so
-- its own table: no terminals, no retail vertical.
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
);

-- Subscription invoices
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
);

-- Payments for invoices
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
);

-- Company billing settings — one row per merchant (company_id is the natural key).
CREATE TABLE IF NOT EXISTS billing_settings (
  company_id        INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  auto_renew        INTEGER NOT NULL DEFAULT 1,
  email_invoice     INTEGER NOT NULL DEFAULT 1,
  invoice_email     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

-- Durable deployment jobs for client orchestration (§11, §27)
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
);

-- Individual granular steps within a deployment job
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
);

-- Privileged actions audit trail (§27, §30)
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
);

CREATE INDEX IF NOT EXISTS idx_deployment_jobs_company ON deployment_jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_deployment_job_steps_job ON deployment_job_steps(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id);

