#!/usr/bin/env node
// Entry point for the systemd timer.
//
// Two jobs per tick: the daily report, then a refresh of every trip the
// forecast can currently see. The trip refresh is what makes an outlook
// "update as better forecasts are known" — a trip 12 days out gets re-narrated
// every few hours as the models firm up, and a trip that was beyond the horizon
// last night gets its first real synthesis the morning it comes into range.
//
// It doubles as the second safety net behind the listener's gap-fill sweep: a
// Realtime event lost to a disconnect leaves a trip stale for a few hours at
// worst, never indefinitely.
//
// Exit codes are the contract with systemd:
//   0  report written from Claude
//   1  nothing written (weather or DB failure) — previous report still stands
//   2  something was written, but degraded — the daily report came from the
//      deterministic fallback, or a trip refresh failed outright
//
// 2 is deliberately non-zero: the row landed, so the page stays useful, but
// `systemctl status` should show the run as failed so a persistent Claude
// outage is visible rather than silently degrading forever.

import { loadEnv, tripsInHorizon, tripsNeedingSynthesis } from './db.js';
import { runDaily, runTrip, DEFAULT_LOCATION } from './pipeline.js';
import { nowInZone } from './openmeteo.js';
import { HORIZON_DAYS, addDays } from './trip.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const tripsOnly = args.has('--trips-only');

/**
 * Every trip worth a run right now: the ones inside the forecast horizon, plus
 * any trip whose newest report is older than its last edit.
 *
 * The second set is what closes the last hole in the listener's coverage. A
 * trip created far past the horizon while the listener was down is not "in
 * horizon", so the first query never sees it, and it would sit showing nothing
 * until the listener happened to restart. It needs one cheap placeholder row,
 * and this is where it gets it.
 *
 * Union by id — a trip in both sets is still one run.
 */
async function tripsToRefresh(today) {
  const horizonEnd = addDays(today, HORIZON_DAYS - 1);
  const [inHorizon, stale] = await Promise.all([
    tripsInHorizon(today, horizonEnd),
    tripsNeedingSynthesis(today),
  ]);

  const byId = new Map();
  for (const trip of [...inHorizon, ...stale]) byId.set(trip.id, trip);
  return [...byId.values()];
}

/**
 * Refresh each trip in turn. Sequential on purpose: each one may spend a Claude
 * call, and the whole point of the surrounding flock is that this machine does
 * one synthesis at a time.
 *
 * A single trip failing is logged and stepped over — one bad trip must not cost
 * the others their refresh — but the count comes back so the exit code can say
 * so.
 */
async function refreshTrips(today) {
  const trips = await tripsToRefresh(today);
  if (!trips.length) {
    console.log('[run] no trips to refresh');
    return { total: 0, failed: 0 };
  }

  console.log(`[run] refreshing ${trips.length} trip(s)`);
  let failed = 0;

  for (const trip of trips) {
    try {
      await runTrip(trip.id, { dryRun, today });
    } catch (err) {
      failed += 1;
      console.error(`[run] trip "${trip.title}" (${trip.id}) FAILED: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }
  }

  return { total: trips.length, failed };
}

async function main() {
  await loadEnv();

  const startedAt = new Date();
  console.log(`[run] starting ${startedAt.toISOString()}${dryRun ? ' (dry run)' : ''}${tripsOnly ? ' (trips only)' : ''}`);

  // One notion of "today" for the whole run, so a tick that straddles midnight
  // can't put the daily report on one date and the trip horizon on another.
  const today = nowInZone(DEFAULT_LOCATION.timezone).slice(0, 10);

  let daily = { source: 'skipped', degraded: false, row: null };
  if (!tripsOnly) {
    // The daily report is the page's headline content, so it goes first: if the
    // run is going to be cut short, this is the part that must have happened.
    daily = await runDaily({ dryRun, targetDate: today });
  }

  const trips = await refreshTrips(today);

  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(
    `[run] done in ${elapsed}s — daily source=${daily.source} row=${daily.row?.id ?? '(none)'};`
    + ` trips ${trips.total - trips.failed}/${trips.total} ok`,
  );

  return (daily.degraded || trips.failed > 0) ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Nothing was written. Log the reason plainly; the next tick retries.
    console.error(`[run] FAILED — no report written: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
