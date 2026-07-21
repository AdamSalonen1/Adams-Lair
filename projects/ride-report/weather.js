// Ride Report — Open-Meteo fetch + response shaping.
// Turns the two Open-Meteo responses (forecast + air quality) into the flat
// `hours` / `daily` shape score.js expects. No scoring logic lives here.

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

/**
 * Fetch forecast + air quality for a location and shape them into
 * { hours, daily }. Air quality is best-effort: if it fails, hours just
 * come back with aqi: null and scoring degrades gracefully.
 */
export async function fetchWeather({
  latitude,
  longitude,
  timezone = 'America/Chicago',
  pastDays = 3,
  forecastDays = 3,
} = {}) {
  const forecastUrl = new URL(FORECAST_URL);
  forecastUrl.searchParams.set('latitude', latitude);
  forecastUrl.searchParams.set('longitude', longitude);
  forecastUrl.searchParams.set('hourly', HOURLY_VARS.join(','));
  forecastUrl.searchParams.set('daily', 'sunrise,sunset');
  forecastUrl.searchParams.set('past_days', String(pastDays));
  forecastUrl.searchParams.set('forecast_days', String(forecastDays));
  forecastUrl.searchParams.set('temperature_unit', 'fahrenheit');
  forecastUrl.searchParams.set('wind_speed_unit', 'mph');
  forecastUrl.searchParams.set('precipitation_unit', 'inch');
  forecastUrl.searchParams.set('timezone', timezone);

  const forecastRes = await fetch(forecastUrl);
  if (!forecastRes.ok) {
    throw new Error(`Open-Meteo forecast request failed: ${forecastRes.status}`);
  }
  const forecast = await forecastRes.json();

  let airQuality = null;
  try {
    const aqUrl = new URL(AIR_QUALITY_URL);
    aqUrl.searchParams.set('latitude', latitude);
    aqUrl.searchParams.set('longitude', longitude);
    aqUrl.searchParams.set('hourly', 'us_aqi,pm2_5');
    aqUrl.searchParams.set('timezone', timezone);
    const aqRes = await fetch(aqUrl);
    if (aqRes.ok) airQuality = await aqRes.json();
  } catch {
    airQuality = null; // AQI is a nice-to-have; score.js tolerates missing values
  }

  return shapeWeather(forecast, airQuality);
}

/** Pure reshape of raw Open-Meteo JSON into { hours, daily }. */
export function shapeWeather(forecast, airQuality) {
  const times = forecast.hourly.time;

  const aqiByTime = new Map();
  if (airQuality?.hourly?.time) {
    airQuality.hourly.time.forEach((t, i) => {
      aqiByTime.set(t, airQuality.hourly.us_aqi ? airQuality.hourly.us_aqi[i] : null);
    });
  }

  const hours = times.map((t, i) => ({
    t,
    temp: forecast.hourly.temperature_2m[i],
    apparentTemp: forecast.hourly.apparent_temperature[i],
    windSpeed: forecast.hourly.wind_speed_10m[i],
    windGust: forecast.hourly.wind_gusts_10m[i],
    windDirection: forecast.hourly.wind_direction_10m[i],
    precipProbability: forecast.hourly.precipitation_probability
      ? forecast.hourly.precipitation_probability[i]
      : null,
    precipitation: forecast.hourly.precipitation[i],
    aqi: aqiByTime.has(t) ? aqiByTime.get(t) : null,
  }));

  const daily = forecast.daily.time.map((date, i) => ({
    date,
    sunrise: forecast.daily.sunrise[i],
    sunset: forecast.daily.sunset[i],
  }));

  return { hours, daily };
}
