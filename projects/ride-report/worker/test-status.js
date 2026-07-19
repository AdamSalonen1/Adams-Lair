// The page's honesty rules, checked without a browser or a calendar.
//   node test-status.js
//
// Lives in worker/ with the other tests even though ../status.js is browser
// code, because this is where `node test-*.js` already lives and a second test
// convention two directories up helps nobody.

import assert from 'node:assert/strict';
import { reportStatus, NARRATIVE_FRESH_MS, NARRATIVE_MAX_AGE_MS, WORKER_QUIET_MS } from '../status.js';

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

// A fixed "now" so every age below is exact arithmetic rather than a race with
// the wall clock.
const NOW = Date.parse('2026-07-19T20:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const formatStamp = () => 'STAMP';
const report = (age, source = 'claude') => ({
  generated_at: ago(age),
  source,
  payload: { summary: 'Morning is the move.' },
});
const heartbeat = (okAge) => ({ last_ok_at: okAge == null ? null : ago(okAge), last_run_at: ago(0) });

const status = (row, workerRow) => reportStatus({ row, status: workerRow, now: NOW, formatStamp });

console.log('a healthy day');
check('fresh report and a live worker is a green dot and no text', () => {
  const s = status(report(30 * MINUTE), heartbeat(30 * MINUTE));
  assert.equal(s.level, 'ok');
  assert.equal(s.showNarrative, true);
  assert.deepEqual(s.notes, []);
});
check('the dot still says something out loud', () => {
  assert.match(status(report(30 * MINUTE), heartbeat(30 * MINUTE)).label, /current/);
});
check('a clock-skewed future report is fresh, not broken', () => {
  const s = status(report(-3 * MINUTE), heartbeat(0));
  assert.equal(s.level, 'ok');
  assert.equal(s.showNarrative, true);
});

console.log('an ageing report');
check('past the freshness bound it is shown WITH a timestamp', () => {
  const s = status(report(NARRATIVE_FRESH_MS + MINUTE), heartbeat(MINUTE));
  assert.equal(s.level, 'stale');
  assert.equal(s.showNarrative, true);
  assert.deepEqual(s.notes, ['Report from STAMP']);
});
check('exactly at the bound is still fresh', () => {
  assert.equal(status(report(NARRATIVE_FRESH_MS), heartbeat(MINUTE)).level, 'ok');
});
check('past the max age the prose is dropped, and the page says so', () => {
  const s = status(report(NARRATIVE_MAX_AGE_MS + MINUTE), heartbeat(MINUTE));
  assert.equal(s.showNarrative, false);
  assert.equal(s.level, 'stale');
  assert.match(s.notes.join(' '), /score is live/);
});
check('a dropped narrative never renders silently', () => {
  // The whole point of the phase: degrading to score-only is fine, doing it
  // without a word is not.
  const s = status(report(NARRATIVE_MAX_AGE_MS + HOUR), heartbeat(MINUTE));
  assert.equal(s.silent, false);
  assert.ok(s.notes.length > 0);
});

console.log('the overnight gap');
check('nine hours of silence overnight is the schedule working, not an outage', () => {
  // 8 PM report, read at 5 AM. Amber for the age, but the Pi is not "quiet".
  const s = status(report(9 * HOUR), heartbeat(9 * HOUR));
  assert.equal(s.level, 'stale');
  assert.deepEqual(s.notes, ['Report from STAMP']);
});
check('past the quiet bound the dot goes red', () => {
  const s = status(report(WORKER_QUIET_MS + HOUR), heartbeat(WORKER_QUIET_MS + HOUR));
  assert.equal(s.level, 'down');
  assert.match(s.notes.join(' '), /gone quiet/);
});

console.log('the Pi is unplugged');
check('a day-old report plus a silent worker reads as down, not merely stale', () => {
  const s = status(report(26 * HOUR), heartbeat(26 * HOUR));
  assert.equal(s.level, 'down');
  assert.equal(s.showNarrative, false);
  assert.match(s.notes.join(' '), /score is live/);
});
check('a heartbeat that has never succeeded counts as quiet', () => {
  assert.equal(status(report(MINUTE), heartbeat(null)).level, 'down');
});
check('no heartbeat row at all falls back to report age, and does not cry wolf', () => {
  // An older deployment, or a failed read. Inferring "the Pi is down" from the
  // absence of evidence would light the page up red for no reason.
  const s = status(report(30 * MINUTE), null);
  assert.equal(s.level, 'ok');
  assert.deepEqual(s.notes, []);
});

console.log('Claude outage days');
check('a fallback report is flagged as auto-generated', () => {
  const s = status(report(MINUTE, 'fallback'), heartbeat(MINUTE));
  assert.deepEqual(s.notes, ['Auto-generated (no narrative)']);
  assert.equal(s.level, 'ok');
});
check('auto-generated and stale are both said, on one line', () => {
  const s = status(report(6 * HOUR, 'fallback'), heartbeat(MINUTE));
  assert.deepEqual(s.notes, ['Auto-generated (no narrative)', 'Report from STAMP']);
});
check('a dropped fallback narrative is not labelled auto-generated', () => {
  // Nothing is on screen to attribute, so the note would describe prose the
  // reader cannot see.
  const s = status(report(30 * HOUR, 'fallback'), heartbeat(MINUTE));
  assert.equal(s.showNarrative, false);
  assert.ok(!s.notes.some((n) => n.includes('Auto-generated')));
});

console.log('Supabase is unreachable');
check('nothing fetched means no dot at all', () => {
  const s = status(null, null);
  assert.equal(s.silent, true);
  assert.equal(s.showNarrative, false);
});
check('a heartbeat with no report still reports', () => {
  const s = status(null, heartbeat(MINUTE));
  assert.equal(s.silent, false);
  assert.equal(s.level, 'stale');
  assert.match(s.notes.join(' '), /No current write-up/);
});
check('a report with no payload is treated as no report', () => {
  const s = status({ generated_at: ago(MINUTE), source: 'claude', payload: {} }, heartbeat(MINUTE));
  assert.equal(s.showNarrative, false);
});
check('an unparseable timestamp does not throw or read as fresh', () => {
  const s = status({ generated_at: 'not a date', source: 'claude', payload: { summary: 'x' } }, heartbeat(MINUTE));
  assert.equal(s.showNarrative, false);
});

console.log(`\n${passed} checks passed`);
