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
const crypto = require('node:crypto');
const items = require('./items');

function migrateBank(db, bank, { dryRun = false, now = () => new Date().toISOString() } = {}) {
  const questions = Array.isArray(bank && bank.questions) ? bank.questions : null;
  if (!questions) throw Error('bank.questions is missing or not an array');

  const insert = db.prepare(`INSERT INTO items
    (id, section, category, passage_id, skill_id, skill, difficulty, text, options, answer, explanation,
     source, review, fingerprint, origin, author_kind, author_model, status, created_at, updated_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', 'human', '', 'live', ?, ?, ?)`);
  const insertPassage = db.prepare(`INSERT INTO passages (id, text, fingerprint, words, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const passageByPrint = db.prepare('SELECT id FROM passages WHERE fingerprint = ?');
  const byId = db.prepare('SELECT id FROM items WHERE id = ?');
  const byPrint = db.prepare('SELECT id FROM items WHERE fingerprint = ?');

  const report = { total: questions.length, migrated: 0, skipped: 0, invalid: [], duplicates: [] };
  const seen = new Map();    // fingerprints inside this run
  const passages = new Map();// passage fingerprint -> { id, text, words } for this run
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
    // One row per distinct passage, shared by its questions.
    let passageId = null;
    if (item.passageText) {
      const pPrint = crypto.createHash('sha256').update(items.normalizeText(item.passageText)).digest('hex');
      const existing = passages.get(pPrint) || passageByPrint.get(pPrint);
      if (existing) passageId = existing.id;
      else {
        passageId = 'P-' + pPrint.slice(0, 10).toUpperCase();
        passages.set(pPrint, { id: passageId, text: item.passageText, print: pPrint,
          words: item.passageText.split(/\s+/).filter(Boolean).length });
      }
    }
    const at = q.review && q.review.date ? String(q.review.date) : now();
    rows.push([item.id, item.section, item.category, passageId, item.skillId, item.skill, item.difficulty, item.text,
      JSON.stringify(item.options), item.answer, item.explanation, item.source,
      q.review ? JSON.stringify(q.review) : '', print, now(), now(), at]);
  }

  report.passages = passages.size;
  if (dryRun) { report.migrated = rows.length; return report; }

  // One transaction: a bank half in the table is worse than a bank not in it.
  db.exec('BEGIN');
  try {
    // Passages first: the items reference them.
    for (const p of passages.values()) insertPassage.run(p.id, p.text, p.print, p.words, now(), now());
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

// Splits passages out of rows migrated before the passages table existed. Safe to re-run:
// it only touches reading items whose text still carries «النص: …» inline.
function splitPassages(db) {
  const rows = db.prepare(
    'SELECT id, text, options FROM items WHERE category = ? AND passage_id IS NULL')
    .all(items.PASSAGE_CATEGORY);
  const insertPassage = db.prepare(`INSERT INTO passages (id, text, fingerprint, words, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const byPrint = db.prepare('SELECT id FROM passages WHERE fingerprint = ?');
  const update = db.prepare('UPDATE items SET passage_id = ?, text = ?, fingerprint = ?, updated_at = ? WHERE id = ?');
  const report = { examined: rows.length, split: 0, passages: 0, unsplit: [] };
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const { passageText, text } = items.splitPassage(r.text);
      if (!passageText) { report.unsplit.push(r.id); continue; }
      const print = crypto.createHash('sha256').update(items.normalizeText(passageText)).digest('hex');
      let pid = byPrint.get(print)?.id;
      if (!pid) {
        pid = 'P-' + print.slice(0, 10).toUpperCase();
        insertPassage.run(pid, passageText, print, passageText.split(/\s+/).filter(Boolean).length, at, at);
        report.passages++;
      }
      // The fingerprint binds the question to its passage, so it changes with the split.
      update.run(pid, text, items.fingerprint({ text, options: JSON.parse(r.options), passageText }), at, r.id);
      report.split++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return report;
}

module.exports = { migrateBank, backfillSkillIds, splitPassages };
