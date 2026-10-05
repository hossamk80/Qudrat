'use strict';
// Admin commands run on the server machine:
//   node server/cli.js make-admin <email>
//   node server/cli.js reset-password <email> <new-password>
//   node server/cli.js list
//   node server/cli.js backup <file>
//   node server/cli.js migrate-bank [--dry-run]
//   node server/cli.js backfill-skills
//   node server/cli.js split-passages
//   node server/cli.js import-items <file.json> [more.json ...] [--model <name>]
//   node server/cli.js publish-items <file.json> [more.json ...] --actor <admin-email> [--to reviewed] [--note "..."]
//   node server/cli.js audit-xlsx <file.xlsx> [more.xlsx ...]      (read-only, no writes)
//   node server/cli.js import-xlsx <file.xlsx> --source "..." [--model <name>] [--profile <id>]
//   node server/cli.js calibrate [--synthetic]
//   node server/cli.js simulate-responses [--students N] [--seed S]   (synthetic, for testing only)
//   node server/cli.js skills
const path = require('node:path');
const { openDb } = require('./db');
const { hashPassword, loadConfig } = require('./server');
const { migrateBank, backfillSkillIds, splitPassages } = require('./migrate-bank');

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  const db = openDb(loadConfig().dataDir);
  const user = email => {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!u) { console.error('No user with email', email); process.exit(1); }
    return u;
  };
  if (cmd === 'make-admin') {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user(a).id);
    console.log(a, 'is now an admin. Admin page: /admin.html');
  } else if (cmd === 'reset-password') {
    if (!b || b.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
    const u = user(a);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(b), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log('Password reset for', a);
  } else if (cmd === 'list') {
    for (const u of db.prepare('SELECT id, email, name, created_at, last_login, is_admin, disabled FROM users ORDER BY id').all()) console.log(u);
  } else if (cmd === 'backup') {
    if (!a) { console.error('Usage: backup <file>'); process.exit(1); }
    db.exec(`VACUUM INTO '${path.resolve(a).replace(/'/g, "''")}'`);
    console.log('Backup written to', path.resolve(a));
  } else if (cmd === 'migrate-bank') {
    const dryRun = process.argv.includes('--dry-run');
    const bank = require('../dist/data.json');
    const r = migrateBank(db, bank, { dryRun });
    console.log(`${dryRun ? '[dry run] ' : ''}bank: ${r.total} questions`);
    console.log(`  ${dryRun ? 'would migrate' : 'migrated'}: ${r.migrated}`);
    console.log(`  already present: ${r.skipped}`);
    if (r.duplicates.length) {
      console.log(`  duplicates inside the bank, first kept: ${r.duplicates.length}`);
      for (const d of r.duplicates) console.log(`    ${d.id} is the same question as ${d.sameAs}`);
    }
    if (r.invalid.length) {
      console.log(`  rejected by the validator: ${r.invalid.length}`);
      for (const x of r.invalid) console.log(`    ${x.id}: ${x.errors.join(' | ')}`);
      process.exitCode = 1;   // a bank that no longer validates is a failure, not a warning
    }
  } else if (cmd === 'backfill-skills') {
    const r = backfillSkillIds(db);
    console.log(`examined ${r.examined} items without a skill, filled ${r.filled}`);
    if (r.unresolved.length) { console.log('unresolved:', r.unresolved.join(', ')); process.exitCode = 1; }
  } else if (cmd === 'split-passages') {
    const r = splitPassages(db);
    console.log(`examined ${r.examined} reading items with an inline passage`);
    console.log(`  split: ${r.split}, new passages: ${r.passages}`);
    if (r.unsplit.length) { console.log('  no passage found in:', r.unsplit.join(', ')); process.exitCode = 1; }
  } else if (cmd === 'import-items') {
    // Goes through the same gateway an upload does: the shared validator, the duplicate
    // fingerprint, the passage table, and draft as the only landing state. Authored by a
    // model, so author_kind is 'ai' and nothing here can publish — a human reviews first.
    const files = process.argv.slice(3).filter(x => /\.json$/i.test(x));
    if (!files.length) { console.error('Usage: import-items <file.json> [more.json ...] [--model <name>]'); process.exit(1); }
    const flag = process.argv.indexOf('--model');
    const model = flag > -1 ? String(process.argv[flag + 1] || '') : 'claude-opus-5';
    if (!model) { console.error('--model needs a name: an AI-authored item records what wrote it.'); process.exit(1); }
    const list = files.flatMap(f => JSON.parse(require('node:fs').readFileSync(path.resolve(f), 'utf8')).items);
    const { importItems } = require('./import-items');
    const r = importItems(db, list, { authorModel: model });
    console.log(`${r.added} added as drafts, ${r.rejected} rejected, ${r.passages} new passages`);
    for (const x of r.results.filter(y => !y.ok)) console.log(`  #${x.row}: ${(x.errors || []).join(' | ')}`);
    if (r.rejected) process.exitCode = 1;
  } else if (cmd === 'publish-items') {
    // The other side of import-items: that one can only create drafts, this one is how a
    // human's decision gets onto the record. It needs an admin to name, runs the same strict
    // re-check the publish route runs, and rolls the whole batch back if any question fails.
    // Several files in one call, because a batch of a hundred lives in three of them and the
    // all-or-nothing promise is worth nothing if a third of it can publish alone.
    const files = process.argv.slice(3).filter(x => /\.json$/i.test(x));
    if (!files.length) { console.error('Usage: publish-items <file.json> [more.json ...] --actor <admin-email> [--to reviewed] [--note "..."]'); process.exit(1); }
    const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? String(process.argv[i + 1] || '') : ''; };
    const email = arg('--actor');
    if (!email) { console.error('--actor needs the email of the admin approving this batch: the human review has to be attributable.'); process.exit(1); }
    const actor = user(email);
    const adminEmails = loadConfig().adminEmails;
    if (!(actor.is_admin === 1 || adminEmails.has(actor.email.toLowerCase()))) {
      console.error(`${actor.email} is not an admin. Use: node server/cli.js make-admin ${actor.email}`); process.exit(1);
    }
    const to = arg('--to') || 'live';
    const list = files.flatMap(f => JSON.parse(require('node:fs').readFileSync(path.resolve(f), 'utf8')).items);
    const { publishItems } = require('./publish-items');
    const r = publishItems(db, list, { actor, to, note: arg('--note') });
    console.log(`${files.length} file(s), ${list.length} question(s): ${r.reviewed} marked reviewed, ${r.published} published live, ${r.already} already ${to}`);
    if (r.rolledBack) {
      console.log(`ROLLED BACK — nothing changed. missing: ${r.missing}, failed: ${r.failed}`);
      for (const x of r.results.filter(y => !y.ok)) console.log(`  #${x.row}${x.id ? ' ' + x.id : ''}: ${x.error}`);
      process.exitCode = 1;
    } else {
      console.log(`approved by ${actor.email} — recorded in items.reviewed_by, item_revisions and admin_audit`);
    }
  } else if (cmd === 'audit-xlsx') {
    // Read-only. Measures a set of sheets before any of them is imported: how many rows are
    // valid, how many repeat inside their own file, and — the one that only shows across a set —
    // how many repeat a question from an earlier file. Writes nothing anywhere.
    const items = require('./items');
    const { readRows } = require('../scripts/xlsx-rows.cjs');
    const files = process.argv.slice(3).filter(x => /\.xlsx$/i.test(x));
    if (!files.length) { console.error('Usage: audit-xlsx <file.xlsx> [more.xlsx ...]'); process.exit(1); }
    const seen = new Map();                 // fingerprint -> "file#question"
    const bankPrints = new Map();
    for (const row of db.prepare('SELECT id, fingerprint FROM items').all()) bankPrints.set(row.fingerprint, row.id);
    const totals = { rows: 0, valid: 0, invalid: 0, inFile: 0, acrossFiles: 0, inBank: 0 };
    const reasons = {};
    console.log(`auditing ${files.length} file(s) against ${bankPrints.size} items already in the bank\n`);
    for (const f of files) {
      const rows = readRows(path.resolve(f));
      const found = items.detectProfile(rows[3]);
      if (!found) { console.log(`${path.basename(f)}: UNKNOWN LAYOUT — skipped`); continue; }
      const body = rows.slice(found.profile.firstDataRow - 1).filter(r => !items.isBlankRow(r));
      const stat = { rows: body.length, valid: 0, invalid: 0, inFile: 0, acrossFiles: 0, inBank: 0 };
      const here = new Set();
      body.forEach((r, i) => {
        const raw = items.fromRow(r, found.name);
        raw.source = raw.source || 'audit';
        const v = items.validateItem(raw);
        const label = `${path.basename(f)}#${r[found.profile.map.number ?? found.profile.map.id] || i + 1}`;
        if (!v.ok) {
          stat.invalid++;
          for (const e of v.errors) { const k = e.replace(/«[^»]*»/g, '«…»'); reasons[k] = (reasons[k] || 0) + 1; }
          return;
        }
        const print = items.fingerprint(v.item);
        if (bankPrints.has(print)) { stat.inBank++; return; }
        if (here.has(print)) { stat.inFile++; return; }
        here.add(print);
        if (seen.has(print)) { stat.acrossFiles++; return; }
        seen.set(print, label);
        stat.valid++;
      });
      for (const k of Object.keys(stat)) totals[k] += stat[k];
      const pct = stat.rows ? Math.round((stat.valid / stat.rows) * 100) : 0;
      console.log(`${path.basename(f).padEnd(34)} ${String(stat.rows).padStart(5)} rows → ` +
        `${String(stat.valid).padStart(5)} new (${String(pct).padStart(3)}%)  ` +
        `dup-in-file ${String(stat.inFile).padStart(4)}  dup-across ${String(stat.acrossFiles).padStart(4)}  ` +
        `in-bank ${String(stat.inBank).padStart(4)}  invalid ${String(stat.invalid).padStart(4)}`);
    }
    console.log('\n' + '-'.repeat(70));
    console.log(`rows: ${totals.rows}`);
    console.log(`distinct new questions: ${totals.valid}  (${totals.rows ? Math.round(totals.valid / totals.rows * 100) : 0}% yield)`);
    console.log(`duplicate inside its own file: ${totals.inFile}`);
    console.log(`duplicate of an earlier file:  ${totals.acrossFiles}`);
    console.log(`already in the bank:           ${totals.inBank}`);
    console.log(`rejected by validation:        ${totals.invalid}`);
    if (Object.keys(reasons).length) {
      console.log('\nreasons for rejection:');
      for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)} × ${k}`);
    }
  } else if (cmd === 'import-xlsx') {
    // Reads a sheet, detects which column layout it uses, and brings it in through the same gate.
    // A rejected row is never repaired here: changing a question's options or key without the
    // author seeing it is how a bank quietly acquires wrong answers. They are written to a report.
    if (!a) { console.error('Usage: import-xlsx <file.xlsx> --source "..." [--model <name>] [--profile <id>]'); process.exit(1); }
    const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || '') : ''; };
    const items = require('./items');
    const { readRows } = require('../scripts/xlsx-rows.cjs');
    const rows = readRows(path.resolve(a));
    const forced = arg('--profile');
    const detected = forced && items.PROFILES[forced]
      ? { name: forced, profile: items.PROFILES[forced], score: 1 }
      : items.detectProfile(rows[(items.PROFILES[forced] || items.PROFILES['gat-template-v1']).headerRow - 1] || rows[3]);
    if (!detected) {
      console.error('Could not recognise the column layout. Known profiles:',
        Object.keys(items.PROFILES).join(', '));
      process.exit(1);
    }
    console.log(`profile: ${detected.name} (${detected.profile.label}) — header match ${Math.round(detected.score * 100)}%`);
    const source = arg('--source');
    if (!source && !Number.isInteger(detected.profile.map.source)) {
      console.error('This layout has no source column, so --source is required: a published item must document its origin.');
      process.exit(1);
    }
    const body = rows.slice(detected.profile.firstDataRow - 1).filter(r => !items.isBlankRow(r));
    const converted = body.map((r, i) => {
      const raw = items.fromRow(r, detected.name);
      if (source && !String(raw.source || '').trim()) raw.source = source;
      return { raw, row: detected.profile.firstDataRow + i, label: String(r[detected.profile.map.number ?? detected.profile.map.id] || '') };
    });
    const { importItems } = require('./import-items');
    const model = arg('--model') || 'claude-opus-5';
    const r = importItems(db, converted.map(c => c.raw), { authorModel: model, authorKind: 'human', origin: 'excel' });
    console.log(`${r.added} added as drafts, ${r.rejected} rejected, ${r.passages} new passages`);
    const rejects = r.results.filter(x => !x.ok).map(x => ({
      sheetRow: converted[x.row - 1].row,
      question: converted[x.row - 1].label,
      reasons: x.errors,
      options: converted[x.row - 1].raw.options,
      answer: converted[x.row - 1].raw.answer ?? null,
    }));
    if (rejects.length) {
      const out = path.resolve(a).replace(/\.xlsx$/i, '') + '-rejects.json';
      require('node:fs').writeFileSync(out, JSON.stringify({ file: path.basename(a), profile: detected.name, rejects }, null, 2));
      console.log(`rejected rows written to ${out}`);
      for (const x of rejects.slice(0, 20)) {
        console.log(`  سؤال ${x.question} (صف ${x.sheetRow}): ${x.reasons.join(' | ')}`);
      }
      if (rejects.length > 20) console.log(`  … و${rejects.length - 20} غيرها في التقرير`);
    }
  } else if (cmd === 'calibrate') {
    const { calibrateBank, MIN_RESPONSES } = require('./calibration');
    const synthetic = process.argv.includes('--synthetic');
    const r = calibrateBank(db, { synthetic });
    if (r.synthetic) console.log('*** بيانات اصطناعية — هذه الأرقام لا تصف طلابًا حقيقيين ***');
    console.log(`population: ${r.synthetic ? 'SYNTHETIC' : 'real'} · ${r.responses} responses from ${r.students} students`);
    console.log(`items: ${r.items} · calibrated (n>=${MIN_RESPONSES}): ${r.calibrated} · insufficient: ${r.insufficient} · flagged: ${r.flagged}`);
    const worst = r.stats.filter(s2 => s2.flags.length).sort((x, y) => (x.rPbis ?? 9) - (y.rPbis ?? 9)).slice(0, 15);
    for (const s2 of worst) {
      console.log(`  ${s2.itemId.padEnd(14)} n=${String(s2.n).padStart(4)} p=${s2.pValue} r=${s2.rPbis}  ${s2.flags.join(', ')}`);
    }
    if (!r.items) console.log('  لا توجد إجابات في هذه المجموعة بعد.');
  } else if (cmd === 'simulate-responses') {
    // Writes synthetic rows only, marked as such. It exists so the calibration arithmetic can be
    // tested without waiting for students; it is not a stand-in for them.
    const { simulateResponses, writeSynthetic } = require('./simulate');
    const num = n => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : undefined; };
    const students = num('--students') || 400;
    const seed = num('--seed') || 20261005;
    const live = db.prepare("SELECT id, answer FROM items WHERE status = 'live' ORDER BY id").all();
    if (!live.length) { console.error('No live items to simulate against. Run migrate-bank first.'); process.exit(1); }
    // parameters drawn from the editorial difficulty, so the shape is plausible; they are invented
    const diff = db.prepare("SELECT id, difficulty FROM items WHERE status = 'live'").all();
    const bFor = Object.fromEntries(diff.map(d => [d.id, d.difficulty === 'صعب' ? 1 : d.difficulty === 'متوسط' ? 0 : -1]));
    const spec = live.map((it, i) => ({ id: it.id, a: 0.8 + ((i % 7) / 10), b: bFor[it.id] ?? 0, key: it.answer }));
    const { rows } = simulateResponses(spec, { students, seed });
    const written = writeSynthetic(db, rows);
    console.log('*** بيانات اصطناعية في جدول synthetic_responses المستقل — لا تُقرأ كأنها إجابات طلاب ***');
    console.log(`wrote ${written} synthetic responses for ${students} simulated students over ${spec.length} items (seed ${seed}).`);
    console.log('next: node server/cli.js calibrate --synthetic');
  } else if (cmd === 'skills') {
    const { SKILLS } = require('./taxonomy');
    const counts = Object.fromEntries(db.prepare(
      "SELECT skill_id, COUNT(*) AS n FROM items WHERE status = 'live' GROUP BY skill_id").all()
      .map(r => [r.skill_id, r.n]));
    let thin = 0;
    for (const sk of SKILLS) {
      const n = counts[sk.id] || 0;
      if (n < 25) thin++;
      console.log(`${n < 25 ? '!' : ' '} ${String(n).padStart(4)}  ${sk.id.padEnd(14)} ${sk.label}`);
    }
    const missing = Object.keys(counts).filter(id => id && !SKILLS.some(s => s.id === id));
    if (missing.length) console.log('unknown skill ids in the table:', missing.join(', '));
    console.log(`\n${SKILLS.length} skills; ${thin} under 25 live items (a skill under 25 cannot be measured).`);
  } else {
    console.log('Commands: make-admin <email> | reset-password <email> <password> | list | backup <file> | migrate-bank [--dry-run] | backfill-skills | split-passages | import-items <file...> | publish-items <file...> --actor <email> | audit-xlsx <files...> | import-xlsx <file> | calibrate [--synthetic] | simulate-responses | skills');
  }
  db.close();
})();
