-- Vula Control Plane registry schema.
-- Source of truth: src/config/registryDb.ts (embedded DDL). Keep both in sync.

-- One row per store deployment. Licence columns are appended by the
-- auto-migration in registryDb.ts so pre-existing databases upgrade in place.
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
  licence_sequence       INTEGER NOT NULL DEFAULT 0,
  licence_issued_at      TEXT,
  licence_push_status    TEXT    NOT NULL DEFAULT 'pending',
  licence_pushed_at      TEXT,
  company_id             INTEGER REFERENCES companies(id) ON DELETE SET NULL,
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
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
