# Phase 1 — Client-Side Score MVP

**Goal:** a working page that answers "is today a good day to ride, and when?"
with zero backend. This layer is permanent — it's the fallback every later phase
degrades to.

## Files

Follow the KanYeezle convention (flat files per project folder):

```
projects/ride-report/
  index.html        page shell, matches site nav/footer/style
  ride-report.css   project styles (orange accent, obviously)
  score.js          scoring engine — PURE module, no DOM, no fetch
  weather.js        Open-Meteo fetch + response shaping
  app.js            glue: fetch → score → render
```

**`score.js` must stay pure** (data in, data out, no imports of DOM or fetch).
Phase 3 imports this exact file on the Pi so browser and worker can never
disagree about what a "72" means.

## Data: Open-Meteo (keyless)

Forecast — hourly, 3 past days + 3 forecast days:

```
https://api.open-meteo.com/v1/forecast
  ?latitude=46.8772&longitude=-96.7898
  &hourly=temperature_2m,apparent_temperature,precipitation_probability,
          precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m
  &daily=sunrise,sunset
  &past_days=3&forecast_days=3
  &temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch
  &timezone=America%2FChicago
```

Air quality — separate endpoint:

```
https://air-quality-api.open-meteo.com/v1/air-quality
  ?latitude=46.8772&longitude=-96.7898
  &hourly=us_aqi,pm2_5
  &timezone=America%2FChicago
```

Merge on timestamp in `weather.js`; hand `score.js` one array of hour objects.

## Scoring engine

Per-hour rideability 0–100. Start with these and tune by feel:

| Factor | Ideal | Penalty shape |
|---|---|---|
| Apparent temp | 55–75 °F | Linear falloff outside band; steep below 32 °F |
| Wind (sustained) | < 10 mph | Ramp 10→25 mph; near-zero score above 25 |
| Gusts | < 20 mph | Additional penalty above 20 |
| Precip probability | < 20 % | Ramp 20→70 %; raining now ≈ 0 |
| US AQI | ≤ 50 | Ramp 50→150; hard floor above 150 |
| Daylight | between sunrise/sunset | Hours outside daylight excluded from windows |

**Mud risk** from past-72h precipitation with recency weighting
(`24h total × 1.0 + 24–48h × 0.6 + 48–72h × 0.3`):

| Weighted total | Verdict |
|---|---|
| < 0.1 in | Dry — trails good |
| 0.1–0.4 in | Damp — probably fine, expect soft spots |
| > 0.4 in | Muddy — pavement day |

**Best windows:** contiguous daylight runs of ≥ 2 hours where score ≥ 70
(fall back to "least bad window" messaging if nothing qualifies).

`score.js` exports something like:

```js
scoreDay(hours, daily) => {
  dayScore,            // 0–100 headline
  hourly: [{t, score, limiting}],   // `limiting` = worst factor that hour
  windows: [{start, end, avgScore}],
  mud: {risk, weightedPrecip}
}
```

The `limiting` factor matters — "68, held back by wind" is the useful sentence.

## UI

- Headline score with a plain-language verdict line
- Hourly strip for today (score-colored blocks, tap/hover for detail)
- Best-window callout ("Ideal: 4–7 PM")
- Mud-risk badge with the past-rain numbers behind it
- Tomorrow / day-after mini summary
- Mobile-first — this gets checked from a phone in a garage

Also: add a Ride Report card to `projects.html` following the existing card
pattern, and keep nav/footer identical to the rest of the site.

## Exit criteria

- [ ] Page loads on GitHub Pages with no console errors, shows live data
- [ ] Score, windows, and mud risk render for today + 2 days out
- [ ] Usable on a phone
- [ ] `score.js` has zero DOM/fetch references (verified by reading it)
- [ ] Open-Meteo outage renders a graceful "no data" state, not a broken page

## Out of scope (resist)

No Supabase, no trips, no LLM, no location picker. Fargo is hard-coded (but
passed as a parameter internally so Phase 4 trip locations slot in later).
