// Takes the question bank from the server when there is one, and keeps the bundled copy
// otherwise. Runs after data.js, so window.GAT_BASE always holds a usable bank before any
// other module reads it: opened from file:// or a static host the app behaves exactly as it
// did, and a server whose items table is still empty is treated the same as no server.
//
// The server stores a reading question's stem only, with its passage in its own row. The
// views still expect one string, so the passage is rejoined here, and passageId and
// passageText are left on the question for the ones that render them apart.
(function () {
  'use strict';
  const BUNDLED = window.GAT_BASE;

  function rejoin(payload) {
    const byId = new Map((payload.passages || []).map(p => [p.id, p.text]));
    const questions = payload.questions.map(q => {
      if (!q.passageId) return q;
      const passageText = byId.get(q.passageId) || '';
      return passageText
        ? { ...q, passageText, text: `النص: ${passageText}\n\n${q.text}` }
        : q;
    });
    // tests and the editorial summary are not item data and stay with the bundle, so a
    // fixed form the app already knows keeps working against the server's bank.
    return {
      ...BUNDLED,
      questions,
      passages: payload.passages || [],
      bankSource: 'server',
      bankCount: questions.length,
    };
  }

  function sane(payload) {
    return payload && Array.isArray(payload.questions) && payload.questions.length > 0
      && payload.questions.every(q => q && typeof q.id === 'string' && typeof q.text === 'string'
        && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.answer)
        && q.answer >= 0 && q.answer < 4);
  }

  window.loadServerBank = async function loadServerBank() {
    if (!BUNDLED || !Array.isArray(BUNDLED.questions)) return 'bundled';
    try {
      const res = await fetch('api/bank', { cache: 'no-store' });
      if (!res.ok) return 'bundled';
      const payload = await res.json();
      // A malformed or empty payload must never replace a bank that works. A student seeing
      // no questions is worse than a student seeing yesterday's.
      if (!sane(payload)) return 'bundled';
      window.GAT_BASE = rejoin(payload);
      return 'server';
    } catch {
      return 'bundled';     // offline, file://, a static host, or a server without /api
    }
  };
})();
