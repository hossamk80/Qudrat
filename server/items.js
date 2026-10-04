'use strict';
// The single gate every question passes through, whoever wrote it: the admin by hand,
// a spreadsheet upload, or a model. One schema, one validator, one fingerprint. Adding
// a second path that skips this file is how a bank ends up with three truths.
const crypto = require('node:crypto');

const SECTIONS = ['لفظي', 'كمي'];
const DIFFICULTIES = ['سهل', 'متوسط', 'صعب'];
const STATUSES = ['draft', 'reviewed', 'live', 'retired'];
const ORIGINS = ['manual', 'excel', 'api'];
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

const LIMITS = { text: 4000, option: 400, explanation: 4000, source: 300, skill: 120, id: 64 };

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

// Duplicate detection has to survive the ways the same question gets retyped: different
// diacritics, أ/إ/آ for ا, ة for ه, Arabic-Indic digits, stray punctuation and spacing.
// Two questions that differ only in those are the same question for our purposes.
function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإاآ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, d => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().toLowerCase();
}

// The fingerprint covers the stem and the option set, not the option order: reordering
// the choices does not make a new question. The key is what the student actually reads.
function fingerprint(item) {
  const stem = normalizeText(item.text);
  const opts = (item.options || []).map(normalizeText).sort().join('|');
  return crypto.createHash('sha256').update(stem + '\u0000' + opts).digest('hex');
}

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
    skill: clean(raw && raw.skill, LIMITS.skill),
    difficulty: clean(raw && raw.difficulty, 20),
    text: clean(raw && raw.text, LIMITS.text),
    options: Array.isArray(raw && raw.options) ? raw.options.map(o => clean(o, LIMITS.option)) : [],
    answer: parseAnswer(raw && raw.answer),
    explanation: clean(raw && raw.explanation, LIMITS.explanation),
    source: clean(raw && raw.source, LIMITS.source),
  };

  if (item.id && !/^[A-Za-z0-9َ_-]{1,64}$/.test(item.id)) errors.push('المعرف يقبل الحروف اللاتينية والأرقام والشرطات فقط.');
  if (!SECTIONS.includes(item.section)) errors.push(`القسم يجب أن يكون أحد: ${SECTIONS.join('، ')}.`);
  else if (!CATEGORIES[item.section].includes(item.category)) {
    errors.push(`التصنيف «${item.category || '—'}» ليس من تصنيفات ${item.section}: ${CATEGORIES[item.section].join('، ')}.`);
  }
  if (!DIFFICULTIES.includes(item.difficulty)) errors.push(`الصعوبة يجب أن تكون أحد: ${DIFFICULTIES.join('، ')}.`);
  if (item.text.length < 5) errors.push('نص السؤال قصير جدًا.');
  if (item.options.length !== 4) errors.push('يجب أن تكون الخيارات أربعة بالضبط.');
  else if (item.options.some(o => !o)) errors.push('لا يجوز ترك خيار فارغًا.');
  else if (new Set(item.options.map(normalizeText)).size !== 4) errors.push('الخيارات متكررة؛ يجب أن تكون أربعة مختلفة.');
  if (item.answer === null) errors.push('الإجابة الصحيحة يجب أن تكون أ أو ب أو ج أو د.');

  if (strict) {
    // A question goes live with a worked explanation or not at all: the wrong answer a
    // student needs explained is the whole reason they are here.
    if (item.explanation.length < 10) errors.push('الشرح مطلوب قبل النشر (١٠ أحرف على الأقل).');
    if (!item.source) errors.push('المرجع مطلوب قبل النشر: وثّق أصالة السؤال.');
  }
  return { ok: errors.length === 0, item, errors };
}

// A spreadsheet row in template order. Rows come from the browser's XLSX reader as an
// array of cell strings; anything shorter than the stem column is treated as blank.
function fromTemplateRow(row) {
  const cell = i => (Array.isArray(row) && row[i] != null ? row[i] : '');
  return {
    id: cell(0), section: cell(1), category: cell(2), difficulty: cell(3), text: cell(4),
    options: [cell(5), cell(6), cell(7), cell(8)],
    answer: cell(9), explanation: cell(10), source: cell(11),
  };
}
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
  SECTIONS, DIFFICULTIES, STATUSES, ORIGINS, AUTHOR_KINDS, CATEGORIES, ANSWER_LETTERS,
  TEMPLATE_COLUMNS, LIMITS, normalizeText, fingerprint, parseAnswer, validateItem,
  fromTemplateRow, isBlankRow, canTransition, TRANSITIONS,
};
