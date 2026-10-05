'use strict';
// Empirical item calibration from the responses table.
//
// The bank's `difficulty` field is an editorial guess; the app itself says so. These two numbers
// replace the guess with measurement:
//
//   p_value — the proportion of students who got the item right. The observed difficulty.
//   r_pbis  — how well the item separates stronger students from weaker ones.
//
// r_pbis is the CORRECTED item-total correlation: each student's comparison score excludes the
// item being calibrated. Correlating an item against a total that contains it correlates it partly
// with itself, which inflates the figure for every item and most for the short tests. The
// correction is not a refinement, it is what makes the number mean what it claims.
//
// Real and simulated answers live in two tables, and this reads exactly one of them per run. The
// separation is structural rather than a flag to remember: a number that cannot be traced to real
// students must never be readable as if it could, and item_stats carries the mark of its source.

const MIN_RESPONSES = 300;        // below this the figures are reported with `insufficient`
const MIN_FOR_FLAGS = 50;         // below this no quality flag is raised at all

// Thresholds. p outside [0.15, 0.95] means the item barely sorts anyone: nearly everyone gets it
// right or nearly everyone gets it wrong. r below 0.15 means it does not track ability, and a
// negative r means it runs against it, which usually points at a wrong key.
const EASY_AT = 0.95, HARD_AT = 0.15, WEAK_R = 0.15, DEAD_DISTRACTOR = 0.02;

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;   // no variation: everyone answered alike
  return num / Math.sqrt(dx * dy);
}

const round = (v, places = 4) => (v === null || v === undefined ? null : Math.round(v * 10 ** places) / 10 ** places);

// rows: { userId, correct, chosen } for ONE item.
// ability: Map userId -> { correct, total } over every item that user answered.
function calibrateItem(rows, ability, optionCount = 4) {
  const n = rows.length;
  const correct = rows.reduce((t, r) => t + (r.correct ? 1 : 0), 0);
  const result = {
    n, pValue: n ? round(correct / n) : null, rPbis: null,
    distractors: null, flags: [], insufficient: n < MIN_RESPONSES,
  };
  if (!n) { result.flags.push('no-responses'); return result; }

  // the rest score: this student's proportion correct on everything except this item
  const xs = [], ys = [];
  for (const r of rows) {
    const a = ability.get(r.userId);
    if (!a) continue;
    const restTotal = a.total - 1;
    if (restTotal < 1) continue;            // answered nothing else; contributes no comparison
    xs.push(r.correct ? 1 : 0);
    ys.push((a.correct - (r.correct ? 1 : 0)) / restTotal);
  }
  result.rPbis = round(pearson(xs, ys));
  result.compared = xs.length;

  // distractor shares, including blanks
  const counts = new Array(optionCount).fill(0);
  let blank = 0;
  for (const r of rows) {
    if (Number.isInteger(r.chosen) && r.chosen >= 0 && r.chosen < optionCount) counts[r.chosen]++;
    else blank++;
  }
  const chosenTotal = counts.reduce((a, b) => a + b, 0);
  result.distractors = { counts, blank, shares: counts.map(c => (chosenTotal ? round(c / chosenTotal) : null)) };

  if (n >= MIN_FOR_FLAGS) {
    if (result.pValue > EASY_AT) result.flags.push('too-easy');
    if (result.pValue < HARD_AT) result.flags.push('too-hard');
    if (result.rPbis === null) result.flags.push('no-variation');
    else if (result.rPbis < 0) result.flags.push('negative-discrimination');   // suspect the key
    else if (result.rPbis < WEAK_R) result.flags.push('weak-discrimination');
    if (chosenTotal >= MIN_FOR_FLAGS) {
      const dead = result.distractors.shares
        .map((s, i) => ({ i, s }))
        .filter(d => d.s !== null && d.s < DEAD_DISTRACTOR);
      if (dead.length) result.flags.push(`dead-distractor:${dead.map(d => d.i).join(',')}`);
    }
  }
  return result;
}

// Reads one population — real or synthetic, never both — and calibrates every item in it.
function calibrateBank(db, { synthetic = false, store = true, now = () => new Date().toISOString() } = {}) {
  const mark = synthetic ? 1 : 0;
  // Blanks are excluded. A left-blank item is scored wrong on the test, but for difficulty it
  // conflates "did not know" with "did not reach", and the second is about the clock rather than
  // the item. The blank count is reported per item so that signal is not lost.
  const rows = synthetic
    ? db.prepare(`SELECT sim_user AS userId, item_id AS itemId, correct, chosen
        FROM synthetic_responses WHERE status <> 'blank'`).all()
    : db.prepare(`SELECT user_id AS userId, item_id AS itemId, correct, chosen
        FROM responses WHERE status <> 'blank'`).all();

  // ability first, over everything each student answered in this population
  const ability = new Map();
  for (const r of rows) {
    const a = ability.get(r.userId) || { correct: 0, total: 0 };
    a.total++; if (r.correct) a.correct++;
    ability.set(r.userId, a);
  }
  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.itemId)) byItem.set(r.itemId, []);
    byItem.get(r.itemId).push({ userId: r.userId, correct: !!r.correct, chosen: r.chosen });
  }

  const report = { synthetic: mark === 1, items: 0, responses: rows.length, students: ability.size,
                   calibrated: 0, insufficient: 0, flagged: 0, stats: [] };
  const insert = db.prepare(`INSERT INTO item_stats
    (item_id, synthetic, n, p_value, r_pbis, distractors, flags, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, synthetic) DO UPDATE SET
      n = excluded.n, p_value = excluded.p_value, r_pbis = excluded.r_pbis,
      distractors = excluded.distractors, flags = excluded.flags, computed_at = excluded.computed_at`);

  const at = now();
  if (store) db.exec('BEGIN');
  try {
    for (const [itemId, itemRows] of byItem) {
      const s = calibrateItem(itemRows, ability);
      report.items++;
      if (s.insufficient) report.insufficient++; else report.calibrated++;
      if (s.flags.length) report.flagged++;
      report.stats.push({ itemId, ...s });
      if (store) {
        insert.run(itemId, mark, s.n, s.pValue, s.rPbis,
          JSON.stringify(s.distractors), JSON.stringify(s.flags), at);
      }
    }
    if (store) db.exec('COMMIT');
  } catch (err) { if (store) db.exec('ROLLBACK'); throw err; }
  return report;
}

module.exports = {
  MIN_RESPONSES, MIN_FOR_FLAGS, EASY_AT, HARD_AT, WEAK_R, DEAD_DISTRACTOR,
  pearson, calibrateItem, calibrateBank,
};
