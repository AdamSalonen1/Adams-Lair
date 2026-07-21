// Trip logic, minus the I/O.
//
// PURE module, in the same spirit as ../score.js: no fetch, no DB, no clock of
// its own — "today" is always passed in. That is what makes the horizon rules
// (the fiddliest part of Phase 4) testable without a network, which test-trip.js
// leans on heavily.
//
// The division of labour against pipeline.js: this file decides *what a trip
// means* — which days are forecastable, which are beyond the horizon, what the
// deterministic payload looks like. pipeline.js does the fetching and writing.

import { computeMud } from '../score.js';

// Open-Meteo's ceiling. 16 forecast days means today plus the next 15, so a
// trip is reachable when it starts on or before today+15.
export const HORIZON_DAYS = 16;

// ===== Date math =====
//
// All of it on 'YYYY-MM-DD' strings via UTC, never local Date arithmetic.
// These dates are calendar dates, not instants: adding a day to a `date` column
// must never land on the same day because a DST boundary ate an hour.

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / 86_400_000);
}

/**
 * How much of a trip the forecast can actually see today.
 *
 * Returns one of four statuses, which are the four cases the pipeline has to
 * write a different report for:
 *
 *   past    — it already ended; nothing to forecast, ever again
 *   beyond  — starts past the horizon; placeholder, no LLM call
 *   covered — fully forecastable
 *   partial — starts inside the horizon but runs off the end of it
 *
 * `coveredStart` clamps to today for a trip already underway: yesterday's
 * conditions are not an outlook.
 */
export function tripWindow(trip, today, horizonDays = HORIZON_DAYS) {
  const horizonEnd = addDays(today, horizonDays - 1);

  if (trip.end_date < today) {
    return { status: 'past', horizonEnd };
  }

  if (trip.start_date > horizonEnd) {
    return {
      status: 'beyond',
      horizonEnd,
      // The day this trip's first day slides into view: start_date - 15, so
      // that day's horizonEnd lands exactly on start_date.
      firmsUpOn: addDays(trip.start_date, -(horizonDays - 1)),
    };
  }

  const coveredStart = trip.start_date < today ? today : trip.start_date;
  const coveredEnd = trip.end_date > horizonEnd ? horizonEnd : trip.end_date;
  const partial = trip.end_date > horizonEnd;

  return {
    status: partial ? 'partial' : 'covered',
    horizonEnd,
    coveredStart,
    coveredEnd,
    partial,
  };
}

/**
 * Why a trip's coordinates can't be used, or null if they're fine.
 *
 * The (0, 0) case is the one that earns this function. It is a real point in
 * the Gulf of Guinea, so Open-Meteo answers it cheerfully — resolving the zone
 * to Etc/GMT and returning a perfectly well-formed marine forecast, which then
 * gets narrated into a confident outlook for a trip nobody is taking. A wrong
 * answer delivered fluently is worse than no answer, and "both coordinates are
 * exactly zero" is the universal signature of a location that was never set
 * rather than one that happens to be there.
 */
export function coordinateProblem({ lat, lon }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'are missing';
  if (lat < -90 || lat > 90) return 'have a latitude outside -90..90';
  if (lon < -180 || lon > 180) return 'have a longitude outside -180..180';
  if (lat === 0 && lon === 0) return 'are still at 0, 0';
  return null;
}

/**
 * The report for a trip whose coordinates can't be forecast. Written rather
 * than thrown so the problem shows up on the card, where the person who can fix
 * it will see it, instead of only in the Pi's journal.
 */
export function badLocationPayload(trip, problem) {
  return {
    start_date: trip.start_date,
    end_date: trip.end_date,
    days: [],
    best_days: [],
    covered_through: null,
    partial: false,
    bad_location: true,
    // The location name is deliberately not interpolated here. The card already
    // shows it two lines up, and a user-supplied name ending in its own
    // punctuation ("Glendalough State Park!") renders as "Park!." when a
    // sentence closes on it.
    summary: `No outlook yet — this trip's coordinates ${problem}, so there's nowhere to forecast. Edit the trip and set its latitude and longitude.`,
    headline: "Set this trip's coordinates",
  };
}

/** `forecast_days` needed to reach coveredEnd, counting today as day 1. */
export function forecastDaysFor(today, coveredEnd, horizonDays = HORIZON_DAYS) {
  const span = daysBetween(today, coveredEnd) + 1;
  return Math.min(Math.max(span, 1), horizonDays);
}

// ===== Deterministic payload =====

/**
 * Reduce a scoreReport() result to the trip's own days, with mud recomputed
 * per day.
 *
 * The per-day mud is the part worth explaining. score.js returns one mud
 * reading anchored at "now", which is the right answer for the daily report and
 * the wrong one here — what matters for a trip is whether the trails will be
 * soft *when you get there*. computeMud() only cares about the 72h of
 * precipitation preceding its anchor, and for a future day those 72h are
 * forecast hours we already have. So: re-anchor it at each trip day and the
 * same function answers the question for that day. Noon rather than midnight so
 * the window covers the three days before a ride, not before a sunrise.
 */
export function buildTripTruth(report, hours, { coveredStart, coveredEnd }, trip) {
  const days = report.days
    .filter((d) => d.date >= coveredStart && d.date <= coveredEnd)
    .map((d) => ({
      date: d.date,
      day_score: d.dayScore,
      windows: d.windows.map((w) => ({
        start: w.start,
        end: w.end,
        avgScore: w.avgScore,
        ...(w.best ? { best: true } : {}),
        ...(w.fallback ? { fallback: true } : {}),
      })),
      // Raw hours, not scored ones: computeMud reads only `t` and
      // `precipitation`, both of which scoreHours passes straight through.
      mud: computeMud(hours, `${d.date}T12:00`),
    }));

  if (!days.length) throw new Error(`scoring produced no days in ${coveredStart}..${coveredEnd}`);

  // Coverage is read back off the response rather than trusted from the
  // request. "Today" here is the Pi's date, while Open-Meteo counts forecast
  // days from the *trip location's* date — for a trip far enough east those
  // disagree, and the honest answer is however far the data actually reached.
  const coveredThrough = days[days.length - 1].date;

  return {
    start_date: trip.start_date,
    end_date: trip.end_date,
    days,
    best_days: pickBestDays(days),
    covered_through: coveredThrough,
    partial: coveredThrough < trip.end_date,
  };
}

/**
 * The days actually worth riding, best first — at most three.
 *
 * The 60 cut-off is deliberate: "best day" should mean "good day", and on a
 * washed-out week every day clearing the bar is none of them. When nothing
 * clears it we still name the single least-bad day, because "the trip is a
 * write-off" is more useful said with a date attached.
 */
export function pickBestDays(days) {
  const ranked = days
    .filter((d) => d.day_score != null)
    .sort((a, b) => b.day_score - a.day_score || a.date.localeCompare(b.date));

  if (!ranked.length) return [];
  const good = ranked.filter((d) => d.day_score >= 60).slice(0, 3);
  return (good.length ? good : ranked.slice(0, 1)).map((d) => d.date);
}

/** The richer per-hour picture the model narrates from; not stored. */
export function buildTripContext(report, hours, truth, trip, location) {
  const byTime = new Map(hours.map((h) => [h.t, h]));
  const wanted = new Set(truth.days.map((d) => d.date));

  const daysDetail = report.days
    .filter((d) => wanted.has(d.date))
    .map((d) => ({
      date: d.date,
      day_score: d.dayScore,
      hours: (d.hourly || [])
        .filter((h) => h.daylight && h.score != null)
        .map((h) => {
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
        }),
    }));

  return {
    trip: {
      title: trip.title,
      location: trip.location_name,
      start_date: trip.start_date,
      end_date: trip.end_date,
      ...(trip.notes ? { notes: trip.notes } : {}),
    },
    location: { name: trip.location_name, ...location },
    units: { temperature: 'F', wind: 'mph', precipitation: 'inch' },
    days: daysDetail,
    partial: truth.partial,
    covered_through: truth.covered_through,
  };
}

// ===== Deterministic prose =====

function timeOf(stamp) {
  const h = Number(String(stamp).slice(11, 13));
  if (Number.isNaN(h)) return String(stamp);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12} ${ampm}`;
}

function dayName(dateStr) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${dateStr}T00:00:00Z`));
}

const MUD_LABEL = {
  dry: 'Trails should be in good shape.',
  damp: 'Trails will be damp — expect soft spots.',
  muddy: 'Trails will be mud — plan on pavement.',
};

/**
 * Trip prose without the model. Same contract as synth.js's fallbackPayload:
 * never fails and never phones home. That it isn't the real narrative is
 * carried by the row's `source`, not by the prose, so a persistent Claude
 * outage is still visible on the page — as a note, not as a sentence.
 */
export function tripFallbackSummary(truth) {
  const parts = [];
  const best = truth.best_days.length
    ? truth.days.find((d) => d.date === truth.best_days[0])
    : null;

  if (best) {
    const good = best.day_score >= 60;
    parts.push(good
      ? `Best day looks like ${dayName(best.date)} (${best.day_score}).`
      : `Nothing on this trip scores well; ${dayName(best.date)} (${best.day_score}) is the least-bad day.`);

    const window = best.windows.find((w) => w.best) || best.windows[0];
    if (window) {
      parts.push(`Best stretch that day is ${timeOf(window.start)} to ${timeOf(window.end)}, averaging ${window.avgScore}.`);
    }
    if (best.mud?.risk) parts.push(MUD_LABEL[best.mud.risk] || '');
  } else {
    parts.push('Not enough forecast data to rank the days yet.');
  }

  if (truth.partial) {
    parts.push(`Forecast reaches ${dayName(truth.covered_through)}; the rest of the trip is still beyond the horizon.`);
  }

  // The "this isn't the real narrative" disclaimer used to live here. It moved
  // to the card, which reads `source` off the row — see synth.js's
  // fallbackPayload for the reasoning. Same fact, told once, where it shows.

  return {
    ...truth,
    summary: parts.filter(Boolean).join(' '),
    headline: best && best.day_score >= 60 ? `Best day: ${dayName(best.date)}` : 'Tough week to ride',
  };
}

/**
 * The report for a trip that starts past the forecast horizon. No LLM call —
 * there is genuinely nothing to narrate, and this row exists so the card says
 * something honest instead of sitting blank for weeks.
 */
export function placeholderPayload(trip, { firmsUpOn }) {
  return {
    start_date: trip.start_date,
    end_date: trip.end_date,
    days: [],
    best_days: [],
    covered_through: null,
    partial: false,
    beyond_horizon: true,
    firms_up_on: firmsUpOn,
    summary: `Too far out to forecast — the outlook firms up on ${dayName(firmsUpOn)}, when ${dayName(trip.start_date)} comes inside the 16-day window.`,
    headline: 'Too far out to call',
  };
}

/** Terminal state: the trip is over, so this report is the last word on it. */
export function pastPayload(trip) {
  return {
    start_date: trip.start_date,
    end_date: trip.end_date,
    days: [],
    best_days: [],
    covered_through: null,
    partial: false,
    past: true,
    summary: `This trip ended ${dayName(trip.end_date)}.`,
    headline: 'Trip has passed',
  };
}
