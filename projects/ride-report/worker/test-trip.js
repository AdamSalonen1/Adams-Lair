// Pure-function checks for the trip logic. No network, no CLI, no clock —
// every case passes its own "today" in, which is the reason trip.js takes one.
//   node test-trip.js
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  tripWindow,
  forecastDaysFor,
  buildTripTruth,
  pickBestDays,
  tripFallbackSummary,
  placeholderPayload,
  pastPayload,
  coordinateProblem,
  badLocationPayload,
  HORIZON_DAYS,
} from './trip.js';
import { validateTripPayload } from './synth.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

const TODAY = '2026-07-19';
const trip = (start, end, extra = {}) => ({
  id: 't1',
  title: 'Test trip',
  location_name: 'Somewhere, MN',
  lat: 46.8,
  lon: -96.8,
  start_date: start,
  end_date: end,
  ...extra,
});

console.log('date math');
check('addDays forward', () => assert.equal(addDays('2026-07-19', 5), '2026-07-24'));
check('addDays backward', () => assert.equal(addDays('2026-07-19', -5), '2026-07-14'));
check('addDays crosses month', () => assert.equal(addDays('2026-07-30', 3), '2026-08-02'));
check('addDays crosses year', () => assert.equal(addDays('2026-12-30', 3), '2027-01-02'));
check('addDays handles leap day', () => assert.equal(addDays('2028-02-28', 1), '2028-02-29'));
// The reason this file does string/UTC math instead of local Date arithmetic:
// US DST springs forward on 2026-03-08, and a local-time +24h lands on the same
// calendar day.
check('addDays survives a DST boundary', () => assert.equal(addDays('2026-03-07', 1), '2026-03-08'));
check('daysBetween counts forward', () => assert.equal(daysBetween('2026-07-19', '2026-07-24'), 5));
check('daysBetween is zero for same day', () => assert.equal(daysBetween('2026-07-19', '2026-07-19'), 0));
check('daysBetween survives a DST boundary', () => assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2));

console.log('tripWindow');
check('a trip that ended is past', () => {
  assert.equal(tripWindow(trip('2026-07-10', '2026-07-18'), TODAY).status, 'past');
});
check('a trip ending today is not past', () => {
  assert.notEqual(tripWindow(trip('2026-07-10', '2026-07-19'), TODAY).status, 'past');
});
check('a trip underway clamps coveredStart to today', () => {
  const w = tripWindow(trip('2026-07-15', '2026-07-22'), TODAY);
  assert.equal(w.status, 'covered');
  assert.equal(w.coveredStart, TODAY);
  assert.equal(w.coveredEnd, '2026-07-22');
});
check('a trip fully inside the horizon is covered', () => {
  const w = tripWindow(trip('2026-07-25', '2026-07-28'), TODAY);
  assert.equal(w.status, 'covered');
  assert.equal(w.coveredStart, '2026-07-25');
  assert.equal(w.coveredEnd, '2026-07-28');
  assert.equal(w.partial, false);
});
check('the last reachable start date is covered, not beyond', () => {
  // today + 15 is the last day forecast_days=16 reaches.
  const edge = addDays(TODAY, HORIZON_DAYS - 1);
  assert.equal(tripWindow(trip(edge, edge), TODAY).status, 'covered');
});
check('one day past the horizon is beyond', () => {
  const past = addDays(TODAY, HORIZON_DAYS);
  assert.equal(tripWindow(trip(past, past), TODAY).status, 'beyond');
});
check('a trip running off the end is partial', () => {
  const w = tripWindow(trip('2026-07-28', '2026-08-20'), TODAY);
  assert.equal(w.status, 'partial');
  assert.equal(w.partial, true);
  assert.equal(w.coveredEnd, addDays(TODAY, HORIZON_DAYS - 1));
});
check('firmsUpOn is the day the trip enters the horizon', () => {
  const start = '2026-09-01';
  const long = trip(start, '2026-09-05');
  const { firmsUpOn } = tripWindow(long, TODAY);
  // The day before, invisible; on the day, visible. It comes into view
  // 'partial' rather than 'covered' because only its first day is reachable —
  // the rest arrives one day per day after that.
  assert.equal(tripWindow(long, addDays(firmsUpOn, -1)).status, 'beyond');
  assert.equal(tripWindow(long, firmsUpOn).status, 'partial');
  // A single-day trip has nothing trailing off the end, so it lands covered.
  assert.equal(tripWindow(trip(start, start), firmsUpOn).status, 'covered');
});

console.log('forecastDaysFor');
check('same-day trip asks for one day', () => assert.equal(forecastDaysFor(TODAY, TODAY), 1));
check('counts today as day one', () => assert.equal(forecastDaysFor(TODAY, '2026-07-24'), 6));
check('clamps to the horizon', () => assert.equal(forecastDaysFor(TODAY, '2027-01-01'), HORIZON_DAYS));
check('never returns less than one', () => assert.equal(forecastDaysFor(TODAY, '2026-07-01'), 1));

console.log('pickBestDays');
const day = (date, score) => ({ date, day_score: score, windows: [], mud: { risk: 'dry', weightedPrecip: 0 } });
check('ranks by score, best first', () => {
  assert.deepEqual(
    pickBestDays([day('2026-07-20', 55), day('2026-07-21', 88), day('2026-07-22', 71)]),
    ['2026-07-21', '2026-07-22'],
  );
});
check('caps at three', () => {
  assert.equal(pickBestDays([90, 88, 86, 84, 82].map((s, i) => day(`2026-07-2${i}`, s))).length, 3);
});
check('excludes days under 60', () => {
  assert.deepEqual(pickBestDays([day('2026-07-20', 59), day('2026-07-21', 61)]), ['2026-07-21']);
});
check('names the least-bad day when none clear the bar', () => {
  assert.deepEqual(pickBestDays([day('2026-07-20', 30), day('2026-07-21', 44)]), ['2026-07-21']);
});
check('ties break by date', () => {
  assert.deepEqual(pickBestDays([day('2026-07-22', 80), day('2026-07-20', 80)])[0], '2026-07-20');
});
check('ignores unscored days', () => {
  assert.deepEqual(pickBestDays([day('2026-07-20', null), day('2026-07-21', 65)]), ['2026-07-21']);
});
check('empty in, empty out', () => assert.deepEqual(pickBestDays([]), []));

console.log('buildTripTruth');
// A scoreReport()-shaped stub: three days, and hourly precip only on the first
// so the per-day mud reading has something to differ over.
const report = {
  days: [
    { date: '2026-07-19', dayScore: 40, windows: [], hourly: [] },
    { date: '2026-07-20', dayScore: 82, windows: [{ start: '2026-07-20T07:00', end: '2026-07-20T11:00', avgScore: 88, best: true }], hourly: [] },
    { date: '2026-07-21', dayScore: 75, windows: [], hourly: [] },
    { date: '2026-07-22', dayScore: 90, windows: [], hourly: [] },
  ],
};
const hours = [
  { t: '2026-07-19T09:00', precipitation: 0.6 },
  { t: '2026-07-20T09:00', precipitation: 0 },
  { t: '2026-07-21T09:00', precipitation: 0 },
  { t: '2026-07-22T09:00', precipitation: 0 },
];

check('keeps only the trip days', () => {
  const truth = buildTripTruth(report, hours, { coveredStart: '2026-07-20', coveredEnd: '2026-07-21' }, trip('2026-07-20', '2026-07-21'));
  assert.deepEqual(truth.days.map((d) => d.date), ['2026-07-20', '2026-07-21']);
});
check('mud is recomputed per day, not copied', () => {
  const truth = buildTripTruth(report, hours, { coveredStart: '2026-07-19', coveredEnd: '2026-07-22' }, trip('2026-07-19', '2026-07-22'));
  // 0.6" fell at 09:00 on the 19th, and each day is read from its own noon.
  // The recency weighting then walks it down: same day at full weight (muddy),
  // 27h later at 0.6x (damp), and past 72h it drops out entirely (dry). A
  // single copied reading could not produce this gradient, which is the point —
  // what matters for a trip is the mud on the day you actually ride.
  assert.equal(truth.days[0].mud.risk, 'muddy');
  assert.equal(truth.days[1].mud.risk, 'damp');
  assert.equal(truth.days[3].mud.risk, 'dry');
});
check('derives covered_through from the data, not the request', () => {
  // Ask for more than the stub report contains — coverage must reflect reality.
  const truth = buildTripTruth(report, hours, { coveredStart: '2026-07-19', coveredEnd: '2026-08-10' }, trip('2026-07-19', '2026-08-10'));
  assert.equal(truth.covered_through, '2026-07-22');
  assert.equal(truth.partial, true);
});
check('a fully covered trip is not partial', () => {
  const truth = buildTripTruth(report, hours, { coveredStart: '2026-07-20', coveredEnd: '2026-07-21' }, trip('2026-07-20', '2026-07-21'));
  assert.equal(truth.partial, false);
});
check('throws rather than write an empty trip report', () => {
  assert.throws(() => buildTripTruth(report, hours, { coveredStart: '2026-09-01', coveredEnd: '2026-09-05' }, trip('2026-09-01', '2026-09-05')));
});

console.log('deterministic prose');
const truth = buildTripTruth(report, hours, { coveredStart: '2026-07-19', coveredEnd: '2026-07-22' }, trip('2026-07-19', '2026-07-22'));
check('fallback validates', () => assert.deepEqual(validateTripPayload(tripFallbackSummary(truth)), []));
check('fallback preserves ground truth', () => {
  const fb = tripFallbackSummary(truth);
  assert.deepEqual(fb.days, truth.days);
  assert.deepEqual(fb.best_days, truth.best_days);
});
check('fallback names the best day', () => {
  assert.match(tripFallbackSummary(truth).summary, /Wed, Jul 22/);
});
check('fallback admits it is not the real narrative', () => {
  assert.match(tripFallbackSummary(truth).summary, /Narrative unavailable/);
});
check('fallback quotes the best window in plain time', () => {
  const oneDay = buildTripTruth(report, hours, { coveredStart: '2026-07-20', coveredEnd: '2026-07-20' }, trip('2026-07-20', '2026-07-20'));
  assert.match(tripFallbackSummary(oneDay).summary, /7 AM to 11 AM/);
});
check('fallback says so when the whole trip is bad', () => {
  const bleak = { ...truth, days: truth.days.map((d) => ({ ...d, day_score: 25 })), best_days: ['2026-07-19'] };
  assert.match(tripFallbackSummary(bleak).summary, /least-bad/);
});
check('fallback flags a partial forecast', () => {
  const partial = { ...truth, partial: true, covered_through: '2026-07-22' };
  assert.match(tripFallbackSummary(partial).summary, /beyond the horizon/);
});

console.log('coordinateProblem');
check('accepts real coordinates', () => assert.equal(coordinateProblem({ lat: 46.87, lon: -96.79 }), null));
check('accepts a legitimate zero latitude', () => assert.equal(coordinateProblem({ lat: 0, lon: -96.79 }), null));
check('accepts a legitimate zero longitude', () => assert.equal(coordinateProblem({ lat: 46.87, lon: 0 }), null));
check('rejects Null Island', () => assert.match(coordinateProblem({ lat: 0, lon: 0 }), /0, 0/));
check('rejects missing', () => assert.match(coordinateProblem({ lat: null, lon: null }), /missing/));
check('rejects NaN', () => assert.match(coordinateProblem({ lat: NaN, lon: 5 }), /missing/));
check('rejects out-of-range latitude', () => assert.match(coordinateProblem({ lat: 91, lon: 0 }), /latitude/));
check('rejects out-of-range longitude', () => assert.match(coordinateProblem({ lat: 0, lon: 181 }), /longitude/));
check('bad-location payload validates', () => {
  const p = badLocationPayload(trip('2026-07-24', '2026-07-26'), 'are still at 0, 0');
  assert.deepEqual(validateTripPayload(p), []);
  assert.equal(p.bad_location, true);
  assert.match(p.summary, /latitude and longitude/);
});

console.log('placeholders');
check('beyond-horizon placeholder validates', () => {
  const p = placeholderPayload(trip('2026-09-01', '2026-09-05'), { firmsUpOn: '2026-08-18' });
  assert.deepEqual(validateTripPayload(p), []);
  assert.equal(p.beyond_horizon, true);
  assert.deepEqual(p.days, []);
});
check('placeholder names the date it firms up', () => {
  const p = placeholderPayload(trip('2026-09-01', '2026-09-05'), { firmsUpOn: '2026-08-18' });
  assert.match(p.summary, /Aug 18/);
});
check('past payload validates', () => {
  const p = pastPayload(trip('2026-07-01', '2026-07-05'));
  assert.deepEqual(validateTripPayload(p), []);
  assert.equal(p.past, true);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
