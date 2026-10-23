-- Vula Control Plane registry schema.
-- Source of truth: src/config/registryDb.ts (embedded DDL). Keep both in sync.

-- One row per store deployment. Licence columns are appended by the
-- auto-migration in registryDb.ts so pre-existing databases upgrade in place.
CREATE TABLE IF NOT EXISTS stores (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                   TEXT    NOT NULL UNIQUE,
  name                   TEXT    NOT NULL,
  -- The Coolify label; null derives one from the client and store name.
  deployment_name        TEXT,
  vertical               TEXT    NOT NULL DEFAULT 'general',
  -- 'store' sells; 'warehouse' only holds stock and transfers it out. A
  -- warehouse does not consume the plan's store allowance and runs no tills
  -- (owner decisions, 2026-10-09) — which is why terminal_count may be 0.
  kind                   TEXT    NOT NULL DEFAULT 'store'
    CHECK (kind IN ('store', 'warehouse')),
  terminal_count         INTEGER NOT NULL DEFAULT 1
    CHECK (terminal_count BETWEEN 0 AND 99),
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
  image_digest           TEXT,
  image_tag              TEXT,
  release_channel        TEXT    NOT NULL DEFAULT 'stable',
  desired_release_id     INTEGER,
  last_release_id        INTEGER,
  previous_release_id    INTEGER,
  last_release_at        TEXT,
  release_state          TEXT    NOT NULL DEFAULT 'idle',
  created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Subscription plans (eight tiers seeded; every value editable). `per_store` is
-- the published model: a rate per trading store with its first till included,
-- plus a rate per ADDITIONAL till (`terminal_price_cents` on that mode).
-- `per_terminal` is the older model kept for grandfathered agreements; `custom`
-- is a negotiated flat amount per period. The once-off onboarding fee is a
-- separate plan field.
CREATE TABLE IF NOT EXISTS plans (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  code                    TEXT    NOT NULL UNIQUE,
  name                    TEXT    NOT NULL,
  max_stores              INTEGER NOT NULL DEFAULT 1,
  max_terminals_per_store INTEGER NOT NULL DEFAULT 2,
  features_json           TEXT    NOT NULL DEFAULT '[]',
  feature_prices_json     TEXT    NOT NULL DEFAULT '{}',
  pricing_mode            TEXT    NOT NULL DEFAULT 'per_terminal'
    CHECK (pricing_mode IN ('per_terminal', 'per_store', 'custom')),
  terminal_price_cents    INTEGER NOT NULL DEFAULT 0 CHECK (terminal_price_cents >= 0),
  -- A per_store plan's rate per trading store, the first till included
  -- (R199/m). On that mode terminal_price_cents is the ADDITIONAL-till rate
  -- (R49/m); a warehouse is not a trading store and carries no line.
  store_price_cents       INTEGER NOT NULL DEFAULT 0 CHECK (store_price_cents >= 0),
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
  -- The price the client AGREED to: copied from the plan when they are onboarded,
  -- moved to another plan, or explicitly re-priced — never read back from the plan,
  -- so editing a plan re-prices nobody. A NULL priced_at means no agreement has
  -- been recorded and the quote falls back to the plan (and says so).
  pricing_mode            TEXT,
  rate_cents              INTEGER,
  -- The agreed per-store rate (`per_store` deals only); rate_cents is the
  -- additional-till rate on that mode.
  store_rate_cents        INTEGER,
  custom_amount_cents     INTEGER,
  setup_fee_cents         INTEGER,
  billing_period          TEXT,
  priced_at               TEXT,
  -- What the client bought: the add-on keys and the price agreed for each,
  -- snapshotted so editing the plan or the price list cannot rewrite them
  -- (2026-10-10). The signed licence carries the plan's features union these.
  features_json           TEXT,
  addon_prices_json       TEXT,
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
  -- The Coolify label; null derives `<client>-ho`.
  deployment_name     TEXT,
  base_url            TEXT    NOT NULL
    CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
  control_plane_token TEXT    NOT NULL,
  admin_email         TEXT,
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
  image_digest        TEXT,
  image_tag           TEXT,
  release_channel     TEXT    NOT NULL DEFAULT 'stable',
  desired_release_id  INTEGER,
  last_release_id     INTEGER,
  previous_release_id INTEGER,
  last_release_at     TEXT,
  release_state       TEXT    NOT NULL DEFAULT 'idle',
  schema_version      INTEGER,
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
  -- On a per-store invoice: the trading stores billed and the store rate, beside
  -- the terminal pair. `terminal_count` stays the licensed TOTAL, so the
  -- additional-till count is the difference.
  store_count          INTEGER,
  store_price_cents    INTEGER,
  -- The paid add-ons billed, with the price agreed for each — the other half of
  -- the recurring evidence (2026-10-10), itemised on the document.
  addons_json          TEXT,
  setup_fee_cents      INTEGER,
  -- What the charge is for. Required on a hand-priced invoice, and derived from
  -- the subscription when the control plane computes the amount.
  description          TEXT,
  -- What the invoice was raised for. Settlement extends the paid period only for
  -- `initial`/`renewal` (2026-09-25); legacy rows default to `initial`, with what
  -- the stored columns can prove backfilled at migration.
  purpose              TEXT NOT NULL DEFAULT 'initial',
  -- The plan at the time of issue (a snapshot): renaming a plan must not restate
  -- what an issued invoice says.
  plan_code            TEXT,
  plan_name            TEXT,
  -- For a mid-period increase: the paid period this charge covered, so the same
  -- increase cannot be billed twice for one period.
  pro_rata_period      TEXT,
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

-- The quote desk's records (§45). A quote starts life as the marketing site's
-- request and ends as a document the office sends. Both figures are kept — what
-- the visitor's page showed and what the catalogue prices — so a stale page is
-- visible on the record instead of being believed (2026-10-13).
CREATE TABLE IF NOT EXISTS quotes (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number            TEXT    NOT NULL UNIQUE,
  status                  TEXT    NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','quoted','accepted','declined')),
  business                TEXT    NOT NULL DEFAULT '',
  contact_name            TEXT    NOT NULL DEFAULT '',
  email                   TEXT    NOT NULL,
  phone                   TEXT    NOT NULL,
  vertical                TEXT    NOT NULL DEFAULT '',
  note                    TEXT    NOT NULL DEFAULT '',
  stores                  INTEGER NOT NULL,
  tills                   INTEGER NOT NULL,
  addons_json             TEXT    NOT NULL DEFAULT '[]',
  setup_variant           TEXT    NOT NULL,
  -- Where the quote came from: the website's builder, or the office's own draft.
  source                  TEXT    NOT NULL DEFAULT 'website'
    CHECK (source IN ('website','office')),
  -- The quote's own price basis and rate overrides (2026-10-14): `store` is the
  -- published list, `till` honours the older per-till terms; NULL/0 means the
  -- list's own figure.
  pricing_basis           TEXT    NOT NULL DEFAULT 'store',
  store_rate_cents        INTEGER,
  till_rate_cents         INTEGER,
  setup_fee_override_cents INTEGER,
  addon_rates_json        TEXT    NOT NULL DEFAULT '{}',
  -- What the visitor's page showed, as JSON [{label,amount}].
  requested_lines_json    TEXT    NOT NULL DEFAULT '[]',
  requested_monthly_cents INTEGER,
  requested_setup_cents   INTEGER,
  -- The catalogue's own figures, as JSON [{label,detail,cents}].
  priced_lines_json       TEXT    NOT NULL DEFAULT '[]',
  monthly_total_cents     INTEGER NOT NULL,
  setup_cents             INTEGER NOT NULL,
  vat_rate                INTEGER NOT NULL,
  monthly_vat_cents       INTEGER NOT NULL,
  setup_vat_cents         INTEGER NOT NULL,
  drift                   INTEGER NOT NULL DEFAULT 0,
  emailed_at              TEXT,
  email_error             TEXT,
  valid_until             TEXT,
  sent_at                 TEXT,
  accepted_at             TEXT,
  declined_at             TEXT,
  company_id              INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_email ON quotes(email);

-- The quote counter, on the invoice counter's rules.
CREATE TABLE IF NOT EXISTS quote_sequences (
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
  -- How long a quotation stays valid, in days (§5f).
  quote_valid_days  INTEGER NOT NULL DEFAULT 30
    CHECK (quote_valid_days BETWEEN 1 AND 180),
  -- The published onboarding pair (2026-10-14): the desk, the onboarding form,
  -- the subscription editor and the marketing page all read these.
  setup_fee_self_cents     INTEGER NOT NULL DEFAULT 150000
    CHECK (setup_fee_self_cents >= 0),
  setup_fee_assisted_cents INTEGER NOT NULL DEFAULT 500000
    CHECK (setup_fee_assisted_cents >= 0),
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

-- Shared-image release catalog and tenant release state.
CREATE TABLE IF NOT EXISTS image_releases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('store', 'ho')),
  tag            TEXT NOT NULL,
  digest         TEXT NOT NULL,
  version        TEXT NOT NULL,
  revision       TEXT,
  channel        TEXT NOT NULL DEFAULT 'stable'
    CHECK (channel IN ('stable', 'beta', 'canary')),
  schema_version INTEGER NOT NULL,
  schema_min     INTEGER NOT NULL,
  schema_max     INTEGER NOT NULL,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  published_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, digest),
  UNIQUE (kind, tag)
);

CREATE TABLE IF NOT EXISTS release_batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id   INTEGER NOT NULL REFERENCES image_releases(id),
  kind         TEXT NOT NULL CHECK (kind IN ('store', 'ho')),
  channel      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'running', 'complete', 'partial', 'failed', 'dry_run')),
  wave_size    INTEGER NOT NULL DEFAULT 1 CHECK (wave_size BETWEEN 1 AND 50),
  requested_by TEXT NOT NULL,
  dry_run      INTEGER NOT NULL DEFAULT 0,
  stop_on_failure INTEGER NOT NULL DEFAULT 1,
  total        INTEGER NOT NULL DEFAULT 0,
  succeeded    INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS release_batch_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES release_batches(id) ON DELETE CASCADE,
  tenant_type   TEXT NOT NULL CHECK (tenant_type IN ('store', 'panel')),
  tenant_id     INTEGER NOT NULL,
  wave_no       INTEGER NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('provision', 'upgrade', 'rollback')),
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
  from_digest   TEXT,
  to_digest     TEXT,
  error         TEXT,
  metadata_json TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  UNIQUE (batch_id, tenant_type, tenant_id)
);

CREATE TABLE IF NOT EXISTS release_deployments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_type     TEXT NOT NULL CHECK (tenant_type IN ('store', 'panel')),
  tenant_id       INTEGER NOT NULL,
  release_id      INTEGER REFERENCES image_releases(id),
  batch_id        INTEGER REFERENCES release_batches(id) ON DELETE SET NULL,
  action          TEXT NOT NULL CHECK (action IN ('provision', 'upgrade', 'rollback')),
  from_release_id INTEGER,
  to_release_id   INTEGER,
  from_digest     TEXT,
  to_digest       TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'complete', 'failed', 'skipped')),
  phase           TEXT NOT NULL DEFAULT 'queued',
  error           TEXT,
  coolify_uuid    TEXT,
  coolify_deployment_uuid TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

CREATE TABLE IF NOT EXISTS deployment_locks (
  tenant_type  TEXT NOT NULL CHECK (tenant_type IN ('store', 'panel')),
  tenant_id    INTEGER NOT NULL,
  lock_token   TEXT NOT NULL,
  batch_id     INTEGER,
  reason       TEXT,
  acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_type, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_image_releases_kind_channel
  ON image_releases(kind, channel, published_at);
CREATE INDEX IF NOT EXISTS idx_release_batches_release ON release_batches(release_id);
CREATE INDEX IF NOT EXISTS idx_release_batch_items_batch ON release_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_release_deployments_tenant
  ON release_deployments(tenant_type, tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_deployment_locks_expiry ON deployment_locks(expires_at);

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

