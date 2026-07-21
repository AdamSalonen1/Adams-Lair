// Supabase writes over plain REST — no supabase-js needed for an upsert, which
// keeps the worker dependency-free (`npm ci` installs nothing). Daily Dozen has
// no Realtime, unlike Ride Report, so this stays true all the way through.
//
// Everything here writes with the SECRET key, which bypasses RLS. shorts_feeds
// and dozen_worker_status have no write policy for anyone else on purpose.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { todayInZone } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Minimal .env loader so `node run-daily.js` works without --env-file and
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
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url) throw new Error('SUPABASE_URL is not set (see .env.example)');
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set (see .env.example)');

  // The publishable/anon key cannot satisfy these tables — neither has an insert
  // policy, so RLS would reject every write. Fail loudly here rather than let it
  // look like a mysterious 401 at 6:30 AM.
  if (key.startsWith('sb_publishable_') || key.includes('publishable')) {
    throw new Error('SUPABASE_SECRET_KEY looks like the publishable key — the worker needs the SECRET (sb_secret_...) key');
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

// ===== The feed =====

/**
 * Upsert today's feed row. `feed_date` is the primary key, so a second run on
 * the same day overwrites rather than duplicates — `on conflict (feed_date) do
 * update`, expressed as PostgREST's merge-duplicates. Returns the stored row.
 */
export async function upsertFeed({ feedDate, region = 'US', items, generatedAt }) {
  if (!feedDate) throw new Error('upsertFeed needs a feedDate');
  if (!Array.isArray(items) || !items.length) throw new Error('upsertFeed needs a non-empty items array');

  const row = {
    feed_date: feedDate,
    region,
    items,
    ...(generatedAt ? { generated_at: generatedAt } : {}),
  };

  const stored = await request('shorts_feeds', {
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return Array.isArray(stored) ? stored[0] : stored;
}

// ===== Heartbeat =====
//
// A twin of Ride Report's, pointed at dozen_worker_status (the two apps share a
// database and must not share a single-row heartbeat). Never throws: a run whose
// feed landed must not be reported as failed because the bookkeeping after it
// didn't, and a run that already failed because Supabase is unreachable will
// fail to write this too — expected, and already logged by the time we're here.

/** One short line. `last_error` is world-readable; keep it small and boring. */
function oneLine(error) {
  if (!error) return null;
  const text = typeof error === 'string' ? error : error.message || String(error);
  return text.split('\n')[0].trim().slice(0, 200) || null;
}

/**
 * Update the single dozen_worker_status row. Only the fields passed are sent,
 * and a failed run deliberately does not pass `okAt` — that is the mechanism the
 * whole table exists for: `last_ok_at` keeps pointing at the last run that
 * actually worked, so the gap since it is the length of the outage.
 */
export async function recordHeartbeat({ ranAt, okAt = null, error = null, itemCount = null } = {}) {
  const fields = {
    last_run_at: ranAt || new Date().toISOString(),
    // Always written, including as null: a clean run has to clear the error left
    // behind by the last broken one.
    last_error: oneLine(error),
    ...(okAt ? { last_ok_at: okAt } : {}),
    ...(itemCount != null ? { last_item_count: itemCount } : {}),
  };

  try {
    // PATCH, not upsert: a plain UPDATE touches the columns named and leaves the
    // rest alone, which is exactly the "don't clobber last_ok_at on a failed
    // run" property in the most boring way SQL offers.
    const updated = await request('dozen_worker_status?id=eq.1', {
      method: 'PATCH',
      body: fields,
      prefer: 'return=representation',
    });
    if (Array.isArray(updated) && updated.length) return;

    // Nothing to update: the seed hasn't run, or the row was deleted. Create it
    // rather than going quiet — a heartbeat that needs someone to notice a
    // missing row first is absent on precisely the day it should speak up.
    await request('dozen_worker_status', { body: { id: 1, ...fields } });
    console.log('[db] dozen_worker_status row was missing — created it');
  } catch (err) {
    // The likeliest cause on a fresh project is that the table doesn't exist yet
    // (schema.sql not re-applied). Say so plainly and carry on — the feed write
    // is the job; the heartbeat is bookkeeping.
    console.warn(`[db] heartbeat write failed (harmless; re-apply schema.sql if the table is missing): ${err.message}`);
  }
}

// ===== Retention =====

/**
 * Drop feed rows older than `keepDays`, counted from today in the feed's zone.
 *
 * Call this only after a row has landed this run. That ordering is the whole
 * safety argument: there is always at least today's row newer than the cutoff,
 * so a Pi returning from a long outage prunes its backlog rather than emptying
 * the table and leaving the page with nothing to read.
 *
 * Never throws. Tidying is the least important thing a run does.
 */
export async function pruneFeeds({ keepDays = 14, today } = {}) {
  const anchor = today || todayInZone();
  const cutoff = new Date(`${anchor}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  try {
    const deleted = await request(
      `shorts_feeds?feed_date=lt.${cutoffDate}&select=feed_date`,
      { method: 'DELETE', prefer: 'return=representation' },
    );
    const count = Array.isArray(deleted) ? deleted.length : 0;
    if (count) console.log(`[db] pruned ${count} feed row(s) older than ${cutoffDate}`);
    return count;
  } catch (err) {
    console.warn(`[db] prune failed (harmless, will retry next run): ${err.message}`);
    return 0;
  }
}
