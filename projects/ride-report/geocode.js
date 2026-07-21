// Ride Report — place search (Open-Meteo geocoding).
//
// Turns a typed place name into pickable coordinates, so a trip never needs a
// hand-entered latitude. Same provider and same keyless posture as weather.js,
// which is the whole reason to prefer it: no API key to leak into a static
// page, and the numbers come from a gazetteer rather than anyone's memory.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/** Below this, results are noise — "a" matches half the planet. */
const MIN_QUERY = 2;

/**
 * Flatten one Open-Meteo hit into what the form actually needs.
 *
 * `admin1` is the state/province and `country` the full name; both are absent
 * for some entries, hence the filter — joining blindly yields "Paris, , ".
 */
function toPlace(hit, index) {
  return {
    // `id` from the gazetteer is stable, but two hits can share one when a city
    // and its township collide, so the index keeps DOM ids unique regardless.
    key: `${hit.id ?? 'x'}-${index}`,
    label: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
    lat: hit.latitude,
    lon: hit.longitude,
    // Echoed for display only. The worker asks Open-Meteo for `timezone=auto`
    // and uses whatever it resolves, so nothing downstream depends on this.
    timezone: hit.timezone ?? null,
    population: hit.population ?? null,
  };
}

/**
 * Search for places matching `query`.
 *
 * Returns `[]` for a too-short query and for no matches; throws only when the
 * request itself fails, which the caller surfaces as "enter coordinates
 * manually" rather than as a dead end.
 *
 * Pass `signal` from an AbortController — the caller fires one of these per
 * keystroke burst and needs the stale ones to stop landing out of order.
 */
export async function searchPlaces(query, { signal, count = 6 } = {}) {
  const name = query.trim();
  if (name.length < MIN_QUERY) return [];

  const url = new URL(GEOCODE_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', String(count));
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Open-Meteo geocoding request failed: ${res.status}`);

  const data = await res.json();
  // On a miss Open-Meteo omits `results` entirely rather than sending an empty
  // array, so `data.results.map` would throw on the most ordinary outcome there
  // is: a typo.
  return (data.results ?? []).map(toPlace);
}
