// Real GAT simulation (computerized, Qiyas format): 120 questions in 5 sections × 24 × 25 minutes,
// no return to a closed section, question types weighted like the official test, reading passages
// kept together, and a section review screen before closing a section. Loaded after engine.js.

// Official weights as percentages of the whole test (Etec / published GAT guides).
// Scientific: 65 verbal + 55 quantitative (Etec reply); humanities: about 75% verbal.
const REAL_TRACKS = {
  'علمي': { verbal: 65, quant: 55,
    v: { 'استيعاب المقروء': 21, 'التناظر اللفظي': 17, 'الخطأ السياقي': 10, 'إكمال الجمل': 7 },
    k: { arith: 23, geo: 10, data: 8, alg: 4 } },
  'نظري': { verbal: 90, quant: 30,
    v: { 'استيعاب المقروء': 25, 'التناظر اللفظي': 21, 'الخطأ السياقي': 16, 'إكمال الجمل': 13 },
    k: { arith: 13, geo: 8, data: 4, alg: 0 } },
};
// The bank's quantitative categories mapped to the four official quantitative areas.
const QUANT_AREAS = {
  arith: ['الحساب', 'النسب والتناسب', 'المعدل والعمل والزمن', 'المقارنة الكمية'],
  geo: ['الهندسة'],
  data: ['الإحصاء', 'الاحتمال'],
  alg: ['الجبر'],
};
const QUANT_AREA_NAMES = { arith: 'الحساب', geo: 'الهندسة', data: 'تحليل البيانات والإحصاء', alg: 'الجبر' };
const REAL_SECTIONS = 5, REAL_SECTION_SIZE = 24, REAL_SECTION_MINUTES = 25;
// Easier banks still produce a realistic mix: aim for this share of each difficulty.
const REAL_DIFFICULTY = { 'سهل': 0.3, 'متوسط': 0.5, 'صعب': 0.2 };

// Largest-remainder split of total across weights, so counts always add up exactly.
function apportion(total, weights) {
  const keys = Object.keys(weights), sum = keys.reduce((s, k) => s + weights[k], 0);
  if (!sum) return Object.fromEntries(keys.map(k => [k, 0]));
  const raw = keys.map(k => total * weights[k] / sum), out = {};
  keys.forEach((k, i) => out[k] = Math.floor(raw[i]));
  let left = total - keys.reduce((s, k) => s + out[k], 0);
  keys.map((k, i) => [k, raw[i] - out[k]]).sort((a, b) => b[1] - a[1]).forEach(([k]) => { if (left > 0) { out[k]++; left-- } });
  return out;
}

// Reading items repeat their passage in the text; the passage is the part before the question line.
function passageKey(q) {
  if (q.group) return 'g:' + q.group;
  const i = q.text.lastIndexOf('\n\n');
  return i > 0 ? 'p:' + q.text.slice(0, i).trim() : 'q:' + q.id;
}

function seenOrder() {
  const seen = new Map();
  attempts.forEach((a, n) => a.qs.forEach(q => seen.set(q.id, n + 1)));
  return seen;
}

// Pick count items from pool: unseen first, then least recently seen, steering toward REAL_DIFFICULTY.
function pickItems(pool, count, seen, taken) {
  const free = shuffle(pool.filter(q => !taken.has(q.id))).sort((a, b) => (seen.get(a.id) || 0) - (seen.get(b.id) || 0));
  const want = apportion(count, REAL_DIFFICULTY), out = [];
  for (const level of Object.keys(want)) {
    for (const q of free) { if (want[level] <= 0) break; if (q.difficulty === level && !taken.has(q.id)) { out.push(q); taken.add(q.id); want[level]-- } }
  }
  for (const q of free) { if (out.length >= count) break; if (!taken.has(q.id)) { out.push(q); taken.add(q.id) } }
  return out;
}

// Whole passages with all their questions, unseen passages first, trimmed to fit count exactly.
function pickPassages(pool, count, seen, taken) {
  const groups = new Map();
  for (const q of pool) { if (taken.has(q.id)) continue; const k = passageKey(q); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(q) }
  const ordered = shuffle([...groups.values()]).sort((a, b) => Math.max(...a.map(q => seen.get(q.id) || 0)) - Math.max(...b.map(q => seen.get(q.id) || 0)));
  const out = []; let n = 0;
  for (const g of ordered) {
    if (n >= count) break;
    const part = g.slice(0, count - n);
    part.forEach(q => taken.add(q.id));
    out.push(part); n += part.length;
  }
  return out;
}

function buildRealExam(track) {
  const spec = REAL_TRACKS[track] || REAL_TRACKS['علمي'];
  const bank = uniqueQuestions(questionBank());
  const seen = seenOrder(), taken = new Set();
  const vCounts = apportion(spec.verbal, spec.v), kCounts = apportion(spec.quant, spec.k);
  const byCat = c => bank.filter(q => q.category === c);

  // Verbal: reading as passage groups, the other three types as single items.
  const passages = pickPassages(byCat('استيعاب المقروء'), vCounts['استيعاب المقروء'], seen, taken);
  let readingShort = vCounts['استيعاب المقروء'] - passages.flat().length;
  const otherVerbal = [];
  for (const c of ['التناظر اللفظي', 'الخطأ السياقي', 'إكمال الجمل']) otherVerbal.push(...pickItems(byCat(c), vCounts[c] + (readingShort > 0 && c === 'التناظر اللفظي' ? readingShort : 0), seen, taken));
  // Quantitative areas, topping up from the whole quantitative bank if an area runs short.
  const quant = [];
  for (const area of Object.keys(kCounts)) quant.push(...pickItems(bank.filter(q => QUANT_AREAS[area].includes(q.category)), kCounts[area], seen, taken));
  if (quant.length < spec.quant) quant.push(...pickItems(bank.filter(q => q.section === 'كمي'), spec.quant - quant.length, seen, taken));
  const verbalTotal = passages.flat().length + otherVerbal.length;
  if (verbalTotal < spec.verbal) otherVerbal.push(...pickItems(bank.filter(q => q.section === 'لفظي' && q.category !== 'الارتباط والاختلاف'), spec.verbal - verbalTotal, seen, taken));
  if (passages.flat().length + otherVerbal.length + quant.length !== REAL_SECTIONS * REAL_SECTION_SIZE)
    throw Error('بنك الأسئلة لا يكفي لاختبار كامل من ١٢٠ سؤالًا مختلفًا.');

  // Spread across 5 sections: each gets its share of verbal and quantitative; passages stay whole.
  const vPer = apportion(spec.verbal, Object.fromEntries([...Array(REAL_SECTIONS).keys()].map(b => [b, 1])));
  const readingPer = apportion(passages.flat().length, Object.fromEntries([...Array(REAL_SECTIONS).keys()].map(b => [b, 1])));
  const sectionPassages = [...Array(REAL_SECTIONS)].map(() => []), sectionReading = Array(REAL_SECTIONS).fill(0);
  for (const g of [...passages].sort((a, b) => b.length - a.length)) {
    let best = 0;
    for (let b = 1; b < REAL_SECTIONS; b++) if (readingPer[b] - sectionReading[b] > readingPer[best] - sectionReading[best] && sectionReading[b] + g.length <= vPer[b]) best = b;
    sectionPassages[best].push(g); sectionReading[best] += g.length;
  }
  const others = shuffle(otherVerbal), q2 = shuffle(quant), qs = [];
  for (let b = 0; b < REAL_SECTIONS; b++) {
    const nOther = vPer[b] - sectionReading[b], nQuant = REAL_SECTION_SIZE - vPer[b];
    qs.push(...others.splice(0, nOther), ...sectionPassages[b].flat(), ...q2.splice(0, nQuant));
  }
  // Rounding leftovers (if a passage pushed a section over) go to the last sections in order.
  qs.push(...others, ...q2);
  return qs.slice(0, REAL_SECTIONS * REAL_SECTION_SIZE).map(mixedOptions);
}

function startRealExam(track) {
  if (!REAL_TRACKS[track]) track = 'علمي';
  if (exam) { go('exams'); return }
  try {
    const qs = buildRealExam(track), now = Date.now();
    exam = {
      id: uid(), name: `اختبار قدرات حقيقي · ${track}`, mode: 'random', real: true, track,
      strict: true, bankScope: settings.bankScope === 'all' ? 'all' : 'reviewed', timerModel: 2, unobservedSeconds: 0,
      qs: clone(qs), answers: Array(qs.length).fill(null), times: Array(qs.length).fill(0), flags: Array(qs.length).fill(false),
      index: 0, startedAt: now, deadline: now + REAL_SECTIONS * REAL_SECTION_MINUTES * 60000, lastTouch: now,
      profile: 'sectioned', block: 0, blockCount: REAL_SECTIONS, blockSize: REAL_SECTION_SIZE, blockMinutes: REAL_SECTION_MINUTES,
      blockDeadline: now + REAL_SECTION_MINUTES * 60000,
    };
    save(); activate('exams'); renderExam(); runTimer();
  } catch (err) { alert(err.message) }
}

// ---------- exams screen: the real simulation comes first ----------
const examsBeforeReal = exams;
exams = function () {
  examsBeforeReal();
  if (exam) return;
  const track = settings.track === 'نظري' ? 'نظري' : 'علمي', spec = REAL_TRACKS[track];
  const card = document.createElement('section');
  card.className = 'card real-exam';
  card.innerHTML = `<span class="tag">مطابق لاختبار قياس المحوسب</span><h2>اختبار قدرات حقيقي</h2>
    <p>${num(120)} سؤالًا في ${num(5)} أقسام، لكل قسم ${num(24)} سؤالًا و${num(25)} دقيقة. لا رجوع لقسم أُغلق، ولا آلة حاسبة.</p>
    <div class="filters"><label>المسار<select id="real-track"><option value="علمي" ${track === 'علمي' ? 'selected' : ''}>علمي</option><option value="نظري" ${track === 'نظري' ? 'selected' : ''}>نظري</option></select></label></div>
    <p class="muted" id="real-split">${num(spec.verbal)} لفظي و${num(spec.quant)} كمي، موزعة على أنواع الأسئلة بأوزان الاختبار الرسمي. تدريب مستقل وليس اختبارًا رسميًا.</p>
    <button class="primary" id="start-real">ابدأ الاختبار</button>`;
  const first = document.querySelector('#main .card');
  if (first) first.before(card); else $('#main').append(card);
  $('#real-track').onchange = ev => { settings.track = ev.target.value; save(); exams() };
  $('#start-real').onclick = () => startRealExam($('#real-track').value);
};

// ---------- section review screen (replaces the browser confirm) ----------
function renderSectionReview() {
  const e = exam, start = e.block * blockSize(), end = start + blockSize(), last = e.block === blockCount() - 1;
  const idx = [...Array(end - start).keys()].map(i => start + i);
  const unanswered = idx.filter(i => !answered(e.answers[i])), flagged = idx.filter(i => e.flags[i]);
  $('#main').innerHTML = title(`مراجعة القسم ${num(e.block + 1)} من ${num(blockCount())}`, last ? 'هذا آخر قسم. بعد الإغلاق تُسلَّم الإجابات وتظهر النتيجة.' : 'بعد إغلاق القسم لن تستطيع الرجوع إليه.') +
    `<section class="card section-review"><div class="qmeta"><b>${num(idx.length - unanswered.length)} من ${num(idx.length)} مُجاب</b><span class="timer" id="time">${remaining()}</span><span>${num(flagged.length)} للمراجعة</span></div>
    ${unanswered.length ? `<p class="review-warn">لم تُجب عن ${num(unanswered.length)} ${unanswered.length === 1 ? 'سؤال' : 'أسئلة'}. السؤال غير المُجاب يُحسب خطأ.</p>` : ''}
    <div class="review-grid">${idx.map(i => `<button data-review-jump="${i}" class="${answered(e.answers[i]) ? 'is-answered' : 'is-blank'}${e.flags[i] ? ' is-flagged' : ''}">${num(i - start + 1)}${e.flags[i] ? ' ⚑' : ''}<small>${answered(e.answers[i]) ? 'مُجاب' : 'غير مُجاب'}</small></button>`).join('')}</div>
    <div class="actions"><button id="review-back">العودة إلى القسم</button>${flagged.length ? '<button id="review-flagged">مراجعة المُعلَّم فقط</button>' : ''}<button class="primary" id="review-close">${last ? 'إنهاء الاختبار' : 'إغلاق القسم والانتقال للتالي'}</button></div></section>`;
  const id = e.id, block = e.block;
  const stillHere = () => { syncBlocks(); if (!exam || exam.id !== id || exam.block !== block) { if (exam) renderExam(); return false } return true };
  document.querySelectorAll('[data-review-jump]').forEach(b => b.onclick = () => { if (!stillHere()) return; touchExam(); exam.index = +b.dataset.reviewJump; save(); renderExam() });
  $('#review-back').onclick = () => { if (stillHere()) renderExam() };
  if (flagged.length) $('#review-flagged').onclick = () => { if (!stillHere()) return; touchExam(); exam.index = flagged[0]; save(); renderExam() };
  $('#review-close').onclick = () => { if (stillHere()) closeBlock() };
}

function closeBlock() {
  if (exam.block === blockCount() - 1) { finishExam(); return }
  touchExam(); exam.block++; exam.index = exam.block * blockSize();
  exam.blockDeadline = Date.now() + blockMs(); exam.deadline = exam.blockDeadline + (blockCount() - 1 - exam.block) * blockMs();
  exam.lastTouch = Date.now(); save(); renderExam();
}

advanceBlock = function () {
  const id = exam?.id, b = exam?.block;
  syncBlocks();
  if (!exam || id !== exam.id || b !== exam.block) { if (exam) renderExam(); return }
  renderSectionReview();
};

// ---------- report: per-section and per-area results for real simulations ----------
const reportBeforeReal = showReport;
showReport = function (id) {
  reportBeforeReal(id);
  const e = attempts.find(a => a.id === id);
  if (!e || !e.real) return;
  const size = e.blockSize || REAL_SECTION_SIZE, rows = [];
  for (let b = 0; b < (e.blockCount || REAL_SECTIONS); b++) {
    const c = counts(e, [...Array(size).keys()].map(i => b * size + i));
    rows.push(`<tr><td>القسم ${num(b + 1)}</td><td>${num(c.correct)} / ${num(c.total)}</td><td>${num(c.blank)}</td><td>${num(c.percent)}٪</td></tr>`);
  }
  const area = q => q.section === 'لفظي' ? q.category : QUANT_AREA_NAMES[Object.keys(QUANT_AREAS).find(k => QUANT_AREAS[k].includes(q.category))] || q.category;
  const groups = new Map();
  e.qs.forEach((q, i) => { const k = q.section + ' · ' + area(q); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i) });
  const areaRows = [...groups].map(([k, idx]) => { const c = counts(e, idx); return `<tr><td>${esc(k)}</td><td>${num(c.correct)} / ${num(c.total)}</td><td>${num(c.percent)}٪</td></tr>` });
  const v = counts(e, e.qs.flatMap((q, i) => q.section === 'لفظي' ? [i] : [])), k = counts(e, e.qs.flatMap((q, i) => q.section === 'كمي' ? [i] : []));
  const panel = document.createElement('section');
  panel.className = 'card spaced real-report';
  panel.innerHTML = `<h2>تحليل الاختبار الحقيقي · ${esc(e.track || 'علمي')}</h2>
    <div class="stats"><div class="stat"><b>${num(v.percent)}٪</b><span>اللفظي (${num(v.correct)} من ${num(v.total)})</span></div><div class="stat"><b>${num(k.percent)}٪</b><span>الكمي (${num(k.correct)} من ${num(k.total)})</span></div><div class="stat"><b>${num(counts(e).percent)}٪</b><span>الإجمالي</span></div></div>
    <div class="table-wrap"><table class="admin-table"><thead><tr><th>القسم</th><th>الصحيح</th><th>المتروك</th><th>النسبة</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div class="table-wrap"><table class="admin-table"><thead><tr><th>نوع السؤال</th><th>الصحيح</th><th>النسبة</th></tr></thead><tbody>${areaRows.join('')}</tbody></table></div>
    <p class="muted">النسبة المئوية هنا ليست الدرجة الرسمية؛ درجة قياس تُحسب بمقارنة أدائك بأداء المختبرين.</p>`;
  const anchor = document.querySelector('#main .card');
  if (anchor) anchor.after(panel); else $('#main').append(panel);
};

// ---------- persistence: keep the real-exam markers and passage groups through backups ----------
const checkedExamBeforeReal = checkedExam;
checkedExam = function (e, active = false) {
  const out = checkedExamBeforeReal(e, active);
  if (e && e.real === true) { out.real = true; out.track = e.track === 'نظري' ? 'نظري' : 'علمي' }
  return out;
};
const checkedQuestionBeforeReal = checkedQuestion;
checkedQuestion = function (q) {
  const out = checkedQuestionBeforeReal(q);
  if (q && typeof q.group === 'string' && q.group.trim()) out.group = q.group.trim().slice(0, 80);
  return out;
};
// engine.js already loaded the saved workspace before this file ran; restore the markers it dropped.
(function restoreRealMarkers() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(STORE) || 'null') } catch { return }
  if (!raw) return;
  const mark = (target, src) => { if (target && src && src.real === true && target.id === src.id) { target.real = true; target.track = src.track === 'نظري' ? 'نظري' : 'علمي' } };
  mark(exam, raw.activeExam);
  if (Array.isArray(raw.attempts)) for (const src of raw.attempts) mark(attempts.find(a => a.id === src?.id), src);
})();

// ---------- question text layout: passages and tables read like the real test ----------
// The bank stores a reading passage or data table before a blank line, then the question.
function enhanceQuestionText(el) {
  if (el.dataset.enhanced) return;
  const text = el.textContent, cut = text.lastIndexOf('\n\n');
  if (cut < 0) return;
  el.dataset.enhanced = '1';
  const lead = text.slice(0, cut).trim(), ask = text.slice(cut + 2).trim();
  const lines = lead.split('\n'), rows = lines.filter(l => l.includes('|'));
  let html;
  if (rows.length >= 2) {
    const intro = lines.filter(l => !l.includes('|')).join('\n');
    const cells = rows.map(r => r.split('|').map(c => esc(c.trim())));
    html = (intro ? `<p class="q-lead">${esc(intro)}</p>` : '') +
      `<div class="table-wrap"><table class="q-table"><thead><tr>${cells[0].map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${cells.slice(1).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else {
    html = `<div class="q-passage">${esc(lead.replace(/^النص:\s*/, ''))}</div>`;
  }
  el.innerHTML = html + `<p class="q-ask">${esc(ask)}</p>`;
}
if (typeof MutationObserver === 'function' && document.getElementById?.('main')) {
  const main = document.getElementById('main');
  const run = () => main.querySelectorAll('.qtext').forEach(enhanceQuestionText);
  new MutationObserver(run).observe(main, { childList: true, subtree: true });
  run();
}

// ---------- comparison items keep the fixed option order used in the real test ----------
const COMPARISON_ORDER = ['القيمة الأولى أكبر', 'القيمة الثانية أكبر', 'القيمتان متساويتان', 'المعطيات غير كافية'];
const mixedOptionsBeforeReal = mixedOptions;
mixedOptions = function (q) {
  const same = q.options.length === 4 && COMPARISON_ORDER.every(o => q.options.includes(o));
  if (!same) return mixedOptionsBeforeReal(q);
  const copy = clone(q);
  copy.options = [...COMPARISON_ORDER];
  copy.answer = COMPARISON_ORDER.indexOf(q.options[q.answer]);
  return copy;
};
