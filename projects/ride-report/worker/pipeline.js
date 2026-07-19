// One full run: fetch -> score -> synthesize -> upload.
//
// Shared by the scheduled entry point and (Phase 4) the Realtime listener, so
// it takes options rather than reading argv, and returns a result object rather
// than calling process.exit().
//
// Ordering is deliberate: weather is fetched and scored BEFORE anything is
// written, and the row is written exactly once at the end. There is no code
// path that writes a partial report.

import { scoreReport } from '../score.js';
import { fetchWeather, nowInZone } from './openmeteo.js';
import { synthesize, synthesizeTrip } from './synth.js';
import { insertReport, getTrip } from './db.js';
import {
  HORIZON_DAYS,
  tripWindow,
  forecastDaysFor,
  buildTripTruth,
  buildTripContext,
  placeholderPayload,
  pastPayload,
  coordinateProblem,
  badLocationPayload,
} from './trip.js';

export const DEFAULT_LOCATION = {
  latitude: Number(process.env.RIDE_LAT || 46.8772),
  longitude: Number(process.env.RIDE_LON || -96.7898),
  timezone: process.env.RIDE_TIMEZONE || 'America/Chicago',
};

/**
 * Reduce a full scoreReport() result to the Phase 2 payload's deterministic
 * fields, for the target date. These are the numbers the LLM must not touch.
 */
export function buildTruth(report, targetDate) {
  const day = report.days.find((d) => d.date === targetDate) || report.days[0];
  if (!day) throw new Error('scoring produced no days');

  return {
    day_score: day.dayScore,
    windows: day.windows.map((w) => ({
      start: w.start,
      end: w.end,
      avgScore: w.avgScore,
      ...(w.best ? { best: true } : {}),
      ...(w.fallback ? { fallback: true } : {}),
    })),
    mud: report.mud,
  };
}

/** The richer picture the model narrates from — not stored in the DB row. */
export function buildContext(report, hours, targetDate, location) {
  const day = report.days.find((d) => d.date === targetDate) || report.days[0];
  const byTime = new Map(hours.map((h) => [h.t, h]));

  const daylight = (day?.hourly || []).filter((h) => h.daylight && h.score != null);
  const detail = daylight.map((h) => {
    const raw = byTime.get(h.t) || {};
    return {
      t: h.t,
      score: h.score,
      limiting: h.limiting,
      apparentTemp: raw.apparentTemp,
      windSpeed: raw.windSpeed,
      windGust: raw.windGust,
      precipProbability: raw.precipProbability,
      aqi: raw.aqi,
    };
  });

  const upcoming = report.days
    .filter((d) => d.date > targetDate)
    .slice(0, 2)
    .map((d) => ({ date: d.date, dayScore: d.dayScore }));

  return {
    date: targetDate,
    location: { name: 'Fargo, ND', ...location },
    units: { temperature: 'F', wind: 'mph', precipitation: 'inch' },
    daylight_hours: detail,
    upcoming_days: upcoming,
  };
}

/**
 * Run the daily pipeline once.
 *
 * Returns { row, source, degraded, truth, payload }. Throws only on failures
 * that must NOT produce a row: weather unavailable, or the DB write itself
 * failing. Synthesis failure is degraded-but-successful — the row still lands
 * with source='fallback' and `degraded: true`, which the caller turns into a
 * non-zero exit so the timer's next tick is a natural retry.
 */
export async function runDaily({
  location = DEFAULT_LOCATION,
  dryRun = false,
  targetDate = null,
} = {}) {
  const startedAt = Date.now();

  // 1. Fetch. Throws on failure -> nothing is written.
  const { hours, daily } = await fetchWeather(location);
  const nowStr = nowInZone(location.timezone);
  const date = targetDate || nowStr.slice(0, 10);
  console.log(`[pipeline] ${hours.length} hours fetched; now=${nowStr} target=${date}`);

  // 2. Score. Pure, same module the browser runs.
  const report = scoreReport(hours, daily, { nowStr });
  const truth = buildTruth(report, date);
  const context = buildContext(report, hours, date, location);
  console.log(`[pipeline] day_score=${truth.day_score} windows=${truth.windows.length} mud=${truth.mud.risk}`);

  // 3. Synthesize. Never throws; may return a fallback.
  const { payload: narrated, source, model } = await synthesize(truth, { context });
  const degraded = source !== 'claude';

  const payload = {
    ...narrated,
    model: { ...model, generated_in_ms: Date.now() - startedAt },
  };

  if (dryRun) {
    console.log('[pipeline] dry run — not writing to Supabase');
    return { row: null, source, degraded, truth, payload };
  }

  // 4. Upload. Single write, at the end.
  const row = await insertReport({ kind: 'daily', source, payload, generatedAt: new Date().toISOString() });
  console.log(`[pipeline] wrote report ${row?.id} (source=${source})`);

  return { row, source, degraded, truth, payload };
}

/**
 * Run the pipeline for one trip.
 *
 * Same shape and same guarantees as runDaily: weather and scoring happen before
 * anything is written, and the row lands exactly once at the end. Throws only
 * where no row should exist — weather unavailable, or the write itself failing.
 *
 * Returns `{ row, source, degraded, placeholder, skipped }`. `placeholder` marks
 * the two outcomes that are correct rather than degraded — a trip beyond the
 * horizon and a trip already over — both of which write `source: 'fallback'`
 * without spending an LLM call. Callers must not treat those as failures.
 */
export async function runTrip(tripId, { dryRun = false, today = null } = {}) {
  const startedAt = Date.now();

  const trip = await getTrip(tripId);
  if (!trip) {
    // Deleted between the Realtime event and this run. The FK cascade already
    // took its reports with it; there is nothing to write and nothing wrong.
    console.log(`[pipeline] trip ${tripId} no longer exists — nothing to do`);
    return { row: null, skipped: 'deleted', degraded: false, placeholder: false };
  }

  /**
   * Write the row and shape the return value. Every exit from this function
   * goes through here, so the deleted-mid-run case only has to be handled once.
   */
  const finish = async (payload, source, outcome) => {
    if (dryRun) {
      console.log('[pipeline] dry run — not writing to Supabase');
      return { row: null, source, ...outcome };
    }

    try {
      const row = await insertReport({
        kind: 'trip',
        tripId,
        source,
        payload: { ...payload, model: { ...(payload.model || {}), generated_in_ms: Date.now() - startedAt } },
        generatedAt: new Date().toISOString(),
      });
      console.log(`[pipeline] wrote trip report ${row?.id} for "${trip.title}" (source=${source})`);
      return { row, source, ...outcome };
    } catch (err) {
      // 23503 is the FK on reports.trip_id: the trip was deleted between the
      // read at the top of this function and this write. Synthesis takes over a
      // minute, so the window is real — and losing that race is a no-op, not a
      // failure. Reporting it as one would mean a deleted trip left a red
      // `systemctl status` and an alarming line in the listener's log.
      if (err.code === '23503') {
        console.log(`[pipeline] trip "${trip.title}" was deleted while its report was being written — discarding it`);
        return { row: null, source, skipped: 'deleted', degraded: false, placeholder: false };
      }
      throw err;
    }
  };

  // "Today" is the Pi's date. A trip in another timezone can be a few hours out
  // of step with this, which moves the horizon boundary by at most a day and is
  // corrected by the next scheduled run — buildTripTruth reads actual coverage
  // back off the response rather than trusting this arithmetic.
  const asOf = today || nowInZone(DEFAULT_LOCATION.timezone).slice(0, 10);
  const window = tripWindow(trip, asOf);
  console.log(`[pipeline] trip "${trip.title}" ${trip.start_date}..${trip.end_date} @ ${trip.location_name} — ${window.status}`);

  if (window.status === 'past') {
    return finish(pastPayload(trip), 'fallback', { degraded: false, placeholder: true });
  }

  // Checked after 'past' — an ended trip needs no coordinates, and telling
  // someone to fix a trip they already took is noise. Checked before the
  // horizon, so an unset location is reported the day it's saved rather than
  // two weeks later when the forecast finally reaches it.
  const problem = coordinateProblem(trip);
  if (problem) {
    console.error(`[pipeline] trip "${trip.title}" coordinates ${problem} (lat=${trip.lat} lon=${trip.lon}) — refusing to forecast`);
    return finish(badLocationPayload(trip, problem), 'fallback', { degraded: false, placeholder: true });
  }

  if (window.status === 'beyond') {
    console.log(`[pipeline] beyond the ${HORIZON_DAYS}-day horizon — placeholder, no LLM call (firms up ${window.firmsUpOn})`);
    return finish(placeholderPayload(trip, window), 'fallback', { degraded: false, placeholder: true });
  }

  // 1. Fetch, for the trip's own coordinates. One day of slack past what the
  // arithmetic asks for, so a timezone-boundary off-by-one costs a spare day of
  // forecast rather than a missing trip day.
  const forecastDays = Math.min(forecastDaysFor(asOf, window.coveredEnd) + 1, HORIZON_DAYS);
  const { hours, daily, timezone } = await fetchWeather({
    latitude: trip.lat,
    longitude: trip.lon,
    // Resolved from the coordinates — a trip does not carry a timezone, and
    // the Pi's is only correct by coincidence.
    timezone: 'auto',
    pastDays: 3,
    forecastDays,
  });

  const nowStr = nowInZone(timezone);
  console.log(`[pipeline] ${hours.length} hours fetched for ${timezone}; now=${nowStr} covering ${window.coveredStart}..${window.coveredEnd}`);

  // 2. Score, then reduce to this trip's days.
  const report = scoreReport(hours, daily, { nowStr });
  const truth = buildTripTruth(report, hours, window, trip);
  const context = buildTripContext(report, hours, truth, trip, {
    latitude: trip.lat,
    longitude: trip.lon,
    timezone,
  });
  console.log(`[pipeline] ${truth.days.length} day(s) scored; best=${truth.best_days.join(', ') || 'none'}${truth.partial ? `; partial through ${truth.covered_through}` : ''}`);

  // 3. Synthesize. Never throws; may return a deterministic summary.
  const { payload: narrated, source, model } = await synthesizeTrip(truth, { context });
  const degraded = source !== 'claude';

  // 4. Upload.
  return finish({ ...narrated, model }, source, { degraded, placeholder: false, truth, payload: narrated });
}
