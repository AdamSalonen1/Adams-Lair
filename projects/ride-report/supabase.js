// Ride Report — Supabase data plane. Nothing in this file touches the DOM.
//
// Two transports, deliberately:
//
//   * The daily report is read over plain REST. It is the page's headline
//     content and it is public under RLS, so a GET with the publishable key is
//     a few lines — it renders without waiting on a CDN module, and still
//     renders when that CDN is unreachable. Same reasoning as the worker's
//     db.js, for the same kind of request.
//   * Auth and trips go through supabase-js, imported lazily on first use.
//     Magic links, session persistence and token refresh are exactly the parts
//     not worth hand-rolling.
//
// The upshot of the split: a bad day for jsDelivr costs you the trips UI, not
// the forecast.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

// Pinned, not floating: this page has no build step and no lockfile, so the
// version in this string is the only thing standing between it and a silent
// breaking change years from now.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.7/+esm';
const REST_TIMEOUT_MS = 8000;

const baseUrl = SUPABASE_URL.replace(/\/+$/, '');

/** False until supabase-config.js is filled in; the page checks before asking for anything. */
export function isConfigured() {
  return Boolean(baseUrl && SUPABASE_PUBLISHABLE_KEY);
}

// ===== Public reads: the daily report and the worker's heartbeat =====

async function publicRead(query, what) {
  const res = await fetch(`${baseUrl}/rest/v1/${query}`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    },
    signal: AbortSignal.timeout(REST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Supabase returned HTTP ${res.status} reading ${what}`);
  }

  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Newest `kind='daily'` report, or null if there are none. Readable by anyone —
 * one of the two things the RLS policies hand out to anonymous visitors.
 */
export function fetchLatestDailyReport() {
  if (!isConfigured()) return Promise.resolve(null);

  return publicRead(
    'reports?kind=eq.daily&select=id,source,generated_at,payload&order=generated_at.desc&limit=1',
    'the daily report',
  );
}

/**
 * The worker's heartbeat row, or null.
 *
 * `last_error` is deliberately not selected. It is world-readable and the page
 * has no business rendering a raw error string to a visitor — the page's job is
 * to say "this is old", not to explain the Pi's internals to a stranger. The
 * column is there for `curl` and the journal.
 */
export function fetchWorkerStatus() {
  if (!isConfigured()) return Promise.resolve(null);

  return publicRead(
    'worker_status?select=last_run_at,last_ok_at,source_of_last_report&limit=1',
    'the worker status',
  );
}

// ===== supabase-js: auth and trips =====

let clientPromise = null;

/**
 * The supabase-js client, or null if it could not be loaded. Resolving to null
 * rather than throwing is the point: every caller is an enhancement, and the
 * page has to stay useful without them.
 */
export function getClient() {
  if (!isConfigured()) return Promise.resolve(null);

  if (!clientPromise) {
    clientPromise = import(SUPABASE_JS)
      .then(({ createClient }) => createClient(baseUrl, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // Consumes the tokens the magic link leaves in the URL, then cleans
          // them out of the address bar.
          detectSessionInUrl: true,
        },
      }))
      .catch((err) => {
        console.warn('Ride Report: supabase-js failed to load — trips are unavailable.', err);
        clientPromise = null; // a later click gets a fresh attempt
        return null;
      });
  }

  return clientPromise;
}

export async function getSession() {
  const supabase = await getClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/** Fires on login, logout, and token refresh — including the magic-link return. */
export async function onAuthChange(handler) {
  const supabase = await getClient();
  if (!supabase) return;
  supabase.auth.onAuthStateChange((_event, session) => handler(session ?? null));
}

export async function sendMagicLink(email) {
  const supabase = await getClient();
  if (!supabase) throw new Error('Sign-in is unavailable right now — try again in a moment.');

  // Back to this page rather than the site root, so the link lands where the
  // trips UI actually is. This exact URL has to be listed under
  // Auth -> URL Configuration -> Redirect URLs, or Supabase quietly redirects
  // to the project's Site URL instead and the session appears to vanish.
  const emailRedirectTo = `${window.location.origin}${window.location.pathname}`;

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo },
  });
  if (error) throw error;
}

export async function signOut() {
  const supabase = await getClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

/**
 * Every trip the caller owns. Anonymous callers get [] from RLS, not an error,
 * so this needs no session check of its own.
 */
export async function listTrips() {
  const supabase = await getClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('trips')
    .select('id,title,location_name,lat,lon,start_date,end_date,notes,updated_at')
    .order('start_date', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Latest report for each of the given trips, keyed by trip_id. Empty until the
 * Phase 4 listener starts producing them; RLS already scopes rows to the owner.
 *
 * One capped query per trip rather than one ordered sweep of the table. The
 * sweep is tempting and is correct today — `reports` is append-only, so newest
 * per trip means filtering a descending scan — but Phase 4 regenerates every
 * upcoming trip on each scheduled run. A few weeks in, that sweep is every
 * narrative ever written, downloaded in full on every page load, to render the
 * handful at the front. Trips are counted in ones and twos; the extra round
 * trips cost nothing and the payload stays bounded.
 */
export async function latestTripReports(tripIds = []) {
  const supabase = await getClient();
  if (!supabase || !tripIds.length) return new Map();

  const rows = await Promise.all(tripIds.map(async (tripId) => {
    const { data, error } = await supabase
      .from('reports')
      .select('trip_id,generated_at,source,payload')
      .eq('kind', 'trip')
      .eq('trip_id', tripId)
      .order('generated_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    return data?.[0] ?? null;
  }));

  return new Map(rows.filter(Boolean).map((row) => [row.trip_id, row]));
}

/**
 * Newest report for a single trip, or null. Same query as latestTripReports()
 * does per trip — split out because the "outlook generating…" poll asks about
 * one trip repeatedly, and rebuilding a Map for one row reads like it means
 * something it doesn't.
 */
export async function latestTripReport(tripId) {
  const supabase = await getClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('reports')
    .select('trip_id,generated_at,source,payload')
    .eq('kind', 'trip')
    .eq('trip_id', tripId)
    .order('generated_at', { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] ?? null;
}

export async function createTrip(fields) {
  const supabase = await getClient();
  if (!supabase) throw new Error('Not connected to Supabase.');

  // `user_id` is deliberately absent: the column defaults to auth.uid(), so
  // ownership is the database's business and the page never gets a vote.
  const { data, error } = await supabase
    .from('trips')
    .insert(fields)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateTrip(id, fields) {
  const supabase = await getClient();
  if (!supabase) throw new Error('Not connected to Supabase.');

  const { data, error } = await supabase
    .from('trips')
    .update(fields)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteTrip(id) {
  const supabase = await getClient();
  if (!supabase) throw new Error('Not connected to Supabase.');

  const { error } = await supabase.from('trips').delete().eq('id', id);
  if (error) throw error;
}
