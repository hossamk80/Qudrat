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
const seenStems = new Map();
const sameAnswerSets = new Map(); // skill+options+key -> where, for the twin REPORT below
const twins = [];   // normalized stem -> option sets already seen, for the twin rule
const perLetter = {};
// A number the explanation offers as the origin of a WRONG CHOICE: 'يعطي ٩٦'، '٣٠٠ ناتج كذا'.
// Such a number has to be one of the options, or the sentence points the student at a choice that
// is not there. This is narrower than 'any number the explanation mentions': an explanation may
// legitimately name the result of a bad method while saying it is not the answer — 'إضافة ١٢٪ إلى
// ٤٤٠ تعطي ٤٩٢٫٨ وهي ليست الطريقة الصحيحة' teaches something and misleads nobody. No regex can
// tell the two apart, so the rule covers the attributing phrasings only and review covers the rest.
const WRONG_RESULT = /(?:يعطي|فيكون الناتج|يُعطي)\s+([٠-٩\d][٠-٩\d٫.,/]*\s*[^\s،.]{0,6})|و([٠-٩\d][٠-٩\d٫.,/]*)\s+ناتج/g;
// Bare numeric value of a string, ignoring any unit, or null when it holds no numeral.
function numeralOf(value) {
  const m = /([٠-٩\d]+(?:٫[٠-٩\d]+)?(?:\/[٠-٩\d]+)?)/.exec(String(value));
  if (!m) return null;
  const digits = [...m[1]].map((c) => (c >= '٠' && c <= '٩' ? String(c.charCodeAt(0) - 0x0660) : c)).join('').replace('٫', '.');
  if (digits.includes('/')) { const [a, b] = digits.split('/'); return Number(a) / Number(b); }
  return Number(digits);
}
// A ratio written 'أ : ب', in lowest terms, or null when the option is not one.
const RATIO = /^([٠-٩\d]+)\s*:\s*([٠-٩\d]+)$/;
function ratioValue(option) {
  const m = RATIO.exec(String(option).trim());
  if (!m) return null;
  const n = (d) => Number([...d].map((c) => (c >= '٠' && c <= '٩' ? String(c.charCodeAt(0) - 0x0660) : c)).join(''));
  let [a, b] = [n(m[1]), n(m[2])];
  if (!b) return null;
  const g = (x, y) => (y ? g(y, x % y) : x);
  const d = g(a, b) || 1;
  return (a / d) + ':' + (b / d);
}
// Consonant skeleton of an Arabic word: diacritics, the article, the weak letters and the common
// affixes dropped. Deliberately crude — it is only compared for exact equality, so a near miss
// says nothing and only two words built on the same root collide.
const ROOT_ECHO_SKILLS = new Set(['VC-LEXICAL', 'VC-CONTEXT', 'VA-SEMANTIC', 'VA-FUNCTION', 'VA-AGENT', 'VA-ORDER', 'VO-CLASS']);
function skeleton(word) {
  let w = String(word).replace(/[\u064B-\u0652\u0670]/g, '').replace(/[«».,!?؟،:؛()]/g, '');
  w = w.replace(/^(?:وال|فال|بال|كال|ال|لل)/, '').replace(/^[وفبلكمتيسن]/, '');
  w = w.replace(/(?:ات|ين|ون|ها|هم|كم|نا|ة|ه|ًا)$/, '');
  return w.replace(/[اأإآىيوءئؤ]/g, '');
}
function rootEcho(key, stem) {
  const k = skeleton(key);
  if (k.length < 3) return null;
  for (const word of String(stem).split(/\s+/)) {
    if (skeleton(word) === k && word.replace(/[«».,!?؟،:؛()]/g, '') !== String(key)) return word;
  }
  return null;
}
const POSITIONAL = /(?:البديل|الخيار|العنوان|البديلان|العنوانان|الخيارين)\s*(?:الأول|الثاني|الثالث|الرابع)|الثلاثة\s+(?:الأولى|الأخرى|الأخيرة)/;
const LETTER = /\p{Script=Arabic}/u;
// Occurrences of `word` in `text` as a word of its own: Arabic has no \b, so the character
// after it must not be a letter ('عنصر' must not match inside 'عنصري'), while before it only a
// prefix that attaches in Arabic is allowed ('لتقصيره' does carry the word 'تقصيره').
const PREFIX = /^(?:[وفبلك]|ال|وال|فال|بال|كال|لل)$/;
function countWord(text, word) {
  const t = String(text); const w = String(word); let n = 0;
  for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + 1)) {
    if (LETTER.test(t[i + w.length] || ' ')) continue;
    let j = i; while (j > 0 && LETTER.test(t[j - 1])) j--;
    if (j === i || PREFIX.test(t.slice(j, i))) n++;
  }
  return n;
}
// A bare numeral, optionally followed by a unit that carries no digits and no arithmetic
// operator — so '٧٠ كم/س' and '٢٥٪' parse, while '٨ ÷ ٠٫٥' and 'زيادة ١٠٪' are left alone. The
// unit may hold a slash, since the numeral is anchored at the start and cannot be confused with it.
const NUMERIC = /^([٠-٩\d]+(?:٫[٠-٩\d]+)?(?:\/[٠-٩\d]+)?)\s*([^\d٠-٩×÷+\-−*()=]*)$/;
function numericValue(option) {
  const m = NUMERIC.exec(String(option).trim());
  if (!m) return null;
  const digits = [...m[1]].map((c) => (c >= '٠' && c <= '٩' ? String(c.charCodeAt(0) - 0x0660) : c)).join('').replace('٫', '.');
  const unit = m[2].replace(/\s+/g, '');
  if (digits.includes('/')) { const [a, b] = digits.split('/'); return { value: Number(a) / Number(b), unit }; }
  return { value: Number(digits), unit };
}
const perCompare = {};
const perRank = {};
// dist/qiyas.js — the one order a comparison item is ever presented in.
const COMPARISON_ORDER = ['القيمة الأولى أكبر', 'القيمة الثانية أكبر', 'القيمتان متساويتان', 'المعطيات غير كافية'];

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

    // An explanation that points at a position ('البديل الثاني', 'الثلاثة الأولى') is wrong the
    // moment learn.js shuffles the options at delivery, so it must name the option's text instead.
    if (POSITIONAL.test(raw.explanation)) {
      console.log(`✗ ${where}: الشرح يحيل إلى موضع الخيار لا إلى نصّه`); problems++; return;
    }
    // In the two 'pick the word that does not belong' skills the options are words from the stem,
    // so a key appearing twice leaves the student guessing which occurrence is the wrong one.
    if (raw.skillId === 'VE-FACT' || raw.skillId === 'VE-CONTRADICT') {
      const k = v.item.options[v.item.answer];
      const hits = countWord(raw.text, k);
      if (hits !== 1) {
        console.log(`✗ ${where}: المفتاح «${k}» يرد ${hits} مرة في الجذع`); problems++; return;
      }
    }

    // An explanation that blames a wrong answer on a number nobody can choose teaches nothing
    // and reads as a slip: every value it presents as the result of an error must be an option.
    for (const m of String(raw.explanation).matchAll(WRONG_RESULT)) {
      const n = numeralOf(m[1] || m[2]);
      if (n === null) continue;
      if (!v.item.options.some((o) => numeralOf(o) === n)) {
        console.log(`✗ ${where}: الشرح ينسب الناتج «${m[1] || m[2]}» إلى خطأ وهو ليس بين الخيارات`); problems++; return;
      }
    }

    // Option length survives the shuffle that hides every position cue, so a key that is plainly
    // the longest option is the one cue a student can use on the delivered question. Measured on
    // the first five batches it held in 53 items, the key running 49% longer than its nearest rival.
    const lens = v.item.options.map((o) => String(o).length);
    const rival = Math.max(...lens.filter((_, j) => j !== v.item.answer));
    if (lens[v.item.answer] >= 15 && lens[v.item.answer] >= rival * 1.2) {
      console.log(`✗ ${where}: المفتاح أطول من أطول منافسيه بـ${Math.round(100 * lens[v.item.answer] / rival - 100)}٪`);
      problems++; return;
    }
    // A key that is the only multi-word option is a cue a student can use without reading the
    // stem, and a distractor that is numerically equal to the key makes two options correct.
    const words = v.item.options.map((o) => String(o).trim().split(/\s+/).length);
    const key = v.item.answer;
    if (words[key] > 1 && words.every((w, i) => i === key || w === 1)) {
      console.log(`✗ ${where}: المفتاح هو الخيار الوحيد المركّب من أكثر من كلمة`); problems++; return;
    }
    const nums = v.item.options.map(numericValue);
    const quantities = nums.map((n) => (n === null ? null : n.value + '\u0000' + n.unit));
    if (nums.every((n) => n !== null) && new Set(quantities).size < quantities.length) {
      console.log(`✗ ${where}: خيارات متساوية القيمة العددية`); problems++; return;
    }

    // A ratio is not a number our reader parses, so '١ : ٣' and '٣ : ٩' slip past the rule above
    // while being one and the same ratio: a student who sees they are equal eliminates both and
    // the item is left with two options. Compared in lowest terms, which is what a ratio means.
    const ratios = v.item.options.map(ratioValue);
    if (ratios.every((r) => r !== null) && new Set(ratios).size < ratios.length) {
      console.log(`✗ ${where}: خياران يعبّران عن نسبة واحدة`); problems++; return;
    }
    // A key that shares its root with a word in the stem can be picked by matching letters without
    // reading the sentence. In VE-FACT and VE-CONTRADICT the key IS a word of the stem by design,
    // and in reading the answer is a sentence drawing on the passage's own words, so this applies
    // to the one-word-option skills where the echo is a giveaway and nothing else.
    // The echo only hands over the answer when the key alone carries it: in 'خبّاز : ؟' both خبز
    // and مخبز answer the letters, so matching them decides nothing and the item still asks for
    // the relation.
    if (ROOT_ECHO_SKILLS.has(raw.skillId) && words[key] === 1) {
      const echo = rootEcho(v.item.options[key], v.item.text);
      const shared = v.item.options.some((o, i) => i !== key && String(o).trim().split(/\s+/).length === 1
        && rootEcho(o, v.item.text));
      if (echo && !shared) {
        console.log(`✗ ${where}: المفتاح وحده يشارك الجذع جذره («${echo}»)`); problems++; return;
      }
    }

    // Two questions with one stem and three of four options in common are the same question with
    // a word swapped: the fingerprint does not see it, because an option's wording is part of the
    // hash, and the duplicate rule above compares whole option sets. What this catches is a bank
    // padded by variation rather than grown — and, in the worst case, one question asked twice
    // with the same key, which is how it turned up: نَجّار : كُرسيّ :: خَيّاط : ثَوب, twice.
    // syncItems already treats this overlap as identity when it matches a stored row, so a bank
    // that holds such a pair cannot be edited by file at all.
    {
      const norm = v.item.options.map((o) => I.normalizeText(o));
      const want = new Set(norm);
      const stem = I.normalizeText(v.item.text) + '\u0000' + I.normalizeText(v.item.passageText || '');
      const twin = (seenStems.get(stem) || []).find((prev) => prev.options.filter((o) => want.has(o)).length >= 3);
      if (twin) {
        console.log(`✗ ${where}: يشارك «${twin.where}» الجذعَ وثلاثةً من خياراته`); problems++; return;
      }
      if (!seenStems.has(stem)) seenStems.set(stem, []);
      seenStems.get(stem).push({ options: norm, where });
    }

    // Same skill, same four options, same key, different stem: usually two different questions
    // that happen to offer the same numbers — 5 of the 11 pairs in the bank are exactly that —
    // but the other 6 are one question asked twice in different words, which no text comparison
    // can tell apart from a coincidence. So this is reported for review, never rejected: a gate
    // that is wrong two times in five is a gate nobody trusts.
    {
      // Comparison items all carry COMPARISON_ORDER by design, so every two of them that share an
      // answer type would collide: they are the one family this says nothing about.
      const opts = v.item.options.map((o) => I.normalizeText(o));
      const isCompare = COMPARISON_ORDER.every((o) => v.item.options.includes(o));
      const sig = isCompare ? null : raw.skillId + '|' + [...opts].sort().join('~') + '|' + opts[v.item.answer];
      if (sig && sameAnswerSets.has(sig)) twins.push([sameAnswerSets.get(sig), where]);
      else if (sig) sameAnswerSets.set(sig, where);
    }

    // qiyas.js forces comparison items into COMPARISON_ORDER at delivery, so their stored order
    // must match it and their key position is decided by content, not by us: they are checked for
    // that order and left out of the balance below, which would otherwise be meaningless for them.
    if (COMPARISON_ORDER.every((o) => v.item.options.includes(o))) {
      if (v.item.options.join('\u0000') !== COMPARISON_ORDER.join('\u0000')) {
        console.log(`✗ ${where}: خيارات المقارنة خارج الترتيب المعياري`); problems++; return;
      }
      perCompare[v.item.options[v.item.answer]] = (perCompare[v.item.options[v.item.answer]] || 0) + 1;
    } else if (nums.every((n) => n !== null) && nums.every((n, j) => j === 0 || nums[j - 1].value <= n.value)) {
      // Ordered ascending: the key sits where its value puts it, so this is a fact about the
      // distractor values, not a layout choice. Reported, never counted as imbalance.
      perRank[v.item.answer + 1] = (perRank[v.item.answer + 1] || 0) + 1;
    } else perLetter[raw.answer] = (perLetter[raw.answer] || 0) + 1;
    perSkill[raw.skillId] = perSkill[raw.skillId] || { صعب: 0, متوسط: 0, سهل: 0 };
    perSkill[raw.skillId][raw.difficulty]++;
  });
}

// A test-wise bias in where the key sits is a cue a student can learn. learn.js shuffles the
// options at delivery, so the bias never reaches a student through the app — but data that only
// looks sound because one layer hides it is data that breaks the moment that layer moves.
const LETTERS = ['أ', 'ب', 'ج', 'د'];
const n = LETTERS.reduce((a, l) => a + (perLetter[l] || 0), 0);
if (n >= 40) {
  const exp = n / 4;
  const chi = LETTERS.reduce((a, l) => a + ((perLetter[l] || 0) - exp) ** 2 / exp, 0);
  const line = LETTERS.map((l) => `${l}: ${perLetter[l] || 0}`).join(' · ');
  // 11.34 is the 0.99 point of the chi-square distribution with 3 degrees of freedom.
  if (chi > 11.34) { console.log(`✗ موضع الجواب منحاز (${line}، كا²=${chi.toFixed(1)})`); problems++; }
  else console.log(`موضع الجواب متوازن — ${line} (كا²=${chi.toFixed(1)})`);
}

if (Object.keys(perRank).length) {
  const n = [1, 2, 3, 4].reduce((a, r) => a + (perRank[r] || 0), 0);
  console.log('مجموعات عددية مرتّبة تصاعديًّا: ' + n + ' · رتبة المفتاح فيها ' +
    [1, 2, 3, 4].map((r) => `${r}: ${Math.round(100 * (perRank[r] || 0) / n)}٪`).join(' · ') +
    ' — مشتّت يحيط بالمفتاح من جهتيه يجعله في الوسط، وهو تصميم أضعف من مشتّت مشتقّ من خطأ بعينه.');
}

if (Object.keys(perCompare).length) {
  console.log('أسئلة المقارنة — نوع الجواب: ' + COMPARISON_ORDER.map((o) => `${o}: ${perCompare[o] || 0}`).join(' · '));
}

console.log('\n--- التوزيع على المهارات ---');
for (const [id, d] of Object.entries(perSkill).sort()) {
  console.log(`  ${id.padEnd(15)} صعب ${String(d['صعب']).padStart(2)} · متوسط ${String(d['متوسط']).padStart(2)} · سهل ${String(d['سهل']).padStart(2)}`);
}
const total = Object.values(perSkill).reduce((n, d) => n + d['صعب'] + d['متوسط'] + d['سهل'], 0);
if (twins.length) {
  console.log(`\nيُراجَع: ${twins.length} زوجًا من الأسئلة تَشترك في المهارة والخيارات الأربعة والمفتاح، وتَختلف جذوعها —` +
    ' بعضها مسألتان مختلفتان تَصادفت خياراتهما، وبعضها سؤالٌ واحد بلفظين. لا يُرفض شيء، والحكم للمراجعة:');
  for (const [a, b] of twins) console.log(`  ${a}  ≈  ${b}`);
}
console.log(`\nسليم: ${total} · مفاتيح محسوبة: ${checked} · بلا تعبير تحقّق: ${unchecked} · مشاكل: ${problems}`);
process.exitCode = problems ? 1 : 0;
