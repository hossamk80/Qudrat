// Importing a sheet whose columns are not our template's: the layout is detected from the header,
// a section written with the definite article is understood, a subject is mapped onto the closed
// category list, and an answer given as its own value is placed by matching the options.
const assert = require('assert'), path = require('path');
const I = require('../server/items');
const { readRows } = require('./xlsx-rows.cjs');

// ---------- the reader, against the real file in the repo ----------
const rows = readRows(path.resolve(__dirname, '../dist/GAT_Import_Template.xlsx'));
assert(rows.length >= 5, 'the template was read: ' + rows.length);
const detected = I.detectProfile(rows[3]);
assert(detected && detected.name === 'gat-template-v1', 'our own template is recognised');
assert.equal(detected.score, 1, 'and matches its header exactly');

// ---------- the other layout ----------
const BANK_HEADER = ['رقم السؤال', 'القسم', 'الموضوع / المجال', 'مستوى الصعوبة', 'نص السؤال',
  'الخيار (أ)', 'الخيار (ب)', 'الخيار (ج)', 'الخيار (د)', 'الإجابة الصحيحة',
  'الشرح التفصيلي والخطوات الرياضية', 'إستراتيجية الحل السريع (اختصار قياس)'];
const bank = I.detectProfile(BANK_HEADER);
assert(bank && bank.name === 'bank-part-v1', 'the bank export layout is recognised');
assert.equal(bank.score, 1);
// the parentheses are not what distinguishes a column
assert.equal(I.detectProfile(BANK_HEADER.map(h => h.replace(/[()]/g, ''))).name, 'bank-part-v1',
  'spacing and parentheses do not decide the match');
// an unrecognisable sheet is refused rather than guessed at
assert.equal(I.detectProfile(['س', 'ص', 'ع']), null, 'a sheet in no known layout is not forced into one');
assert.equal(I.detectProfile([]), null);
// a half-matching header is not a match: the wrong profile moves the answer column
assert.equal(I.detectProfile(BANK_HEADER.slice(0, 5).concat(['x', 'y', 'z', 'w', 'v', 'u', 't'])), null,
  'a partial header match is refused');

// ---------- reading a row through it ----------
const row = ['1', 'الكمي', 'النسبة المئوية والحساب', 'سهل', 'ما هي النسبة المئوية 15% من العدد 20؟',
  '3', '8', '1', '6', '3', 'لحساب النسبة المئوية: (20 × 15) ÷ 100 = 3.', 'اضرب العدد في النسبة واقسم على 100.'];
const got = I.fromRow(row, 'bank-part-v1');
assert.equal(got.section, 'كمي', 'الكمي is the same section as كمي');
assert.equal(got.category, 'الحساب', 'the subject was mapped onto the closed list');
assert.equal(got.skillId, 'QA-PERCENT', 'and carried a skill where the subject implies one');
assert.equal(got.skill, 'النسبة المئوية والحساب', 'the subject itself is kept as the editorial note');
assert.equal(got.answer, 0, 'the answer «3» was placed by matching the options, not read as a letter');
assert.equal(got.strategy, 'اضرب العدد في النسبة واقسم على 100.', 'the quick-solution column is kept');
assert.equal(I.fromRow(['2', 'اللفظي', 'التناظر اللفظي', 'صعب', 'س : ص :: ع : ؟', 'أ', 'ب', 'ج', 'د', 'ج', 'ش', 'ا'], 'bank-part-v1').section, 'لفظي');
// a subject that implies no particular skill leaves it to the taxonomy
const analogy = I.fromRow(['3', 'اللفظي', 'التناظر اللفظي', 'صعب', 'بوصلة : اتجاه :: ميزان : ؟',
  'وزن', 'طول', 'زمن', 'حجم', 'وزن', 'العلاقة أداة وما تقيسه.', 'انظر إلى الوظيفة'], 'bank-part-v1');
assert.equal(analogy.skillId, undefined, 'the subject «التناظر اللفظي» cannot say which relation is tested');
assert.equal(I.validateItem(analogy).item.skillId, 'VA-FUNCTION', 'so the taxonomy places it from the category');
// an unmapped subject falls through and is rejected rather than invented
const odd = I.fromRow(['4', 'الكمي', 'موضوع لا نعرفه', 'سهل', 'س؟', '1', '2', '3', '4', '1', 'ش', 'ا'], 'bank-part-v1');
assert.equal(odd.category, 'موضوع لا نعرفه');
assert(!I.validateItem(odd).ok, 'an unknown subject does not become a category');

// ---------- the answer-as-value rule, which is where this layout can go wrong ----------
const amb = I.fromRow(['60', 'الكمي', 'الجبر والمعادلات', 'سهل', 'أوجد س: 2س + 30 = 32',
  '1', '3', '1', '2', '1', 'ش', 'ا'], 'bank-part-v1');
assert(amb.answerError && amb.answerError.includes('تطابق 2'), 'a value in two options identifies no key');
let v = I.validateItem(amb, { strict: true });
assert(!v.ok && v.errors.some(e => e.includes('تطابق 2')), 'and the row is refused with that reason');
const missing = I.fromRow(['61', 'الكمي', 'الجبر والمعادلات', 'سهل', 'س؟', '2', '4', '5', '7', '9', 'ش', 'ا'], 'bank-part-v1');
assert(missing.answerError.includes('لا تطابق'), 'a value in no option is a typo, and is named');
assert(!I.validateItem(missing).ok);
// matching tolerates the spelling noise the normaliser already handles
const loose = I.fromRow(['62', 'الكمي', 'النسبة المئوية والحساب', 'سهل', 'س؟',
  '١٢', '13', '14', '15', '12', 'ش', 'ا'], 'bank-part-v1');
assert.equal(loose.answer, 0, 'Arabic-Indic digits in an option still match an ASCII answer');
// and it does not tolerate a difference that matters
const signed = I.fromRow(['63', 'الكمي', 'الجبر والمعادلات', 'سهل', 'س؟',
  '-7', '7', '14', '21', '7', 'ش', 'ا'], 'bank-part-v1');
assert.equal(signed.answer, 1, 'the answer 7 is the option 7, not the option -7');

// ---------- our own template still reads as it did ----------
const old = I.fromTemplateRow(['NEW-001', 'كمي', 'الحساب', 'سهل', 'ما ناتج ٧ × ٩؟',
  '56', '63', '70', '72', 'ب', 'سبعة في تسعة = ٦٣.', 'مثال']);
assert.equal(old.answer, 'ب', 'the lettered layout passes the letter through');
assert.equal(I.validateItem(old).item.answer, 1);
assert.equal(old.source, 'مثال', 'and its last column is a source, not a strategy');
assert.equal(old.strategy, undefined);

// ---------- the profiles are coherent ----------
for (const [name, p] of Object.entries(I.PROFILES)) {
  assert.equal(p.headers.length, 12, name + ' describes twelve columns');
  assert(p.headerRow < p.firstDataRow, name + ' puts its data after its header');
  assert(['letter', 'value'].includes(p.answerAs), name + ' says how its answer is written');
  assert.equal(p.map.options.length, 4, name + ' maps four options');
  assert(p.label, name + ' has a label for the page to show');
}
for (const [topic, hit] of Object.entries(I.TOPIC_MAP)) {
  const cats = Object.values(I.CATEGORIES).flat();
  assert(cats.includes(hit.category), `${topic} maps onto a real category, not ${hit.category}`);
  if (hit.skillId) {
    assert(I.SKILL_IDS.has(hit.skillId), `${topic} maps onto a real skill`);
    const section = Object.entries(I.CATEGORIES).find(([, cs]) => cs.includes(hit.category))[0];
    assert.equal(I.SKILLS.find(s => s.id === hit.skillId).section, section,
      `${topic}: its skill and its category must belong to the same section`);
  }
}
console.log('PASS: column profiles — our template and a bank export are each detected from their header row while a partial or unknown header is refused rather than guessed; the definite article on a section, a free-text subject mapped onto the closed category list, and a quick-solution column are all handled; an answer written as its own value is placed by matching the options, with a value that matches two options or none refused by name instead of resolved; and every profile and subject mapping is checked for internal coherence.');
