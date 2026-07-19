// Supabase writes over plain REST — no supabase-js needed for an insert, which
// keeps `npm ci` on the Pi dependency-free. Phase 4 adds supabase-js for the
// Realtime socket; this file stays as-is.
//
// Note on insert-vs-upsert: the plan says "upsert", but `reports` has no unique
// constraint to conflict on, and its index is (kind, generated_at desc) — it's
// an append-only history the page reads the newest row from. So: insert.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Minimal .env loader so `node run-scheduled.js` works without --env-file and
 * without a dotenv dependency. Existing process.env always wins, which is what
 * makes systemd's EnvironmentFile= and one-off overrides behave predictably.
 */
export async function loadEnv(file = path.join(HERE, '.env')) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return false; // no .env is fine — systemd supplies the environment directly
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

function credentials() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url) throw new Error('SUPABASE_URL is not set (see .env.example)');
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set (see .env.example)');

  // The publishable/anon key cannot satisfy this table — `reports` has no
  // insert policy at all, so RLS would reject every write. Fail loudly here
  // rather than let it look like a mysterious 401 at 3 AM.
  if (key.startsWith('sb_publishable_') || key.includes('publishable')) {
    throw new Error('SUPABASE_SERVICE_KEY looks like the publishable key — the worker needs the SECRET (service_role) key');
  }

  return { url, key };
}

async function request(pathname, { method = 'POST', body, prefer, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { url, key } = credentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${url}/rest/v1/${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Supabase ${method} ${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      // PostgREST passes the Postgres SQLSTATE through as `code`. Carrying it
      // on the error lets callers tell apart the failures that mean something
      // specific — 23503, a trip deleted out from under an in-flight report —
      // from the generic ones, without parsing the message back out.
      try { err.code = JSON.parse(text)?.code; } catch { /* not JSON; leave it unset */ }
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Supabase ${method} ${pathname} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Insert one report row. `source` must be 'claude' or 'fallback' to satisfy the
 * table's CHECK constraint. Returns the inserted row.
 */
export async function insertReport({ kind = 'daily', tripId = null, source, payload, generatedAt }) {
  if (!['claude', 'fallback'].includes(source)) {
    throw new Error(`invalid source "${source}" — reports.source only allows 'claude' or 'fallback'`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an object');
  }

  const row = {
    kind,
    trip_id: tripId,
    source,
    payload,
    ...(generatedAt ? { generated_at: generatedAt } : {}),
  };

  const inserted = await request('reports', { body: row, prefer: 'return=representation' });
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

/** Most recent report of a kind — used by tests and the Phase 5 heartbeat. */
export async function latestReport(kind = 'daily') {
  const rows = await request(
    `reports?kind=eq.${encodeURIComponent(kind)}&select=id,kind,source,generated_at&order=generated_at.desc&limit=1`,
    { method: 'GET' },
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ===== Trips (Phase 4) =====
//
// All of these read with the secret key, which bypasses RLS — the worker is
// deliberately not owner-scoped. It synthesizes for whoever owns the trip; the
// owner check happens on the way back out, when the page reads the report.

const TRIP_FIELDS = 'id,user_id,title,location_name,lat,lon,start_date,end_date,notes,updated_at';

/** One trip by id, or null if it has since been deleted. */
export async function getTrip(id) {
  const rows = await request(
    `trips?id=eq.${encodeURIComponent(id)}&select=${TRIP_FIELDS}&limit=1`,
    { method: 'GET' },
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Trips worth regenerating on a scheduled run: already started or starting
 * within the horizon, and not yet over.
 *
 * `horizonEnd` is passed in rather than computed here so the caller's notion of
 * "today" stays the single source of truth for the whole run.
 */
export async function tripsInHorizon(today, horizonEnd) {
  const rows = await request(
    `trips?select=${TRIP_FIELDS}`
    + `&start_date=lte.${encodeURIComponent(horizonEnd)}`
    + `&end_date=gte.${encodeURIComponent(today)}`
    + '&order=start_date.asc',
    { method: 'GET' },
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Every trip that hasn't ended yet — including ones far past the horizon, which
 * still need their placeholder written once. This is the gap-fill sweep's
 * candidate set.
 */
export async function activeTrips(today) {
  const rows = await request(
    `trips?select=${TRIP_FIELDS}&end_date=gte.${encodeURIComponent(today)}&order=start_date.asc`,
    { method: 'GET' },
  );
  return Array.isArray(rows) ? rows : [];
}

/** `generated_at` of a trip's newest report, or null if it has none. */
export async function latestTripReportStamp(tripId) {
  const rows = await request(
    `reports?kind=eq.trip&trip_id=eq.${encodeURIComponent(tripId)}`
    + '&select=generated_at&order=generated_at.desc&limit=1',
    { method: 'GET' },
  );
  return Array.isArray(rows) && rows.length ? rows[0].generated_at : null;
}

/**
 * Trips whose newest report is older than their last edit (or which have no
 * report at all) — i.e. the ones a Realtime event should have covered and
 * didn't, because the socket was down when it fired.
 *
 * One capped query per trip rather than one sweep of `reports`, for the reason
 * spelled out in ../supabase.js: `reports` is append-only and every scheduled
 * run appends to it, so a sweep grows without bound while the answer stays a
 * handful of rows. Trips are counted in ones and twos.
 */
export async function tripsNeedingSynthesis(today) {
  const trips = await activeTrips(today);

  const stale = await Promise.all(trips.map(async (trip) => {
    const stamp = await latestTripReportStamp(trip.id);
    if (!stamp) return trip;
    return Date.parse(trip.updated_at) > Date.parse(stamp) ? trip : null;
  }));

  return stale.filter(Boolean);
}
