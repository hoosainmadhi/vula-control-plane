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

-- Subscription plans (four tiers seeded; every value editable). Pricing is a rate
-- per licensed terminal per period plus a once-off onboarding fee; `custom` means
-- the deal is negotiated — it may carry an agreed amount (billed flat, never
-- calculated from terminals) or 0, which leaves each invoice to the office.
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
  -- A custom plan's agreed charge per period (0 = negotiated per client, so an
  -- amountless invoice is refused). Ignored on a per_terminal plan.
  custom_amount_cents     INTEGER NOT NULL DEFAULT 0 CHECK (custom_amount_cents >= 0),
  setup_fee_cents         INTEGER NOT NULL DEFAULT 0 CHECK (setup_fee_cents >= 0),
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

-- What a client purchased: the quantity of licensed terminals it pays for and the
-- state of the once-off onboarding charge. One row per company — the company holds
-- the plan and the paid-through date, so this carries only the commercial facts.
CREATE TABLE IF NOT EXISTS company_subscriptions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id              INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  licensed_terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (licensed_terminal_count >= 0),
  setup_fee_status        TEXT    NOT NULL DEFAULT 'not_invoiced'
    CHECK (setup_fee_status IN ('not_invoiced', 'invoiced', 'paid', 'waived')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Where the purchased licences sit. A store's signed licence carries its
-- allocation and the tenant refuses device claims beyond it. The sum of a
-- client's allocations never exceeds its licensed count, and no allocation
-- exceeds the plan's per-store ceiling (enforced in services/terminalLicences.ts).
CREATE TABLE IF NOT EXISTS store_terminal_licences (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  store_id                INTEGER NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,
  licensed_terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (licensed_terminal_count >= 0),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Subscription invoices. The breakdown columns are the evidence for the amount:
-- terminal_count × terminal_price_cents is the recurring line as it stood when the
-- invoice was raised (rate snapshot), and setup_fee_cents is the once-off
-- onboarding charge — never repeated on a renewal.
CREATE TABLE IF NOT EXISTS invoices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_number       TEXT    NOT NULL UNIQUE,
  amount_cents         INTEGER NOT NULL,
  terminal_count       INTEGER,
  terminal_price_cents INTEGER,
  setup_fee_cents      INTEGER,
  -- What the charge is for. Required on a hand-priced invoice, and derived from
  -- the subscription when the control plane computes the amount.
  description          TEXT,
  -- The tax split of amount_cents, which is VAT-INCLUSIVE (prices are quoted
  -- incl. VAT). Stored per invoice so a rate change never restates a document
  -- already issued; NULL on invoices raised before the split existed.
  subtotal_cents       INTEGER,
  vat_cents            INTEGER,
  vat_rate             INTEGER,
  status               TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'overdue', 'cancelled')),
  due_date             TEXT,
  paid_date            TEXT,
  -- Written only after the mail server accepted the message, so the stamp means
  -- "sent" rather than "attempted".
  emailed_at           TEXT,
  emailed_to           TEXT,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
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

-- The monotonic per-year invoice counter (VULA-2026-000001).
CREATE TABLE IF NOT EXISTS invoice_sequences (
  year       INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL
);

-- The control plane's OWN settings: the vendor's identity and the SMTP account
-- it mails clients from. A true singleton (CHECK id = 1), seeded on first boot.
-- Distinct from billing_settings above (per client) and from the tenant's
-- per-store settings: no merchant's data belongs here.
CREATE TABLE IF NOT EXISTS office_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  office_name       TEXT    NOT NULL DEFAULT 'Vula',
  office_email      TEXT    NOT NULL DEFAULT '',
  office_phone      TEXT    NOT NULL DEFAULT '',
  office_address    TEXT    NOT NULL DEFAULT '',
  invoice_due_days  INTEGER NOT NULL DEFAULT 14
    CHECK (invoice_due_days BETWEEN 1 AND 180),
  invoice_footer    TEXT    NOT NULL DEFAULT '',
  -- The vendor's own registration and the rate its inclusive prices carry.
  vat_reg_no        TEXT    NOT NULL DEFAULT '',
  vat_rate          INTEGER NOT NULL DEFAULT 15
    CHECK (vat_rate BETWEEN 0 AND 100),
  smtp_host         TEXT    NOT NULL DEFAULT '',
  smtp_port         INTEGER NOT NULL DEFAULT 587,
  smtp_user         TEXT    NOT NULL DEFAULT '',
  smtp_pass         TEXT    NOT NULL DEFAULT '',
  smtp_from         TEXT    NOT NULL DEFAULT '',
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_store_terminal_licences_company ON store_terminal_licences(company_id);

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

-- Grouped failure feed (§30 observability). One row per fingerprint × source ×
-- entity, incremented when the same fault recurs, so the table grows with the
-- number of distinct problems rather than with the number of probes. Recovery
-- never deletes rows: it is a timeline, and freshness is last_seen. Technical
-- summaries only — never merchant payloads (§40).
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_error_events_group
  ON error_events(fingerprint, source, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_error_events_last_seen ON error_events(last_seen);

