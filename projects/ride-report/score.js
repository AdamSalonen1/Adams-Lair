// Ride Report — scoring engine.
// PURE module: no DOM, no fetch, no Date.now(). Same file runs in the
// browser (Phase 1) and on the Pi worker (Phase 3) so a "72" always means
// the same thing in both places. Every timestamp is a "YYYY-MM-DDTHH:mm"
// wall-clock string in the location's own timezone (what Open-Meteo
// returns when you pass a `timezone` param) — callers are responsible for
// producing `nowStr` in that same zone.

function clampedLerp(x, x0, y0, x1, y1) {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  const t = (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

function hoursBetween(aStr, bStr) {
  return (Date.parse(bStr) - Date.parse(aStr)) / 3600000;
}

function formatLocal(d) {
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addHours(tStr, n) {
  const d = new Date(tStr);
  d.setHours(d.getHours() + n);
  return formatLocal(d);
}

// ----- per-factor components (each 0-100, or null if data is missing) -----

function tempComponent(apparentF) {
  if (apparentF == null || Number.isNaN(apparentF)) return null;
  if (apparentF < 20) return 0;
  if (apparentF < 32) return clampedLerp(apparentF, 20, 0, 32, 40);
  if (apparentF < 55) return clampedLerp(apparentF, 32, 40, 55, 100);
  if (apparentF <= 75) return 100;
  if (apparentF < 95) return clampedLerp(apparentF, 75, 100, 95, 40);
  return clampedLerp(apparentF, 95, 40, 110, 0);
}

function windComponent(windMph) {
  if (windMph == null || Number.isNaN(windMph)) return null;
  if (windMph <= 10) return 100;
  return clampedLerp(windMph, 10, 100, 25, 0);
}

function gustComponent(gustMph) {
  if (gustMph == null || Number.isNaN(gustMph)) return null;
  if (gustMph <= 20) return 100;
  return clampedLerp(gustMph, 20, 100, 40, 0);
}

function precipComponent(precipProbPct, precipAmountIn) {
  if (precipAmountIn != null && precipAmountIn > 0) return 5; // raining now ~= 0
  if (precipProbPct == null || Number.isNaN(precipProbPct)) return null;
  if (precipProbPct <= 20) return 100;
  return clampedLerp(precipProbPct, 20, 100, 70, 0);
}

function aqiComponent(aqi) {
  if (aqi == null || Number.isNaN(aqi)) return null;
  if (aqi <= 50) return 100;
  return clampedLerp(aqi, 50, 100, 150, 0); // hard floor: stays 0 past 150
}

function isDaylight(tStr, daily) {
  const date = tStr.slice(0, 10);
  const entry = daily.find((d) => d.date === date);
  if (!entry || !entry.sunrise || !entry.sunset) return null;
  return tStr >= entry.sunrise && tStr < entry.sunset;
}

/** Score a single hour. Returns { score, limiting, components }. */
export function scoreHour(hour) {
  const components = {
    temp: tempComponent(hour.apparentTemp),
    wind: windComponent(hour.windSpeed),
    gust: gustComponent(hour.windGust),
    precip: precipComponent(hour.precipProbability, hour.precipitation),
    aqi: aqiComponent(hour.aqi),
  };

  const available = Object.entries(components).filter(([, v]) => v != null);
  if (!available.length) return { score: null, limiting: null, components };

  available.sort((a, b) => a[1] - b[1]);
  const [limiting, worst] = available[0];
  return { score: Math.round(worst), limiting, components };
}

/** Score every hour, attaching score/limiting/components/daylight. */
export function scoreHours(hours, daily) {
  return hours.map((h) => {
    const { score, limiting, components } = scoreHour(h);
    return { ...h, score, limiting, components, daylight: isDaylight(h.t, daily) };
  });
}

function groupContiguous(hours) {
  const runs = [];
  let current = [];
  for (const h of hours) {
    if (current.length && hoursBetween(current[current.length - 1].t, h.t) !== 1) {
      runs.push(current);
      current = [];
    }
    current.push(h);
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * Best rideable windows for one day's worth of scored hours.
 * Looks for contiguous daylight runs of >= minLength hours scoring >= threshold.
 * If nothing qualifies, falls back to the single least-bad daylight run
 * (flagged `fallback: true`) so there's always something to show.
 */
export function findWindows(dayHours, { minLength = 2, threshold = 70 } = {}) {
  const daylightHours = dayHours.filter((h) => h.daylight && h.score != null);
  if (!daylightHours.length) return [];

  const runs = groupContiguous(daylightHours);

  const toWindow = (sub, extra = {}) => ({
    start: sub[0].t,
    end: addHours(sub[sub.length - 1].t, 1),
    avgScore: Math.round(sub.reduce((s, h) => s + h.score, 0) / sub.length),
    hours: sub.length,
    ...extra,
  });

  const qualifying = [];
  for (const run of runs) {
    let sub = [];
    for (const h of run) {
      if (h.score >= threshold) {
        sub.push(h);
      } else {
        if (sub.length >= minLength) qualifying.push(sub);
        sub = [];
      }
    }
    if (sub.length >= minLength) qualifying.push(sub);
  }

  if (qualifying.length) {
    const windows = qualifying.map((sub) => toWindow(sub));
    let bestIdx = 0;
    windows.forEach((w, i) => { if (w.avgScore > windows[bestIdx].avgScore) bestIdx = i; });
    windows[bestIdx].best = true;
    return windows;
  }

  let bestRun = null;
  let bestAvg = -Infinity;
  for (const run of runs) {
    const avg = run.reduce((s, h) => s + h.score, 0) / run.length;
    if (avg > bestAvg) { bestAvg = avg; bestRun = run; }
  }
  if (!bestRun) return [];
  return [toWindow(bestRun, { fallback: true, best: true })];
}

/**
 * Mud risk from the last 72h of actual precipitation, recency-weighted
 * (24h x1.0 + 24-48h x0.6 + 48-72h x0.3). `hours` should include the past
 * days fetched via Open-Meteo's `past_days`; `nowStr` anchors "now".
 */
export function computeMud(hours, nowStr) {
  const nowMs = Date.parse(nowStr);
  let weighted = 0;

  for (const h of hours) {
    if (h.precipitation == null) continue;
    const ageHours = (nowMs - Date.parse(h.t)) / 3600000;
    if (ageHours < 0 || ageHours >= 72) continue;
    const weight = ageHours < 24 ? 1.0 : ageHours < 48 ? 0.6 : 0.3;
    weighted += h.precipitation * weight;
  }

  weighted = Math.round(weighted * 100) / 100;
  const risk = weighted < 0.1 ? 'dry' : weighted <= 0.4 ? 'damp' : 'muddy';
  return { risk, weightedPrecip: weighted };
}

/**
 * Top-level entry point: scores every hour, groups into days, finds best
 * windows per day, and computes one current mud reading.
 *
 * hours: [{t, apparentTemp, windSpeed, windGust, precipProbability, precipitation, aqi}]
 * daily: [{date, sunrise, sunset}]
 * options.nowStr: "YYYY-MM-DDTHH:mm" wall-clock string in the data's timezone
 *
 * Returns { days: [{date, dayScore, hourly, windows}], mud, generatedAt }
 */
export function scoreReport(hours, daily, options = {}) {
  const {
    nowStr = hours.length ? hours[hours.length - 1].t : null,
    minWindowLength = 2,
    threshold = 70,
  } = options;

  const scored = scoreHours(hours, daily);

  const byDate = new Map();
  for (const h of scored) {
    const date = h.t.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(h);
  }

  const days = daily.map((d) => {
    const dayHours = byDate.get(d.date) || [];
    const daylightScored = dayHours.filter((h) => h.daylight && h.score != null);
    const pool = daylightScored.length ? daylightScored : dayHours.filter((h) => h.score != null);
    const dayScore = pool.length ? Math.round(pool.reduce((s, h) => s + h.score, 0) / pool.length) : null;

    return {
      date: d.date,
      dayScore,
      hourly: dayHours.map(({ t, score, limiting, daylight }) => ({ t, score, limiting, daylight })),
      windows: findWindows(dayHours, { minLength: minWindowLength, threshold }),
    };
  });

  const mud = computeMud(scored, nowStr);

  return { days, mud, generatedAt: nowStr };
}
