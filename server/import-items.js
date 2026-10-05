'use strict';
// Imports authored items outside an HTTP session, through the same gate the upload route uses:
// one validator, one fingerprint, one passage table, and draft as the only landing state.
// Nothing here can publish — an item a model wrote needs a human review on the record first.
const crypto = require('node:crypto');
const items = require('./items');

function importItems(db, list, { authorModel, origin = 'manual', authorKind = 'ai', actorId = null } = {}) {
  if (!Array.isArray(list)) throw Error('items must be an array');
  if (authorKind === 'ai' && !authorModel) throw Error('an AI-authored batch must name its model');

  const insert = db.prepare(`INSERT INTO items
    (id, section, category, passage_id, skill_id, skill, difficulty, text, options, answer, explanation,
     source, strategy, fingerprint, origin, author_kind, author_model, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`);
  const insertPassage = db.prepare(`INSERT INTO passages (id, text, fingerprint, words, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const passageByPrint = db.prepare('SELECT id FROM passages WHERE fingerprint = ?');
  const byPrint = db.prepare('SELECT id, status FROM items WHERE fingerprint = ?');
  const byId = db.prepare('SELECT id FROM items WHERE id = ?');

  const report = { added: 0, rejected: 0, passages: 0, results: [] };
  const batchPrints = new Map();
  const at = new Date().toISOString();

  db.exec('BEGIN');
  try {
    list.forEach((raw, i) => {
      const row = i + 1;
      const { check, ...clean } = raw;          // check is an authoring aid, never stored
      const { ok, item, errors } = items.validateItem(clean, { strict: true });
      if (!ok) { report.results.push({ row, ok: false, errors }); report.rejected++; return; }

      let passageId = null;
      if (item.passageText) {
        const pPrint = crypto.createHash('sha256').update(items.normalizeText(item.passageText)).digest('hex');
        const found = passageByPrint.get(pPrint);
        if (found) passageId = found.id;
        else {
          passageId = 'P-' + pPrint.slice(0, 10).toUpperCase();
          insertPassage.run(passageId, item.passageText, pPrint,
            item.passageText.split(/\s+/).filter(Boolean).length, actorId, at, at);
          report.passages++;
        }
      }

      const print = items.fingerprint(item);
      const clash = byPrint.get(print) || (batchPrints.has(print) ? { id: batchPrints.get(print), status: 'في هذه الدفعة' } : null);
      if (clash) { report.results.push({ row, ok: false, errors: [`مكرر: يطابق «${clash.id}» (${clash.status}).`] }); report.rejected++; return; }
      if (item.id && byId.get(item.id)) { report.results.push({ row, ok: false, errors: [`المعرف «${item.id}» مستخدم.`] }); report.rejected++; return; }

      const id = item.id || ((item.section === 'كمي' ? 'QN-' : 'VN-') + print.slice(0, 8).toUpperCase());
      if (byId.get(id)) { report.results.push({ row, ok: false, errors: [`تعارض في المعرف المولّد ${id}.`] }); report.rejected++; return; }
      insert.run(id, item.section, item.category, passageId, item.skillId, item.skill, item.difficulty,
        item.text, JSON.stringify(item.options), item.answer, item.explanation, item.source, item.strategy,
        print, origin, authorKind, authorModel || '', actorId, at, at);
      batchPrints.set(print, id);
      report.added++;
      report.results.push({ row, ok: true, id });
    });
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return report;
}

module.exports = { importItems };
