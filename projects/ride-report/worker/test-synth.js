// Pure-function checks for the synthesis guardrails. No network, no CLI.
//   node test-synth.js
import assert from 'node:assert/strict';
import { extractJson, validatePayload, fallbackPayload } from './synth.js';

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

const truth = {
  day_score: 73,
  windows: [{ start: '2026-07-18T06:00', end: '2026-07-18T12:00', avgScore: 96, best: true }],
  mud: { risk: 'dry', weightedPrecip: 0 },
};

console.log('extractJson');
check('bare JSON', () => assert.equal(extractJson('{"a":1}').a, 1));
check('fenced JSON', () => assert.equal(extractJson('```json\n{"a":2}\n```').a, 2));
check('unlabelled fence', () => assert.equal(extractJson('```\n{"a":3}\n```').a, 3));
check('prose wrapper', () => assert.equal(extractJson('Here you go:\n{"a":4}\nHope that helps!').a, 4));
check('leading whitespace', () => assert.equal(extractJson('\n\n  {"a":5}  ').a, 5));
check('throws on no JSON', () => assert.throws(() => extractJson('no object here')));
check('throws on non-string', () => assert.throws(() => extractJson(null)));

console.log('validatePayload');
const valid = { ...truth, summary: 'Good day.', headline: 'Great' };
check('accepts valid', () => assert.deepEqual(validatePayload(valid), []));
check('rejects non-object', () => assert.equal(validatePayload('nope').length, 1));
check('rejects missing summary', () => {
  const { summary, ...rest } = valid;
  assert.ok(validatePayload(rest).some((e) => e.includes('summary')));
});
check('rejects empty summary', () => {
  assert.ok(validatePayload({ ...valid, summary: '   ' }).some((e) => e.includes('summary')));
});
check('rejects score > 100', () => {
  assert.ok(validatePayload({ ...valid, day_score: 140 }).some((e) => e.includes('between 0 and 100')));
});
check('rejects score < 0', () => {
  assert.ok(validatePayload({ ...valid, day_score: -5 }).some((e) => e.includes('between 0 and 100')));
});
check('rejects string score', () => {
  assert.ok(validatePayload({ ...valid, day_score: '73' }).some((e) => e.includes('must be a number')));
});
check('rejects bad mud risk', () => {
  assert.ok(validatePayload({ ...valid, mud: { risk: 'swampy', weightedPrecip: 0 } }).some((e) => e.includes('mud.risk')));
});
check('rejects windows not array', () => {
  assert.ok(validatePayload({ ...valid, windows: 'none' }).some((e) => e.includes('windows')));
});
check('accepts empty windows', () => {
  assert.deepEqual(validatePayload({ ...valid, windows: [] }), []);
});
check('rejects malformed window entry', () => {
  assert.ok(validatePayload({ ...valid, windows: [{ start: 1, end: 2, avgScore: 'x' }] }).length >= 3);
});
check('rejects overlong summary', () => {
  assert.ok(validatePayload({ ...valid, summary: 'x'.repeat(1300) }).some((e) => e.includes('1200')));
});

console.log('fallbackPayload');
check('produces valid payload', () => assert.deepEqual(validatePayload(fallbackPayload(truth)), []));
check('preserves ground truth', () => {
  const fb = fallbackPayload(truth);
  assert.equal(fb.day_score, 73);
  assert.deepEqual(fb.mud, truth.mud);
  assert.deepEqual(fb.windows, truth.windows);
});
check('mentions the window in plain time', () => {
  assert.match(fallbackPayload(truth).summary, /6 AM to 12 PM/);
});
check('handles no windows', () => {
  const fb = fallbackPayload({ ...truth, windows: [] });
  assert.deepEqual(validatePayload(fb), []);
  assert.match(fb.summary, /No daylight window/);
});
check('handles least-bad window', () => {
  const fb = fallbackPayload({ ...truth, windows: [{ ...truth.windows[0], fallback: true }] });
  assert.match(fb.summary, /least-bad/);
});
check('handles null score', () => {
  const fb = fallbackPayload({ ...truth, day_score: null, windows: [] });
  assert.match(fb.summary, /Not enough data/);
});
check('muddy says pavement', () => {
  assert.match(fallbackPayload({ ...truth, mud: { risk: 'muddy', weightedPrecip: 0.9 } }).summary, /pavement/);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
