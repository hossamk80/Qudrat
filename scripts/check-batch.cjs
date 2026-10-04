// Verifies an authored batch before it goes anywhere near the database.
//   node scripts/check-batch.cjs content/batch-001-quant.json [...]
// Every numeric item carries a `check` expression; it is evaluated here and must produce the
// option the key points at. An authored answer key is a claim, and this is what tests it.
const fs = require('fs'), path = require('path');
const I = require('../server/items');
const T = require('../server/taxonomy');
const bank = require('../dist/data.json');

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: check-batch.cjs <file.json> [...]'); process.exit(2); }

// Fingerprints already in the shipped bank, so a new item cannot repeat an old one.
const existing = new Map();
for (const q of bank.questions) {
  const v = I.validateItem(q);
  if (v.ok) existing.set(I.fingerprint(v.item), q.id);
}

let problems = 0, checked = 0, unchecked = 0;
const seen = new Map();
const perSkill = {};

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const items = data.items || [];
  console.log(`\n=== ${path.basename(file)} — ${items.length} سؤالًا ===`);
  items.forEach((raw, i) => {
    const where = `${path.basename(file)}#${i + 1}`;
    const { check, ...item } = raw;
    const v = I.validateItem(item, { strict: true });
    if (!v.ok) { console.log(`✗ ${where}: ${v.errors.join(' | ')}`); problems++; return; }
    if (!raw.skillId) { console.log(`✗ ${where}: بلا مهارة محددة`); problems++; return; }
    if (!T.SKILL_IDS.has(raw.skillId)) { console.log(`✗ ${where}: مهارة مجهولة ${raw.skillId}`); problems++; return; }
    if (v.item.skillId !== raw.skillId) { console.log(`✗ ${where}: المهارة تغيّرت إلى ${v.item.skillId}`); problems++; return; }

    const print = I.fingerprint(v.item);
    if (existing.has(print)) { console.log(`✗ ${where}: يطابق سؤالًا في البنك (${existing.get(print)})`); problems++; return; }
    if (seen.has(print)) { console.log(`✗ ${where}: يطابق ${seen.get(print)} في هذه الدفعة`); problems++; return; }
    seen.set(print, where);

    // the key, actually computed
    if (check) {
      let got;
      // eq, not ===: 0.75 * 0.8 is 0.6000000000000001 in binary floating point, and strict
      // equality in a check expression rejects a key that is arithmetically right.
      const eq = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;   // eslint-disable-line no-unused-vars
      try { got = eval(check); }                      // eslint-disable-line no-eval
      catch (e) { console.log(`✗ ${where}: تعبير التحقّق فشل — ${e.message}`); problems++; return; }
      const expected = v.item.options[v.item.answer];
      if (String(got) !== expected) {
        console.log(`✗ ${where}: المفتاح «${expected}» والحساب يعطي «${got}»`);
        problems++; return;
      }
      checked++;
    } else unchecked++;

    perSkill[raw.skillId] = perSkill[raw.skillId] || { صعب: 0, متوسط: 0, سهل: 0 };
    perSkill[raw.skillId][raw.difficulty]++;
  });
}

console.log('\n--- التوزيع على المهارات ---');
for (const [id, d] of Object.entries(perSkill).sort()) {
  console.log(`  ${id.padEnd(15)} صعب ${String(d['صعب']).padStart(2)} · متوسط ${String(d['متوسط']).padStart(2)} · سهل ${String(d['سهل']).padStart(2)}`);
}
const total = Object.values(perSkill).reduce((n, d) => n + d['صعب'] + d['متوسط'] + d['سهل'], 0);
console.log(`\nسليم: ${total} · مفاتيح محسوبة: ${checked} · بلا تعبير تحقّق: ${unchecked} · مشاكل: ${problems}`);
process.exitCode = problems ? 1 : 0;
