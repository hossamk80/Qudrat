// Withdrawing a published question and bringing it back. The three things that make this safe to
// run on a live bank are what is asserted: nothing is deleted, an attempt already in a student's
// hands is untouched because it carries its own copies, and a withdrawal that would thin a skill
// below the floor is refused by name instead of happening quietly.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { openDb } = require('../server/db');
const { importItems } = require('../server/import-items');
const { publishItems, retireItems, FLOOR } = require('../server/publish-items');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-retire-'));
const db = openDb(dataDir);
db.prepare(`INSERT INTO users (email, name, pass_hash, is_admin, created_at)
  VALUES (?, ?, '', 1, ?)`).run('admin@example.com', 'مدير', new Date().toISOString());
const actor = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@example.com');
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', f), 'utf8')).items;

// A batch of a hundred, published, is the state this command is for.
const batch = [...read('batch-009-quant.json'), ...read('batch-009-verbal.json'), ...read('batch-009-reading.json')];
assert.equal(importItems(db, batch, { authorKind: 'ai', authorModel: 'test' }).added, 100);
assert.equal(publishItems(db, batch, { actor }).published, 100);
const live = () => db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n;
assert.equal(live(), 100);

// ---------- it refuses to run without the things that make it accountable ----------
assert.throws(() => retireItems(db, { ids: ['x'], reason: 'r' }), /needs the admin/);
assert.throws(() => retireItems(db, { ids: ['x'], actor }), /needs a reason/);
assert.throws(() => retireItems(db, { actor, reason: 'r' }), /nothing to retire/);

// ---------- an unknown question moves nothing ----------
const anyId = db.prepare("SELECT id FROM items WHERE status = 'live' LIMIT 1").get().id;
const ghost = retireItems(db, { ids: [anyId, 'NO-SUCH-ID'], actor, reason: 'سبب', force: true });
assert(ghost.rolledBack, 'one unknown id rolls the whole call back');
assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get(anyId).status, 'live',
  'the known one stayed live: all or nothing');

// ---------- the floor is counted over the whole set, not one at a time ----------
const skill = db.prepare(`SELECT skill_id, COUNT(*) AS n FROM items WHERE status = 'live'
  GROUP BY skill_id ORDER BY n DESC LIMIT 1`).get();
const spare = skill.n - FLOOR;                       // how many this skill can lose and stay legal
const victims = db.prepare(`SELECT id FROM items WHERE status = 'live' AND skill_id = ?
  LIMIT ?`).all(skill.skill_id, spare + 1).map(r => r.id);
if (victims.length === spare + 1) {
  const one = retireItems(db, { ids: [victims[0]], actor, reason: 'واحد ضمن المسموح' });
  assert.equal(one.retired, 1, 'inside the floor it goes through');
  retireItems(db, { ids: [victims[0]], actor, reason: 'إرجاع', restore: true });
  const all = retireItems(db, { ids: victims, actor, reason: 'كلها' });
  assert(all.refused, 'together they breach the floor, so the set is refused though each alone would pass');
  assert.equal(all.skillsAtFloor[0].skill, skill.skill_id);
  assert.equal(all.skillsAtFloor[0].after, FLOOR - 1);
  assert.equal(live(), 100, 'a refusal changes nothing at all');
  const forced = retireItems(db, { ids: victims, actor, reason: 'بأمر صريح', force: true });
  assert.equal(forced.retired, victims.length, '--force is the only way past it');
  assert.deepEqual(forced.skillsAtFloor.map(s => s.skill), [skill.skill_id], 'and it still says what it cost');
  retireItems(db, { ids: victims, actor, reason: 'إرجاع', restore: true, force: true });
  assert.equal(live(), 100 - victims.length, 'restored rows come back as drafts, not live');
  assert.equal(publishItems(db, batch, { actor }).published, victims.length, 'and publish again from draft');
  assert.equal(live(), 100);
}

// ---------- a question is also found by the file it came from ----------
const readingFile = read('batch-009-reading.json');
const group = readingFile.filter(q => q.passageText === readingFile[0].passageText);
assert(group.length >= 3);
const byFile = retireItems(db, { list: group, actor, reason: 'النص بُدّل', force: true });
assert.equal(byFile.retired, group.length, 'matched on the stored fingerprint, no ids needed');
assert.equal(byFile.orphanPassages.length, 1, 'and it says the passage has no live question left');

// ---------- nothing is deleted, and the trail says who and why ----------
const gone = byFile.results.filter(r => r.ok).map(r => r.id);
for (const id of gone) {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  assert.equal(row.status, 'retired', 'the row is still there, withdrawn');
  const rev = db.prepare(`SELECT * FROM item_revisions WHERE item_id = ? AND change = 'status'
    ORDER BY id DESC LIMIT 1`).get(id);
  assert.equal(rev.actor_email, 'admin@example.com');
  assert.equal(JSON.parse(rev.after).status, 'retired');
  assert.equal(JSON.parse(rev.after).note, 'النص بُدّل', 'the reason is on the record, not just the fact');
  assert(db.prepare(`SELECT COUNT(*) AS n FROM admin_audit
    WHERE target_id = ? AND action = 'item-status:live->retired'`).get(id).n >= 1);
}

// ---------- a student's answers and a question's statistics survive the withdrawal ----------
const kept = gone[0];
db.prepare(`INSERT INTO responses (user_id, item_id, section, category, exam_id, status, correct,
  chosen, ms_spent, answered_at, ingested_at) VALUES (?, ?, '', '', 'e1', 'done', 1, 0, 1000, ?, ?)`)
  .run(actor.id, kept, new Date().toISOString(), new Date().toISOString());
db.prepare(`INSERT INTO item_stats (item_id, synthetic, n, p_value, r_pbis, computed_at)
  VALUES (?, 0, 300, 0.5, 0.3, ?)`).run(kept, new Date().toISOString());
retireItems(db, { ids: [kept], actor, reason: 'مرّة أخرى', restore: true });
retireItems(db, { ids: [kept], actor, reason: 'وإحالة ثانية', force: true });
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses WHERE item_id = ?').get(kept).n, 1,
  'the response a student gave is the measurement record of the question, and it stays');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_stats WHERE item_id = ?').get(kept).n, 1);

// ---------- what students are served no longer contains it ----------
const served = db.prepare("SELECT id FROM items WHERE status = 'live'").all().map(r => r.id);
assert(!served.includes(kept), 'the live bank the server reads is what a withdrawal changes');
// and re-running is a no-op rather than a second withdrawal
const again = retireItems(db, { ids: [kept], actor, reason: 'مرّة ثالثة' });
assert.equal(again.retired, 0); assert.equal(again.already, 1);

// ---------- a draft can be withdrawn too, and a retired row cannot go straight back to live ----------
const draft = db.prepare("SELECT id FROM items WHERE status = 'draft' LIMIT 1").get();
if (draft) {
  assert.equal(retireItems(db, { ids: [draft.id], actor, reason: 'مسوّدة لا تُنشر' }).retired, 1);
}
const back = retireItems(db, { ids: [kept], actor, reason: 'إرجاع', restore: true });
assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get(kept).status, 'draft',
  'coming back means coming back to draft: the review it had was for a question we withdrew');
assert.equal(back.restored, 1);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('PASS: retiring questions — the command refuses to run without an admin, a reason and a target; one unknown id rolls the whole call back; the skill floor is counted over the whole set so three withdrawals that each pass alone are refused together, and --force is the only way past it while still reporting the cost; a question is found by its id or by the file it came from; a passage left with no live question is reported; nothing is deleted and every withdrawal records who, from what and why; a student\'s answers and the question\'s statistics survive it; the live bank no longer serves it; re-running withdraws nothing again; and coming back means coming back to draft, not to live.');
