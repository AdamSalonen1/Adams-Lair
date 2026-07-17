/* KanYeezle — daily leaderboard and chat, backed by Supabase.
   Fully optional: if the key below isn't filled in, or the supabase-js CDN
   script failed to load, the whole section stays hidden and the game itself
   is untouched. */
(function (L) {
  'use strict';

  var SUPABASE_URL = 'https://bdjlnnhoskqgvxgxawcu.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_6hF1Wu6jRu25EUvWFfQ_6Q_wr6caWu_';

  var NAME_KEY = 'kanyeezle:name';
  var POSTED_KEY = 'kanyeezle:posted'; // day+1 of the last score we posted

  if (SUPABASE_KEY.indexOf('PASTE_') === 0 || typeof supabase === 'undefined') return;

  var client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var day = 0;
  var lastFinish = null; // detail of kanyeezle:finished, if the round is over
  var editingName = false;
  var seenMsg = {}; // message ids already rendered, so the realtime echo of our own send doesn't double up

  var el = {
    social: document.getElementById('social'),
    nameForm: document.getElementById('name-form'),
    nameInput: document.getElementById('name-input'),
    nameCurrent: document.getElementById('name-current'),
    nameDisplay: document.getElementById('name-display'),
    nameChange: document.getElementById('name-change'),
    lbList: document.getElementById('lb-list'),
    lbNote: document.getElementById('lb-note'),
    chatLog: document.getElementById('chat-log'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    chatSend: document.getElementById('chat-send')
  };

  /* ===== name ===== */

  function getName() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setName(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch (e) {
      // Private mode: the name just won't stick between visits.
    }
  }

  function renderName() {
    var name = getName();
    var showForm = editingName || !name;
    el.nameForm.hidden = !showForm;
    el.nameCurrent.hidden = showForm;
    el.nameDisplay.textContent = name;
    el.chatInput.disabled = !name;
    el.chatSend.disabled = !name;
    el.chatInput.placeholder = name ? 'Say something…' : 'Set a name above to chat';
  }

  el.nameForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = el.nameInput.value.trim().slice(0, 20);
    if (!name) return;
    setName(name);
    editingName = false;
    renderName();
    maybePostScore(); // in case the round ended before they picked a name
  });

  el.nameChange.addEventListener('click', function () {
    editingName = true;
    el.nameInput.value = getName();
    renderName();
    el.nameInput.focus();
  });

  /* ===== leaderboard ===== */

  function renderLeaderboard(rows) {
    el.lbList.textContent = '';
    el.lbNote.textContent = rows.length ? '' : 'No scores yet — be first.';
    rows.forEach(function (row, i) {
      var li = document.createElement('li');

      var rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = i + 1 + '.';
      li.appendChild(rank);

      var name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = row.name;
      li.appendChild(name);

      var score = document.createElement('span');
      score.className = 'lb-score';
      score.textContent = row.won
        ? row.guesses + '/' + L.MAX_GUESSES + (row.time_ms ? ' · ' + L.fmtLength(row.time_ms) : '')
        : 'X/' + L.MAX_GUESSES;
      li.appendChild(score);

      el.lbList.appendChild(li);
    });
  }

  function loadLeaderboard() {
    client
      .from('scores')
      .select('name,won,guesses,time_ms')
      .eq('day', day)
      .order('won', { ascending: false })
      .order('guesses', { ascending: true })
      .order('time_ms', { ascending: true })
      .limit(50)
      .then(function (res) {
        if (res.error) el.lbNote.textContent = 'Leaderboard unavailable right now.';
        else renderLeaderboard(res.data);
      });
  }

  function maybePostScore() {
    var name = getName();
    if (!name || !lastFinish) return;
    var posted = 0;
    try {
      posted = Number(localStorage.getItem(POSTED_KEY));
    } catch (e) {
      // If we can't read the flag we may double-post; the unique(day, name)
      // constraint on the table makes that harmless.
    }
    if (posted === day + 1) return; // stored as day+1 so day 0 isn't falsy

    client
      .from('scores')
      .upsert(
        {
          day: day,
          name: name,
          won: lastFinish.won,
          guesses: lastFinish.guesses,
          time_ms: lastFinish.timeMs
        },
        { onConflict: 'day,name', ignoreDuplicates: true }
      )
      .then(function (res) {
        if (res.error) return;
        try {
          localStorage.setItem(POSTED_KEY, String(day + 1));
        } catch (e) {
          // See above — the DB constraint has our back.
        }
        loadLeaderboard();
      });
  }

  /* ===== chat ===== */

  function addMsg(row) {
    if (row.id != null) {
      if (seenMsg[row.id]) return;
      seenMsg[row.id] = true;
    }
    var div = document.createElement('div');
    div.className = 'chat-msg';

    var name = document.createElement('b');
    name.textContent = row.name;
    div.appendChild(name);

    var time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = new Date(row.created_at).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
    div.appendChild(time);

    var text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = row.text;
    div.appendChild(text);

    el.chatLog.appendChild(div);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function loadChat() {
    client
      .from('messages')
      .select('id,name,text,created_at')
      .eq('day', day)
      .order('created_at', { ascending: true })
      .limit(200)
      .then(function (res) {
        if (!res.error) res.data.forEach(addMsg);
      });
  }

  el.chatForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var name = getName();
    var text = el.chatInput.value.trim().slice(0, 280);
    if (!name || !text) return;
    el.chatInput.value = '';
    client
      .from('messages')
      .insert({ day: day, name: name, text: text })
      .select()
      .single()
      .then(function (res) {
        if (res.error) el.chatInput.value = text; // give it back so they can retry
        else addMsg(res.data);
      });
  });

  /* ===== realtime ===== */

  function subscribe() {
    client
      .channel('kanyeezle-day-' + day)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: 'day=eq.' + day },
        function (payload) {
          addMsg(payload.new);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scores', filter: 'day=eq.' + day },
        function () {
          loadLeaderboard();
        }
      )
      .subscribe();
  }

  /* ===== boot — driven by events from game.js ===== */

  document.addEventListener('kanyeezle:ready', function (ev) {
    day = ev.detail.day;
    el.social.hidden = false;
    renderName();
    loadLeaderboard();
    loadChat();
    subscribe();
  });

  document.addEventListener('kanyeezle:finished', function (ev) {
    lastFinish = ev.detail;
    maybePostScore();
  });
})(window.KanYeezleLogic);
