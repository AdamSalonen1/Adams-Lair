// Daily Dozen worker — configuration and the couple of time helpers the whole
// run shares. Pure: loadConfig() reads env, everything else is a function of its
// arguments, so tests can pin "now" and exercise the knobs without a real clock
// or a real environment.
//
// Phase 4 asked for REGION / MAX_DURATION_SEC / DOZEN_SIZE to live somewhere a
// second region or a 3-minute-Short experiment is a value change, not a code
// change. This is that somewhere.

/** The feed's timezone — matches the project plan and Ride Report. "Today" is Central. */
export const FEED_TIMEZONE = 'America/Chicago';

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Resolve the run's configuration from the environment, with the project-plan
 * defaults. `region`/`relevanceLanguage` bias discovery; the rest bound the
 * filter, the dozen, and retention.
 */
export function loadConfig(env = process.env) {
  return {
    region: env.REGION || 'US',
    relevanceLanguage: env.RELEVANCE_LANGUAGE || 'en',
    // search.list returns nothing without a query term (an unanchored
    // order=viewCount search matches zero rows, confirmed against the live API).
    // '#shorts' anchors to short-form content; the velocity rank does the real
    // curation afterward.
    searchQuery: env.SEARCH_QUERY || '#shorts',
    maxDurationSec: num(env.MAX_DURATION_SEC, 60),
    dozenSize: num(env.DOZEN_SIZE, 12),
    publishedWithinHours: num(env.PUBLISHED_WITHIN_HOURS, 48),
    retentionDays: num(env.RETENTION_DAYS, 14),
    // search.list caps at 50, and 50 candidates for a dozen is plenty of slack
    // for the filter. Not exposed as a knob; it's an API limit, not a taste.
    searchMaxResults: 50,
    feedTimezone: FEED_TIMEZONE,
    mock: Boolean(env.MOCK_YOUTUBE),
  };
}

/**
 * Today as YYYY-MM-DD in `tz`, via Intl so it's correct regardless of the Pi's
 * local zone. This is the feed_date the run writes and reads "today" against.
 */
export function todayInZone(tz = FEED_TIMEZONE, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** ISO timestamp `hours` before `date` — the search.list `publishedAfter` bound. */
export function isoHoursAgo(hours, date = new Date()) {
  return new Date(date.getTime() - hours * 3_600_000).toISOString();
}
