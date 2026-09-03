import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { env } from './env.js';

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';

export const STORE_STATUSES: readonly StoreStatus[] = ['active', 'paused'];
export const CONFIG_STATUSES: readonly ConfigStatus[] = ['pending', 'ok', 'failed'];
export const HEALTH_STATUSES: readonly HealthStatus[] = ['up', 'down', 'unknown'];

export interface StoreRecord {
  id: number;
  slug: string;
  name: string;
  vat_reg_no: string | null;
  terminal_count: number;
  base_url: string;
  control_plane_token: string;
  status: StoreStatus;
  last_config_status: ConfigStatus;
  last_config_at: string | null;
  last_config_snapshot_json: string | null;
  last_health_at: string | null;
  last_health_status: HealthStatus;
  created_at: string;
  updated_at: string;
}

const STORES_DDL = `
  CREATE TABLE IF NOT EXISTS stores (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug                   TEXT    NOT NULL UNIQUE,
    name                   TEXT    NOT NULL,
    vat_reg_no             TEXT,
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
  // Lightweight auto-migrations for pre-existing databases.
  const storeCols = db.prepare('PRAGMA table_info(stores)').all() as Array<{ name: string }>;
  const addColumn = (name: string, ddl: string) => {
    if (!storeCols.some((c) => c.name === name)) db.exec(`ALTER TABLE stores ADD COLUMN ${ddl}`);
  };
  addColumn('vat_reg_no', 'vat_reg_no TEXT');
  addColumn('control_plane_token', `control_plane_token TEXT NOT NULL DEFAULT ''`);
  return registry;
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
  terminalCount: number;
  baseUrl: string;
}

export const createStore = (input: CreateStoreInput, controlPlaneToken: string): StoreRecord => {
  const db = getRegistryDb();
  const insert = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO stores (name, slug, vat_reg_no, terminal_count, base_url, control_plane_token)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.slug,
        input.vatRegNo ?? null,
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
       terminal_count = COALESCE(?, terminal_count),
       base_url = COALESCE(?, base_url),
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    input.name ?? null,
    input.vatRegNo === undefined ? current.vat_reg_no : input.vatRegNo,
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
