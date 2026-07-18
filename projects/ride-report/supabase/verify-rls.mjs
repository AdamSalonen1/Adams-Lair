#!/usr/bin/env node
// Ride Report — RLS verification. The Phase 2 exit criteria, as a script.
//
//   node verify-rls.mjs
//     Anon-only checks. Honest, but weak on its own: "anonymous callers see
//     zero trips" is trivially true when there are no trips to see.
//
//   SUPABASE_SERVICE_KEY=sb_secret_... node verify-rls.mjs
//     Seeds a trip, a trip report and a daily report first, so every "sees
//     nothing" assertion has something real to fail to see, then cleans up
//     after itself. Run this on the Pi, where the secret key already lives —
//     it deliberately has no reason to be on the laptop.
//
// Reads the project URL and publishable key straight from supabase-config.js,
// so it always tests the same project the page talks to.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../supabase-config.js';

const url = SUPABASE_URL.replace(/\/+$/, '');
const anonKey = SUPABASE_PUBLISHABLE_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_KEY || '';

if (!url || !anonKey) {
  console.error('supabase-config.js is not filled in — nothing to verify against.');
  process.exit(1);
}

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
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
  // The trips table defaults user_id to auth.uid(), which is null for the
  // service role — so a seeded trip has to name its owner explicitly.
  const usersRes = await fetch(`${url}/auth/v1/admin/users?per_page=1`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!usersRes.ok) throw new Error(`admin users lookup failed: HTTP ${usersRes.status}`);
  const userId = (await usersRes.json()).users?.[0]?.id;
  if (!userId) throw new Error('no auth users exist yet — create your account first');

  const today = new Date().toISOString().slice(0, 10);
  const trip = await rest('trips', {
    key: serviceKey,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      user_id: userId,
      title: 'RLS verification — safe to delete',
      location_name: 'Nowhere',
      start_date: today,
      end_date: today,
    },
  });
  if (!trip.ok) throw new Error(`could not seed a trip: HTTP ${trip.status} ${trip.text.slice(0, 200)}`);
  const tripId = trip.json[0].id;

  const tripReport = await rest('reports', {
    key: serviceKey,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      kind: 'trip',
      trip_id: tripId,
      source: 'fallback',
      payload: { summary: 'RLS verification trip narrative — must never be public.' },
    },
  });
  if (!tripReport.ok) throw new Error(`could not seed a trip report: HTTP ${tripReport.status} ${tripReport.text.slice(0, 200)}`);

  const dailyReport = await rest('reports', {
    key: serviceKey,
    method: 'POST',
    prefer: 'return=representation',
    body: {
      kind: 'daily',
      source: 'fallback',
      payload: { summary: 'RLS verification daily report — public by design.' },
    },
  });
  if (!dailyReport.ok) throw new Error(`could not seed a daily report: HTTP ${dailyReport.status} ${dailyReport.text.slice(0, 200)}`);

  return { tripId, dailyReportId: dailyReport.json[0].id };
}

async function cleanup(seeded) {
  // The trip's reports go with it via ON DELETE CASCADE.
  await rest(`trips?id=eq.${seeded.tripId}`, { key: serviceKey, method: 'DELETE' });
  await rest(`reports?id=eq.${seeded.dailyReportId}`, { key: serviceKey, method: 'DELETE' });
}

// ===== The checks =====

async function anonChecks(seeded) {
  const daily = await rest('reports?kind=eq.daily&select=id&limit=5');
  check('anon can read daily reports', daily.ok, `HTTP ${daily.status}`);
  if (seeded) {
    check('anon actually sees a daily report row', Array.isArray(daily.json) && daily.json.length > 0);
  }

  const trips = await rest('trips?select=id');
  check(
    'anon gets zero trips, and gets them as an empty list rather than an error',
    trips.status === 200 && Array.isArray(trips.json) && trips.json.length === 0,
    `HTTP ${trips.status}, ${Array.isArray(trips.json) ? `${trips.json.length} rows` : trips.text.slice(0, 120)}`,
  );

  const tripReports = await rest('reports?kind=eq.trip&select=id');
  check(
    'anon gets zero trip reports',
    tripReports.status === 200 && Array.isArray(tripReports.json) && tripReports.json.length === 0,
    `HTTP ${tripReports.status}, ${Array.isArray(tripReports.json) ? `${tripReports.json.length} rows` : tripReports.text.slice(0, 120)}`,
  );

  // The filtered query above would still pass if the policy leaked trip rows to
  // an unfiltered read, so ask the way an attacker would: no filter at all.
  const allReports = await rest('reports?select=id,kind');
  check(
    'an unfiltered read of reports returns nothing of kind=trip',
    Array.isArray(allReports.json) && allReports.json.every((r) => r.kind === 'daily'),
  );

  const insertTrip = await rest('trips', {
    method: 'POST',
    body: { title: 'anon should not be able to write this', start_date: '2026-01-01', end_date: '2026-01-02' },
  });
  check('anon cannot insert a trip', !insertTrip.ok, `HTTP ${insertTrip.status}`);

  const insertReport = await rest('reports', {
    method: 'POST',
    body: { kind: 'daily', source: 'fallback', payload: { summary: 'anon write' } },
  });
  check('anon cannot insert a report', !insertReport.ok, `HTTP ${insertReport.status}`);

  if (!seeded) return;

  // Update and delete are only meaningful against a row that exists: PostgREST
  // answers the same way for "matched nothing" and "not allowed to match it".
  //
  // And both are checked by reading the row back, not by reading the response.
  // A blocked write returns 200 with an empty body — but so does a write that
  // was allowed and returned no representation, and so does a request that went
  // somewhere unexpected. Only the stored row settles whether it changed.
  const readBack = async () => {
    const res = await rest(`reports?id=eq.${seeded.dailyReportId}&select=id,source`);
    return Array.isArray(res.json) ? res.json[0] ?? null : null;
  };

  const before = await readBack();
  if (!before) throw new Error('seeded daily report vanished before the write checks');

  const patch = await rest(`reports?id=eq.${seeded.dailyReportId}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { source: 'claude' },
  });
  const afterPatch = await readBack();
  check(
    'anon cannot update an existing daily report',
    afterPatch?.source === before.source,
    `HTTP ${patch.status}, source is still ${JSON.stringify(afterPatch?.source)}`,
  );

  const del = await rest(`reports?id=eq.${seeded.dailyReportId}`, {
    method: 'DELETE',
    prefer: 'return=representation',
  });
  const afterDelete = await readBack();
  check(
    'anon cannot delete an existing daily report',
    Boolean(afterDelete),
    `HTTP ${del.status}, ${afterDelete ? 'row still present' : 'ROW IS GONE'}`,
  );
}

async function main() {
  console.log(`Verifying RLS on ${url}\n`);

  let seeded = null;
  if (serviceKey) {
    seeded = await seed();
    console.log('Seeded a trip, a trip report and a daily report.\n');
  } else {
    console.log('No SUPABASE_SERVICE_KEY set — running anon checks against whatever');
    console.log('data already exists. The "sees zero rows" checks prove less this way.\n');
  }

  try {
    await anonChecks(seeded);
  } finally {
    if (seeded) {
      await cleanup(seeded);
      console.log('\nCleaned up the seeded rows.');
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
