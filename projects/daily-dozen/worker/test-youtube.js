#!/usr/bin/env node
// Pure-function checks for discovery: duration parsing, the embed/Short filter,
// velocity ranking, and the whole selectDozen(). No network, no clock — every
// case pins its own inputs, so this runs anywhere and never flakes.
//
//   node test-youtube.js

import assert from 'node:assert/strict';
import { parseDurationSec, filterReason, isNonLatinTitle, velocity, selectDozen, toItem } from './youtube.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed += 1; }
  catch (err) { console.error(` FAIL  ${name}\n         ${err.message}`); failed += 1; }
}

const CONFIG = { maxDurationSec: 60, region: 'US', dozenSize: 12 };

// A minimal hydrated video, overridable per case. `snippet` merges (so a case
// can set just publishedAt and keep the title/channel defaults); the other
// blocks REPLACE, so passing `statistics: {}` genuinely means "no view count".
const video = (over = {}) => ({
  id: 'id' in over ? over.id : 'vid',
  snippet: { title: 'T', channelTitle: 'C', publishedAt: '2026-07-20T06:00:00Z', ...over.snippet },
  contentDetails: over.contentDetails ?? { duration: 'PT30S' },
  status: over.status ?? { embeddable: true },
  statistics: over.statistics ?? { viewCount: '1000' },
});

// ===== parseDurationSec =====

test('parseDurationSec handles S / M+S / M / H+M+S', () => {
  assert.equal(parseDurationSec('PT19S'), 19);
  assert.equal(parseDurationSec('PT1M5S'), 65);
  assert.equal(parseDurationSec('PT2M'), 120);
  assert.equal(parseDurationSec('PT1H2M3S'), 3723);
  assert.equal(parseDurationSec('PT60S'), 60);
});

test('parseDurationSec rejects junk and non-strings', () => {
  assert.equal(parseDurationSec('garbage'), null);
  assert.equal(parseDurationSec('PT'), null);
  assert.equal(parseDurationSec('P1D'), null);
  assert.equal(parseDurationSec(''), null);
  assert.equal(parseDurationSec(null), null);
  assert.equal(parseDurationSec(41), null);
});

// ===== filterReason =====

test('filterReason keeps a plain embeddable Short', () => {
  assert.equal(filterReason(video(), CONFIG), null);
});

test('filterReason drops non-embeddable', () => {
  assert.equal(filterReason(video({ status: { embeddable: false } }), CONFIG), 'not-embeddable');
});

test('filterReason drops over-long and missing-duration', () => {
  assert.equal(filterReason(video({ contentDetails: { duration: 'PT2M5S' } }), CONFIG), 'too-long');
  assert.equal(filterReason(video({ contentDetails: { duration: 'nope' } }), CONFIG), 'no-duration');
  // Exactly at the cutoff is kept.
  assert.equal(filterReason(video({ contentDetails: { duration: 'PT60S' } }), CONFIG), null);
});

test('filterReason drops age-restricted', () => {
  const v = video({ contentDetails: { duration: 'PT40S', contentRating: { ytRating: 'ytAgeRestricted' } } });
  assert.equal(filterReason(v, CONFIG), 'age-restricted');
});

test('filterReason drops region-blocked (blocked list and allowed list)', () => {
  const blocked = video({ contentDetails: { duration: 'PT25S', regionRestriction: { blocked: ['US'] } } });
  assert.equal(filterReason(blocked, CONFIG), 'region-blocked');
  const allowedElsewhere = video({ contentDetails: { duration: 'PT25S', regionRestriction: { allowed: ['GB'] } } });
  assert.equal(filterReason(allowedElsewhere, CONFIG), 'region-blocked');
  const allowedHere = video({ contentDetails: { duration: 'PT25S', regionRestriction: { allowed: ['US', 'GB'] } } });
  assert.equal(filterReason(allowedHere, CONFIG), null);
});

test('filterReason drops a video with no id', () => {
  assert.equal(filterReason({ ...video(), id: undefined }, CONFIG), 'no-id');
});

// ===== filterReason — the English/American language gate =====

test('filterReason keeps English-declared and unlabelled Latin videos', () => {
  // Explicitly English audio: kept.
  assert.equal(filterReason(video({ snippet: { defaultAudioLanguage: 'en-US' } }), CONFIG), null);
  // No language metadata at all + a Latin title: kept (we drop only on evidence).
  assert.equal(filterReason(video({ snippet: { title: 'Most viewed Shorts of 2025' } }), CONFIG), null);
});

test('filterReason drops a video that declares a non-English language', () => {
  // Latin title, but the metadata says the audio is Hindi -> not for this feed.
  assert.equal(filterReason(video({ snippet: { defaultAudioLanguage: 'hi' } }), CONFIG), 'lang-mismatch');
  assert.equal(filterReason(video({ snippet: { defaultLanguage: 'es' } }), CONFIG), 'lang-mismatch');
});

test('filterReason drops a predominantly non-Latin title (the Hindi case)', () => {
  const hindi = video({ snippet: { title: 'दुनिया का सबसे मजेदार वीडियो 😂' } });
  assert.equal(filterReason(hindi, CONFIG), 'non-latin-title');
});

test('filterReason keeps an emoji/number-only title (nothing to judge)', () => {
  assert.equal(filterReason(video({ snippet: { title: '🔥🔥🔥 2025 🏆' } }), CONFIG), null);
});

test('filterReason: REQUIRE_LATIN_TITLE off lets a non-Latin title through', () => {
  const jp = video({ snippet: { title: 'サメの赤ちゃん' } });
  assert.equal(filterReason(jp, { ...CONFIG, requireLatinTitle: false }), null);
});

// ===== isNonLatinTitle =====

test('isNonLatinTitle: Latin (incl. accents), emoji-only, and non-Latin scripts', () => {
  assert.equal(isNonLatinTitle('Most Viewed YouTube Shorts of 2025'), false);
  assert.equal(isNonLatinTitle('Café au lait, résumé'), false); // accented Latin is still Latin
  assert.equal(isNonLatinTitle('🔥🔥🔥 100% 🏆'), false);        // no letters -> not judged
  assert.equal(isNonLatinTitle('दुनिया का सबसे'), true);         // Devanagari
  assert.equal(isNonLatinTitle('OMG 😱 मजेदार वीडियो देखो अभी'), true); // majority Devanagari
  assert.equal(isNonLatinTitle('サメの赤ちゃん'), true);          // Japanese
  assert.equal(isNonLatinTitle(42), false);                      // non-string
});

// ===== velocity =====

test('velocity: a recent rocket outranks an older video with more lifetime views', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const rocket = video({ statistics: { viewCount: '1000000' }, snippet: { publishedAt: '2026-07-20T06:00:00Z' } }); // 6h -> ~166k/h
  const veteran = video({ statistics: { viewCount: '5000000' }, snippet: { publishedAt: '2026-07-18T12:00:00Z' } }); // 48h -> ~104k/h
  assert.ok(velocity(rocket, now) > velocity(veteran, now));
});

test('velocity: missing stats or date is zero, and never divides by zero', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  assert.equal(velocity(video({ statistics: {} }), now), 0);
  assert.equal(velocity(video({ snippet: { publishedAt: 'nope' } }), now), 0);
  // Published "now" would be a zero denominator without the one-hour floor.
  const justNow = video({ statistics: { viewCount: '3600' }, snippet: { publishedAt: '2026-07-20T12:00:00Z' } });
  assert.ok(Number.isFinite(velocity(justNow, now)) && velocity(justNow, now) === 3600);
});

// ===== selectDozen =====

test('selectDozen filters, ranks by velocity, trims to dozenSize, and tallies drops', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const g1 = video({ id: 'g1', statistics: { viewCount: '3600000' }, snippet: { publishedAt: '2026-07-20T00:00:00Z' } }); // 12h -> 300k/h
  const g2 = video({ id: 'g2', statistics: { viewCount: '1000000' }, snippet: { publishedAt: '2026-07-20T11:00:00Z' } }); // 1h -> 1M/h
  const g3 = video({ id: 'g3', statistics: { viewCount: '2000000' }, snippet: { publishedAt: '2026-07-20T08:00:00Z' } }); // 4h -> 500k/h
  const g4 = video({ id: 'g4', statistics: { viewCount: '5000000' }, snippet: { publishedAt: '2026-07-18T12:00:00Z' } }); // 48h -> ~104k/h
  const bad1 = video({ id: 'b1', status: { embeddable: false } });
  const bad2 = video({ id: 'b2', contentDetails: { duration: 'PT3M' } });
  const bad3 = video({ id: 'b3', contentDetails: { duration: 'PT30S', regionRestriction: { blocked: ['US'] } } });

  const { items, stats } = selectDozen([g1, bad1, g2, bad2, g3, bad3, g4], { ...CONFIG, dozenSize: 3 }, now);

  assert.equal(stats.candidates, 7);
  assert.equal(stats.survived, 4);
  assert.equal(stats.kept, 3);
  assert.deepEqual(stats.dropped, { 'not-embeddable': 1, 'too-long': 1, 'region-blocked': 1 });
  // Top three by velocity, in order: g2 (1M/h) > g3 (500k/h) > g1 (300k/h). g4 trimmed.
  assert.deepEqual(items.map((i) => i.video_id), ['g2', 'g3', 'g1']);
});

test('selectDozen reports a thin day (survived < dozenSize) without padding', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const only = [video({ id: 'a' }), video({ id: 'b' })];
  const { items, stats } = selectDozen(only, { ...CONFIG, dozenSize: 12 }, now);
  assert.equal(stats.survived, 2);
  assert.equal(stats.kept, 2);
  assert.equal(items.length, 2); // honest short, not padded to 12
});

test('selectDozen tolerates empty / missing input', () => {
  assert.deepEqual(selectDozen([], CONFIG, 0).items, []);
  assert.deepEqual(selectDozen(undefined, CONFIG, 0).items, []);
});

// ===== toItem =====

test('toItem produces exactly the frozen feed item shape', () => {
  const item = toItem(video({ id: 'xyz', statistics: { viewCount: '1234567' }, contentDetails: { duration: 'PT42S' } }));
  assert.deepEqual(Object.keys(item).sort(), ['channel_title', 'duration_sec', 'published_at', 'title', 'video_id', 'view_count']);
  assert.equal(item.video_id, 'xyz');
  assert.equal(item.duration_sec, 42);
  assert.equal(item.view_count, 1234567);
  assert.equal(typeof item.published_at, 'string');
});

test('toItem coerces a missing view count to null rather than NaN', () => {
  const item = toItem(video({ statistics: {} }));
  assert.equal(item.view_count, null);
});

console.log(`\n${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);
