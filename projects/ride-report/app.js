// Ride Report — glue: fetch weather, score it, render the page.
import { fetchWeather } from './weather.js';
import { scoreReport } from './score.js';
import { isConfigured, fetchLatestDailyReport, fetchWorkerStatus } from './supabase.js';
import { reportStatus } from './status.js';
import { initTripsUi } from './trips.js';

const LOCATION = {
  latitude: 46.8772,
  longitude: -96.7898,
  timezone: 'America/Chicago',
};

const LIMITING_LABELS = {
  temp: 'temperature',
  wind: 'wind',
  gust: 'gusts',
  precip: 'rain chances',
  aqi: 'air quality',
};

// One row per scoring factor, in the order score.js computes them. `value`
// renders the measurement the reader can check against their own window;
// `scale` explains the curve, and is shown only for the factor that set the
// score — the rest of the time it is noise.
const FACTOR_META = {
  temp: {
    label: 'Temperature',
    value: (h) => (h.apparentTemp == null ? null : `feels like ${Math.round(h.apparentTemp)}°F`),
    scale: 'Ideal 55–75°F, falling off to either side.',
  },
  wind: {
    label: 'Wind',
    value: (h) => (h.windSpeed == null
      ? null
      : `${Math.round(h.windSpeed)} mph${h.windDirection == null ? '' : ` from the ${compassPoint(h.windDirection)}`}`),
    scale: 'Free below 10 mph, down to zero by 25.',
  },
  gust: {
    label: 'Gusts',
    value: (h) => (h.windGust == null ? null : `${Math.round(h.windGust)} mph`),
    scale: 'Free below 20 mph, down to zero by 40.',
  },
  precip: {
    label: 'Precipitation',
    value: (h) => {
      if (h.precipitation != null && h.precipitation > 0) return `${h.precipitation}" falling`;
      return h.precipProbability == null ? null : `${Math.round(h.precipProbability)}% chance`;
    },
    scale: 'Free below 20% chance, zero by 70% — measurable rain scores 5 outright.',
  },
  aqi: {
    label: 'Air quality',
    value: (h) => (h.aqi == null ? null : `AQI ${Math.round(h.aqi)}`),
    scale: 'Free below AQI 50, down to zero by 150.',
  },
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compassPoint(degrees) {
  return COMPASS[Math.round(degrees / 22.5) % 16];
}

const MUD_META = {
  dry: { icon: '☀️', label: 'Dry — trails good' },
  damp: { icon: '💧', label: 'Damp — expect soft spots' },
  muddy: { icon: '🥾', label: 'Muddy — pavement day' },
};

function nowStrInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

function formatHourLabel(tStr) {
  let h = parseInt(tStr.slice(11, 13), 10);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}${suffix}`;
}

function dayLabel(dateStr, todayDateStr) {
  const days = Math.round(
    (Date.parse(`${dateStr}T00:00:00`) - Date.parse(`${todayDateStr}T00:00:00`)) / 86400000
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(`${dateStr}T00:00:00`));
}

function scoreColor(score) {
  if (score == null) return 'var(--score-na)';
  if (score >= 75) return 'var(--score-good)';
  if (score >= 50) return 'var(--score-mid)';
  return 'var(--score-bad)';
}

function verdictFor(score) {
  if (score == null) return 'No data';
  if (score >= 90) return 'Excellent — get out there';
  if (score >= 75) return 'Great day to ride';
  if (score >= 60) return 'Good, with some caveats';
  if (score >= 45) return 'Okay — pick your window carefully';
  if (score >= 30) return 'Rough one — short window if any';
  return 'Not today';
}

function dominantLimiting(hourly) {
  const counts = {};
  for (const h of hourly) {
    if (!h.daylight || !h.limiting) continue;
    counts[h.limiting] = (counts[h.limiting] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return best;
}

function showLoading() {
  document.getElementById('ride-status').hidden = false;
  document.getElementById('ride-content').hidden = true;
  document.getElementById('ride-error').hidden = true;
}

function showContent() {
  document.getElementById('ride-status').hidden = true;
  document.getElementById('ride-content').hidden = false;
  document.getElementById('ride-error').hidden = true;
}

function showError() {
  document.getElementById('ride-status').hidden = true;
  document.getElementById('ride-content').hidden = true;
  document.getElementById('ride-error').hidden = false;
}

/**
 * The breakdown behind one hour's score.
 *
 * The score is the *worst* component, not a blend, so the panel is sorted
 * ascending and the top row is the answer to "why this number" — everything
 * below it is context for how much headroom the other factors had. Saying that
 * out loud beats a bar chart the reader has to infer the rule from.
 */
function renderHourDetail(hour) {
  const panel = document.getElementById('hour-detail');
  panel.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'hour-detail-head';

  const when = document.createElement('p');
  when.className = 'hour-detail-when';
  when.textContent = formatHourLabel(hour.t) + (hour.daylight === false ? ' · after dark' : '');

  const num = document.createElement('p');
  num.className = 'hour-detail-score';
  num.textContent = hour.score != null ? hour.score : '—';
  num.style.color = scoreColor(hour.score);

  head.append(when, num);
  panel.appendChild(head);

  const components = hour.components || {};

  // `limiting` is an argmin, so score.js still names a factor when all five tie
  // at 100 — reporting that as "held back by temperature" on a perfect hour
  // would be a lie about a number the reader can see is maxed. A factor only
  // counts as holding the hour back if it actually cost it something.
  const limiting = hour.limiting
    && Math.round(components[hour.limiting] ?? 0) < 100
    ? hour.limiting
    : null;

  const why = document.createElement('p');
  why.className = 'hour-detail-why';
  if (hour.score == null) {
    why.textContent = 'No forecast data for this hour.';
  } else if (limiting) {
    why.textContent = `Held back by ${LIMITING_LABELS[limiting]} — the lowest-scoring factor sets the hour.`;
  } else {
    why.textContent = 'Nothing is holding this hour back — every factor is maxed.';
  }
  panel.appendChild(why);

  const rows = Object.keys(FACTOR_META)
    .map((key) => ({ key, meta: FACTOR_META[key], component: components[key] ?? null }))
    // Missing factors sink to the bottom: they explain nothing, and floating a
    // null above a real 40 would imply it mattered more.
    .sort((a, b) => (a.component ?? Infinity) - (b.component ?? Infinity));

  const list = document.createElement('ul');
  list.className = 'factor-list';

  for (const { key, meta, component } of rows) {
    const item = document.createElement('li');
    item.className = 'factor' + (key === limiting ? ' factor--limiting' : '');

    const name = document.createElement('span');
    name.className = 'factor-name';
    name.textContent = meta.label;

    const value = document.createElement('span');
    value.className = 'factor-value';
    value.textContent = meta.value(hour) ?? 'no data';

    const bar = document.createElement('span');
    bar.className = 'factor-bar';
    if (component != null) {
      const fill = document.createElement('span');
      fill.className = 'factor-fill';
      fill.style.width = `${Math.round(component)}%`;
      fill.style.background = scoreColor(component);
      bar.appendChild(fill);
    }

    const points = document.createElement('span');
    points.className = 'factor-points';
    points.textContent = component != null ? Math.round(component) : '—';

    item.append(name, value, bar, points);

    if (key === limiting) {
      const note = document.createElement('span');
      note.className = 'factor-note';
      note.textContent = meta.scale;
      item.appendChild(note);
    }

    list.appendChild(item);
  }

  panel.appendChild(list);
  panel.hidden = false;
}

function renderHourlyStrip(todayDay, nowStr) {
  const el = document.getElementById('hourly-strip');
  const panel = document.getElementById('hour-detail');
  el.innerHTML = '';
  panel.hidden = true;
  let selected = null;
  let currentBlock = null;
  let currentHour = null;

  const select = (block, hour) => {
    // Clicking the open hour again closes the panel, so the strip can be put
    // back the way it was found.
    if (selected === block) {
      block.setAttribute('aria-expanded', 'false');
      block.classList.remove('is-selected');
      panel.hidden = true;
      selected = null;
      return;
    }
    if (selected) {
      selected.setAttribute('aria-expanded', 'false');
      selected.classList.remove('is-selected');
    }
    block.setAttribute('aria-expanded', 'true');
    block.classList.add('is-selected');
    selected = block;
    renderHourDetail(hour);
  };

  todayDay.hourly.forEach((h, i) => {
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'hour-block' + (h.daylight === false ? ' hour-block--night' : '');
    block.style.background = scoreColor(h.score);
    block.setAttribute('aria-controls', 'hour-detail');
    block.setAttribute('aria-expanded', 'false');

    const label = formatHourLabel(h.t);
    const detail = h.score != null
      ? `${label} — ${h.score}${h.limiting ? `, held back by ${LIMITING_LABELS[h.limiting]}` : ''}`
      : `${label} — no data`;
    block.title = `${detail}. Click for the breakdown.`;
    block.setAttribute('aria-label', detail);

    block.addEventListener('click', () => select(block, h));

    // Compared to the hour, not the minute: "2026-07-20T14" is the block that
    // contains right now.
    if (nowStr && h.t.slice(0, 13) === nowStr.slice(0, 13)) {
      block.classList.add('hour-block--now');
      currentBlock = block;
      currentHour = h;
    }

    if (i % 3 === 0) {
      const tick = document.createElement('span');
      tick.className = 'hour-block-label';
      tick.textContent = label;
      block.appendChild(tick);
    }
    el.appendChild(block);
  });

  // Open on the current hour, so the page answers "what's it like right now"
  // without a click. select() rather than click() — a programmatic click would
  // be indistinguishable from the reader's own, and this must not take focus
  // away from the top of the page on load.
  //
  // No match means the strip is not showing today at all (the report fell
  // through to a future day), and there is no "now" to open — the panel stays
  // closed rather than opening an arbitrary hour.
  if (currentBlock) select(currentBlock, currentHour);
}

function renderMud(mud) {
  const meta = MUD_META[mud.risk];
  document.getElementById('mud-icon').textContent = meta.icon;
  document.getElementById('mud-risk').textContent = meta.label;
  document.getElementById('mud-detail').textContent =
    `${mud.weightedPrecip}" weighted precip over the last 72h`;
  document.getElementById('mud-badge').dataset.risk = mud.risk;
}

function renderOutlook(days, todayDateStr) {
  const el = document.getElementById('outlook');
  el.innerHTML = '';
  const future = days.filter((d) => d.date > todayDateStr).slice(0, 2);
  for (const d of future) {
    const card = document.createElement('div');
    card.className = 'outlook-day';

    const label = document.createElement('p');
    label.className = 'outlook-label';
    label.textContent = dayLabel(d.date, todayDateStr);

    const score = document.createElement('p');
    score.className = 'outlook-score';
    score.textContent = d.dayScore != null ? d.dayScore : '—';
    score.style.color = scoreColor(d.dayScore);

    const verdict = document.createElement('p');
    verdict.className = 'outlook-verdict';
    verdict.textContent = verdictFor(d.dayScore);

    card.append(label, score, verdict);
    el.appendChild(card);
  }
}

/** "5:10 AM", or "Fri 8:10 PM" once the report is from a different day. */
function stampTime(date, sameDay) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCATION.timezone,
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** "5:10 AM", or "Fri 8:10 PM" once the timestamp is from a different day. */
function stampFor(iso) {
  const when = new Date(iso);
  const zoneDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: LOCATION.timezone }).format(d);
  return stampTime(when, zoneDay(when) === zoneDay(new Date()));
}

/**
 * Layer the Pi's narrative onto an already-rendered page, and say plainly how
 * much of it to trust.
 *
 * Everything here is additive and failure-tolerant by design: the score, the
 * strip and the outlook are computed in the browser and have already rendered
 * by the time this runs. A missing, stale, or unreachable report costs the
 * reader some prose, never the forecast.
 *
 * The rules live in status.js; this is the brush. The one judgement it makes is
 * the same one the rest of the page makes — nothing here is allowed to throw
 * away what has already rendered.
 *
 * `payload.headline` is deliberately left unrendered. It is the model's take on
 * a score computed on the Pi up to three hours ago, while the dial shows the
 * score computed here, now — so on a swinging day the two can land in different
 * verdict buckets and read as a contradiction. The prose is the part worth
 * having; the verdict line stays tied to the number beside it.
 */
function renderReportMeta(row, status) {
  const { showNarrative, silent, level, notes, label } = reportStatus({
    row,
    status,
    formatStamp: stampFor,
  });

  if (showNarrative) {
    const narrativeEl = document.getElementById('narrative');
    narrativeEl.textContent = row.payload.summary;
    narrativeEl.hidden = false;
  }

  if (silent) return;

  const dot = document.getElementById('status-dot');
  dot.dataset.level = level;
  dot.setAttribute('aria-label', label);

  document.getElementById('report-stamp-text').textContent = notes.join(' · ');
  document.getElementById('report-stamp').hidden = false;
}

function render(report, nowStr) {
  const todayDateStr = nowStr.slice(0, 10);
  const today = report.days.find((d) => d.date === todayDateStr)
    || report.days.find((d) => d.date > todayDateStr);
  if (!today) { showError(); return; }

  document.getElementById('score-num').textContent = today.dayScore != null ? today.dayScore : '—';
  document.getElementById('score-num').style.color = scoreColor(today.dayScore);
  document.getElementById('score-dial').style.borderColor = scoreColor(today.dayScore);
  document.getElementById('verdict').textContent = verdictFor(today.dayScore);

  const limiting = dominantLimiting(today.hourly);
  const limitingEl = document.getElementById('limiting-line');
  if (today.dayScore != null && limiting && today.dayScore < 90) {
    limitingEl.textContent = `Mostly held back by ${LIMITING_LABELS[limiting]}.`;
  } else if (today.dayScore != null) {
    limitingEl.textContent = 'Near-ideal conditions.';
  } else {
    limitingEl.textContent = '';
  }

  const windowEl = document.getElementById('window-callout');
  const best = today.windows.find((w) => w.best) || today.windows[0];
  if (best) {
    const range = `${formatHourLabel(best.start)}–${formatHourLabel(best.end)}`;
    windowEl.textContent = best.fallback
      ? `Least-bad window: ${range} (avg ${best.avgScore})`
      : `Ideal: ${range}`;
  } else {
    windowEl.textContent = 'No solid window today.';
  }

  renderHourlyStrip(today, nowStr);
  renderMud(report.mud);
  renderOutlook(report.days, todayDateStr);

  showContent();
}

async function init() {
  showLoading();

  // Started alongside the weather fetch rather than after it. The narrative is
  // layered on once the spine has rendered, but there is no reason to make the
  // request queue behind Open-Meteo.
  //
  // Both settle to null on failure rather than rejecting, and they are settled
  // independently: a heartbeat that fails to load must not take the narrative
  // down with it, and vice versa.
  const configured = isConfigured();
  const quietly = (promise, what) => promise.catch((err) => {
    console.warn(`Ride Report: could not load ${what}.`, err);
    return null;
  });

  const reportPromise = configured
    ? quietly(fetchLatestDailyReport(), 'the synthesized report')
    : Promise.resolve(null);
  const statusPromise = configured
    ? quietly(fetchWorkerStatus(), "the worker's status")
    : Promise.resolve(null);

  let rendered = false;
  try {
    const { hours, daily } = await fetchWeather(LOCATION);
    const nowStr = nowStrInZone(LOCATION.timezone);
    const report = scoreReport(hours, daily, { nowStr });
    render(report, nowStr);
    rendered = true;
  } catch (err) {
    console.error('Ride Report failed to load:', err);
    showError();
  }

  // Before the await, not after: the trips UI has nothing to do with the daily
  // report, and gating it on that request would leave the sign-in link missing
  // for the full REST timeout whenever Supabase is slow.
  initTripsUi();

  const [reportRow, workerStatus] = await Promise.all([reportPromise, statusPromise]);
  if (rendered) renderReportMeta(reportRow, workerStatus);
}

document.addEventListener('DOMContentLoaded', init);
