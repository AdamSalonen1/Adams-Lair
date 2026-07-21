# Phase 4 — Realtime Trip Synthesis

**Goal:** add or edit a trip on the page → a synthesized outlook for that trip
appears within about a minute, no manual step. The Pi stays outbound-only: this
is a WebSocket the Pi *opens* to Supabase, never an inbound webhook.

## Listener daemon

```
projects/ride-report/worker/
  listener.js               long-running daemon
  systemd/
    ride-report-listener.service    Restart=always
```

Core shape (supabase-js Realtime):

```js
supabase
  .channel('trips-watch')
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'trips' },
      handleTripChange)
  .subscribe();
```

On INSERT/UPDATE → queue that `trip_id` for synthesis. On DELETE → nothing
(the FK cascade already removed its reports).

## The two rules that keep this sane

1. **Debounce per trip.** Editing a trip five times in ten seconds must produce
   one Claude run, not five. Hold each queued `trip_id` until it's been quiet
   for ~5 s, then fire. This also protects the Pro usage window, which is
   shared with your own interactive Claude Code sessions.
2. **Single-flight lock.** The listener and the Phase 3 timer are separate
   processes that must never synthesize concurrently. Both wrap pipeline
   execution in `flock` on the same lockfile. The listener invokes the pipeline
   as a child process (`node pipeline.js --trip <id>`) rather than in-process,
   so one lock mechanism covers both paths.

## Trip synthesis (`pipeline.js --trip <id>`)

- Fetch the trip row; fetch Open-Meteo for the **trip's lat/lon** across
  `start_date`–`end_date` (this is why Phase 1 parameterized location).
- Within the 16-day forecast horizon: score each trip day with `score.js`,
  synthesize a trip narrative (per-day outlook, best riding days/windows, mud
  outlook, pack-list-relevant notes like wind and temp swing).
- Beyond the horizon: write a placeholder report (`source: 'fallback'`,
  "too far out — outlook firms up on {date}"). No LLM call.
- Upsert as `kind: 'trip'`, `trip_id` set.

## Scheduled refresh of upcoming trips

Extend `run-scheduled.js`: after the daily report, loop trips where
`start_date <= today + 16 days` and `end_date >= today`, regenerating each —
this is the "updates as better forecasts are known" requirement. The debounce
queue and this loop share the lock, so collisions just wait their turn.

## Resilience

- supabase-js auto-reconnects with backoff; `Restart=always` backstops a
  crashed process.
- **Reconnect gap-fill:** events during a disconnect are lost, so on every
  (re)subscribe, sweep for trips whose `updated_at` is newer than their latest
  report and queue them. The scheduled loop is the second safety net — worst
  case a missed event is stale for a few hours, never forever.
- Log subscribe/close/error events with timestamps; boring logs are the goal.

## Page changes

- Trip cards render their latest report (or the placeholder), with
  `generated_at`.
- After a trip save, show "outlook generating…" and either poll that trip's
  report for ~90 s or subscribe the browser to `reports` via Realtime (the
  page already speaks supabase-js; if the polish is cheap, take it —
  enable the publication on `reports` too).

## Exit criteria

- [ ] Add a trip from a phone → narrative outlook appears without touching
      the Pi (~1 min)
- [ ] Five rapid edits → exactly one synthesis run (check logs)
- [ ] Trip beyond 16 days gets the placeholder; gets real synthesis once a
      scheduled run finds it inside the horizon
- [ ] Kill the listener, add a trip, restart it → gap-fill sweep catches the
      trip without a manual poke
- [ ] Timer run and listener run triggered simultaneously → serialized by the
      lock, both complete
