/* KanYeezle — DOM, state and rendering. Game rules live in logic.js. */
(function (L) {
  'use strict';

  var STORE_KEY = 'kanyeezle:v1';
  var EPOCH = new Date(2026, 6, 16); // puzzle #1

  var songs = [];
  var albums = [];
  var shortNames = {};
  var scorer = null;
  var answer = null;
  var day = 0;
  var state = { day: 0, guesses: [], status: 'playing', startedAt: 0, elapsedMs: 0 };

  var el = {
    guessArea: document.getElementById('guess-area'),
    input: document.getElementById('guess-input'),
    suggestions: document.getElementById('suggestions'),
    guessesLeft: document.getElementById('guesses-left'),
    rows: document.getElementById('rows'),
    loading: document.getElementById('loading'),
    result: document.getElementById('result'),
    resultLine: document.getElementById('result-line'),
    resultAnswer: document.getElementById('result-answer'),
    shareBtn: document.getElementById('share-btn'),
    shareNote: document.getElementById('share-note'),
    puzzleNo: document.getElementById('puzzle-no')
  };

  function findSong(title) {
    for (var i = 0; i < songs.length; i++) {
      if (songs[i].title === title) return songs[i];
    }
    return null;
  }

  /* ===== rendering ===== */

  function tile(cls, text, arrowChar, extraClass) {
    var d = document.createElement('div');
    d.className = 'tile ' + cls + (extraClass ? ' ' + extraClass : '');
    d.appendChild(document.createTextNode(text));
    if (arrowChar) {
      var a = document.createElement('span');
      a.className = 'arrow';
      a.textContent = arrowChar;
      d.appendChild(a);
    }
    return d;
  }

  function renderRow(guess) {
    var s = scorer.score(guess, answer);
    var row = document.createElement('div');
    row.className = 'row';

    var song = document.createElement('div');
    song.className = 'cell-song';
    song.textContent = guess.title;
    row.appendChild(song);

    row.appendChild(
      tile(s.album, shortNames[guess.album] || guess.album, scorer.albumArrow(guess, answer))
    );
    row.appendChild(tile(s.track, String(guess.track), L.arrow(guess.track, answer.track, 0)));
    row.appendChild(
      tile(
        s.length,
        L.fmtLength(guess.lengthMs),
        L.arrow(guess.lengthMs, answer.lengthMs, L.EXACT_LENGTH)
      )
    );
    row.appendChild(
      tile(s.features, guess.features.length ? guess.features.join(', ') : '—', '', 'tile-feat')
    );

    el.rows.appendChild(row);
  }

  function render() {
    el.rows.textContent = '';
    state.guesses.forEach(function (title) {
      var g = findSong(title);
      if (g) renderRow(g);
    });

    var over = state.status !== 'playing';
    el.guessArea.hidden = over;
    el.result.hidden = !over;

    var left = L.MAX_GUESSES - state.guesses.length;
    el.guessesLeft.textContent = left + (left === 1 ? ' guess left' : ' guesses left');

    if (over) {
      var line =
        state.status === 'won'
          ? 'Got it in ' + state.guesses.length + '/' + L.MAX_GUESSES
          : 'Out of guesses';
      if (state.status === 'won' && state.elapsedMs) line += ' · ' + L.fmtLength(state.elapsedMs);
      el.resultLine.textContent = line;
      el.resultAnswer.textContent = answer.title + ' — ' + answer.album;
      el.shareNote.textContent = '';
    }
  }

  /* ===== state ===== */

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      // Private mode or storage disabled: the round still plays, it just won't survive a reload.
    }
  }

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE_KEY));
      if (saved && saved.day === day) state = saved;
    } catch (e) {
      // Missing or corrupt: fall through to a fresh round.
    }
  }

  // Tell social.js (leaderboard + chat) the round is over, without coupling
  // the game to it — the game works fine if nothing is listening.
  function announceFinish() {
    if (state.status === 'playing') return;
    document.dispatchEvent(
      new CustomEvent('kanyeezle:finished', {
        detail: {
          day: day,
          won: state.status === 'won',
          guesses: state.guesses.length,
          timeMs: state.elapsedMs || 0
        }
      })
    );
  }

  function submit(song) {
    if (state.status !== 'playing') return;
    if (state.guesses.indexOf(song.title) !== -1) return; // already guessed

    if (!state.startedAt) state.startedAt = Date.now(); // clock runs from the first guess

    state.guesses.push(song.title);
    if (song.title === answer.title) state.status = 'won';
    else if (state.guesses.length >= L.MAX_GUESSES) state.status = 'lost';
    if (state.status !== 'playing') state.elapsedMs = Date.now() - state.startedAt;

    save();
    render();
    el.input.value = '';
    closeSuggestions();
    if (state.status === 'playing') el.input.focus();
    announceFinish();
  }

  /* ===== share ===== */

  var EMOJI = { g: '🟩', y: '🟨', n: '⬜' };

  function shareText() {
    var head =
      'KanYeezle #' +
      (day + 1) +
      '  ' +
      (state.status === 'won' ? state.guesses.length + '/' + L.MAX_GUESSES : 'X/' + L.MAX_GUESSES);
    if (state.status === 'won' && state.elapsedMs) head += ' · ' + L.fmtLength(state.elapsedMs);
    var grid = state.guesses.map(function (title) {
      var s = scorer.score(findSong(title), answer);
      return EMOJI[s.album] + EMOJI[s.track] + EMOJI[s.length] + EMOJI[s.features];
    });
    return [head].concat(grid, [location.origin + location.pathname]).join('\n');
  }

  el.shareBtn.addEventListener('click', function () {
    var text = shareText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          el.shareNote.textContent = 'Copied to clipboard';
        },
        function () {
          el.shareNote.textContent = 'Could not copy';
        }
      );
    } else {
      el.shareNote.textContent = 'Could not copy';
    }
  });

  /* ===== autocomplete ===== */

  var matches = [];
  var cursor = -1;

  function closeSuggestions() {
    el.suggestions.hidden = true;
    el.suggestions.textContent = '';
    el.input.setAttribute('aria-expanded', 'false');
    matches = [];
    cursor = -1;
  }

  function highlight(i) {
    cursor = i;
    var items = el.suggestions.children;
    for (var k = 0; k < items.length; k++) {
      items[k].setAttribute('aria-selected', k === i ? 'true' : 'false');
    }
    if (i >= 0 && items[i]) items[i].scrollIntoView({ block: 'nearest' });
  }

  function openSuggestions(list) {
    el.suggestions.textContent = '';
    list.forEach(function (s, i) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.tabIndex = 0; // reachable with Tab from the input

      var name = document.createElement('span');
      name.textContent = s.title;
      li.appendChild(name);

      var alb = document.createElement('span');
      alb.className = 'sug-album';
      alb.textContent = shortNames[s.album] || s.album;
      li.appendChild(alb);

      li.addEventListener('mousedown', function (ev) {
        ev.preventDefault(); // keep focus, so blur doesn't close the list before the click lands
        submit(s);
      });
      li.addEventListener('mouseenter', function () {
        highlight(i);
      });
      li.addEventListener('focus', function () {
        highlight(i);
      });
      li.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          submit(s);
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          var next = li.nextElementSibling || el.suggestions.firstElementChild;
          if (next) next.focus();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (li.previousElementSibling) li.previousElementSibling.focus();
          else el.input.focus();
        } else if (ev.key === 'Escape') {
          closeSuggestions();
          el.input.focus();
        }
      });
      el.suggestions.appendChild(li);
    });
    matches = list;
    el.suggestions.hidden = list.length === 0;
    el.input.setAttribute('aria-expanded', list.length ? 'true' : 'false');
    highlight(list.length ? 0 : -1);
  }

  el.input.addEventListener('input', function () {
    openSuggestions(L.search(songs, el.input.value, state.guesses));
  });

  el.input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown' && matches.length) {
      ev.preventDefault();
      highlight((cursor + 1) % matches.length);
    } else if (ev.key === 'ArrowUp' && matches.length) {
      ev.preventDefault();
      highlight((cursor - 1 + matches.length) % matches.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (cursor >= 0 && matches[cursor]) submit(matches[cursor]);
    } else if (ev.key === 'Escape') {
      closeSuggestions();
    }
  });

  // Close only when focus leaves the combo entirely, so Tab can move from the
  // input into the suggestion list without dismissing it.
  var combo = el.input.parentNode;
  combo.addEventListener('focusout', function (ev) {
    if (ev.relatedTarget && combo.contains(ev.relatedTarget)) return;
    setTimeout(function () {
      if (!combo.contains(document.activeElement)) closeSuggestions();
    }, 120);
  });

  /* ===== boot ===== */

  fetch('songs.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      songs = L.indexSongs(data.songs);
      albums = data.albums;
      albums.forEach(function (a) {
        shortNames[a.name] = a.short || a.name;
      });
      scorer = L.makeScorer(albums);

      day = L.dayNumber(new Date(), EPOCH);
      answer = L.dailyAnswer(songs, day);
      load();

      el.puzzleNo.textContent = 'Daily puzzle #' + (day + 1);
      el.loading.hidden = true;
      el.guessArea.hidden = false;
      render();
      if (state.status === 'playing') el.input.focus();

      document.dispatchEvent(new CustomEvent('kanyeezle:ready', { detail: { day: day } }));
      announceFinish(); // covers reloading a page whose round already ended
    })
    .catch(function (err) {
      el.loading.className = 'loading error';
      el.loading.textContent =
        'Could not load songs.json (' +
        err.message +
        '). If you opened this file directly, serve the folder over HTTP instead — ' +
        'browsers block fetch on file:// URLs.';
    });
})(window.KanYeezleLogic);
