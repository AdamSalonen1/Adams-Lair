// Daily Dozen — the finite feed.
//
// The rules this file enforces, because they *are* the product:
//   * exactly the items in the feed are shown; there is no 13th, ever;
//   * nothing autoplays into the next thing — a human presses Next;
//   * when the dozen is done, it's done, and the page says so.
//
// It knows nothing about YouTube (that's player.js) and nothing about where the
// feed came from (that's feed.js). It owns which video is current, what's been
// watched, and the shape of the screen.

import { loadFeed, fetchWorkerStatus, feedIsLive, feedToday } from './feed.js';
import { feedStatus } from './status.js';
import { createPlayer } from './player.js';

const YT_WATCH = (id) => `https://www.youtube.com/watch?v=${id}`;

// ===== State =====

let items = [];
let feedDate = null;
let currentIndex = 0;
let currentConsumed = false;   // has the current item ended, been skipped, or failed to play?
let player = null;
const watched = new Set();     // indices done for good; persisted per feed_date

// ===== DOM =====

const $ = (id) => document.getElementById(id);
const el = {
  date: $('dd-date'),
  status: $('dd-status'),
  statusDot: $('dd-status-dot'),
  statusText: $('dd-status-text'),
  bar: $('dd-progress-bar'),
  count: $('dd-progress-count'),
  stage: $('dd-stage'),
  unavailable: $('dd-unavailable'),
  unavailableLink: $('dd-unavailable-link'),
  nowTitle: $('dd-now-title'),
  nowChannel: $('dd-now-channel'),
  nowYt: $('dd-now-yt'),
  advance: $('dd-advance'),
  list: $('dd-list'),
  end: $('dd-end'),
  endTitle: $('dd-end-title'),
  countdown: $('dd-countdown'),
  empty: $('dd-empty'),
  emptyIcon: $('dd-empty-icon'),
  emptyTitle: $('dd-empty-title'),
  emptyBody: $('dd-empty-body'),
};

// "dozen" only when there really are twelve. Fewer, and the page says how many
// there are rather than calling eight a dozen — the honest thin-day labeling the
// Phase 4 plan asks for, applied everywhere the word would otherwise appear.
function countNoun(n) {
  return n === 12 ? 'dozen' : `${n} short${n === 1 ? '' : 's'}`;
}

// ===== Watched-state persistence =====
//
// Keyed by feed_date, so a refresh resumes the day and tomorrow's feed starts
// clean without anyone having to clear anything. Per-device on purpose — no
// accounts, no server round trip to remember where you were.

function storageKey() {
  return `daily-dozen:${feedDate || 'unknown'}`;
}

function loadWatched() {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    for (const i of JSON.parse(raw)) {
      if (Number.isInteger(i) && i >= 0 && i < items.length) watched.add(i);
    }
  } catch { /* a corrupt entry just means "start fresh"; not worth surfacing */ }
}

function persistWatched() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...watched]));
  } catch { /* private mode / full quota — the session still works, it just won't resume */ }
}

// ===== Index helpers =====

function firstUnwatchedIndex() {
  for (let i = 0; i < items.length; i++) if (!watched.has(i)) return i;
  return -1;
}

/** The next unwatched item after `from`, wrapping once so earlier skips get picked up. Never returns `from`. */
function nextUnwatchedIndex(from) {
  for (let step = 1; step < items.length; step++) {
    const i = (from + step) % items.length;
    if (!watched.has(i)) return i;
  }
  return -1;
}

// ===== Rendering =====

function renderDate() {
  if (!el.date) return;
  const noun = countNoun(items.length);
  if (!feedDate) { el.date.textContent = `Today's ${noun}`; return; }
  // Parse as a local date purely for the weekday/month labels (feed_date is a
  // calendar day, not an instant). "Is it today" is judged in the feed's zone —
  // the same clock the staleness note uses — so the header and the footnote can
  // never disagree for a viewer whose local midnight has passed but Central's
  // hasn't.
  const [y, m, d] = feedDate.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  const day = feedDate === feedToday() ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'long' });
  el.date.textContent = `${day}'s ${noun} · ${dt.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
}

/**
 * The staleness footnote under the header. Silent on a fresh, current dozen —
 * a working page has no line to spend — and otherwise a dot plus one sentence
 * saying which silence this is. `decision` is null in the offline sample path,
 * where there's no Pi to have a status.
 */
function renderStatusNote(decision) {
  if (!el.status) return;
  if (!decision || decision.silent || !decision.note) { el.status.hidden = true; return; }
  if (el.statusDot) {
    el.statusDot.dataset.level = decision.level;
    el.statusDot.setAttribute('aria-label', decision.label);
  }
  if (el.statusText) el.statusText.textContent = decision.note;
  el.status.hidden = false;
}

function renderProgress() {
  const done = watched.size;
  const total = items.length;
  if (el.count) el.count.textContent = `${done} of ${total} watched`;
  if (el.bar) el.bar.style.width = `${total ? (done / total) * 100 : 0}%`;
}

function renderList() {
  if (!el.list) return;
  el.list.innerHTML = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'dd-item';
    if (watched.has(i)) li.classList.add('is-watched');
    if (i === currentIndex) li.classList.add('is-current');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-item-btn';
    btn.setAttribute('aria-current', i === currentIndex ? 'true' : 'false');

    const mark = document.createElement('span');
    mark.className = 'dd-item-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = watched.has(i) ? '✓' : String(i + 1);

    const text = document.createElement('span');
    text.className = 'dd-item-text';
    const t = document.createElement('span');
    t.className = 'dd-item-title';
    t.textContent = item.title || 'Untitled';
    const c = document.createElement('span');
    c.className = 'dd-item-channel';
    c.textContent = item.channel_title || '';
    text.append(t, c);

    btn.append(mark, text);
    btn.addEventListener('click', () => goTo(i));

    // Every card carries its own link to the source on YouTube, credited to its
    // channel — a sibling of the play button, not a wrapper around it, so the
    // row still plays in place and only this corner leaves the page.
    const yt = document.createElement('a');
    yt.className = 'dd-item-yt';
    yt.href = YT_WATCH(item.video_id);
    yt.target = '_blank';
    yt.rel = 'noopener';
    yt.textContent = '↗';
    yt.setAttribute('aria-label', `Watch “${item.title || 'this short'}” on YouTube`);

    li.append(btn, yt);
    el.list.append(li);
  });
}

function renderNow() {
  const item = items[currentIndex];
  if (el.nowTitle) el.nowTitle.textContent = item?.title || '';
  if (el.nowChannel) el.nowChannel.textContent = item?.channel_title || '';
  // Attribution + escape hatch: the current video is always one click from its
  // source on YouTube, credited to its channel. Good citizenship, and TOS-kind.
  if (el.nowYt) {
    if (item?.video_id) {
      el.nowYt.href = YT_WATCH(item.video_id);
      el.nowYt.hidden = false;
    } else {
      el.nowYt.hidden = true;
    }
  }
  updateAdvanceButton();
}

function updateAdvanceButton() {
  if (!el.advance) return;
  const noneLeft = nextUnwatchedIndex(currentIndex) === -1;
  const consumed = currentConsumed || watched.has(currentIndex);
  el.advance.classList.toggle('is-ready', consumed || noneLeft);
  const doneLabel = items.length === 12 ? "That's the dozen →" : "That's all →";
  el.advance.textContent = noneLeft ? doneLabel : (consumed ? 'Next →' : 'Skip →');
}

// ===== Flow =====

function markWatched(index) {
  if (watched.has(index)) return;
  watched.add(index);
  persistWatched();
  renderProgress();
  // Reflect the ✓ in the ledger without a full rebuild.
  const li = el.list?.children[index];
  if (li) {
    li.classList.add('is-watched');
    const mark = li.querySelector('.dd-item-mark');
    if (mark) mark.textContent = '✓';
  }
}

function goTo(index) {
  if (index < 0 || index >= items.length) return;
  currentIndex = index;
  currentConsumed = false;
  hideUnavailable();
  // Move the "current" highlight in the ledger.
  [...(el.list?.children || [])].forEach((li, i) => {
    li.classList.toggle('is-current', i === index);
    li.querySelector('.dd-item-btn')?.setAttribute('aria-current', i === index ? 'true' : 'false');
  });
  renderNow();
  player?.cue(items[index].video_id);
}

function advance() {
  markWatched(currentIndex);
  const next = nextUnwatchedIndex(currentIndex);
  if (next === -1) { showEnd(); return; }
  goTo(next);
}

function onEnded() {
  markWatched(currentIndex);
  currentConsumed = true;
  updateAdvanceButton();
}

function onUnplayable() {
  // A dead tile shouldn't be able to hold the dozen hostage: mark it done, show
  // the escape hatch, and let Next carry on. Phase 3's worker filters these out
  // at the source, so in a real feed this is the rare exception, not the rule.
  markWatched(currentIndex);
  currentConsumed = true;
  showUnavailable(items[currentIndex]?.video_id);
  updateAdvanceButton();
}

// ===== Screens =====

function showUnavailable(videoId) {
  if (!el.unavailable) return;
  if (el.unavailableLink && videoId) {
    el.unavailableLink.href = `https://www.youtube.com/watch?v=${videoId}`;
  }
  el.unavailable.hidden = false;
}

function hideUnavailable() {
  if (el.unavailable) el.unavailable.hidden = true;
}

function showEnd() {
  el.stage?.setAttribute('hidden', '');
  // "That's the dozen." only when it was one; a thin day gets an honest heading.
  if (el.endTitle) el.endTitle.textContent = items.length === 12 ? "That's the dozen." : "That's all for today.";
  if (el.end) el.end.hidden = false;
  renderProgress();
  startCountdown();
}

/**
 * No dozen to show. `decision` (from status.js) chooses the words: the calm
 * "isn't up yet" by default, or the "fetcher's gone quiet" variant when the
 * heartbeat says so — never a raw error either way. Null decision (offline
 * sample path, or an unconfigured page) keeps index.html's default copy.
 */
function showEmpty(decision) {
  el.stage?.setAttribute('hidden', '');
  if (decision?.empty) {
    if (el.emptyTitle) el.emptyTitle.textContent = decision.empty.title;
    if (el.emptyBody) el.emptyBody.textContent = decision.empty.body;
    if (el.emptyIcon) el.emptyIcon.textContent = decision.level === 'down' ? '📡' : '⏳';
  }
  if (el.empty) el.empty.hidden = false;
}

// A quiet nudge that the wait is finite and short: time until the next local day.
let countdownTimer = null;
function startCountdown() {
  if (!el.countdown || countdownTimer) return;
  const tick = () => {
    const now = new Date();
    const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
    let s = Math.max(0, Math.floor((midnight - now) / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    s %= 3600;
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    el.countdown.textContent = `${h}:${m}:${sec}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ===== Init =====

async function init() {
  // Feed and heartbeat in parallel: the heartbeat only decides which sentence
  // sits under the feed, so there's no reason to make it queue behind the feed
  // read. The status read is skipped entirely in the offline sample path, where
  // there is no Pi to have a status. Both settle to null rather than throwing.
  const live = feedIsLive();
  const [feed, workerStatus] = await Promise.all([
    loadFeed(),
    live ? fetchWorkerStatus() : Promise.resolve(null),
  ]);

  const decision = live
    ? feedStatus({ feed, status: workerStatus, today: feedToday(), now: Date.now() })
    : null;

  if (!feed || !feed.items.length) { showEmpty(decision); return; }

  items = feed.items;
  feedDate = feed.feed_date;

  loadWatched();
  renderDate();
  renderStatusNote(decision);
  renderProgress();
  renderList();

  const start = firstUnwatchedIndex();
  if (start === -1) { showEnd(); return; }   // came back after finishing the dozen
  currentIndex = start;

  el.advance?.addEventListener('click', advance);

  // Build the player, then point it at the first unwatched item. Until it's
  // ready, the ledger and progress already render, so the page is never blank.
  player = await createPlayer('player', { onEnded, onUnplayable });
  goTo(start);

  // A small handle for end-to-end verification: drive the ENDED path without
  // sitting through a video, and read state back out. Harmless in production.
  window.__dd = {
    get state() { return { currentIndex, watched: [...watched], total: items.length, feedDate }; },
    endCurrent: onEnded,
    advance,
    goTo,
    player,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
