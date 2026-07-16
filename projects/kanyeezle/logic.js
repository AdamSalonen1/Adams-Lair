/* KanYeezle — pure game logic. No DOM in here, so tools/test-logic.mjs can load it too. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KanYeezleLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_GUESSES = 8;

  // "Close" (yellow) thresholds.
  var NEAR_TRACK = 2; // track positions
  var EXACT_LENGTH = 5000; // ms — close enough to call it a match
  var NEAR_LENGTH = 30000; // ms

  // Fold for searching: strip accents and punctuation so "dont like" finds
  // "Don’t Like.1", and case never matters.
  function norm(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // Beyoncé -> Beyonce
      .toLowerCase()
      .replace(/[‘’'`]/g, '') // don’t -> dont
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // "H•A•M" normalises to "h a m" but players type "ham", so match squished too.
  function squish(s) {
    return norm(s).replace(/ /g, '');
  }

  function fmtLength(ms) {
    var total = Math.round(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Days since the epoch, counted in the player's own timezone so the puzzle
  // rolls at local midnight. Both sides are local midnights; rounding absorbs DST.
  function dayNumber(now, epoch) {
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - epoch) / 86400000);
  }

  // mulberry32 — small deterministic PRNG so the daily order is identical for
  // every player on every browser, with no server involved.
  function rng(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Fixed-seed shuffle walked one song per day: every song comes up exactly once
  // before any repeat, and day N is the same song for everyone.
  function dailyOrder(pool) {
    var order = pool.slice();
    var rand = rng(0x4b414e59); // "KANY"
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    return order;
  }

  function dailyAnswer(pool, n) {
    var order = dailyOrder(pool);
    return order[((n % order.length) + order.length) % order.length];
  }

  function indexSongs(songs) {
    songs.forEach(function (s) {
      var searchable = [s.title].concat(s.aliases || []);
      s._n = searchable.map(norm).join(' | ');
      s._s = searchable.map(squish).join('|');
    });
    return songs;
  }

  function search(songs, q, exclude, limit) {
    var nq = norm(q);
    var sq = squish(q);
    if (!nq) return [];
    var out = [];
    for (var i = 0; i < songs.length && out.length < (limit || 8); i++) {
      var s = songs[i];
      if (exclude && exclude.indexOf(s.title) !== -1) continue;
      if (s._n.indexOf(nq) !== -1 || s._s.indexOf(sq) !== -1) out.push(s);
    }
    return out;
  }

  function scoreNumeric(guessVal, targetVal, exact, near) {
    var d = Math.abs(guessVal - targetVal);
    if (d <= exact) return 'g';
    return d <= near ? 'y' : 'n';
  }

  function scoreFeatures(guess, target) {
    var a = guess.features.map(norm);
    var b = target.features.map(norm);
    var same = a.length === b.length && a.every(function (x) { return b.indexOf(x) !== -1; });
    if (same) return 'g'; // includes both having no features at all
    return a.some(function (x) { return b.indexOf(x) !== -1; }) ? 'y' : 'n';
  }

  // Returns '' when the values are close enough to read as a match, so a green
  // tile never carries a misleading arrow.
  function arrow(guessVal, targetVal, exact) {
    if (Math.abs(guessVal - targetVal) <= exact) return '';
    return targetVal > guessVal ? '↑' : '↓';
  }

  // albums must be in chronological order — album "closeness" is adjacency in it.
  function makeScorer(albums) {
    var albumIndex = {};
    albums.forEach(function (a, i) {
      albumIndex[a.name] = i;
    });

    function scoreAlbum(guess, target) {
      if (guess.album === target.album) return 'g';
      return Math.abs(albumIndex[guess.album] - albumIndex[target.album]) === 1 ? 'y' : 'n';
    }

    return {
      score: function (guess, target) {
        return {
          album: scoreAlbum(guess, target),
          track: scoreNumeric(guess.track, target.track, 0, NEAR_TRACK),
          length: scoreNumeric(guess.lengthMs, target.lengthMs, EXACT_LENGTH, NEAR_LENGTH),
          features: scoreFeatures(guess, target)
        };
      },

      // albums is chronological, so a higher index is a later record: ↑ means
      // the answer came out after your guess.
      albumArrow: function (guess, target) {
        return arrow(albumIndex[guess.album], albumIndex[target.album], 0);
      }
    };
  }

  return {
    MAX_GUESSES: MAX_GUESSES,
    NEAR_TRACK: NEAR_TRACK,
    EXACT_LENGTH: EXACT_LENGTH,
    NEAR_LENGTH: NEAR_LENGTH,
    norm: norm,
    squish: squish,
    fmtLength: fmtLength,
    dayNumber: dayNumber,
    dailyOrder: dailyOrder,
    dailyAnswer: dailyAnswer,
    indexSongs: indexSongs,
    search: search,
    arrow: arrow,
    makeScorer: makeScorer
  };
});
