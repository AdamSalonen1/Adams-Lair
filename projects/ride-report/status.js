// Ride Report — how much of the Pi's report to believe, and what to admit.
//
// Pure: no DOM, no clock of its own, no network. app.js paints what this
// decides. It lives apart from app.js for the same reason score.js does — the
// interesting part is a set of rules about time, and rules about time are worth
// being able to test at 3 AM on a Tuesday in February without waiting for one.
//
// The rule the whole file serves: the page never presents a stale narrative as
// current, and never goes quiet about *why* it has stopped talking. Degrading
// to score-only is fine. Degrading to score-only without saying so is not.

// How old the prose can be before it stops being presented as current, and
// before it stops being shown at all. Between the two it renders with a visible
// timestamp, because a six-hour-old narrative is still worth reading as long as
// nobody is misled about when it was written.
export const NARRATIVE_FRESH_MS = 4 * 60 * 60 * 1000;
export const NARRATIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// How long the Pi may go without a successful run before the page stops
// vouching for it. The timer fires every three hours between 05:10 and 20:10
// Central, so roughly nine hours of overnight silence is not merely tolerable,
// it is the schedule working — a tighter bound would light up amber every
// morning and teach the reader to ignore it.
export const WORKER_QUIET_MS = 10 * 60 * 60 * 1000;

/** Milliseconds since an ISO timestamp, or null if there isn't a usable one. */
export function ageOf(iso, now) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  // Negative ages — a report stamped three minutes into the future by a
  // slightly-off Pi clock — come back as-is. Every comparison below is an upper
  // bound, so skew reads as "fresh", which it is.
  return Number.isNaN(ms) ? null : now - ms;
}

/**
 * Decide what the page should say about the report it just fetched.
 *
 * `row` is the newest daily report or null; `status` is the worker_status row
 * or null. `formatStamp` turns an ISO string into human time — injected rather
 * than imported so this module never has to know the page's timezone, and so a
 * test can hand it something that doesn't move.
 *
 * Returns:
 *   showNarrative — render the prose at all
 *   level         — 'ok' | 'stale' | 'down', the dot's colour
 *   notes         — footnote fragments, already worded; [] means say nothing
 *   label         — what a screen reader gets for the dot
 *   silent        — true when nothing came back from Supabase and the page
 *                   should show no status at all
 */
export function reportStatus({ row, status, now = Date.now(), formatStamp }) {
  const summary = row?.payload?.summary;
  const reportAge = ageOf(row?.generated_at, now);
  const showNarrative = Boolean(summary) && reportAge != null && reportAge <= NARRATIVE_MAX_AGE_MS;

  // Nothing came back from Supabase at all — unconfigured, unreachable, or
  // blocked. Stay silent. What's left on screen is the Phase 1 page, which is a
  // complete and correct thing on its own, and a status dot with no status to
  // report is worse than no dot.
  if (!row && !status) {
    return { showNarrative, silent: true, level: 'ok', notes: [], label: '' };
  }

  // `status` present with an empty `last_ok_at` means the heartbeat row exists
  // and the worker has never had a good run — quiet, in the way that matters.
  // A missing `status` entirely is a different thing: an older deployment, or a
  // read that failed, and inferring "the Pi is down" from that would cry wolf.
  // Then the report's own age is the only evidence, which is exactly the
  // situation the page was in before there was a heartbeat at all.
  const workerAge = ageOf(status?.last_ok_at, now);
  const workerQuiet = Boolean(status) && (workerAge == null || workerAge > WORKER_QUIET_MS);

  // Fragments, joined into one footnote by the caller. Two things can be true
  // at once — a report can be both auto-generated and four hours old — and they
  // belong on one quiet line rather than stacked into a status panel.
  const notes = [];
  if (showNarrative && row.source === 'fallback') notes.push('Auto-generated (no narrative)');

  let level;
  if (workerQuiet) {
    level = 'down';
    notes.push(showNarrative
      ? `Report from ${formatStamp(row.generated_at)} — the Pi has gone quiet`
      : 'The Pi has gone quiet; the score is live');
  } else if (!showNarrative) {
    level = 'stale';
    notes.push('No current write-up; the score is live');
  } else if (reportAge > NARRATIVE_FRESH_MS) {
    level = 'stale';
    notes.push(`Report from ${formatStamp(row.generated_at)}`);
  } else {
    level = 'ok';
  }

  return {
    showNarrative,
    silent: false,
    level,
    notes,
    // On a good day the dot is the only thing rendered, so it carries the label
    // rather than hiding behind aria-hidden: a green circle that announces
    // nothing tells a screen reader strictly less than it tells everyone else.
    label: notes.length ? notes.join('. ') : `Report is current, written ${formatStamp(row.generated_at)}`,
  };
}
