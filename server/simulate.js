'use strict';
// Generates SYNTHETIC responses with known item parameters, so the calibration pipeline can be
// tested by whether it recovers them. Every row it writes carries synthetic = 1.
//
// This exists to validate the arithmetic, not to describe anybody. Numbers computed from these
// rows say nothing about real students or real item difficulty, and the marking is what keeps the
// two apart: calibrateBank reads one population at a time and stamps its output with the mark.
//
// A two-parameter logistic model: a student of ability θ answers an item of difficulty b and
// discrimination a correctly with probability 1 / (1 + e^(−a(θ − b))). A wrong answer picks among
// the distractors, with one distractor optionally made attractive so distractor analysis has
// something real to find.

// Deterministic generator: a seeded run reproduces exactly, so a failing test can be re-read.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
// Box-Muller, for abilities drawn from a standard normal
function normal(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const P = (theta, a, b) => 1 / (1 + Math.exp(-a * (theta - b)));

// items: [{ id, a, b, key, magnet? }] — magnet is the index of an attractive wrong option.
// Returns { rows, truth } where truth holds the parameters used, for a recovery check.
function simulateResponses(items, { students = 400, seed = 20261005, blankRate = 0 } = {}) {
  const rand = rng(seed);
  const rows = [];
  const abilities = [];
  for (let s = 0; s < students; s++) abilities.push(normal(rand));

  for (let s = 0; s < students; s++) {
    const theta = abilities[s];
    for (const it of items) {
      if (blankRate && rand() < blankRate) {
        rows.push({ userId: s + 1, itemId: it.id, correct: 0, chosen: null, status: 'blank' });
        continue;
      }
      const right = rand() < P(theta, it.a, it.b);
      let chosen;
      if (right) chosen = it.key;
      else {
        const wrong = [0, 1, 2, 3].filter(i => i !== it.key);
        // a magnet distractor takes most of the wrong answers; otherwise they spread evenly
        if (Number.isInteger(it.magnet) && it.magnet !== it.key && rand() < 0.7) chosen = it.magnet;
        else chosen = wrong[Math.floor(rand() * wrong.length)];
      }
      rows.push({ userId: s + 1, itemId: it.id, correct: right ? 1 : 0, chosen,
                  status: right ? 'correct' : 'wrong' });
    }
  }
  return { rows, truth: items.map(it => ({ id: it.id, a: it.a, b: it.b })), abilities };
}

// Writes simulated rows into synthetic_responses — never into the real table. The separation is
// the whole safeguard: there is no code path by which a simulated answer becomes a student's.
// `run` labels the batch so two simulations can coexist and be told apart.
function writeSynthetic(db, rows, { run = 'default', now = () => new Date().toISOString() } = {}) {
  const insert = db.prepare(`INSERT OR IGNORE INTO synthetic_responses
    (sim_user, item_id, status, correct, chosen, run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const at = now();
  let written = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      written += insert.run(r.userId, r.itemId, r.status, r.correct, r.chosen, run, at).changes;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return written;
}

module.exports = { rng, normal, P, simulateResponses, writeSynthetic };
