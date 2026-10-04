'use strict';
const fs = require('node:fs');
const path = require('node:path');

// node:sqlite prints an ExperimentalWarning on first load; the API is stable enough for this schema.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = emit;

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'qudrat.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      rev INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      summary TEXT
    );

    -- One row per answered item: the grain every report, calibration and adaptive
    -- decision needs. Derived from the workspace snapshot on each save, so it also
    -- back-fills the history students accumulated before this table existed.
    -- exam_id is '' rather than NULL for practice so the UNIQUE index can dedupe:
    -- SQLite treats NULLs as distinct, and every save resends the whole history.
    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      section TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      exam_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      correct INTEGER NOT NULL,
      chosen INTEGER,
      ms_spent INTEGER,
      answered_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      UNIQUE (user_id, item_id, exam_id, answered_at)
    );
    CREATE INDEX IF NOT EXISTS responses_item ON responses(item_id);
    CREATE INDEX IF NOT EXISTS responses_user_time ON responses(user_id, answered_at);

    -- Administrative actions are irreversible for the student, so they leave a trail.
    -- No foreign keys: the record must outlive the accounts it refers to.
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY,
      actor_id INTEGER,
      actor_email TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target_id INTEGER,
      target_email TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit(at);
  `);
  // Migration for databases created before responses existed.
  const cols = db.prepare('PRAGMA table_info(progress)').all().map(c => c.name);
  if (!cols.includes('ingested_len')) db.exec('ALTER TABLE progress ADD COLUMN ingested_len INTEGER NOT NULL DEFAULT 0');
  return db;
}

module.exports = { openDb };
