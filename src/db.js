import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const STATUS = { None: 0, NeedsReview: 1, Approved: 2 };

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  last_file_id INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_approve INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  meta TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS file_access (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, user_id)
);

CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  ns INTEGER NOT NULL,
  row_key TEXT NOT NULL,
  key TEXT NOT NULL,
  key_hash INTEGER NOT NULL,
  value_hash INTEGER NOT NULL,
  extern_id INTEGER NOT NULL,
  key_unicode INTEGER NOT NULL,
  value_unicode INTEGER NOT NULL,
  source TEXT NOT NULL,
  translation TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  src_words INTEGER NOT NULL DEFAULT 0,
  src_lc TEXT NOT NULL,
  tr_lc TEXT NOT NULL DEFAULT '',
  key_lc TEXT NOT NULL,
  ver INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS rows_file_pos ON rows(file_id, pos);
CREATE INDEX IF NOT EXISTS rows_file_rev ON rows(file_id, rev);

CREATE TABLE IF NOT EXISTS edits (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  row_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at INTEGER NOT NULL,
  old_translation TEXT NOT NULL,
  new_translation TEXT NOT NULL,
  old_status INTEGER NOT NULL,
  new_status INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS edits_file ON edits(file_id, at);
CREATE INDEX IF NOT EXISTS edits_user ON edits(user_id, at);
`;

/**
 * Ролі (одноразова, ідемпотентна міграція за відсутністю стовпця):
 *  users.role: найстаріший is_admin → owner, інші is_admin → admin, решта → user;
 *  project_members.role: can_approve → reviewer, інакше translator.
 * Стовпці is_admin і can_approve лишаються й синхронізуються (is_admin = owner|admin) для зворотної сумісності.
 */
function migrateRoles(db) {
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    const owner = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
    db.exec("UPDATE users SET role = 'admin' WHERE is_admin = 1");
    if (owner) db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.id);
  }
  if (!db.prepare('PRAGMA table_info(project_members)').all().some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE project_members ADD COLUMN role TEXT NOT NULL DEFAULT 'translator'");
    db.exec("UPDATE project_members SET role = 'reviewer' WHERE can_approve = 1");
  }
}

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  // міграція: структурна ревізія файлу (зростає, коли змінюється набір/порядок рядків)
  if (!db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'struct_rev')) {
    db.exec('ALTER TABLE files ADD COLUMN struct_rev INTEGER NOT NULL DEFAULT 0');
  }
  // формат джерела файлу: 'locres' | 'csv' | 'txt' | 'json'
  if (!db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'format')) {
    db.exec("ALTER TABLE files ADD COLUMN format TEXT NOT NULL DEFAULT 'locres'");
  }
  migrateRoles(db);
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  for (const col of ['email', 'discord', 'telegram']) {
    if (!userCols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  return db;
}

/** Виконує fn у транзакції. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function getSetting(db, key, fallback) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
