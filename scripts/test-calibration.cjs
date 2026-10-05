// The calibration pipeline: the arithmetic is right, it recovers parameters it was not told, it
// flags what it should, and simulated answers can never reach the real population.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { openDb } = require('../server/db');
const { migrateBank } = require('../server/migrate-bank');
const C = require('../server/calibration');
const S = require('../server/simulate');
const bank = require('../dist/data.json');

// ---------- the arithmetic ----------
assert.equal(Math.round(C.pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]) * 1e4) / 1e4, 0.7746,
  'pearson matches a hand-computed value');
assert.equal(C.pearson([1, 1, 1], [2, 3, 4]), null, 'no variation in x has no correlation');
assert.equal(C.pearson([1, 2], [2, 4]), 1, 'a perfect line is 1');
assert.equal(C.pearson([1, 2, 3], [3, 2, 1]), -1, 'a perfect inverse is -1');
assert.equal(C.pearson([1], [1]), null, 'one point is not a correlation');

// ---------- the correlation is corrected: the item is removed from the score it is compared to ----------
// A student who answered only this item has no rest score, so they cannot be compared at all. An
// uncorrected implementation would score them against a total containing the item and report a
// perfect correlation from nothing.
const soloAbility = new Map([[1, { correct: 1, total: 1 }], [2, { correct: 0, total: 1 }]]);
const solo = C.calibrateItem([{ userId: 1, correct: true, chosen: 0 }, { userId: 2, correct: false, chosen: 1 }], soloAbility);
assert.equal(solo.compared, 0, 'students with nothing else answered are excluded from the correlation');
assert.equal(solo.rPbis, null, 'so there is no correlation to report, rather than a spurious 1');
assert.equal(solo.pValue, 0.5, 'the p-value is still reported: it needs no comparison');

// with a rest score present, the correction is visible: a student right on this item and wrong on
// everything else pulls the correlation down, where self-inclusion would push it up
const ability = new Map([
  [1, { correct: 1, total: 10 }],   // right here, wrong on the other nine
  [2, { correct: 9, total: 10 }],   // wrong here, right on the other nine
]);
const inverted = C.calibrateItem([{ userId: 1, correct: true, chosen: 0 }, { userId: 2, correct: false, chosen: 1 }], ability);
assert.equal(inverted.rPbis, -1, 'the item runs against ability, which only the corrected score shows');
assert(inverted.flags.length === 0, 'two responses are far too few to flag anything');

// ---------- recovery: parameters the pipeline was never told ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-calib-'));
const db = openDb(dir);
const spec = [];
for (const a of [0.3, 0.8, 1.5, 2.5]) for (const b of [-1.5, 0, 1.5]) spec.push({ id: `I-${a}-${b}`, a, b, key: 0 });
spec.push({ id: 'I-MAGNET', a: 1.2, b: 0, key: 0, magnet: 2 });
spec.push({ id: 'I-VERYEASY', a: 1.5, b: -4, key: 0 });
spec.push({ id: 'I-VERYHARD', a: 1.5, b: 4, key: 0 });

const sim = S.simulateResponses(spec, { students: 1200, seed: 99 });
assert.equal(S.writeSynthetic(db, sim.rows, { run: 'recovery' }), sim.rows.length);
const report = C.calibrateBank(db, { synthetic: true });
assert.equal(report.synthetic, true, 'the report says which population it came from');
assert.equal(report.students, 1200);
assert.equal(report.items, spec.length);
const by = Object.fromEntries(report.stats.map(s => [s.itemId, s]));

// difficulty: a harder item is answered correctly by fewer, at every discrimination level
for (const a of [0.8, 1.5, 2.5]) {
  const [easy, mid, hard] = [-1.5, 0, 1.5].map(b => by[`I-${a}-${b}`].pValue);
  assert(easy > mid && mid > hard, `p falls as b rises at a=${a}: ${easy} ${mid} ${hard}`);
  assert(Math.abs(mid - 0.5) < 0.08, `an item at b=0 sits near 0.5 for a normal cohort: ${mid}`);
}
// discrimination: the correlation rises with the parameter that governs it
const rs = [0.3, 0.8, 1.5, 2.5].map(a => by[`I-${a}-0`].rPbis);
assert(rs.every((v, i) => i === 0 || v > rs[i - 1]), 'r rises with a: ' + rs.join(', '));
assert(rs[0] < 0.2 && rs[3] > 0.45, 'and spans a usable range: ' + rs.join(', '));

// ---------- flags ----------
assert(by['I-0.3-0'].flags.includes('weak-discrimination'), 'a barely discriminating item is flagged');
assert(by['I-VERYEASY'].pValue > C.EASY_AT, 'the fixture is as easy as intended: ' + by['I-VERYEASY'].pValue);
assert(by['I-VERYEASY'].flags.includes('too-easy'));
assert(by['I-VERYEASY'].flags.some(f => f.startsWith('dead-distractor')),
  'when almost nobody answers wrong, the distractors are flagged dead: ' + by['I-VERYEASY'].flags.join(','));
assert(by['I-VERYHARD'].pValue < C.HARD_AT, 'the hard fixture is as hard as intended: ' + by['I-VERYHARD'].pValue);
assert(by['I-VERYHARD'].flags.includes('too-hard'));
assert.deepEqual(by['I-2.5-0'].flags, [], 'a sound item carries no flag: ' + JSON.stringify(by['I-2.5-0']));

// the magnet distractor is visible in the shares, which is the point of distractor analysis
const shares = by['I-MAGNET'].distractors.shares;
assert(shares[2] > 0.3, 'the attractive wrong option took a large share: ' + JSON.stringify(shares));
assert(shares[1] < 0.1 && shares[3] < 0.1, 'and the other two took little');
assert.equal(shares.reduce((a, b) => a + b, 0).toFixed(2), '1.00', 'the shares account for every choice');

// ---------- a wrong key shows up as negative discrimination ----------
// Same answers, but scored against the wrong option: stronger students now look wrong, which is
// exactly the signature that should make someone re-read the key.
const magnetRows = db.prepare("SELECT sim_user AS userId, correct, chosen FROM synthetic_responses WHERE item_id = 'I-MAGNET'").all();
const abil = new Map();
for (const r of db.prepare('SELECT sim_user AS userId, correct FROM synthetic_responses').all()) {
  const a = abil.get(r.userId) || { correct: 0, total: 0 };
  a.total++; if (r.correct) a.correct++;
  abil.set(r.userId, a);
}
const mis = C.calibrateItem(magnetRows.map(r => ({ userId: r.userId, correct: r.chosen === 2, chosen: r.chosen })), abil);
assert(mis.rPbis < 0, 'scoring the magnet as correct inverts the correlation: ' + mis.rPbis);
assert(mis.flags.includes('negative-discrimination'), 'and that is flagged: ' + mis.flags.join(','));

// ---------- too few responses is said, not papered over ----------
const thin = C.calibrateItem(
  Array.from({ length: 40 }, (_, i) => ({ userId: i + 1, correct: i % 2 === 0, chosen: i % 4 })),
  new Map(Array.from({ length: 40 }, (_, i) => [i + 1, { correct: 5, total: 10 }])));
assert.equal(thin.insufficient, true, `under ${C.MIN_RESPONSES} responses is marked insufficient`);
assert.deepEqual(thin.flags, [], 'and under 50 nothing is flagged at all, to avoid judging on noise');
assert(thin.pValue !== null, 'the figures are still computed and reported with their n');

// ---------- the two populations cannot mix ----------
migrateBank(db, bank);          // a real bank, with no real responses
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM responses').get().n, 0,
  'the simulator wrote nothing into the real responses table');
const real = C.calibrateBank(db, { synthetic: false });
assert.equal(real.synthetic, false);
assert.equal(real.items, 0, 'a real calibration sees none of the simulated answers');
assert.equal(real.responses, 0);
const stored = db.prepare('SELECT synthetic, COUNT(*) AS n FROM item_stats GROUP BY synthetic').all();
assert.deepEqual(stored, [{ synthetic: 1, n: spec.length }], 'every stored statistic carries its mark');

// a real response alongside them stays apart
db.prepare("INSERT INTO users (email, name, pass_hash, created_at) VALUES ('r@example.com', 'ط', 'x', '2026-01-01')").run();
const uid = db.prepare("SELECT id FROM users WHERE email = 'r@example.com'").get().id;
db.prepare(`INSERT INTO responses (user_id, item_id, status, correct, chosen, answered_at, ingested_at)
  VALUES (?, 'V-A-001', 'correct', 1, 0, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`).run(uid);
const real2 = C.calibrateBank(db, { synthetic: false });
assert.equal(real2.items, 1, 'the real calibration sees exactly the one real answer');
assert.equal(real2.responses, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_stats WHERE synthetic = 0").get().n, 1);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM item_stats WHERE synthetic = 1").get().n, spec.length,
  'and does not overwrite the synthetic figures it sits beside');

// ---------- the simulator is reproducible, and a rerun adds nothing ----------
const again = S.simulateResponses(spec, { students: 20, seed: 99 });
const once = S.simulateResponses(spec, { students: 20, seed: 99 });
assert.deepEqual(again.rows, once.rows, 'the same seed gives the same answers');
assert.notDeepEqual(S.simulateResponses(spec, { students: 20, seed: 100 }).rows, once.rows, 'a different seed does not');
assert.equal(S.writeSynthetic(db, sim.rows, { run: 'recovery' }), 0, 're-writing the same run adds nothing');
assert(S.writeSynthetic(db, sim.rows.slice(0, 10), { run: 'second' }) === 10, 'a differently labelled run is kept apart');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS: calibration — pearson matches hand-computed values; the item-total correlation is corrected, so a student with nothing else answered is excluded instead of yielding a spurious 1; across ${spec.length} simulated items with parameters the pipeline was never given, p falls as difficulty rises and r rises with discrimination (${rs[0]} to ${rs[3]}); too-easy, too-hard, weak and negative discrimination and dead distractors are each flagged, a wrong key shows as negative discrimination, and under ${C.MIN_RESPONSES} responses is reported as insufficient rather than presented as a measurement; simulated answers live in their own table, a real calibration sees none of them, and every stored statistic carries the mark of the population it came from.`);
