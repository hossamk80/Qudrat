'use strict';
// Moves the shipped question bank out of dist/data.json and into the items table, so the
// bank and everything added through the intake gateway live in one place.
//
// The bank arrives already published and already editorially reviewed, so it lands as
// `live` with origin `legacy` rather than going through the draft that createItem forces
// on anything authored from now on. It still passes the same validator: a bank nobody can
// validate is a bank nobody can trust.
//
// Re-running is safe. Items already present are counted as `skipped`, never duplicated,
// so the migration can be run again after the bank is extended.
const items = require('./items');

function migrateBank(db, bank, { dryRun = false, now = () => new Date().toISOString() } = {}) {
  const questions = Array.isArray(bank && bank.questions) ? bank.questions : null;
  if (!questions) throw Error('bank.questions is missing or not an array');

  const insert = db.prepare(`INSERT INTO items
    (id, section, category, skill_id, skill, difficulty, text, options, answer, explanation, source,
     review, fingerprint, origin, author_kind, author_model, status, created_at, updated_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', 'human', '', 'live', ?, ?, ?)`);
  const byId = db.prepare('SELECT id FROM items WHERE id = ?');
  const byPrint = db.prepare('SELECT id FROM items WHERE fingerprint = ?');

  const report = { total: questions.length, migrated: 0, skipped: 0, invalid: [], duplicates: [] };
  const seen = new Map();    // fingerprints inside this run
  const takenIds = new Set();// ids inside this run: the database checks cannot see them yet
  const rows = [];

  for (const q of questions) {
    const { ok, item, errors } = items.validateItem(q, { strict: true });
    if (!ok) { report.invalid.push({ id: String(q && q.id || '—'), errors }); continue; }
    if (!item.id) { report.invalid.push({ id: '—', errors: ['السؤال بلا معرف.'] }); continue; }
    const print = items.fingerprint(item);

    // A collision inside the bank itself is a content decision, not something a migration
    // should resolve: the first occurrence is kept and the other reported by both ids.
    const earlier = seen.get(print);
    if (earlier) { report.duplicates.push({ id: item.id, sameAs: earlier }); continue; }
    // Two questions sharing an id but not a fingerprint would both clear the checks above
    // and then collide on the primary key, aborting the whole run. Report instead.
    if (takenIds.has(item.id)) { report.invalid.push({ id: item.id, errors: ['المعرف مستخدم لسؤال آخر في نفس الدفعة.'] }); continue; }
    seen.set(print, item.id);
    takenIds.add(item.id);

    if (byId.get(item.id) || byPrint.get(print)) { report.skipped++; continue; }
    const at = q.review && q.review.date ? String(q.review.date) : now();
    rows.push([item.id, item.section, item.category, item.skillId, item.skill, item.difficulty, item.text,
      JSON.stringify(item.options), item.answer, item.explanation, item.source,
      q.review ? JSON.stringify(q.review) : '', print, now(), now(), at]);
  }

  if (dryRun) { report.migrated = rows.length; return report; }

  // One transaction: a bank half in the table is worse than a bank not in it.
  db.exec('BEGIN');
  try {
    for (const r of rows) insert.run(...r);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  report.migrated = rows.length;
  return report;
}

// Fills skill_id on rows migrated before the taxonomy existed. Safe to re-run: it only
// touches rows whose skill_id is still empty.
function backfillSkillIds(db) {
  const taxonomy = require('./taxonomy');
  const rows = db.prepare("SELECT id, category, skill FROM items WHERE skill_id = ''").all();
  const update = db.prepare('UPDATE items SET skill_id = ? WHERE id = ?');
  const report = { examined: rows.length, filled: 0, unresolved: [] };
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const id = taxonomy.classify(r);
      if (!id) { report.unresolved.push(r.id); continue; }
      update.run(id, r.id);
      report.filled++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return report;
}

module.exports = { migrateBank, backfillSkillIds };
