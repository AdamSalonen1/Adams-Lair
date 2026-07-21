// Daily Dozen — telling two silences apart, and admitting which one it is.
//
// Pure: no DOM, no clock of its own, no network. app.js paints what this
// decides, and it lives apart for the reason score.js and Ride Report's
// status.js do — the interesting part is a rule about time, and a rule about
// time is worth testing at 6 AM in February without waiting for one.
//
// The whole file serves one honesty rule from the Phase 4 plan: a stale dozen
// is never presented as today's, and the page never goes quiet about *why* a
// fresh one hasn't landed. It distinguishes:
//
//   * "today's dozen isn't up yet" — normal. It's before the morning fetch, or
//     the fetch found nothing to write. Yesterday's dozen still stands.
//   * "the fetcher's gone quiet" — an outage. No successful run behind the
//     stale feed. Still shows the last good dozen; just stops vouching for it.
//
// It reads the heartbeat's `last_ok_at`, never `last_error` — that column is
// world-readable but the page has no business rendering a raw error to a
// visitor (feed.js does not even select it).

// How long the Pi may go without a *successful* run before the page stops
// vouching for it. The worker fires once daily at ~06:30 Central, so a healthy
// last success is at most ~24h old (plus the timer's catch-up/jitter slack).
// 30h clears a normal overnight-into-morning gap — yesterday's success showing
// at 6 AM is fine — but trips once a full day-and-change has passed with no
// dozen. A tighter bound would light up amber every morning and teach the
// reader to ignore it; a looser one would stay green through a real outage.
export const WORKER_QUIET_MS = 30 * 60 * 60 * 1000;

/** Milliseconds since an ISO timestamp, or null if there isn't a usable one. */
export function ageOf(iso, now) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  // A negative age — a heartbeat stamped seconds into the future by a slightly
  // fast Pi clock — comes back as-is. Every comparison below is an upper bound,
  // so skew reads as "fresh", which it effectively is.
  return Number.isNaN(ms) ? null : now - ms;
}

const EMPTY_WAITING = {
  title: "Today's dozen isn't up yet.",
  body: 'The feed is gathered fresh each morning. Check back in a little while.',
};

const EMPTY_DOWN = {
  title: 'The fetcher has gone quiet.',
  body: "The morning fetch hasn't checked in, so there's no dozen to show right now. It'll be back once the fetcher is.",
};

/**
 * Decide what the page should say about the feed it just fetched.
 *
 * `feed` is the normalized feed row (with `feed_date`) or null; `status` is the
 * dozen_worker_status row or null; `today` is YYYY-MM-DD in the feed's zone.
 *
 * Returns everything app.js needs and no DOM:
 *   hasFeed  — is there a dozen to render at all?
 *   isToday  — is the dozen we have today's? (drives nothing here; handy to app)
 *   level    — 'ok' | 'waiting' | 'down', the status dot's colour
 *   silent   — true when there is nothing worth saying (a fresh, current dozen)
 *   note     — the footnote shown beside a rendered-but-stale dozen ('' = none)
 *   label    — the note reworded for a screen reader, never empty when a dot shows
 *   empty    — { title, body } for the no-feed screen; the down variant differs
 */
export function feedStatus({ feed, status, today, now = Date.now() } = {}) {
  const hasFeed = Boolean(feed && Array.isArray(feed.items) && feed.items.length);
  const isToday = hasFeed && feed.feed_date === today;

  // Worker health from the last *successful* run. A missing status row — an
  // older deployment, or a heartbeat read that failed — is not evidence of an
  // outage: inferring "the Pi is down" from silence we can't interpret would
  // cry wolf. Then the feed's own date (shown in the header) is the only signal,
  // which is exactly where the page stood before there was a heartbeat at all.
  const okAge = ageOf(status?.last_ok_at, now);
  const workerKnown = Boolean(status);
  const workerDown = workerKnown && (okAge == null || okAge > WORKER_QUIET_MS);

  // No dozen to show. The screen carries the whole message, so there's no
  // footnote — just which message, and how alarmed to look.
  if (!hasFeed) {
    return workerDown
      ? { hasFeed: false, isToday: false, level: 'down', silent: false, note: '', label: EMPTY_DOWN.title, empty: EMPTY_DOWN }
      : { hasFeed: false, isToday: false, level: 'waiting', silent: false, note: '', label: EMPTY_WAITING.title, empty: EMPTY_WAITING };
  }

  // Today's dozen is up. Nothing to add — the header already says so, and a
  // status line on a working page is noise the reader learns to tune out.
  if (isToday) {
    return { hasFeed: true, isToday: true, level: 'ok', silent: true, note: '', label: "Today's dozen is up", empty: EMPTY_WAITING };
  }

  // We're showing an older dozen. Which silence is it?
  if (workerDown) {
    const note = "The fetcher's gone quiet — this is the last good dozen.";
    return { hasFeed: true, isToday: false, level: 'down', silent: false, note, label: note, empty: EMPTY_DOWN };
  }
  const note = "Today's dozen isn't up yet — it lands each morning.";
  return { hasFeed: true, isToday: false, level: 'waiting', silent: false, note, label: note, empty: EMPTY_WAITING };
}
