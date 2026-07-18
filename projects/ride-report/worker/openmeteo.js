// Worker twin of ../weather.js.
//
// The *shaping* logic is imported, not copied — shapeWeather() is the part
// that would silently drift from the browser if duplicated. What the worker
// adds is I/O policy the browser doesn't need: hard timeouts, an abort, and
// bounded retry, so a dead network fails fast and loudly instead of hanging
// a systemd unit forever.

import { shapeWeather } from '../weather.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
];

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 3;

/** fetch + JSON with an AbortController timeout. Throws on non-2xx. */
async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'request' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${label} failed: HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw new Error(`${label} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Retry with linear backoff. Only worth it for the forecast, which is required. */
async function withRetry(fn, { attempts = DEFAULT_ATTEMPTS, label = 'request' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const waitMs = 2000 * i;
        console.warn(`[openmeteo] ${label} attempt ${i}/${attempts} failed (${err.message}); retrying in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

function buildForecastUrl({ latitude, longitude, timezone, pastDays, forecastDays }) {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', latitude);
  url.searchParams.set('longitude', longitude);
  url.searchParams.set('hourly', HOURLY_VARS.join(','));
  url.searchParams.set('daily', 'sunrise,sunset');
  url.searchParams.set('past_days', String(pastDays));
  url.searchParams.set('forecast_days', String(forecastDays));
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', timezone);
  return url;
}

function buildAirQualityUrl({ latitude, longitude, timezone }) {
  const url = new URL(AIR_QUALITY_URL);
  url.searchParams.set('latitude', latitude);
  url.searchParams.set('longitude', longitude);
  url.searchParams.set('hourly', 'us_aqi,pm2_5');
  url.searchParams.set('timezone', timezone);
  return url;
}

/**
 * Current wall-clock in the *target* location's timezone, formatted the way
 * score.js wants ("YYYY-MM-DDTHH:mm"). Computed via Intl rather than the
 * host clock's local zone, so the worker is correct even if the Pi's TZ is
 * ever changed out from under it.
 */
export function nowInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  // en-CA gives 24h, but hour can come back as "24" at midnight in some ICU builds.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Fetch forecast (required, retried) + air quality (best-effort) and shape
 * them with the browser's own shapeWeather. Throws if the forecast can't be
 * had — the caller must not write a report in that case.
 */
export async function fetchWeather({
  latitude,
  longitude,
  timezone = 'America/Chicago',
  pastDays = 3,
  forecastDays = 3,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const forecast = await withRetry(
    () => fetchJson(buildForecastUrl({ latitude, longitude, timezone, pastDays, forecastDays }), {
      timeoutMs,
      label: 'Open-Meteo forecast',
    }),
    { label: 'Open-Meteo forecast' },
  );

  // AQI is a nice-to-have; score.js scores fine with aqi: null.
  let airQuality = null;
  try {
    airQuality = await fetchJson(buildAirQualityUrl({ latitude, longitude, timezone }), {
      timeoutMs,
      label: 'Open-Meteo air quality',
    });
  } catch (err) {
    console.warn(`[openmeteo] air quality unavailable, continuing without AQI: ${err.message}`);
  }

  const shaped = shapeWeather(forecast, airQuality);
  if (!shaped.hours?.length) throw new Error('Open-Meteo returned no hourly data');
  return shaped;
}
