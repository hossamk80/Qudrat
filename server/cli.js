'use strict';
// Admin commands run on the server machine:
//   node server/cli.js make-admin <email>
//   node server/cli.js reset-password <email> <new-password>
//   node server/cli.js list
//   node server/cli.js backup <file>
//   node server/cli.js migrate-bank [--dry-run]
//   node server/cli.js backfill-skills
//   node server/cli.js split-passages
//   node server/cli.js import-items <file.json> [--model <name>]
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
    if (!a) { console.error('Usage: import-items <file.json> [--model <name>]'); process.exit(1); }
    const flag = process.argv.indexOf('--model');
    const model = flag > -1 ? String(process.argv[flag + 1] || '') : 'claude-opus-5';
    if (!model) { console.error('--model needs a name: an AI-authored item records what wrote it.'); process.exit(1); }
    const { items: list } = JSON.parse(require('node:fs').readFileSync(path.resolve(a), 'utf8'));
    const { importItems } = require('./import-items');
    const r = importItems(db, list, { authorModel: model });
    console.log(`${r.added} added as drafts, ${r.rejected} rejected, ${r.passages} new passages`);
    for (const x of r.results.filter(y => !y.ok)) console.log(`  #${x.row}: ${(x.errors || []).join(' | ')}`);
    if (r.rejected) process.exitCode = 1;
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
    console.log('Commands: make-admin <email> | reset-password <email> <password> | list | backup <file> | migrate-bank [--dry-run] | backfill-skills | split-passages | import-items <file> | skills');
  }
  db.close();
})();
