// Daily Dozen — where the day's feed comes from. Nothing here touches the DOM.
//
// Phase 2: loadFeed() now reads a real Supabase row over plain REST — the
// publicRead() pattern from ride-report/supabase.js — instead of the committed
// sample. The signature and the returned shape have NOT moved, which is the
// whole reason app.js never learns where its dozen came from.
//
// Two transports were never needed here the way they are in Ride Report: the
// feed is public, non-personal content, so there is no auth and no supabase-js —
// a GET with the publishable key is the entire data plane. That also means it
// renders without waiting on a CDN module, and keeps rendering when the CDN is
// unreachable.
//
// Degrading: blank supabase-config.js, or an explicit `?sample` on the URL,
// drops back to the committed feed.sample.json — the Phase-1 self, for offline
// dev. A *configured* project that then fails to answer resolves to null (a calm
// "no feed yet" state) rather than quietly serving the sample: that file is dev
// scaffolding, not a curated feed, and showing it as today's dozen would be a
// lie. The app never fabricates a feed.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const SAMPLE_URL = './feed.sample.json';
const REST_TIMEOUT_MS = 8000;

// The feed's notion of "today" is Central time, to match the Pi that writes it
// (America/Chicago, per the project plan) — not the visitor's local midnight. A
// phone in Tokyo should still see the same "today's dozen" the Pi published.
const FEED_TIMEZONE = 'America/Chicago';

const baseUrl = SUPABASE_URL.replace(/\/+$/, '');

// Only the fields the UI reads, ordered so a fallback query and the primary
// query ask for exactly the same columns.
const FEED_SELECT = 'select=feed_date,generated_at,region,items';

/** False until supabase-config.js is filled in; loadFeed() checks before asking for anything. */
function isConfigured() {
  return Boolean(baseUrl && SUPABASE_PUBLISHABLE_KEY);
}

/** True when the URL asks to bypass Supabase and use the committed sample (offline dev). */
function wantsSample() {
  if (typeof window === 'undefined' || !window.location) return false;
  return new URLSearchParams(window.location.search).has('sample');
}

/** Today as YYYY-MM-DD in the feed's timezone, computed via Intl so it's right regardless of the device's local zone. */
function todayInFeedZone() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FEED_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * One public read over plain REST. Returns the first row, or null if the query
 * matched nothing. Throws only on a transport/HTTP failure — the caller decides
 * what an *empty* result (a missing day) means, separately from a broken one.
 */
async function publicRead(query) {
  const res = await fetch(`${baseUrl}/rest/v1/${query}`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    },
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Supabase returned HTTP ${res.status} reading the feed`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Today's feed row, or the newest one if today's hasn't been written yet.
 *
 * The fallback is deliberate and honest: on a morning before the 6:30 fetch, or
 * on a thin day, "today" is simply absent, and the newest row is yesterday's
 * dozen. The UI labels it by date ("Friday's dozen"), so a stale feed reads as
 * old rather than as current — that labelling already lives in app.js and works
 * off whatever `feed_date` this returns.
 */
async function fetchFeedRow() {
  const today = todayInFeedZone();
  const todays = await publicRead(`shorts_feeds?feed_date=eq.${today}&${FEED_SELECT}&limit=1`);
  if (todays) return todays;
  return publicRead(`shorts_feeds?${FEED_SELECT}&order=feed_date.desc&limit=1`);
}

/**
 * The day's feed, or null if there isn't one to show. Never throws — a missing
 * or malformed feed is a calm empty state, not a broken page. The finiteness of
 * the app depends on `items` being exactly what gets rendered, so this is also
 * where a feed is sanity-checked into a shape the UI can trust.
 *
 * @returns {Promise<null | {feed_date: string, generated_at?: string, region?: string, items: Array}>}
 */
export async function loadFeed() {
  if (!isConfigured() || wantsSample()) return loadSampleFeed();

  try {
    return normalizeFeed(await fetchFeedRow());
  } catch (err) {
    // Configured but unreachable: null, not the sample. See the file header.
    console.warn('Daily Dozen: could not load the feed —', err);
    return null;
  }
}

/** The Phase-1 path: the committed sample, for a blank config or an explicit ?sample. */
async function loadSampleFeed() {
  try {
    const res = await fetch(SAMPLE_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return normalizeFeed(await res.json());
  } catch (err) {
    console.warn('Daily Dozen: could not load the sample feed —', err);
    return null;
  }
}

/**
 * Keep only items with a usable video id, and only the fields the UI reads.
 * A feed with no valid items is treated as no feed at all: better a clean
 * "nothing today" than a player pointed at nothing.
 */
function normalizeFeed(feed) {
  if (!feed || !Array.isArray(feed.items)) return null;

  const items = feed.items
    .filter((it) => it && typeof it.video_id === 'string' && it.video_id.trim())
    .map((it) => ({
      video_id: it.video_id.trim(),
      title: typeof it.title === 'string' ? it.title : '',
      channel_title: typeof it.channel_title === 'string' ? it.channel_title : '',
      duration_sec: Number.isFinite(it.duration_sec) ? it.duration_sec : null,
      view_count: Number.isFinite(it.view_count) ? it.view_count : null,
      published_at: typeof it.published_at === 'string' ? it.published_at : null,
    }));

  if (!items.length) return null;

  return {
    feed_date: typeof feed.feed_date === 'string' ? feed.feed_date : null,
    generated_at: typeof feed.generated_at === 'string' ? feed.generated_at : null,
    region: typeof feed.region === 'string' ? feed.region : null,
    items,
  };
}
