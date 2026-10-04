// Admin dashboard: lists students with progress summaries; disable/enable and reset passwords.
(function () {
  'use strict';
  const main = document.getElementById('main');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
  const date = v => v ? fmt.format(new Date(v)) : '—';
  let students = [], filter = '';

  async function api(method, url, body) {
    const r = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  async function load() {
    const r = await api('GET', 'api/admin/students');
    if (r.status === 401) { main.innerHTML = '<section class="auth-card"><h1>سجّل الدخول أولًا</h1><p class="sub">ادخل بحساب المدير من الصفحة الرئيسية ثم عد إلى هذه الصفحة.</p><a href="./">الذهاب لتسجيل الدخول</a></section>'; return; }
    if (r.status !== 200) { main.innerHTML = '<section class="auth-card"><h1>غير مسموح</h1><p class="sub">هذه الصفحة لمديري المنصة فقط.</p></section>'; return; }
    students = r.data.students; render();
  }

  function row(s) {
    const m = s.summary || {};
    const rate = m.answered ? Math.round(100 * m.correct / m.answered) + '%' : '—';
    const last = m.lastExam ? `${m.lastExam.percent}%` : '—';
    return `<tr${s.disabled ? ' class="muted"' : ''}><td><b>${esc(s.name)}</b>${s.admin ? ' <span class="tag">مدير</span>' : ''}<br><small dir="ltr">${esc(s.email)}</small></td>
      <td>${date(s.createdAt)}</td><td>${date(s.lastLogin)}</td><td>${m.answered ?? 0}</td><td>${rate}</td><td>${m.exams ?? 0}</td><td>${last}</td>
      <td>${s.disabled ? 'موقوف' : 'نشط'}</td>
      <td>${s.admin ? '' : `<button data-act="${s.disabled ? 'enable' : 'disable'}" data-id="${s.id}">${s.disabled ? 'تفعيل' : 'إيقاف'}</button> <button data-act="reset-password" data-id="${s.id}">كلمة مرور مؤقتة</button>`}</td></tr>`;
  }

  function render() {
    const list = students.filter(s => !filter || (s.name + ' ' + s.email).toLowerCase().includes(filter));
    const active = students.filter(s => s.lastLogin && Date.now() - new Date(s.lastLogin) < 7 * 864e5).length;
    const answered = students.reduce((n, s) => n + (s.summary?.answered || 0), 0);
    main.innerHTML = `<div class="topline"><div><p class="eyebrow">لوحة الإدارة</p><h1>الطلاب</h1></div><button id="csv">تنزيل CSV</button></div>
      <div class="stats admin-stats"><div class="stat"><b>${students.length}</b><span>طالب مسجّل</span></div><div class="stat"><b>${active}</b><span>نشط خلال 7 أيام</span></div><div class="stat"><b>${answered}</b><span>إجابة محفوظة</span></div></div>
      <label class="admin-search">بحث بالاسم أو البريد<input id="q" value="${esc(filter)}" type="search"></label>
      <div class="table-wrap"><table class="admin-table"><thead><tr><th>الطالب</th><th>التسجيل</th><th>آخر دخول</th><th>أسئلة مجابة</th><th>نسبة الصحة</th><th>اختبارات</th><th>آخر اختبار</th><th>الحالة</th><th></th></tr></thead>
      <tbody>${list.map(row).join('') || '<tr><td colspan="9">لا يوجد طلاب.</td></tr>'}</tbody></table></div>`;
    const q = document.getElementById('q');
    q.oninput = () => { filter = q.value.trim().toLowerCase(); render(); const n = document.getElementById('q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
    document.getElementById('csv').onclick = csv;
    main.querySelectorAll('button[data-act]').forEach(b => b.onclick = () => act(Number(b.dataset.id), b.dataset.act));
  }

  async function act(id, action) {
    const s = students.find(x => x.id === id);
    const ask = { disable: `إيقاف حساب ${s.name}؟ لن يستطيع الدخول حتى تعيد تفعيله.`, enable: `إعادة تفعيل حساب ${s.name}؟`, 'reset-password': `إنشاء كلمة مرور مؤقتة لـ ${s.name}؟ ستتوقف كلمة المرور الحالية.` }[action];
    if (!confirm(ask)) return;
    const r = await api('POST', 'api/admin/student', { id, action });
    if (r.status !== 200) return alert(r.data.error || 'تعذّر التنفيذ.');
    if (r.data.password) prompt('كلمة المرور المؤقتة (أرسلها للطالب واطلب منه تغييرها):', r.data.password);
    load();
  }

  function csv() {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['الاسم', 'البريد', 'التسجيل', 'آخر دخول', 'أسئلة مجابة', 'إجابات صحيحة', 'اختبارات', 'آخر اختبار %', 'الحالة'].map(cell).join(',')];
    for (const s of students) { const m = s.summary || {}; lines.push([s.name, s.email, s.createdAt, s.lastLogin, m.answered || 0, m.correct || 0, m.exams || 0, m.lastExam?.percent ?? '', s.disabled ? 'موقوف' : 'نشط'].map(cell).join(',')); }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'qudrat-students.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  load();
})();
