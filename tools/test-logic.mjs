/**
 * Exercises the KanYeezle scoring rules against the real songs.json.
 *
 * Run: node --test tools/test-logic.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../projects/kanyeezle/logic.js');

const data = JSON.parse(await readFile(new URL('../projects/kanyeezle/songs.json', import.meta.url), 'utf8'));
const songs = L.indexSongs(data.songs);
const albums = data.albums;
const scorer = L.makeScorer(albums);
const score = (g, t) => scorer.score(g, t);

const byTitle = (t) => {
  const s = songs.find((x) => x.title === t);
  if (!s) throw new Error(`no such song: ${t}`);
  return s;
};

test('the dataset is intact', () => {
  assert.equal(songs.length, 182);
  assert.equal(albums.length, 13);
  assert.deepEqual(albums.map((a) => a.year), [...albums.map((a) => a.year)].sort((a, b) => a - b),
    'albums must be chronological — album adjacency depends on it');
  for (const s of songs) {
    assert.ok(s.title && s.album && s.lengthMs > 0 && s.track > 0, `malformed: ${s.title}`);
    assert.ok(albums.some((a) => a.name === s.album), `unknown album: ${s.album}`);
  }
});

test('guessing the answer scores all green', () => {
  for (const s of songs) {
    assert.deepEqual(score(s, s), { album: 'g', track: 'g', length: 'g', features: 'g' }, s.title);
  }
});

test('album is green on itself, yellow on a neighbour, grey further out', () => {
  const stronger = byTitle('Stronger'); // Graduation (idx 2)
  const goldDigger = byTitle('Gold Digger'); // Late Registration (idx 1)
  const paranoid = byTitle('Paranoid'); // 808s (idx 3)
  const jail = byTitle('Jail'); // Donda (idx 12)

  assert.equal(score(stronger, stronger).album, 'g');
  assert.equal(score(goldDigger, stronger).album, 'y', 'Late Registration is adjacent to Graduation');
  assert.equal(score(paranoid, stronger).album, 'y', '808s is adjacent to Graduation');
  assert.equal(score(jail, stronger).album, 'n', 'Donda is nowhere near Graduation');
});

test('track number: exact green, within 2 yellow, else grey', () => {
  const target = byTitle('Stronger'); // Graduation #3
  assert.equal(target.track, 3);
  const at = (n) => songs.find((s) => s.album === 'Graduation' && s.track === n);

  assert.equal(score(at(3), target).track, 'g');
  assert.equal(score(at(1), target).track, 'y'); // 2 away
  assert.equal(score(at(5), target).track, 'y'); // 2 away
  assert.equal(score(at(6), target).track, 'n'); // 3 away
});

test('length: within 5s green, within 30s yellow, else grey', () => {
  const target = { album: 'ye', track: 1, lengthMs: 180000, features: [] };
  const guess = (ms) => ({ album: 'ye', track: 1, lengthMs: ms, features: [] });

  assert.equal(score(guess(180000), target).length, 'g');
  assert.equal(score(guess(184000), target).length, 'g', '4s under the 5s bar');
  assert.equal(score(guess(185000), target).length, 'g', '5s is inclusive');
  assert.equal(score(guess(186000), target).length, 'y');
  assert.equal(score(guess(210000), target).length, 'y', '30s is inclusive');
  assert.equal(score(guess(211000), target).length, 'n');
});

test('features: same set green, overlap yellow, disjoint grey', () => {
  const mk = (features) => ({ album: 'ye', track: 1, lengthMs: 1, features });

  assert.equal(score(mk([]), mk([])).features, 'g', 'both instrumental-credited is a match');
  assert.equal(score(mk(['Jay-Z']), mk([])).features, 'n');
  assert.equal(score(mk(['Jay-Z', 'Big Sean']), mk(['Big Sean', 'Jay-Z'])).features, 'g', 'order must not matter');
  assert.equal(score(mk(['Jay-Z', 'Big Sean']), mk(['Big Sean'])).features, 'y');
  assert.equal(score(mk(['Jay-Z']), mk(['Pusha T'])).features, 'n');
});

test('arrows point at the answer and never contradict a green tile', () => {
  assert.equal(L.arrow(3, 7, 0), '↑');
  assert.equal(L.arrow(7, 3, 0), '↓');
  assert.equal(L.arrow(3, 3, 0), '');
  assert.equal(L.arrow(180000, 183000, L.EXACT_LENGTH), '', 'inside the green band -> no arrow');
  assert.equal(L.arrow(180000, 200000, L.EXACT_LENGTH), '↑');
});

test('the album arrow points at the answer chronologically', () => {
  const stronger = byTitle('Stronger'); // Graduation, 2007
  const goldDigger = byTitle('Gold Digger'); // Late Registration, 2005
  const jail = byTitle('Jail'); // Donda, 2021
  const goodMorning = byTitle('Good Morning'); // Graduation too

  assert.equal(scorer.albumArrow(goldDigger, stronger), '↑', 'Graduation came after Late Registration');
  assert.equal(scorer.albumArrow(jail, stronger), '↓', 'Graduation came before Donda');
  assert.equal(scorer.albumArrow(goodMorning, stronger), '', 'same album -> no arrow on the green tile');
});

test('every album tile that is not green carries an arrow', () => {
  // The bug was a grey album tile with no direction on it. Guard the whole matrix:
  // exactly the green tiles are arrowless, and every other one points somewhere.
  const oneEach = albums.map((a) => songs.find((s) => s.album === a.name));
  for (const guess of oneEach) {
    for (const target of oneEach) {
      const cls = scorer.score(guess, target).album;
      const arr = scorer.albumArrow(guess, target);
      if (cls === 'g') {
        assert.equal(arr, '', `${guess.album} vs ${target.album}: green must not have an arrow`);
      } else {
        assert.ok(arr === '↑' || arr === '↓', `${guess.album} vs ${target.album}: ${cls} tile needs an arrow`);
      }
    }
  }
});

test('the daily answer is stable, and every song comes up before any repeat', () => {
  const a = L.dailyAnswer(songs, 41);
  const b = L.dailyAnswer(songs, 41);
  assert.equal(a.title, b.title, 'same day must give the same song');

  const cycle = new Set();
  for (let d = 0; d < songs.length; d++) cycle.add(L.dailyAnswer(songs, d).title);
  assert.equal(cycle.size, songs.length, 'a full cycle must hit all 182 songs exactly once');

  assert.equal(L.dailyAnswer(songs, 0).title, L.dailyAnswer(songs, songs.length).title, 'wraps');
  assert.ok(L.dailyAnswer(songs, -3), 'a clock set before the epoch must not crash');
});

test('day number rolls over at local midnight', () => {
  const epoch = new Date(2026, 6, 16);
  assert.equal(L.dayNumber(new Date(2026, 6, 16, 0, 0, 1), epoch), 0);
  assert.equal(L.dayNumber(new Date(2026, 6, 16, 23, 59, 59), epoch), 0, 'still day 0 just before midnight');
  assert.equal(L.dayNumber(new Date(2026, 6, 17, 0, 0, 1), epoch), 1, 'ticks over at midnight');
  assert.equal(L.dayNumber(new Date(2026, 10, 8, 12, 0, 0), epoch), 115, 'survives a DST boundary');
});

test('search finds songs the way people actually type them', () => {
  const hit = (q) => L.search(songs, q, []).map((s) => s.title);

  assert.ok(hit('mercy').includes('Mercy.1'), 'the .1 suffix must not hide the track');
  assert.ok(hit('dont like').includes('Don’t Like.1'), 'plain apostrophe finds the curly one');
  assert.ok(hit('ham').includes('H•A•M'), 'squished match for punctuated titles');
  assert.ok(hit('h.a.m').includes('H•A•M'));
  assert.ok(hit('STRONGER').includes('Stronger'), 'case-insensitive');
  assert.ok(hit('jesus walks').includes('Jesus Walks'));
  assert.ok(hit('father stretch').includes('Pt. 2'), 'alias reaches TLOP track 3');
  assert.equal(hit('').length, 0, 'empty query offers nothing');
  assert.equal(hit('zzzzz').length, 0);
});

test('search hides songs already guessed', () => {
  assert.ok(!L.search(songs, 'stronger', ['Stronger']).some((s) => s.title === 'Stronger'));
});

test('lengths format as m:ss', () => {
  assert.equal(L.fmtLength(180000), '3:00');
  assert.equal(L.fmtLength(185000), '3:05');
  assert.equal(L.fmtLength(760000), '12:40'); // Last Call
  assert.equal(L.fmtLength(38000), '0:38'); // Frank’s Track
});
