#!/usr/bin/env node
// The page's honesty rules, checked without a browser or a calendar.
//   node test-status.js
//
// Lives in worker/ with the other tests even though ../status.js is browser
// code, because this is where `node test-*.js` already lives and a second test
// convention two directories up helps nobody. status.js imports nothing, so it
// loads straight into node.

import assert from 'node:assert/strict';
import { feedStatus, ageOf, WORKER_QUIET_MS } from '../status.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(` FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

// A fixed "now" so every age below is exact arithmetic, not a race with the
// wall clock. Central afternoon, well after the morning fetch would have run.
const TODAY = '2026-07-20';
const YESTERDAY = '2026-07-19';
const NOW = Date.parse('2026-07-20T18:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms).toISOString();

const feed = (date, n = 12) => ({ feed_date: date, items: Array.from({ length: n }, () => ({ video_id: 'x' })) });
const heartbeat = (okAgeMs, runAgeMs = 0) => ({
  last_ok_at: okAgeMs == null ? null : ago(okAgeMs),
  last_run_at: ago(runAgeMs),
});
const decide = (over) => feedStatus({ today: TODAY, now: NOW, ...over });

// ===== ageOf =====

check('ageOf: null / unparseable is null, a real stamp is positive', () => {
  assert.equal(ageOf(null, NOW), null);
  assert.equal(ageOf('not a date', NOW), null);
  assert.equal(ageOf(ago(2 * HOUR), NOW), 2 * HOUR);
});

check('ageOf: a clock-skewed future stamp is negative (reads as fresh below)', () => {
  assert.ok(ageOf(new Date(NOW + 5 * 60_000).toISOString(), NOW) < 0);
});

// ===== A fresh, current day =====

check("today's dozen with a live worker is silent — no line to spend", () => {
  const s = decide({ feed: feed(TODAY), status: heartbeat(11 * HOUR) });
  assert.equal(s.hasFeed, true);
  assert.equal(s.isToday, true);
  assert.equal(s.level, 'ok');
  assert.equal(s.silent, true);
  assert.equal(s.note, '');
});

check("today's dozen is still current even if the heartbeat won't load", () => {
  // Today's row exists, so the worker plainly succeeded; a missing status is no
  // reason to nag on a fresh day.
  const s = decide({ feed: feed(TODAY), status: null });
  assert.equal(s.silent, true);
  assert.equal(s.level, 'ok');
});

check('a thin but current day is a full-strength ok (count lives in app.js)', () => {
  const s = decide({ feed: feed(TODAY, 8), status: heartbeat(11 * HOUR) });
  assert.equal(s.isToday, true);
  assert.equal(s.silent, true);
});

// ===== A stale dozen: which silence? =====

check("stale feed + a worker that ran ok recently → 'isn't up yet', not down", () => {
  const s = decide({ feed: feed(YESTERDAY), status: heartbeat(20 * HOUR) });
  assert.equal(s.hasFeed, true);
  assert.equal(s.isToday, false);
  assert.equal(s.level, 'waiting');
  assert.equal(s.silent, false);
  assert.match(s.note, /isn't up yet/);
});

check("stale feed + no successful run for over a day → 'gone quiet' (down)", () => {
  const s = decide({ feed: feed(YESTERDAY), status: heartbeat(31 * HOUR) });
  assert.equal(s.level, 'down');
  assert.match(s.note, /gone quiet/);
  assert.match(s.note, /last good dozen/);
});

check('stale feed + a heartbeat that has never succeeded (null last_ok) is down', () => {
  const s = decide({ feed: feed(YESTERDAY), status: heartbeat(null) });
  assert.equal(s.level, 'down');
});

check("stale feed + no heartbeat at all does NOT cry wolf → 'isn't up yet'", () => {
  // A missing status is an unknown worker, not a down one; the feed's own date
  // (shown in the header) is the only signal, and it's benign by default.
  const s = decide({ feed: feed(YESTERDAY), status: null });
  assert.equal(s.level, 'waiting');
  assert.match(s.note, /isn't up yet/);
});

check('the quiet threshold is an upper bound: exactly at it is still waiting', () => {
  const at = decide({ feed: feed(YESTERDAY), status: heartbeat(WORKER_QUIET_MS) });
  assert.equal(at.level, 'waiting');
  const past = decide({ feed: feed(YESTERDAY), status: heartbeat(WORKER_QUIET_MS + 60_000) });
  assert.equal(past.level, 'down');
});

// ===== No dozen at all =====

check('no feed + a down worker → the fetcher-quiet empty screen', () => {
  const s = decide({ feed: null, status: heartbeat(40 * HOUR) });
  assert.equal(s.hasFeed, false);
  assert.equal(s.level, 'down');
  assert.match(s.empty.title, /gone quiet/i);
  assert.equal(s.note, '');
});

check("no feed + a healthy worker → the calm 'isn't up yet' empty screen", () => {
  const s = decide({ feed: null, status: heartbeat(3 * HOUR) });
  assert.equal(s.level, 'waiting');
  assert.match(s.empty.title, /isn't up yet/);
});

check('no feed + no status (Supabase unreachable) stays calm, never down', () => {
  const s = decide({ feed: null, status: null });
  assert.equal(s.level, 'waiting');
  assert.match(s.empty.title, /isn't up yet/);
});

check('an empty items array counts as no feed, not a zero-length dozen', () => {
  const s = decide({ feed: feed(TODAY, 0), status: heartbeat(2 * HOUR) });
  assert.equal(s.hasFeed, false);
});

// ===== Never a raw error =====

check('a status carrying a last_error never surfaces it in any field', () => {
  const status = { ...heartbeat(40 * HOUR), last_error: 'ECONNREFUSED at 127.0.0.1:5432 stack...' };
  const s = decide({ feed: feed(YESTERDAY), status });
  for (const v of [s.note, s.label, s.empty.title, s.empty.body]) {
    assert.doesNotMatch(String(v), /ECONNREFUSED/);
  }
});

console.log(`\n${passed} checks passed.`);
