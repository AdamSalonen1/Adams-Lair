#!/usr/bin/env node
// Daily Dozen — RLS verification. The Phase 2 exit criteria, as a script.
//
//   node verify-rls.mjs
//     Anon-only checks. Honest, but weak on its own: "anonymous callers see the
//     feed and can't write it" proves more once there is a row to see.
//
//   SUPABASE_SERVICE_KEY=sb_secret_... node verify-rls.mjs
//     Seeds a throwaway feed row first (a far-past sentinel date, so it can
//     never be mistaken for a real "today" or become the newest-row fallback),
//     so every read/write assertion has something real to act on, then cleans up
//     after itself. The secret key already lives on the Pi in worker/.env.
//
// Reads the project URL and publishable key straight from supabase-config.js, so
// it always tests the same project the page talks to. That project is shared
// with Ride Report; this script only ever touches Daily Dozen's own objects.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../supabase-config.js';

const url = SUPABASE_URL.replace(/\/+$/, '');
const anonKey = SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_KEY || '';

// A date no real feed will ever carry: it sorts below every genuine row, so the
// page's `order=feed_date.desc` fallback never surfaces it even mid-test.
const SENTINEL_DATE = '1970-01-01';
const SENTINEL_INSERT_DATE = '1970-01-02';   // what an anon write would try to add

if (!url || !anonKey) {
  console.error('supabase-config.js is not filled in — nothing to verify against.');
  process.exit(1);
}

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function note(text) {
  console.log(`  --  ${text}`);
}

async function rest(path, { key = anonKey, method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON; keep the text */ }
  return { status: res.status, ok: res.ok, json, text };
}

// ===== Seeding (service key only) =====

async function seed() {
  const row = await rest('shorts_feeds', {
    key: serviceKey,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      feed_date: SENTINEL_DATE,
      region: 'US',
      items: [{ video_id: 'jNQXAC9IVRw', title: 'RLS verification — safe to delete', channel_title: 'verify-rls' }],
    },
  });
  if (!row.ok) throw new Error(`could not seed a feed row: HTTP ${row.status} ${row.text.slice(0, 200)}`);
  return { feedDate: SENTINEL_DATE };
}

async function cleanup() {
  await rest(`shorts_feeds?feed_date=eq.${SENTINEL_DATE}`, { key: serviceKey, method: 'DELETE' });
  await rest(`shorts_feeds?feed_date=eq.${SENTINEL_INSERT_DATE}`, { key: serviceKey, method: 'DELETE' });
}

// ===== The feed: public read, no writes =====

async function feedChecks(seeded) {
  const read = await rest(`shorts_feeds?${'select=feed_date,items'}&limit=5`);
  check('anon can read shorts_feeds', read.ok, `HTTP ${read.status}`);

  if (seeded) {
    const one = await rest(`shorts_feeds?feed_date=eq.${SENTINEL_DATE}&select=feed_date,items`);
    check(
      'anon actually sees the seeded feed row',
      Array.isArray(one.json) && one.json.length === 1 && one.json[0].feed_date === SENTINEL_DATE,
      `HTTP ${one.status}, ${Array.isArray(one.json) ? `${one.json.length} rows` : one.text.slice(0, 120)}`,
    );
  }

  const insert = await rest('shorts_feeds', {
    method: 'POST',
    body: { feed_date: SENTINEL_INSERT_DATE, items: [{ video_id: 'x', title: 'anon should not be able to write this' }] },
  });
  check('anon cannot insert a feed row', !insert.ok, `HTTP ${insert.status}`);

  if (!seeded) return;

  // Read the row back rather than trusting the response: a blocked write returns
  // 200 with an empty body, but so does a write that was allowed and returned no
  // representation. Only the stored row settles whether it changed.
  const readBack = async () => {
    const res = await rest(`shorts_feeds?feed_date=eq.${SENTINEL_DATE}&select=feed_date,region`);
    return Array.isArray(res.json) ? res.json[0] ?? null : null;
  };

  const before = await readBack();
  if (!before) throw new Error('seeded feed row vanished before the write checks');

  const patch = await rest(`shorts_feeds?feed_date=eq.${SENTINEL_DATE}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { region: 'ZZ' },
  });
  const afterPatch = await readBack();
  check(
    'anon cannot update a feed row',
    afterPatch?.region === before.region,
    `HTTP ${patch.status}, region is still ${JSON.stringify(afterPatch?.region)}`,
  );

  const del = await rest(`shorts_feeds?feed_date=eq.${SENTINEL_DATE}`, {
    method: 'DELETE',
    prefer: 'return=representation',
  });
  const afterDelete = await readBack();
  check(
    'anon cannot delete a feed row',
    Boolean(afterDelete),
    `HTTP ${del.status}, ${afterDelete ? 'row still present' : 'ROW IS GONE'}`,
  );
}

// ===== The heartbeat: public read, no writes =====
//
// Needs no seeding — schema.sql creates the singleton. Tolerant of the table not
// existing yet: if this project predates the Phase 3 heartbeat, the checks are
// skipped with a note rather than failing, so verify-rls stays useful before the
// schema is re-applied.

async function heartbeatChecks() {
  const read = await rest('dozen_worker_status?select=last_run_at,last_ok_at,last_item_count');

  // PostgREST answers an unknown table with 404 and code PGRST205/42P01.
  if (read.status === 404) {
    note('dozen_worker_status does not exist yet — re-apply schema.sql to add the Phase 3 heartbeat. Skipping its checks.');
    return;
  }

  check(
    'anon can read dozen_worker_status, and there is exactly one row',
    read.status === 200 && Array.isArray(read.json) && read.json.length === 1,
    `HTTP ${read.status}, ${Array.isArray(read.json) ? `${read.json.length} rows` : read.text.slice(0, 120)}`,
  );

  const insert = await rest('dozen_worker_status', {
    method: 'POST',
    body: { id: 2, last_error: 'anon should not be able to write this' },
  });
  check('anon cannot insert a dozen_worker_status row', !insert.ok, `HTTP ${insert.status}`);

  const readBack = async () => {
    const res = await rest('dozen_worker_status?id=eq.1&select=last_error');
    return Array.isArray(res.json) ? res.json[0] ?? null : null;
  };

  const before = await readBack();
  if (!before) {
    check('dozen_worker_status singleton exists to test writes against', false, 'no row with id=1 — apply schema.sql');
    return;
  }

  const patch = await rest('dozen_worker_status?id=eq.1', {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { last_error: 'anon tampered with the heartbeat' },
  });
  const afterPatch = await readBack();
  check(
    'anon cannot update dozen_worker_status',
    afterPatch?.last_error === before.last_error,
    `HTTP ${patch.status}, last_error is still ${JSON.stringify(afterPatch?.last_error)}`,
  );

  const del = await rest('dozen_worker_status?id=eq.1', { method: 'DELETE', prefer: 'return=representation' });
  const afterDelete = await readBack();
  check(
    'anon cannot delete dozen_worker_status',
    Boolean(afterDelete),
    `HTTP ${del.status}, ${afterDelete ? 'row still present' : 'ROW IS GONE'}`,
  );
}

async function main() {
  console.log(`Verifying RLS on ${url}\n`);

  let seeded = null;
  if (serviceKey) {
    seeded = await seed();
    console.log(`Seeded a throwaway feed row (${SENTINEL_DATE}).\n`);
  } else {
    console.log('No SUPABASE_SERVICE_KEY set — running anon checks against whatever');
    console.log('data already exists. The "sees a row" / write checks prove less this way.\n');
  }

  try {
    await feedChecks(seeded);
    await heartbeatChecks();
  } finally {
    if (seeded) {
      await cleanup();
      console.log('\nCleaned up the seeded row.');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nverify-rls failed to run: ${err.message}`);
  process.exit(1);
});
