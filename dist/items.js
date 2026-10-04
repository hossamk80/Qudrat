// The admin side of the question intake gateway: a form, a spreadsheet upload, and the
// review queue. Every path posts to /api/admin/items*, so the server's validator in
// server/items.js decides what is acceptable — this page only reports its verdicts.
(function () {
  'use strict';
  const main = document.getElementById('main');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => main.querySelector(sel);
  const noticeHtml = () => notice
    ? `<p class="${notice.kind === 'error' ? 'auth-error' : ''}" role="status">${esc(notice.text)}</p>` : '';
  const STATUS_LABEL = { draft: 'مسوّدة', reviewed: 'مراجَع', live: 'منشور', retired: 'مسحوب' };
  const KIND_LABEL = { human: 'بشري', ai: 'آلي' };
  let meta = null, tab = 'manual', list = [], passages = [], openPassage = null;
  let filters = { status: '', section: '', skill: '', q: '' };
  // A message written straight into the DOM is wiped by the next render(), so anything the
  // admin must still be able to read after a reload lives here and is rendered with the view.
  let notice = null;   // { kind: 'ok' | 'error', text }

  async function api(method, url, body) {
    const r = await fetch(url, {
      method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  // ---------- a minimal XLSX reader ----------
  // dist/app.js carries its own copy for the student-side import; merge the two when
  // app.js is split into modules. Until then this page stays independent of the app.
  const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xml = async (zip, p) => new DOMParser().parseFromString(await zip.file(p).async('string'), 'application/xml');
  const tags = (doc, name) => [...doc.getElementsByTagName('*')].filter(n => n.localName === name);
  const colIndex = ref => {
    let n = 0;
    for (const ch of String(ref).replace(/[^A-Z]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  async function readRows(file) {
    if (!/\.xlsx$/i.test(file.name)) throw Error('اختر ملف .xlsx. احفظ ملفات .xls القديمة بصيغة .xlsx أولًا.');
    if (file.size > 15 * 1024 * 1024) throw Error('الحد الأقصى ١٥ ميجابايت.');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const rels = await xml(zip, 'xl/_rels/workbook.xml.rels');
    const target = new Map(tags(rels, 'Relationship')
      .filter(n => n.getAttribute('TargetMode') !== 'External')
      .map(n => [n.getAttribute('Id'), ('xl/' + n.getAttribute('Target')).replace('xl//', '').replace(/^xl\/\.\.\//, '')]));
    const book = await xml(zip, 'xl/workbook.xml');
    const first = tags(book, 'sheet')[0];
    if (!first) throw Error('لا توجد أوراق في الملف.');
    const path = target.get(first.getAttributeNS(NS_R, 'id') || first.getAttribute('r:id'));
    if (!path || !zip.file(path)) throw Error('تعذّر قراءة ورقة العمل.');
    let shared = [];
    if (zip.file('xl/sharedStrings.xml')) {
      shared = tags(await xml(zip, 'xl/sharedStrings.xml'), 'si').map(si => tags(si, 't').map(t => t.textContent).join(''));
    }
    const sheet = await xml(zip, path);
    const rows = [];
    for (const row of tags(sheet, 'row')) {
      const n = Number(row.getAttribute('r'));
      if (!n || n < 5) continue;                       // headers live on row 4
      const cells = [];
      for (const c of tags(row, 'c')) {
        const v = tags(c, 'v')[0], isx = tags(c, 'is')[0];
        let text = '';
        if (c.getAttribute('t') === 's' && v) text = shared[Number(v.textContent)] ?? '';
        else if (isx) text = tags(isx, 't').map(t => t.textContent).join('');
        else if (v) text = v.textContent;
        cells[colIndex(c.getAttribute('r'))] = text;
      }
      rows[n - 5] = Array.from({ length: 12 }, (_, i) => cells[i] ?? '');
    }
    return rows.filter(Boolean);
  }

  // ---------- shared form pieces ----------
  const skillSelect = (section, value) => {
    const list = meta.skills.filter(sk => sk.section === section);
    return `<select id="skillId"><option value="">— استنتجها من التصنيف —</option>${
      list.map(sk => `<option value="${esc(sk.id)}"${sk.id === value ? ' selected' : ''}>${esc(sk.label)} (${sk.live})</option>`).join('')}</select>`;
  };

  const sel = (id, options, value, blank) => `<select id="${id}">${blank ? `<option value="">${esc(blank)}</option>` : ''}${
    options.map(o => `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;

  function authorFields() {
    return `<fieldset><legend>من ألّف السؤال؟</legend>
      <label><input type="radio" name="kind" value="human" checked> بشري — أنت أو مؤلّف</label>
      <label><input type="radio" name="kind" value="ai"> آلي — نموذج أو أداة ذكاء اصطناعي</label>
      <p><label for="model">اسم النموذج أو الأداة</label><input id="model" placeholder="مطلوب عند الاختيار الآلي" autocomplete="off"></p>
      <p class="muted">السؤال المولّد آليًا يُسجَّل بمصدره، ولا يُنشر للطلاب قبل مراجعة بشرية موثّقة.</p></fieldset>`;
  }
  const authorPayload = () => {
    const kind = main.querySelector('input[name=kind]:checked').value;
    return { authorKind: kind, authorModel: kind === 'ai' ? $('#model').value.trim() : '' };
  };

  // ---------- manual entry ----------
  function manualView() {
    const cats = meta.categories[meta.sections[0]];
    return `<section class="auth-card" style="max-width:min(860px,96vw)"><h1>إدخال سؤال</h1>
      <p class="sub">يُحفظ كمسوّدة. الشرح والمرجع مطلوبان قبل النشر، لا قبل الحفظ.</p>
      <form id="manual" novalidate>
        <p><label for="section">القسم</label>${sel('section', meta.sections, meta.sections[0])}</p>
        <p><label for="category">التصنيف</label>${sel('category', cats, cats[0])}</p>
        <p><label for="difficulty">الصعوبة</label>${sel('difficulty', meta.difficulties, meta.difficulties[1])}</p>
        <p><label for="skillId">المهارة</label>${skillSelect(meta.sections[0])}
          <span class="muted" id="skill-hint"></span></p>
        <p><label for="skill">وصف تحريري للمهارة (اختياري)</label><input id="skill" autocomplete="off"
          placeholder="لا يُستخدم في القياس؛ للتوثيق فقط"></p>
        <p id="passage-row" hidden><label for="passageId">النص</label><select id="passageId"></select>
          <span class="muted">أضف النصوص من تبويب «النصوص».</span></p>
        <p><label for="text">نص السؤال</label><textarea id="text" rows="4"></textarea></p>
        ${meta.answerLetters.map((l, i) => `<p><label for="opt${i}">الخيار ${esc(l)}</label><input id="opt${i}" autocomplete="off"></p>`).join('')}
        <p><label for="answer">الإجابة الصحيحة</label>${sel('answer', meta.answerLetters, meta.answerLetters[0])}</p>
        <p><label for="explanation">الشرح</label><textarea id="explanation" rows="3"></textarea></p>
        <p><label for="source">المرجع / إثبات الأصالة</label><input id="source" autocomplete="off" placeholder="مثال: تأليف أصلي — ٢٠٢٦/١٠/٠٤"></p>
        ${authorFields()}
        <button class="primary" type="submit">حفظ كمسوّدة</button>
      </form><div id="manual-out" role="status"></div></section>`;
  }

  function wireManual() {
    const hint = () => {
      const sk = meta.skills.find(x => x.id === $('#skillId').value);
      $('#skill-hint').textContent = sk
        ? `${sk.live} سؤالًا منشورًا في هذه المهارة.`
        : 'ستُستنتج المهارة من التصنيف إن تركتها.';
    };
    $('#section').onchange = () => {
      const section = $('#section').value;
      const cats = meta.categories[section] || [];
      $('#category').innerHTML = cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      $('#skillId').outerHTML = skillSelect(section);
      $('#skillId').onchange = hint;
      hint();
      passageRow();
    };
    $('#skillId').onchange = hint;
    hint();
    const passageRow = () => {
      const isReading = $('#category').value === meta.passageCategory;
      $('#passage-row').hidden = !isReading;
      if (isReading) {
        $('#passageId').innerHTML = passages.length
          ? passages.map(p => `<option value="${esc(p.id)}">${esc(p.id)} — ${esc(p.text.slice(0, 50))}… (${p.items})</option>`).join('')
          : '<option value="">لا نصوص بعد — أضف نصًا أولًا</option>';
      }
    };
    $('#category').onchange = passageRow;
    passageRow();
    $('#manual').onsubmit = async e => {
      e.preventDefault();
      const out = $('#manual-out');
      out.innerHTML = '<p>جارٍ الحفظ…</p>';
      const r = await api('POST', 'api/admin/items', {
        section: $('#section').value, category: $('#category').value, difficulty: $('#difficulty').value,
        skillId: $('#skillId').value, skill: $('#skill').value, text: $('#text').value,
        ...(!$('#passage-row').hidden && $('#passageId').value ? { passageId: $('#passageId').value } : {}),
        options: [0, 1, 2, 3].map(i => $('#opt' + i).value),
        answer: $('#answer').value, explanation: $('#explanation').value, source: $('#source').value,
        origin: 'manual', ...authorPayload(),
      });
      if (r.status === 201) {
        out.innerHTML = `<p class="auth-error" style="color:inherit">تم الحفظ كمسوّدة بالمعرف <code>${esc(r.data.id)}</code>. راجعه ثم انشره من قائمة الأسئلة.</p>`;
        for (const id of ['#text', '#explanation', '#skill', '#opt0', '#opt1', '#opt2', '#opt3']) $(id).value = '';
        $('#text').focus();
        await refreshCounts();
      } else {
        const errs = r.data.errors || [r.data.error || 'تعذّر الحفظ.'];
        out.innerHTML = `<ul class="auth-error">${errs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
      }
    };
  }

  // ---------- spreadsheet upload ----------
  function uploadView() {
    return `<section class="auth-card" style="max-width:min(860px,96vw)"><h1>رفع ملف Excel</h1>
      <p class="sub">بالقالب نفسه المرفق: العناوين في الصف الرابع، والأسئلة من الصف الخامس.
      الأعمدة بالترتيب: ${esc(meta.templateColumns.join(' · '))}</p>
      <p><a href="GAT_Import_Template.xlsx" download>تنزيل القالب</a></p>
      <form id="upload" novalidate>
        <p><label for="file">ملف .xlsx</label><input id="file" type="file" accept=".xlsx"></p>
        ${authorFields()}
        <button class="primary" type="submit">قراءة الملف ورفعه</button>
      </form><div id="upload-out" role="status"></div></section>`;
  }

  function wireUpload() {
    $('#upload').onsubmit = async e => {
      e.preventDefault();
      const out = $('#upload-out'), file = $('#file').files[0];
      if (!file) { out.innerHTML = '<p class="auth-error">اختر ملفًا أولًا.</p>'; return; }
      out.innerHTML = '<p>جارٍ قراءة الملف…</p>';
      let rows;
      try { rows = await readRows(file); }
      catch (err) { out.innerHTML = `<p class="auth-error">${esc(err.message)}</p>`; return; }
      if (!rows.length) { out.innerHTML = '<p class="auth-error">لا توجد صفوف بيانات من الصف الخامس.</p>'; return; }
      out.innerHTML = `<p>قُرئ ${rows.length} صفًا. جارٍ الرفع…</p>`;
      const r = await api('POST', 'api/admin/items/import', { rows, origin: 'excel', ...authorPayload() });
      if (r.status !== 200) { out.innerHTML = `<p class="auth-error">${esc(r.data.error || 'تعذّر الرفع.')}</p>`; return; }
      const bad = r.data.results.filter(x => !x.ok);
      out.innerHTML = `<p><b>أُضيف ${r.data.added} سؤالًا كمسوّدات. رُفض ${r.data.rejected}.</b></p>`
        + (bad.length ? `<div class="admin-table"><table><thead><tr><th>الصف</th><th>السبب</th></tr></thead><tbody>${
            bad.map(x => `<tr><td>${x.row}</td><td>${esc((x.errors || []).join(' — '))}</td></tr>`).join('')}</tbody></table></div>`
          : '<p>لا أخطاء.</p>');
      await refreshCounts();
    };
  }

  // ---------- the queue ----------
  function queueView() {
    const rows = list.map(it => {
      const next = (meta.transitions[it.status] || []).map(s =>
        `<button data-id="${esc(it.id)}" data-to="${s}">${esc(STATUS_LABEL[s])}</button>`).join(' ');
      return `<tr><td><code>${esc(it.id)}</code></td><td>${esc(STATUS_LABEL[it.status] || it.status)}</td>
        <td>${esc(it.section)} · ${esc(it.category)}</td>
        <td>${esc((meta.skills.find(sk => sk.id === it.skillId) || {}).label || '—')}</td>
        <td>${esc(it.difficulty)}</td>
        <td dir="auto">${esc(it.text.slice(0, 90))}${it.text.length > 90 ? '…' : ''}</td>
        <td>${esc(KIND_LABEL[it.authorKind] || it.authorKind)}${it.authorModel ? ' · ' + esc(it.authorModel) : ''}</td>
        <td>${it.explanation ? '✓' : '—'}</td><td>${next || '—'}</td></tr>`;
    }).join('');
    return `<section class="auth-card" style="max-width:min(1200px,96vw)"><h1>قائمة الأسئلة</h1>
      <p><label for="f-status">الحالة</label>${sel('f-status', meta.statuses.map(s => s), filters.status, 'الكل')}
         <label for="f-section">القسم</label>${sel('f-section', meta.sections, filters.section, 'الكل')}
         <label for="f-skill">المهارة</label>${(() => {
           const list = filters.section ? meta.skills.filter(sk => sk.section === filters.section) : meta.skills;
           return `<select id="f-skill"><option value="">الكل</option>${list.map(sk =>
             `<option value="${esc(sk.id)}"${sk.id === filters.skill ? ' selected' : ''}>${esc(sk.label)} (${sk.live})</option>`).join('')}</select>`;
         })()}
         <label for="f-q">بحث</label><input id="f-q" value="${esc(filters.q)}" autocomplete="off"></p>
      <div class="admin-table"><table><thead><tr><th>المعرف</th><th>الحالة</th><th>القسم والتصنيف</th><th>المهارة</th>
        <th>الصعوبة</th><th>السؤال</th><th>المؤلّف</th><th>شرح</th><th>نقل إلى</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9">لا نتائج.</td></tr>'}</tbody></table></div>
      <div id="queue-out" role="status"></div></section>`;
  }

  function wireQueue() {
    const reload = async () => { await loadList(); render(); };
    $('#f-status').onchange = e => { filters.status = e.target.value; reload(); };
    $('#f-section').onchange = e => { filters.section = e.target.value; filters.skill = ''; reload(); };
    $('#f-skill').onchange = e => { filters.skill = e.target.value; reload(); };
    let timer;
    $('#f-q').oninput = e => { filters.q = e.target.value; clearTimeout(timer); timer = setTimeout(reload, 300); };
    main.querySelectorAll('tbody button').forEach(b => {
      b.onclick = async () => {
        const r = await api('POST', 'api/admin/items/status', { id: b.dataset.id, status: b.dataset.to });
        if (r.status === 200) { await refreshCounts(); await reload(); }
        else {
          const errs = r.data.errors || [r.data.error || 'تعذّر النقل.'];
          $('#queue-out').innerHTML = `<ul class="auth-error">${errs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
        }
      };
    });
  }

  // ---------- passages ----------
  // A passage is written once and its questions hang off it, which is both how the real
  // test reads and the reason a correction no longer has to be made three to five times.
  function passagesView() {
    if (openPassage) {
      const p = openPassage.passage, its = openPassage.items;
      return `<section class="auth-card" style="max-width:min(1000px,96vw)">
        <p><button id="back">← كل النصوص</button></p>
        <h1>النص <code>${esc(p.id)}</code></h1>
        <p class="sub">${p.words} كلمة · ${its.length} سؤالًا عليه · آخر تعديل ${esc(String(p.updatedAt).slice(0, 10))}</p>
        <form id="edit-passage" novalidate>
          <p><label for="ptext">نص القطعة</label><textarea id="ptext" rows="10">${esc(p.text)}</textarea></p>
          <p class="muted">تعديل النص يسري على ${its.length} سؤالًا، ويُعيد المنشور منها إلى المراجعة.</p>
          <button class="primary" type="submit">حفظ النص</button>
        </form>${noticeHtml()}
        <h2>الأسئلة على هذا النص</h2>
        <div class="admin-table"><table><thead><tr><th>المعرف</th><th>الحالة</th><th>المهارة</th><th>السؤال</th></tr></thead>
          <tbody>${its.map(i => `<tr><td><code>${esc(i.id)}</code></td><td>${esc(STATUS_LABEL[i.status] || i.status)}</td>
            <td>${esc((meta.skills.find(sk => sk.id === i.skillId) || {}).label || '—')}</td>
            <td dir="auto">${esc(i.text)}</td></tr>`).join('') || '<tr><td colspan="4">لا أسئلة بعد.</td></tr>'}</tbody></table></div></section>`;
    }
    return `<section class="auth-card" style="max-width:min(1000px,96vw)"><h1>النصوص</h1>
      <p class="sub">${meta.passages} نصًا. اكتب النص مرة واحدة، ثم أضف أسئلته من «إدخال يدوي».</p>
      <form id="new-passage" novalidate>
        <p><label for="newtext">نص جديد</label><textarea id="newtext" rows="6" placeholder="الصق القطعة بلا كلمة «النص:»"></textarea></p>
        <button class="primary" type="submit">إضافة النص</button>
      </form>${noticeHtml()}
      <div class="admin-table"><table><thead><tr><th>المعرف</th><th>كلمات</th><th>أسئلة</th><th>منشورة</th><th>بداية النص</th><th></th></tr></thead>
        <tbody>${passages.map(p => `<tr><td><code>${esc(p.id)}</code></td><td>${p.words}</td><td>${p.items}</td><td>${p.live}</td>
          <td dir="auto">${esc(p.text.slice(0, 70))}…</td>
          <td><button data-open="${esc(p.id)}">عرض وتعديل</button>${p.items ? '' : ` <button data-del="${esc(p.id)}">حذف</button>`}</td></tr>`).join('')
          || '<tr><td colspan="6">لا نصوص بعد.</td></tr>'}</tbody></table></div></section>`;
  }

  function wirePassages() {
    if (openPassage) {
      $('#back').onclick = async () => { openPassage = null; notice = null; await loadPassages(); render(); };
      $('#edit-passage').onsubmit = async e => {
        e.preventDefault();
        const id = openPassage.passage.id;
        const r = await api('POST', 'api/admin/passages/update', { id, text: $('#ptext').value });
        notice = r.status === 200
          ? { kind: 'ok', text: `حُفظ النص. تأثّر ${r.data.affected} سؤالًا، وعاد ${r.data.unpublished} منها إلى المراجعة.` }
          : { kind: 'error', text: r.data.error || 'تعذّر الحفظ.' };
        if (r.status === 200) { await refreshCounts(); await openOne(id); }
        render();
      };
      return;
    }
    $('#new-passage').onsubmit = async e => {
      e.preventDefault();
      const r = await api('POST', 'api/admin/passages', { text: $('#newtext').value });
      notice = r.status === 201
        ? { kind: 'ok', text: `أُضيف النص ${r.data.id} (${r.data.words} كلمة). أضف أسئلته من «إدخال يدوي».` }
        : { kind: 'error', text: r.data.error || 'تعذّر الإضافة.' };
      if (r.status === 201) { await refreshCounts(); await loadPassages(); }
      render();
    };
    main.querySelectorAll('[data-open]').forEach(b => {
      b.onclick = async () => { await openOne(b.dataset.open); render(); };
    });
    main.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => {
        const r = await api('POST', 'api/admin/passages/delete', { id: b.dataset.del });
        notice = r.status === 200 ? { kind: 'ok', text: 'حُذف النص.' }
          : { kind: 'error', text: r.data.error || 'تعذّر الحذف.' };
        if (r.status === 200) { await refreshCounts(); await loadPassages(); }
        render();
      };
    });
  }

  async function loadPassages() {
    const r = await api('GET', 'api/admin/passages');
    passages = r.status === 200 ? r.data.passages : [];
  }
  async function openOne(id) {
    const r = await api('GET', 'api/admin/passages?id=' + encodeURIComponent(id));
    openPassage = r.status === 200 ? r.data : null;
  }

  // ---------- shell ----------
  const TABS = [['manual', 'إدخال يدوي'], ['upload', 'رفع Excel'], ['passages', 'النصوص'], ['queue', 'قائمة الأسئلة']];

  function render() {
    const counts = meta.counts;
    main.innerHTML = `<nav class="admin-stats" aria-label="أقسام البوابة">${
      TABS.map(([k, label]) => `<button data-tab="${k}"${k === tab ? ' class="primary"' : ''}>${esc(label)}</button>`).join(' ')
      }</nav><p class="muted">مسوّدات ${counts.draft} · مراجَعة ${counts.reviewed} · منشورة ${counts.live} · مسحوبة ${counts.retired} · نصوص ${meta.passages}</p>`
      + (tab === 'manual' ? manualView() : tab === 'upload' ? uploadView()
        : tab === 'passages' ? passagesView() : queueView());
    main.querySelectorAll('nav button').forEach(b => {
      b.onclick = async () => {
        tab = b.dataset.tab;
        notice = null;
        if (tab === 'queue') await loadList();
        if (tab === 'passages') { openPassage = null; await loadPassages(); }
        render();
      };
    });
    if (tab === 'passages') wirePassages();
    if (tab === 'manual') wireManual();
    if (tab === 'upload') wireUpload();
    if (tab === 'queue') wireQueue();
  }

  async function loadList() {
    const p = new URLSearchParams();
    if (filters.status) p.set('status', filters.status);
    if (filters.section) p.set('section', filters.section);
    if (filters.skill) p.set('skill', filters.skill);
    if (filters.q) p.set('q', filters.q);
    p.set('limit', '200');
    const r = await api('GET', 'api/admin/items?' + p);
    list = r.status === 200 ? r.data.items : [];
  }
  async function refreshCounts() {
    const r = await api('GET', 'api/admin/items/meta');
    if (r.status === 200) { meta.counts = r.data.counts; meta.skills = r.data.skills; meta.passages = r.data.passages; }
  }

  (async () => {
    const r = await api('GET', 'api/admin/items/meta');
    if (r.status === 401) {
      main.innerHTML = '<section class="auth-card"><h1>سجّل الدخول أولًا</h1><p class="sub">ادخل بحساب المدير من الصفحة الرئيسية ثم عد إلى هذه الصفحة.</p><a href="./">الذهاب لتسجيل الدخول</a></section>';
      return;
    }
    if (r.status === 403) {
      main.innerHTML = '<section class="auth-card"><h1>هذه الصفحة للمدير</h1><p class="sub">حسابك لا يملك صلاحية إدارة بنك الأسئلة.</p><a href="./">العودة للتدريب</a></section>';
      return;
    }
    if (r.status !== 200) { main.innerHTML = '<p class="auth-error">تعذّر تحميل البوابة. أعد تحميل الصفحة.</p>'; return; }
    meta = r.data;
    await loadPassages();
    render();
  })();
})();
