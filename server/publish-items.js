'use strict';
// Marks authored items reviewed and publishes them, outside an HTTP session but through the
// same gate POST /api/admin/items/status uses: the status machine, a full strict re-check
// before anything reaches a student, and the rule that a model-authored item needs a human
// review on the record.
//
// The actor is not optional. The guard this command passes through exists to put a person's
// decision on the record, so the command refuses to run without an admin to name, and writes
// that name into items.reviewed_by, item_revisions and admin_audit. A command that could
// approve a batch with nobody attached would be the guard approving itself.
const crypto = require('node:crypto');
const items = require('./items');

const itemRow = r => ({
  id: r.id, section: r.section, category: r.category, passageId: r.passage_id || '',
  skillId: r.skill_id, skill: r.skill, difficulty: r.difficulty,
  text: r.text, options: JSON.parse(r.options), answer: r.answer, explanation: r.explanation,
  source: r.source, origin: r.origin, authorKind: r.author_kind, authorModel: r.author_model,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, reviewedAt: r.reviewed_at,
});

// The file carries no ids — the database assigned them on import — so each authored question is
// found by the fingerprint the importer stored, computed here exactly as it was there.
function printOf(raw) {
  const { check, ...clean } = raw;
  const { ok, item } = items.validateItem(clean, { strict: true });
  if (!ok) return null;
  if (item.passageText) {
    item.passageId = 'P-' + crypto.createHash('sha256').update(items.normalizeText(item.passageText))
      .digest('hex').slice(0, 10).toUpperCase();
  }
  return items.fingerprint(item);
}

function publishItems(db, list, { actor, to = 'live', note = '' } = {}) {
  if (!Array.isArray(list)) throw Error('items must be an array');
  if (!actor || !actor.id) throw Error('publishing needs the admin who authorises it');
  if (!['reviewed', 'live'].includes(to)) throw Error(`cannot publish to "${to}"`);

  const byPrint = db.prepare('SELECT * FROM items WHERE fingerprint = ?');
  const setStatus = db.prepare(`UPDATE items SET status = ?, updated_at = ?,
    reviewed_by = CASE WHEN ? IN ('reviewed','live') THEN ? ELSE reviewed_by END,
    reviewed_at = CASE WHEN ? IN ('reviewed','live') THEN ? ELSE reviewed_at END WHERE id = ?`);
  const insertRevision = db.prepare(`INSERT INTO item_revisions
    (item_id, actor_id, actor_email, change, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertAudit = db.prepare(`INSERT INTO admin_audit
    (actor_id, actor_email, action, target_id, target_email, ip, at) VALUES (?, ?, ?, ?, ?, '', ?)`);

  const report = { reviewed: 0, published: 0, already: 0, missing: 0, failed: 0, results: [] };
  const at = new Date().toISOString();

  const step = (row, next) => {
    if (!items.canTransition(row.status, next)) throw Error(`لا يمكن الانتقال من ${row.status} إلى ${next}.`);
    if (next === 'live') {
      // Same two checks the route runs: publishing is where a half-finished draft would
      // otherwise reach students, and where the human-review guarantee is spelled out again
      // so a later change to the transition table cannot quietly drop it.
      const check = items.validateItem(itemRow(row), { strict: true });
      if (!check.ok) throw Error(check.errors[0]);
      if (row.author_kind === 'ai' && !row.reviewed_at) {
        throw Error('سؤال مولّد آليًا لا يُنشر قبل مراجعة بشرية موثّقة.');
      }
    }
    setStatus.run(next, at, next, actor.id, next, at, row.id);
    insertRevision.run(row.id, actor.id, actor.email, 'status',
      JSON.stringify({ status: row.status }), JSON.stringify({ status: next, note }), at);
    insertAudit.run(actor.id, actor.email, `item-status:${row.status}->${next}`, row.id, '', at);
    row.status = next;
    if (next === 'reviewed') { row.reviewed_at = at; report.reviewed++; } else report.published++;
  };

  db.exec('BEGIN');
  try {
    list.forEach((raw, i) => {
      const n = i + 1;
      const print = printOf(raw);
      if (!print) { report.results.push({ row: n, ok: false, error: 'لا يجتاز الفحص' }); report.failed++; return; }
      const row = byPrint.get(print);
      if (!row) { report.results.push({ row: n, ok: false, error: 'غير موجود في القاعدة — استورده أولًا' }); report.missing++; return; }
      if (row.status === to) { report.results.push({ row: n, ok: true, id: row.id, already: true }); report.already++; return; }
      try {
        // draft -> live is two steps by design: a human marks it reviewed, then it publishes.
        if (row.status === 'draft') step(row, 'reviewed');
        if (to === 'live' && row.status === 'reviewed') step(row, 'live');
        report.results.push({ row: n, ok: true, id: row.id, status: row.status });
      } catch (err) {
        report.results.push({ row: n, ok: false, id: row.id, error: err.message });
        report.failed++;
      }
    });
    // All or nothing: a batch half-published is worse than one not published, because the
    // half that went live is the half nobody chose.
    if (report.failed || report.missing) { db.exec('ROLLBACK'); report.rolledBack = true; }
    else db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return report;
}

module.exports = { publishItems, itemRow };
