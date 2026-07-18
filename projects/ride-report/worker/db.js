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
      throw new Error(`Supabase ${method} ${pathname} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
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
