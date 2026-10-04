'use strict';
// The measurable skill taxonomy.
//
// The shipped bank carried 631 distinct `skill` strings over 1490 questions — 2.4 items
// each. Much of that was the same skill spelled several ways (كسور/الكسور,
// نسبة مئوية/النسبة المئوية, متمم/متمم الاحتمال) and the rest was over-specific labels
// used once (مادة خام وعملية تحسينها). Neither mastery nor a diagnostic can be computed
// from two items, so those labels are descriptions, not measurements.
//
// This file replaces them with a closed list sized so every skill can actually be
// measured. The original string is kept on each item as skill_note: it is editorial
// information worth keeping, it is simply not a unit of measurement.
//
// A skill may span more than one category where the underlying competence is identical:
// computing a mean is the same skill whether the bank filed the question under الحساب or
// الإحصاء. Categories describe the test's structure; skills describe the student.

const SKILLS = [
  // ---------- لفظي ----------
  { id: 'VA-SEMANTIC', label: 'التناظر: علاقات دلالية (تضاد وترادف وجزء وكل)', section: 'لفظي' },
  { id: 'VA-FUNCTION', label: 'التناظر: أداة ووظيفة وسبب ونتيجة', section: 'لفظي' },
  { id: 'VA-AGENT', label: 'التناظر: فاعل ومنتج ومادة', section: 'لفظي' },
  { id: 'VA-ORDER', label: 'التناظر: تدرج وتتابع ومكان', section: 'لفظي' },

  { id: 'VC-CONTEXT', label: 'إكمال الجمل: فهم السياق', section: 'لفظي' },
  { id: 'VC-LEXICAL', label: 'إكمال الجمل: الزوج الدلالي والمفردة', section: 'لفظي' },

  { id: 'VE-CONTRADICT', label: 'الخطأ السياقي: التناقض الدلالي', section: 'لفظي' },
  { id: 'VE-FACT', label: 'الخطأ السياقي: خطأ المنطق والحقيقة', section: 'لفظي' },

  // One skill, not two. Splitting on whether the old label happened to contain the word
  // تصنيف separated items by how they were annotated, not by what the student does: every
  // odd-one-out question is the same classification task.
  { id: 'VO-CLASS', label: 'الارتباط والاختلاف: التصنيف الدلالي', section: 'لفظي' },

  { id: 'VR-MAIN', label: 'الاستيعاب: الفكرة الرئيسة', section: 'لفظي' },
  { id: 'VR-DETAIL', label: 'الاستيعاب: التفصيل الصريح', section: 'لفظي' },
  { id: 'VR-INFER', label: 'الاستيعاب: الاستنتاج والتطبيق', section: 'لفظي' },
  { id: 'VR-PURPOSE', label: 'الاستيعاب: غرض الكاتب والنبرة', section: 'لفظي' },
  { id: 'VR-MEANING', label: 'الاستيعاب: المعنى في السياق', section: 'لفظي' },

  // ---------- كمي ----------
  { id: 'QG-MEASURE', label: 'الهندسة: المساحة والمحيط والحجم', section: 'كمي' },
  { id: 'QG-CIRCLE', label: 'الهندسة: الدائرة والقطاع', section: 'كمي' },
  { id: 'QG-ANGLE', label: 'الهندسة: الزوايا والمثلث القائم والتشابه', section: 'كمي' },

  { id: 'QA-NUMBER', label: 'الحساب: العمليات وخواص الأعداد والأسس', section: 'كمي' },
  { id: 'QA-FRACTION', label: 'الحساب: الكسور والأعداد العشرية', section: 'كمي' },
  { id: 'QA-PERCENT', label: 'الحساب: النسبة المئوية والربح والخصم', section: 'كمي' },

  { id: 'QL-EQUATION', label: 'الجبر: المعادلات والمتباينات', section: 'كمي' },
  { id: 'QL-EXPRESS', label: 'الجبر: التعبير والتبسيط والتحليل', section: 'كمي' },
  { id: 'QL-SEQUENCE', label: 'الجبر: المتتابعات والأنماط', section: 'كمي' },

  { id: 'QR-PROPORTION', label: 'التناسب: الطردي والعكسي والتقسيم', section: 'كمي' },

  { id: 'QW-RATE', label: 'المعدل: العمل والإنتاج', section: 'كمي' },
  { id: 'QW-SPEED', label: 'المعدل: السرعة والمسافة والزمن', section: 'كمي' },

  { id: 'QS-CENTER', label: 'الإحصاء: النزعة المركزية والتشتت', section: 'كمي' },
  { id: 'QS-DATA', label: 'الإحصاء: قراءة البيانات ونسبة التغير', section: 'كمي' },

  { id: 'QP-PROB', label: 'الاحتمال', section: 'كمي' },

  { id: 'QC-COMPARE', label: 'المقارنة الكمية', section: 'كمي' },
];

// Distinctions the taxonomy deliberately does not make yet, because the bank cannot
// measure them: fewer than 25 items each. Each is a content gap with a known fix, and the
// split is mechanical once the items exist.
const PENDING_SPLITS = [
  { from: 'QR-PROPORTION', into: ['طردي', 'عكسي', 'تقسيم وخلط'], have: 'عكسي ١٣، تقسيم ١٠' },
  { from: 'QA-NUMBER', into: ['ترتيب العمليات', 'خواص الأعداد', 'الأسس والجذور'], have: 'خواص ١٦، أسس ٨' },
  { from: 'QG-ANGLE', into: ['الزوايا والتشابه', 'المثلث القائم وفيثاغورس'], have: 'قائم ٢٤، زوايا ٢٣' },
  { from: 'QL-EXPRESS', into: ['التعبير والتبسيط', 'التحليل والمتطابقات'], have: 'تحليل ١٤' },
  { from: 'QS-CENTER', into: ['النزعة المركزية', 'المدى والتشتت'], have: 'تشتت ١٤' },
  { from: 'QP-PROB', into: ['البسيط والمتمم', 'العدّ والمركب'], have: 'عدّ ٨' },
  { from: 'VA-SEMANTIC', into: ['تضاد وترادف', 'جزء وكل وتصنيف'], have: 'جزء وكل ١٤' },
  { from: 'VE-FACT', into: ['خطأ المنطق', 'خطأ الحقيقة'], have: 'منطق ١٣' },
  { from: 'VC-LEXICAL', into: ['الزوج الدلالي', 'المفردة في السياق'], have: 'مفردة ١٦' },
];

const SKILL_IDS = new Set(SKILLS.map(s => s.id));
const SKILL_BY_ID = new Map(SKILLS.map(s => [s.id, s]));
const CATCH_ALL = Symbol('catch-all');

// Ordered rules per category: the first pattern that matches the old label wins, so the
// more specific pattern must come first. `text` lets a rule fall back to the question
// itself when the old label is too vague to place.
const RULES = {
  'التناظر اللفظي': [
    [/تضاد|تقابل|نقيض|ترادف|تقارب معنى|كلمة ومعنى|مصطلح ودلال|مفهوم وما|علامة ومدلول/, 'VA-SEMANTIC'],
    [/جزء|كل وبدايت|وحدة بناء|وحدة صغرى|فرد وجماع|نوع وجنس|أصل وفرع|ينتمي|مادة البناء|وصف ومثال|صفة ومثال|صفته/, 'VA-SEMANTIC'],
    [/سبب|نتيج|أثر|استجاب|مسبب|مؤثر|مثير|عملية ونتيجة|حالة ونتيجة/, 'VA-FUNCTION'],
    [/أداة|وسيل|آلة|وحدة وما تقيس|قياس|مفتاح|حاج|مشكلة وحل|معالج|يزيل|يحجب|ينفذ|حماية|عضو|جسم ووظيف|وظيفة/, 'VA-FUNCTION'],
    [/مهن|صانع|منتِج|منتج|مصدر|مادة|خام|صاحب|متخصص|قائد|علم وموضوع|مستخدم|شخص|تحول|تسخين|مرحلة وناتج/, 'VA-AGENT'],
    [/تدرج|درج|تتابع|تسلسل|زمن|طور|يفرط|وعاء|محتو|مكان|موطن|مسكن|حفظ|نشاط/, 'VA-ORDER'],
    [CATCH_ALL, 'VA-FUNCTION'],
  ],
  'إكمال الجمل': [
    [/زوج|مفرد|معنى|دلال/, 'VC-LEXICAL'],
    [CATCH_ALL, 'VC-CONTEXT'],
  ],
  'الخطأ السياقي': [
    [/تناقض|تضاد|عكس/, 'VE-CONTRADICT'],
    [CATCH_ALL, 'VE-FACT'],
  ],
  'الارتباط والاختلاف': [[CATCH_ALL, 'VO-CLASS']],
  'استيعاب المقروء': [
    [/رئيس|عنوان|موضوع النص|فكرة/, 'VR-MAIN'],
    [/تفصيل|صريح|معلومة/, 'VR-DETAIL'],
    [/غرض|نبرة|أسلوب|موقف الكاتب|اتجاه الكاتب/, 'VR-PURPOSE'],
    [/معنى|مفرد|دلال/, 'VR-MEANING'],
    [CATCH_ALL, 'VR-INFER'],
  ],
  'الهندسة': [
    [/دائر|قطاع|قوس|حلق|مركزي|محيطي|نصف دائرة|ربع دائرة/, 'QG-CIRCLE'],
    [/زاوي|زوايا|متكامل|متتام|متقابل|قاطع|متوازيان|مضلع|تشابه|توازي|متباين|خارجية|فيثاغورس|وتر|قطر المربع|قطر المستطيل|قطر مستطيل|المسافة بين نقطتين|المسافة مع|نقطة المنتصف|منتصف|ميل|قائم/, 'QG-ANGLE'],
    [CATCH_ALL, 'QG-MEASURE'],
  ],
  'الحساب': [
    [/متوسط|وسط حساب|موزون/, 'QS-CENTER'],
    // مئوي alone: the bank writes النسبة المئوية, النسب المئوية and نسبة مئوية, and a
    // pattern spelling out the article and the taa missed ten of them.
    [/تناسب|نسبة عكسي|نسب متتابع/, 'QR-PROPORTION'],
    [/مئوي|خصم|ربح|خسار|زياد|تغير|تغيير|عكس النسبة/, 'QA-PERCENT'],
    [/كسر|كسور|عشري|مقلوب/, 'QA-FRACTION'],
    [CATCH_ALL, 'QA-NUMBER'],
  ],
  'الجبر': [
    [/متتابع|نمط|فيبوناتشي|حد عام|رتبة حد|مجموع الأعداد/, 'QL-SEQUENCE'],
    [/معادل|متباين|نظام|حل|مسألة عددين|أعمار|مسألة لفظية|قيمة مطلقة/, 'QL-EQUATION'],
    [CATCH_ALL, 'QL-EXPRESS'],
  ],
  'النسب والتناسب': [
    [/مئوي/, 'QA-PERCENT'],
    [CATCH_ALL, 'QR-PROPORTION'],
  ],
  'المعدل والعمل والزمن': [
    [/سرع|مسافة|زمن|وقت|قطار|سيار/, 'QW-SPEED'],
    [CATCH_ALL, 'QW-RATE'],
  ],
  'الإحصاء': [
    [/مدى|تشتت|انحراف|تباين|وسيط|منوال|متوسط|وسط/, 'QS-CENTER'],
    [CATCH_ALL, 'QS-DATA'],
  ],
  'الاحتمال': [[CATCH_ALL, 'QP-PROB']],
  'المقارنة الكمية': [[CATCH_ALL, 'QC-COMPARE']],
};


// Diacritics are decoration in these labels but they break a plain match: the bank holds
// كلّ وبدايته with a shadda, which /كل وبدايت/ does not find.
const bareLabel = v => String(v == null ? '' : v).replace(/[ً-ْٰـ]/g, '').trim();

// Every category ends in a catch-all so an unseen label is placed rather than dropped.
// classifyDetailed says whether the catch-all did the placing, which is the signal that a
// label needs a rule of its own; classify is the plain answer.
function classifyDetailed(item) {
  const rules = RULES[item && item.category];
  if (!rules) return { id: null, viaCatchAll: false };
  const label = bareLabel(item && item.skill);
  for (const [pattern, id] of rules) {
    if (pattern === CATCH_ALL) return { id, viaCatchAll: true };
    if (pattern.test(label)) return { id, viaCatchAll: false };
  }
  return { id: null, viaCatchAll: false };
}
const classify = item => classifyDetailed(item).id;

module.exports = { SKILLS, SKILL_IDS, SKILL_BY_ID, RULES, PENDING_SPLITS, classify, classifyDetailed };
