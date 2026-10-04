// Student accounts. When the page is served by server/server.js, the student signs in and the
// workspace the app keeps in localStorage is mirrored to their account. Opened from file:// or
// a plain static host (no /api), the app runs exactly as before with browser-only storage.
(function () {
  'use strict';
  const STORE = 'gat-workspace-v2', OWNER = 'qudrat-account-owner', OFFLINE_BACKUP = 'gat-workspace-v2-offline-backup';
  const APP = ['vendor/jszip.min.js', 'data.js', 'bank.js', 'core.js', 'app.js', 'learn.js', 'engine.js', 'qiyas.js'];
  const KEEPALIVE_LIMIT = 60000;
  const main = document.getElementById('main');
  let user = null, rev = 0, pending = null, lastSent = null, inflight = false, blocked = false, timer = null;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get: k => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
    del: k => { try { localStorage.removeItem(k) } catch {} },
  };

  // Workspaces hold full exam snapshots and grow to megabytes; gzip shrinks uploads about tenfold.
  async function gzip(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function api(method, url, body, opts = {}) {
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
      if (payload.length > 8192 && typeof CompressionStream === 'function') { payload = await gzip(payload); headers['Content-Encoding'] = 'gzip'; }
    }
    if (opts.keepalive && payload && payload.length > KEEPALIVE_LIMIT) opts = { ...opts, keepalive: false };
    const res = await fetch(url, { method, cache: 'no-store', credentials: 'same-origin', keepalive: !!opts.keepalive, headers, body: payload });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = resolve; s.onerror = () => reject(Error(src));
      document.head.appendChild(s);
    });
  }
  async function bootApp() {
    main.innerHTML = '<p role="status">جارٍ تحميل بنك الأسئلة…</p>';
    for (const src of APP) {
      await loadScript(src);
      // bank.js only installs the loader; it is awaited here so window.GAT_BASE is final
      // before core.js and the rest read it. A failure leaves the bundled bank in place.
      if (src === 'bank.js' && typeof window.loadServerBank === 'function') {
        try { window.bankSource = await window.loadServerBank(); }
        catch { window.bankSource = 'bundled'; }
      }
    }
  }

  // ---------- sign in / register ----------
  function showAuth(canRegister, mode = 'login', message = '') {
    document.body.classList.add('auth-mode');
    const reg = mode === 'register';
    main.innerHTML = `<section class="auth-card">
      <p class="eyebrow">قدرات | مساحة التدريب</p>
      <h1>${reg ? 'إنشاء حساب طالب' : 'تسجيل الدخول'}</h1>
      <p class="sub">${reg ? 'أنشئ حسابك ليُحفظ تقدمك ونتائج اختباراتك وتكمل من أي جهاز.' : 'ادخل إلى حسابك لتكمل تدريبك من حيث توقفت.'}</p>
      <form id="auth-form" novalidate>
        ${reg ? '<label>الاسم<input name="name" autocomplete="name" required maxlength="80"></label>' : ''}
        <label>البريد الإلكتروني<input name="email" type="email" dir="ltr" autocomplete="email" required></label>
        <label>كلمة المرور<input name="password" type="password" dir="ltr" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="8" required></label>
        ${reg ? '<p class="hint">8 أحرف على الأقل.</p>' : ''}
        <p class="auth-error" role="alert">${esc(message)}</p>
        <button class="primary" type="submit">${reg ? 'إنشاء الحساب' : 'دخول'}</button>
      </form>
      ${canRegister ? `<p class="auth-switch">${reg ? 'لديك حساب؟' : 'طالب جديد؟'} <button type="button" id="auth-switch">${reg ? 'تسجيل الدخول' : 'أنشئ حسابًا'}</button></p>` : ''}
    </section>`;
    const form = document.getElementById('auth-form');
    form.querySelector('input').focus();
    document.getElementById('auth-switch')?.addEventListener('click', () => showAuth(canRegister, reg ? 'login' : 'register'));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(form), btn = form.querySelector('button[type=submit]'), err = form.querySelector('.auth-error');
      btn.disabled = true; err.textContent = '';
      try {
        const r = await api('POST', reg ? 'api/register' : 'api/login', Object.fromEntries(f));
        if (r.status === 200 || r.status === 201) { user = r.data.user; document.body.classList.remove('auth-mode'); return startCloud(); }
        err.textContent = r.data.error || 'تعذّر الدخول. حاول مرة أخرى.';
      } catch { err.textContent = 'تعذّر الاتصال بالخادم. تحقّق من الإنترنت وحاول مرة أخرى.'; }
      btn.disabled = false;
    });
  }

  // ---------- cloud sync ----------
  async function startCloud() {
    const r = await api('GET', 'api/progress');
    if (r.status !== 200) throw Error('progress ' + r.status);
    rev = r.data.rev;
    const local = store.get(STORE), owner = store.get(OWNER);
    let upload = null;
    if (r.data.data) {
      // Progress made offline before this browser was ever linked to an account is kept aside, not lost.
      if (local && !owner && local !== r.data.data) store.set(OFFLINE_BACKUP, local);
      store.set(STORE, r.data.data);
      lastSent = r.data.data;
    } else if (local && (!owner || owner === String(user.id))) {
      upload = local; // first sign-in on a browser that already holds this student's work
    } else {
      store.del(STORE); // another student's data on a shared computer
    }
    store.set(OWNER, String(user.id));
    hookStorage();
    decorate();
    await bootApp();
    if (upload) queue(upload);
  }

  function hookStorage() {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      original.call(this, key, value);
      if (key === STORE && this === window.localStorage) queue(String(value));
    };
  }

  function queue(raw) {
    // Throttle, not debounce: an exam saves every few seconds and must still reach the server.
    pending = raw;
    if (!timer && !inflight) timer = setTimeout(flush, 3000);
    setSync('saving');
  }

  async function flush(keepalive) {
    clearTimeout(timer); timer = null;
    if (inflight || blocked || pending === null) return;
    if (pending === lastSent) { pending = null; return setSync('saved'); }
    const raw = pending;
    pending = null; inflight = true;
    try {
      const r = await api('PUT', 'api/progress', { data: raw, rev }, { keepalive });
      if (r.status === 200) { rev = r.data.rev; lastSent = raw; setSync(pending === null ? 'saved' : 'saving'); }
      else if (r.status === 409) { pending = raw; blocked = true; showConflict(); }
      else if (r.status === 401) { pending = raw; blocked = true; setSync('error'); banner('انتهت جلستك. سجّل الدخول من جديد لتُحفظ آخر التغييرات في حسابك.', [['تسجيل الدخول', () => location.reload()]]); }
      else { pending = pending ?? raw; setSync('error'); timer = setTimeout(flush, 10000); }
    } catch {
      pending = pending ?? raw; setSync('offline'); timer = setTimeout(flush, 5000);
    } finally { inflight = false; }
    if (pending !== null && !blocked && !timer) flush();
  }

  function showConflict() {
    setSync('error');
    banner('حُفظ تقدّم أحدث في حسابك من جهاز أو نافذة أخرى. اختر النسخة التي تريد الاحتفاظ بها.', [
      ['تحميل النسخة المحفوظة في الحساب', () => location.reload()],
      ['اعتماد بيانات هذه النافذة', async () => {
        const r = await api('GET', 'api/progress');
        if (r.status !== 200) return;
        rev = r.data.rev; blocked = false; banner(''); flush();
      }],
    ]);
  }

  function banner(text, actions = []) {
    let el = document.getElementById('sync-warning');
    if (!el) { el = document.createElement('div'); el.id = 'sync-warning'; el.setAttribute('role', 'alert'); document.getElementById('storage-warning').after(el); }
    el.hidden = !text;
    el.innerHTML = text ? `<span>${esc(text)}</span>` : '';
    for (const [label, fn] of actions) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; el.append(b); }
  }

  const SYNC_TEXT = { saved: '☁ محفوظ في حسابك', saving: 'جارٍ الحفظ…', offline: 'غير متصل، سيُحفظ عند عودة الاتصال', error: 'لم يُحفظ في الحساب' };
  function setSync(state) {
    const el = document.getElementById('sync-state');
    if (el) { el.textContent = SYNC_TEXT[state]; el.dataset.state = state; }
  }

  // ---------- header account menu ----------
  function decorate() {
    const end = document.querySelector('.header-end');
    const priv = end.querySelector('.private');
    if (priv) priv.remove();
    end.insertAdjacentHTML('afterbegin', `<span id="sync-state" data-state="saved">${SYNC_TEXT.saved}</span>
      <div class="account"><button id="account-btn" aria-expanded="false">${esc(user.name)} ▾</button>
      <div id="account-menu" hidden><p><b>${esc(user.name)}</b><br><span dir="ltr">${esc(user.email)}</span></p>
      ${user.admin ? '<a href="admin.html">لوحة الإدارة</a>' : ''}
      <details><summary>تغيير كلمة المرور</summary><form id="password-form">
        <label>الحالية<input name="current" type="password" dir="ltr" autocomplete="current-password" required></label>
        <label>الجديدة<input name="password" type="password" dir="ltr" autocomplete="new-password" minlength="8" required></label>
        <button type="submit">حفظ</button><p class="auth-error" role="status"></p></form></details>
      <button id="logout">تسجيل الخروج</button></div></div>`);
    const note = document.querySelector('.local-note');
    if (note) note.textContent = 'تقدّمك محفوظ في حسابك ويمكنك متابعته من أي جهاز.';
    const btn = document.getElementById('account-btn'), menu = document.getElementById('account-menu');
    btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); };
    document.addEventListener('click', e => { if (!e.target.closest('.account')) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    document.getElementById('logout').onclick = logout;
    const pf = document.getElementById('password-form');
    pf.onsubmit = async e => {
      e.preventDefault();
      const out = pf.querySelector('.auth-error');
      const r = await api('POST', 'api/password', Object.fromEntries(new FormData(pf))).catch(() => ({ status: 0, data: {} }));
      out.textContent = r.status === 200 ? 'تم تغيير كلمة المرور.' : (r.data.error || 'تعذّر الحفظ.');
      if (r.status === 200) pf.reset();
    };
  }

  async function logout() {
    if ((pending !== null || inflight) && !blocked) {
      await flush();
      if (pending !== null && !confirm('آخر التغييرات لم تُحفظ في حسابك بعد. هل تريد الخروج على أي حال؟')) return;
    }
    try { await api('POST', 'api/logout', {}); } catch {}
    store.del(STORE); store.del(OWNER);
    location.reload();
  }

  addEventListener('visibilitychange', () => { if (document.hidden && user) flush(true); });
  addEventListener('pagehide', () => { if (user) flush(true); });
  addEventListener('online', () => { if (user && !blocked) flush(); });
  addEventListener('beforeunload', e => { if (user && (pending !== null || inflight) && !blocked) e.preventDefault(); });

  // ---------- start ----------
  (async () => {
    let r;
    try { r = await api('GET', 'api/me'); }
    catch { return bootApp(); } // file:// or no network: browser-only mode
    if (r.status === 200) { user = r.data.user; return startCloud(); }
    if (r.status === 401 && r.data.error === 'unauthenticated') return showAuth(r.data.registration !== false);
    return bootApp(); // static hosting without the account server
  })().catch(err => {
    main.innerHTML = `<section class="auth-card"><h1>تعذّر التحميل</h1><p class="sub">${esc(err.message)}</p><button onclick="location.reload()">إعادة المحاولة</button></section>`;
  });
})();
