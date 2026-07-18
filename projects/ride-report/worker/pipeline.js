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
import { synthesize } from './synth.js';
import { insertReport } from './db.js';

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
