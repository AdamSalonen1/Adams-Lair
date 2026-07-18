// Ride Report — glue: fetch weather, score it, render the page.
import { fetchWeather } from './weather.js';
import { scoreReport } from './score.js';
import { isConfigured, fetchLatestDailyReport } from './supabase.js';
import { initTripsUi } from './trips.js';

const LOCATION = {
  latitude: 46.8772,
  longitude: -96.7898,
  timezone: 'America/Chicago',
};

// How old a synthesized report can be before it stops being presented as
// current, and before it stops being shown at all. Between the two it renders
// with a visible timestamp, because a six-hour-old narrative is still worth
// reading as long as nobody is misled about when it was written.
const NARRATIVE_FRESH_MS = 4 * 60 * 60 * 1000;
const NARRATIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const LIMITING_LABELS = {
  temp: 'temperature',
  wind: 'wind',
  gust: 'gusts',
  precip: 'rain chances',
  aqi: 'air quality',
};

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

function renderHourlyStrip(todayDay) {
  const el = document.getElementById('hourly-strip');
  el.innerHTML = '';
  todayDay.hourly.forEach((h, i) => {
    const block = document.createElement('div');
    block.className = 'hour-block' + (h.daylight === false ? ' hour-block--night' : '');
    block.style.background = scoreColor(h.score);

    const label = formatHourLabel(h.t);
    const detail = h.score != null
      ? `${label} — ${h.score}${h.limiting ? `, held back by ${LIMITING_LABELS[h.limiting]}` : ''}`
      : `${label} — no data`;
    block.title = detail;
    block.setAttribute('aria-label', detail);

    if (i % 3 === 0) {
      const tick = document.createElement('span');
      tick.className = 'hour-block-label';
      tick.textContent = label;
      block.appendChild(tick);
    }
    el.appendChild(block);
  });
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

/**
 * Layer the Pi's narrative onto an already-rendered page.
 *
 * Everything here is additive and failure-tolerant by design: the score, the
 * strip and the outlook are computed in the browser and have already rendered
 * by the time this runs. A missing, stale, or unreachable report costs the
 * reader some prose, never the forecast.
 *
 * `payload.headline` is deliberately left unrendered. It is the model's take on
 * a score computed on the Pi up to three hours ago, while the dial shows the
 * score computed here, now — so on a swinging day the two can land in different
 * verdict buckets and read as a contradiction. The prose is the part worth
 * having; the verdict line stays tied to the number beside it.
 */
function renderNarrative(row) {
  const summary = row?.payload?.summary;
  if (!summary) return;

  const generatedAt = new Date(row.generated_at);
  const ageMs = Date.now() - generatedAt.getTime();
  if (Number.isNaN(ageMs) || ageMs > NARRATIVE_MAX_AGE_MS) return;

  const narrativeEl = document.getElementById('narrative');
  narrativeEl.textContent = summary;
  narrativeEl.hidden = false;

  // A clock-skewed "3 minutes in the future" report is fresh, not broken.
  if (ageMs <= NARRATIVE_FRESH_MS) return;

  const zoneDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: LOCATION.timezone }).format(d);
  const stampEl = document.getElementById('report-stamp');
  stampEl.textContent = `Report from ${stampTime(generatedAt, zoneDay(generatedAt) === zoneDay(new Date()))}`;
  stampEl.hidden = false;
}

function render(report, todayDateStr) {
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

  renderHourlyStrip(today);
  renderMud(report.mud);
  renderOutlook(report.days, todayDateStr);

  showContent();
}

async function init() {
  showLoading();

  // Started alongside the weather fetch rather than after it. The narrative is
  // layered on once the spine has rendered, but there is no reason to make the
  // request queue behind Open-Meteo.
  const reportPromise = isConfigured()
    ? fetchLatestDailyReport().catch((err) => {
      console.warn('Ride Report: could not load the synthesized report.', err);
      return null;
    })
    : Promise.resolve(null);

  let rendered = false;
  try {
    const { hours, daily } = await fetchWeather(LOCATION);
    const nowStr = nowStrInZone(LOCATION.timezone);
    const report = scoreReport(hours, daily, { nowStr });
    render(report, nowStr.slice(0, 10));
    rendered = true;
  } catch (err) {
    console.error('Ride Report failed to load:', err);
    showError();
  }

  // Before the await, not after: the trips UI has nothing to do with the daily
  // report, and gating it on that request would leave the sign-in link missing
  // for the full REST timeout whenever Supabase is slow.
  initTripsUi();

  const reportRow = await reportPromise;
  if (rendered) renderNarrative(reportRow);
}

document.addEventListener('DOMContentLoaded', init);
