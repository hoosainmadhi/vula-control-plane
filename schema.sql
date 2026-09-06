-- Vula Control Plane registry schema.
-- Source of truth: src/config/registryDb.ts (embedded DDL). Keep both in sync.

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
);
