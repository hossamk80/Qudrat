'use strict';
// The single gate every question passes through, whoever wrote it: the admin by hand,
// a spreadsheet upload, or a model. One schema, one validator, one fingerprint. Adding
// a second path that skips this file is how a bank ends up with three truths.
const crypto = require('node:crypto');
const taxonomy = require('./taxonomy');

const SECTIONS = ['لفظي', 'كمي'];
const DIFFICULTIES = ['سهل', 'متوسط', 'صعب'];
const STATUSES = ['draft', 'reviewed', 'live', 'retired'];
const ORIGINS = ['manual', 'excel', 'api', 'legacy'];  // legacy: the bank migrated out of dist/data.json
const AUTHOR_KINDS = ['human', 'ai'];
// Taken from the shipped bank so imports cannot invent a category the app never renders.
const CATEGORIES = {
  'لفظي': ['استيعاب المقروء', 'التناظر اللفظي', 'إكمال الجمل', 'الخطأ السياقي', 'الارتباط والاختلاف'],
  'كمي': ['الهندسة', 'الجبر', 'الحساب', 'الإحصاء', 'النسب والتناسب', 'المعدل والعمل والزمن', 'الاحتمال', 'المقارنة الكمية'],
};
const ANSWER_LETTERS = ['أ', 'ب', 'ج', 'د'];
// The column order of dist/GAT_Import_Template.xlsx, headers on row 4, data from row 5.
const TEMPLATE_COLUMNS = ['معرف السؤال', 'القسم', 'التصنيف', 'الصعوبة', 'السؤال',
  'الخيار أ', 'الخيار ب', 'الخيار ج', 'الخيار د', 'الإجابة الصحيحة', 'الشرح', 'المرجع'];

// Spreadsheets arrive in more than one shape. Rather than demand that every author retype into
// one template, each recognised layout is described here and detected from its header row.
//
// What differs between them is not only column order. A layout may write the section with the
// definite article (الكمي), name a free-text topic instead of a category from the closed list, give
// the answer as the option's own value rather than a letter, and carry a column the other has no
// place for. Each of those is handled by the profile, so the rest of the pipeline sees one shape.
const PROFILES = {
  // dist/GAT_Import_Template.xlsx
  'gat-template-v1': {
    label: 'قالب قدرات', headerRow: 4, firstDataRow: 5,
    headers: TEMPLATE_COLUMNS,
    map: { id: 0, section: 1, category: 2, difficulty: 3, text: 4, options: [5, 6, 7, 8], answer: 9, explanation: 10, source: 11 },
    answerAs: 'letter',
  },
  // A bank export: a running number instead of an id, a free-text subject, the answer written out
  // as its own value, and a quick-solution strategy in the last column.
  'bank-part-v1': {
    label: 'تصدير بنك (رقم السؤال · الموضوع · الإجابة بالقيمة)', headerRow: 4, firstDataRow: 5,
    headers: ['رقم السؤال', 'القسم', 'الموضوع / المجال', 'مستوى الصعوبة', 'نص السؤال',
      'الخيار (أ)', 'الخيار (ب)', 'الخيار (ج)', 'الخيار (د)', 'الإجابة الصحيحة',
      'الشرح التفصيلي والخطوات الرياضية', 'إستراتيجية الحل السريع (اختصار قياس)'],
    map: { number: 0, section: 1, topic: 2, difficulty: 3, text: 4, options: [5, 6, 7, 8], answer: 9, explanation: 10, strategy: 11 },
    answerAs: 'value',
  },
};

// Free-text subjects seen in bank exports, mapped onto the closed category list. Where the subject
// cannot tell us the skill — an analogy's subject says "التناظر اللفظي" and nothing about which
// relation it tests — the skill is left for the taxonomy to resolve from the category instead of
// being guessed here.
const TOPIC_MAP = {
  'النسبة المئوية والحساب': { category: 'الحساب', skillId: 'QA-PERCENT' },
  'الجبر والمعادلات': { category: 'الجبر', skillId: 'QL-EQUATION' },
  'المتتابعات والأنماط': { category: 'الجبر', skillId: 'QL-SEQUENCE' },
  'الهندسة والزوايا': { category: 'الهندسة', skillId: 'QG-ANGLE' },
  'المسائل الحياتية والسرعات': { category: 'المعدل والعمل والزمن', skillId: 'QW-SPEED' },
  'المفردة الشاذة': { category: 'الارتباط والاختلاف', skillId: 'VO-CLASS' },
  'التناظر اللفظي': { category: 'التناظر اللفظي' },
  'إكمال الجمل': { category: 'إكمال الجمل' },
  'الخطأ السياقي': { category: 'الخطأ السياقي' },
  'استيعاب المقروء': { category: 'استيعاب المقروء' },
};

// الكمي and كمي are the same section; so are اللفظي and لفظي.
const SECTION_ALIASES = { 'الكمي': 'كمي', 'اللفظي': 'لفظي' };

const LIMITS = { text: 4000, option: 400, explanation: 4000, source: 300, skill: 120, id: 64, passage: 6000 };

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

// Duplicate detection has to survive the ways the same question gets retyped: different
// diacritics, أ/إ/آ for ا, ة for ه, Arabic-Indic digits, stray punctuation and spacing.
// Two questions that differ only in those are the same question for our purposes.
//
// What it must NOT discard is arithmetic. A quantitative option set is frequently four
// values that differ only by a sign or a comparison: 7 and -7, س > 5 and س < 5,
// (س + 8)(س − 3) and (س − 8)(س + 3). Dropping every non-letter collapses those into one
// another and rejects a sound question as a duplicate, so this removes a named list of
// sentence punctuation and keeps every operator. Decimal separators are protected before
// the comma and the full stop go.
const NOISE = /[!؟?."'”“‘’,،;؛:…«»]/g;
const DASHES = /[−‒–—―]/g;   // the minus sign and the dashes typed for it
const DEC = '\u0001';
const DEC_RE = new RegExp(DEC, 'g');

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإاآ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[٫٬]/g, '.')                 // Arabic decimal and thousands marks
    .replace(DASHES, '-')
    .replace(/[×✕∗]/g, '*').replace(/÷/g, '/')  // the same operation, written either way
    .replace(/(\d)[.,](\d)/g, '$1' + DEC + '$2')     // 3.5 must not become 3 5
    .replace(NOISE, ' ')
    .replace(DEC_RE, '.')
    .replace(/\s+/g, ' ')
    // س - 7 and س-7 are one formula written two ways, so spacing around an operator is
    // noise; the operator itself is not, which is why it is kept above.
    .replace(/ ?([-+*/=<>≤≥≠^()√%]) ?/g, '$1')
    // 3س and 3 س are the same coefficient; the space between a number and what follows
    // it carries no meaning either.
    .replace(/(\d) +(?=[\p{L}\d])/gu, '$1')
    .trim().toLowerCase();
}

// The fingerprint covers the stem and the option set, not the option order: reordering
// the choices does not make a new question. The key is what the student actually reads.
//
// A reading question also takes its passage in, because the stem alone does not identify
// it: «ما الفكرة الرئيسة للنص؟» is a different question under every passage, and once the
// passage lives in its own row the stem stops carrying it. Items with no passage hash
// exactly as before, so nothing else has to be recomputed.
function fingerprint(item) {
  const stem = normalizeText(item.text);
  const opts = (item.options || []).map(normalizeText).sort().join('|');
  const passage = item.passageText ? normalizeText(item.passageText) : '';
  const body = passage ? passage + '\u0000' + stem : stem;
  return crypto.createHash('sha256').update(body + '\u0000' + opts).digest('hex');
}

// Reading items in the bank are one string: «النص: …», a blank line, then the question.
// Splitting them is unambiguous — all 254 share that exact shape — and it is what lets one
// passage serve its three to five questions instead of being retyped under each.
const PASSAGE_PREFIX = /^النص\s*:\s*/;
function splitPassage(text) {
  const raw = String(text == null ? '' : text);
  const at = raw.indexOf('\n\n');
  if (at === -1 || !PASSAGE_PREFIX.test(raw)) return { passageText: '', text: raw.trim() };
  return {
    passageText: raw.slice(0, at).replace(PASSAGE_PREFIX, '').trim(),
    text: raw.slice(at + 2).trim(),
  };
}
// The one place the two halves are put back together, so the app and any export agree.
const joinPassage = (passageText, text) => (passageText ? `النص: ${passageText}\n\n${text}` : text);

// Only this category is passage-based today; a question outside it with a passage is an
// error rather than something to silently accept.
const PASSAGE_CATEGORY = 'استيعاب المقروء';

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

// Accepts an answer as a letter (أ/ب/ج/د), a 1-based number as people write it in a
// spreadsheet, or the 0-based index the app stores. Returns null when it is none of them.
function parseAnswer(value) {
  if (Number.isInteger(value)) return value >= 0 && value <= 3 ? value : null;
  const raw = clean(value, 8).replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)));
  const letter = ANSWER_LETTERS.indexOf(raw);
  if (letter !== -1) return letter;
  if (/^[1-4]$/.test(raw)) return Number(raw) - 1;
  if (/^[0-3]$/.test(raw) && raw !== '0') return null; // ambiguous with 1-based: reject
  return null;
}

// `strict` adds the rules a question must satisfy to be shown to a student, as opposed
// to the rules it must satisfy to be saved as a draft and finished later.
function validateItem(raw, { strict = false } = {}) {
  const errors = [];
  const item = {
    id: clean(raw && raw.id, LIMITS.id),
    section: clean(raw && raw.section, 20),
    category: clean(raw && raw.category, 60),
    strategy: clean(raw && raw.strategy, LIMITS.explanation),
    passageId: clean(raw && raw.passageId, 32),
    passageText: clean(raw && raw.passageText, LIMITS.passage),
    skillId: clean(raw && raw.skillId, 32),
    skill: clean(raw && raw.skill, LIMITS.skill),
    difficulty: clean(raw && raw.difficulty, 20),
    text: clean(raw && raw.text, LIMITS.text),
    options: Array.isArray(raw && raw.options) ? raw.options.map(o => clean(o, LIMITS.option)) : [],
    answer: parseAnswer(raw && raw.answer),
    explanation: clean(raw && raw.explanation, LIMITS.explanation),
    source: clean(raw && raw.source, LIMITS.source),
  };

  // A caller may send the passage separately, or send the bank's combined form and let it
  // be split here. Either way only the question reaches item.text.
  if (!item.passageText && !item.passageId) {
    const split = splitPassage(item.text);
    if (split.passageText) { item.passageText = split.passageText.slice(0, LIMITS.passage); item.text = split.text; }
  } else {
    const split = splitPassage(item.text);
    if (split.passageText) item.text = split.text;   // combined text sent alongside a passage
  }
  if (item.passageText && item.passageText.length < 40) errors.push('النص قصير جدًا ليكون نص استيعاب.');
  if (item.category && item.category !== PASSAGE_CATEGORY && (item.passageText || item.passageId)) {
    errors.push(`النص المرفق لا يُستخدم إلا في «${PASSAGE_CATEGORY}».`);
  }
  if (item.id && !/^[A-Za-z0-9َ_-]{1,64}$/.test(item.id)) errors.push('المعرف يقبل الحروف اللاتينية والأرقام والشرطات فقط.');
  // A caller may name the skill, or leave it to the taxonomy to place the question from its
  // category and descriptive label. A named skill that is not on the list is an error: the
  // list is closed on purpose, because an open one is how 631 skills happened.
  if (item.skillId && !taxonomy.SKILL_IDS.has(item.skillId)) {
    errors.push(`المهارة «${item.skillId}» ليست من قائمة المهارات المعتمدة.`);
  } else if (!item.skillId) {
    item.skillId = taxonomy.classify(item) || '';
  }
  if (item.skillId) {
    const skill = taxonomy.SKILL_BY_ID.get(item.skillId);
    if (skill && item.section && skill.section !== item.section) {
      errors.push(`المهارة «${skill.label}» تخصّ قسم ${skill.section}، والسؤال في ${item.section}.`);
    }
  }
  if (!SECTIONS.includes(item.section)) errors.push(`القسم يجب أن يكون أحد: ${SECTIONS.join('، ')}.`);
  else if (!CATEGORIES[item.section].includes(item.category)) {
    errors.push(`التصنيف «${item.category || '—'}» ليس من تصنيفات ${item.section}: ${CATEGORIES[item.section].join('، ')}.`);
  }
  if (!DIFFICULTIES.includes(item.difficulty)) errors.push(`الصعوبة يجب أن تكون أحد: ${DIFFICULTIES.join('، ')}.`);
  if (item.text.length < 5) errors.push('نص السؤال قصير جدًا.');
  if (item.options.length !== 4) errors.push('يجب أن تكون الخيارات أربعة بالضبط.');
  else if (item.options.some(o => !o)) errors.push('لا يجوز ترك خيار فارغًا.');
  else if (new Set(item.options.map(normalizeText)).size !== 4) errors.push('الخيارات متكررة؛ يجب أن تكون أربعة مختلفة.');
  if (raw && raw.answerError) errors.push(raw.answerError);
  else if (item.answer === null) errors.push('الإجابة الصحيحة يجب أن تكون أ أو ب أو ج أو د.');

  if (strict) {
    // A question goes live with a worked explanation or not at all: the wrong answer a
    // student needs explained is the whole reason they are here.
    if (item.explanation.length < 10) errors.push('الشرح مطلوب قبل النشر (١٠ أحرف على الأقل).');
    if (!item.source) errors.push('المرجع مطلوب قبل النشر: وثّق أصالة السؤال.');
    if (!item.skillId) errors.push('لا يمكن نشر سؤال بلا مهارة من القائمة المعتمدة.');
    if (item.category === PASSAGE_CATEGORY && !item.passageText && !item.passageId) {
      errors.push('سؤال استيعاب المقروء يحتاج نصًا؛ بلا نص يرى الطالب سؤالًا معلّقًا.');
    }
  }
  return { ok: errors.length === 0, item, errors };
}

// Picks the profile whose header row this sheet matches. Comparison ignores spacing and the
// parentheses layouts differ on, so «الخيار (أ)» and «الخيار أ» are recognised as the same column.
const headerKey = v => clean(v, 80).replace(/[()\s]+/g, '');
function detectProfile(headerCells) {
  const got = (headerCells || []).map(headerKey).filter(Boolean);
  let best = null;
  for (const [name, p] of Object.entries(PROFILES)) {
    const want = p.headers.map(headerKey);
    const hits = want.filter((h, i) => got[i] === h).length;
    const score = hits / want.length;
    if (!best || score > best.score) best = { name, profile: p, score };
  }
  // A partial match is not a match: importing under the wrong profile would silently move the
  // answer column, and every key in the file would be wrong.
  return best && best.score >= 0.75 ? best : null;
}

// A spreadsheet row, read through a profile. Rows come from the browser's XLSX reader as an array
// of cell strings; anything shorter than the stem column is treated as blank.
function fromRow(row, profileName = 'gat-template-v1') {
  const p = PROFILES[profileName] || PROFILES['gat-template-v1'];
  const m = p.map;
  const cell = i => (Number.isInteger(i) && Array.isArray(row) && row[i] != null ? String(row[i]) : '');
  const options = m.options.map(cell);
  const out = {
    id: cell(m.id), difficulty: cell(m.difficulty), text: cell(m.text), options,
    explanation: cell(m.explanation), source: cell(m.source),
  };
  // the section may carry the definite article
  const section = clean(cell(m.section), 20);
  out.section = SECTION_ALIASES[section] || section;
  // a category straight from the closed list, or a free-text subject mapped onto it
  if (Number.isInteger(m.category)) out.category = cell(m.category);
  else if (Number.isInteger(m.topic)) {
    const topic = clean(cell(m.topic), 80);
    const hit = TOPIC_MAP[topic];
    out.category = hit ? hit.category : topic;      // unmapped subject falls through and is rejected
    if (hit && hit.skillId) out.skillId = hit.skillId;
    out.skill = topic;                              // kept as the editorial note it is
  }
  if (Number.isInteger(m.strategy)) out.strategy = cell(m.strategy);

  const raw = cell(m.answer);
  if (p.answerAs === 'value') {
    // The answer is written out rather than lettered. Matching it against the options is the only
    // way to place it, and the match has to be exact-after-normalising and unique: a value that
    // appears in two options does not identify a key, and a value that appears in none is a typo.
    // Both are reported rather than resolved, because guessing here silently mis-keys a question.
    const want = normalizeText(raw);
    const at = options.map((o, i) => (normalizeText(o) === want ? i : -1)).filter(i => i !== -1);
    if (at.length === 1) out.answer = at[0];
    else out.answerError = at.length === 0
      ? `الإجابة «${raw}» لا تطابق أي خيار.`
      : `الإجابة «${raw}» تطابق ${at.length} خيارات (${at.map(i => ANSWER_LETTERS[i]).join('، ')}) فلا تحدد مفتاحًا.`;
  } else out.answer = raw;
  return out;
}
// Kept for callers written against the original template.
const fromTemplateRow = row => fromRow(row, 'gat-template-v1');
const isBlankRow = row => !Array.isArray(row) || row.every(c => clean(c, 50) === '');

// draft is where everything lands; reviewed means a human read it; live is visible to
// students; retired is withdrawn and never returns to live without another review.
const TRANSITIONS = {
  draft: ['reviewed', 'retired'],
  reviewed: ['live', 'draft', 'retired'],
  live: ['retired', 'reviewed'],
  retired: ['draft'],
};
function canTransition(from, to) {
  return STATUSES.includes(to) && (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  SKILLS: taxonomy.SKILLS, SKILL_IDS: taxonomy.SKILL_IDS,
  PASSAGE_CATEGORY, splitPassage, joinPassage,
  PROFILES, TOPIC_MAP, SECTION_ALIASES, detectProfile, fromRow,
  SECTIONS, DIFFICULTIES, STATUSES, ORIGINS, AUTHOR_KINDS, CATEGORIES, ANSWER_LETTERS,
  TEMPLATE_COLUMNS, LIMITS, normalizeText, fingerprint, parseAnswer, validateItem,
  fromTemplateRow, isBlankRow, canTransition, TRANSITIONS,
};
