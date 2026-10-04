// The admin side of the question intake gateway: a form, a spreadsheet upload, and the
// review queue. Every path posts to /api/admin/items*, so the server's validator in
// server/items.js decides what is acceptable — this page only reports its verdicts.
(function () {
  'use strict';
  const main = document.getElementById('main');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => main.querySelector(sel);
  const STATUS_LABEL = { draft: 'مسوّدة', reviewed: 'مراجَع', live: 'منشور', retired: 'مسحوب' };
  const KIND_LABEL = { human: 'بشري', ai: 'آلي' };
  let meta = null, tab = 'manual', list = [], filters = { status: '', section: '', q: '' };

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
        <p><label for="skill">المهارة (اختياري)</label><input id="skill" autocomplete="off"></p>
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
    $('#section').onchange = () => {
      const cats = meta.categories[$('#section').value] || [];
      $('#category').innerHTML = cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    };
    $('#manual').onsubmit = async e => {
      e.preventDefault();
      const out = $('#manual-out');
      out.innerHTML = '<p>جارٍ الحفظ…</p>';
      const r = await api('POST', 'api/admin/items', {
        section: $('#section').value, category: $('#category').value, difficulty: $('#difficulty').value,
        skill: $('#skill').value, text: $('#text').value,
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
        <td>${esc(it.section)} · ${esc(it.category)}</td><td>${esc(it.difficulty)}</td>
        <td dir="auto">${esc(it.text.slice(0, 90))}${it.text.length > 90 ? '…' : ''}</td>
        <td>${esc(KIND_LABEL[it.authorKind] || it.authorKind)}${it.authorModel ? ' · ' + esc(it.authorModel) : ''}</td>
        <td>${it.explanation ? '✓' : '—'}</td><td>${next || '—'}</td></tr>`;
    }).join('');
    return `<section class="auth-card" style="max-width:min(1200px,96vw)"><h1>قائمة الأسئلة</h1>
      <p><label for="f-status">الحالة</label>${sel('f-status', meta.statuses.map(s => s), filters.status, 'الكل')}
         <label for="f-section">القسم</label>${sel('f-section', meta.sections, filters.section, 'الكل')}
         <label for="f-q">بحث</label><input id="f-q" value="${esc(filters.q)}" autocomplete="off"></p>
      <div class="admin-table"><table><thead><tr><th>المعرف</th><th>الحالة</th><th>القسم والتصنيف</th>
        <th>الصعوبة</th><th>السؤال</th><th>المؤلّف</th><th>شرح</th><th>نقل إلى</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8">لا نتائج.</td></tr>'}</tbody></table></div>
      <div id="queue-out" role="status"></div></section>`;
  }

  function wireQueue() {
    const reload = async () => { await loadList(); render(); };
    $('#f-status').onchange = e => { filters.status = e.target.value; reload(); };
    $('#f-section').onchange = e => { filters.section = e.target.value; reload(); };
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

  // ---------- shell ----------
  const TABS = [['manual', 'إدخال يدوي'], ['upload', 'رفع Excel'], ['queue', 'قائمة الأسئلة']];

  function render() {
    const counts = meta.counts;
    main.innerHTML = `<nav class="admin-stats" aria-label="أقسام البوابة">${
      TABS.map(([k, label]) => `<button data-tab="${k}"${k === tab ? ' class="primary"' : ''}>${esc(label)}</button>`).join(' ')
      }</nav><p class="muted">مسوّدات ${counts.draft} · مراجَعة ${counts.reviewed} · منشورة ${counts.live} · مسحوبة ${counts.retired}</p>`
      + (tab === 'manual' ? manualView() : tab === 'upload' ? uploadView() : queueView());
    main.querySelectorAll('nav button').forEach(b => {
      b.onclick = async () => { tab = b.dataset.tab; if (tab === 'queue') await loadList(); render(); };
    });
    if (tab === 'manual') wireManual();
    if (tab === 'upload') wireUpload();
    if (tab === 'queue') wireQueue();
  }

  async function loadList() {
    const p = new URLSearchParams();
    if (filters.status) p.set('status', filters.status);
    if (filters.section) p.set('section', filters.section);
    if (filters.q) p.set('q', filters.q);
    p.set('limit', '200');
    const r = await api('GET', 'api/admin/items?' + p);
    list = r.status === 200 ? r.data.items : [];
  }
  async function refreshCounts() {
    const r = await api('GET', 'api/admin/items/meta');
    if (r.status === 200) meta.counts = r.data.counts;
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
    render();
  })();
})();
