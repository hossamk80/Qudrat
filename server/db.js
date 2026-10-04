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

    -- The question bank, whatever authored it. fingerprint is the duplicate guard: it
    -- hashes the normalised stem plus the sorted option set, so retyping a question with
    -- different hamzas, digits or option order cannot slip a second copy in.
    -- origin says which path it arrived by, author_kind who wrote it. Both are recorded
    -- because an item authored by a model must never reach a student unreviewed, and
    -- because originality has to be auditable item by item.
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      section TEXT NOT NULL,
      category TEXT NOT NULL,
      skill TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL,
      text TEXT NOT NULL,
      options TEXT NOT NULL,
      answer INTEGER NOT NULL,
      explanation TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      -- The editorial review record the migrated bank carries (batch, date, type), kept as
      -- JSON: it is the audit trail for originality and must not be lost in the move.
      review TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL,
      author_kind TEXT NOT NULL,
      author_model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_by INTEGER,
      reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS items_status ON items(status);
    CREATE INDEX IF NOT EXISTS items_section ON items(section, category);

    -- Every change to an item, so a bad edit can be traced and undone by hand.
    CREATE TABLE IF NOT EXISTS item_revisions (
      id INTEGER PRIMARY KEY,
      item_id TEXT NOT NULL,
      actor_id INTEGER,
      actor_email TEXT NOT NULL DEFAULT '',
      change TEXT NOT NULL,
      before TEXT NOT NULL DEFAULT '',
      after TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS item_revisions_item ON item_revisions(item_id, id);
  `);
  // Migration for databases created before responses existed.
  const cols = db.prepare('PRAGMA table_info(progress)').all().map(c => c.name);
  if (!cols.includes('ingested_len')) db.exec('ALTER TABLE progress ADD COLUMN ingested_len INTEGER NOT NULL DEFAULT 0');
  return db;
}

module.exports = { openDb };
