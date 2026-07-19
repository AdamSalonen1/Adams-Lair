# Ride Report — Pi Worker

Fetch → score → `claude -p` → Supabase. Two ways in: a systemd timer for the
daily report and upcoming trips, and a daemon that reacts to trip edits within
seconds.

The script does all the I/O. Claude only turns numbers into a sentence: it gets
JSON on stdin and returns JSON on stdout, with no tools and no agent loop. Every
number in the stored payload comes from `../score.js` — the same module the
browser runs — so a "72" means the same thing in both places.

The Pi stays outbound-only. The listener is a WebSocket the Pi *opens* to
Supabase — no inbound port, no webhook, nothing exposed.

## Files

| File | Job |
|---|---|
| `pipeline.js` | One full run, daily (`runDaily`) or trip (`runTrip`). All the I/O. |
| `trip.js` | Pure trip logic: horizon math, payload shaping, deterministic prose. |
| `run-scheduled.js` | Timer entry point: daily report, then every trip in range. |
| `run-trip.js` | One trip. What the listener spawns under `flock`. |
| `listener.js` | Realtime daemon. Debounce, queue, gap-fill sweep. |
| `openmeteo.js` | Fetch with timeout/retry. Imports `shapeWeather` from `../weather.js`. |
| `synth.js` | `claude -p`, JSON extraction, validation, one retry, deterministic fallback. |
| `db.js` | Supabase REST reads/insert + a tiny `.env` loader. |
| `prompt.md`, `prompt-trip.md` | The prompts, versioned like code. |
| `test-synth.js`, `test-trip.js` | Pure-function checks. No network. |

One runtime dependency: `@supabase/supabase-js`, used only for the listener's
Realtime socket. Everything else talks to Supabase over plain REST.

## How a trip becomes an outlook

```
edit on the page
   └─> Postgres  ──Realtime──>  listener.js
                                  └─ debounce 5s per trip
                                  └─ queue, one at a time
                                       └─ flock ──> run-trip.js ──> pipeline.runTrip()
```

`run-scheduled.js` runs the same `runTrip()` in-process every few hours for
every trip in range, so an outlook keeps improving as the forecast firms up.

### The horizon

Open-Meteo forecasts 16 days. `trip.js` sorts every trip into one of four
states, and each writes a different report:

| State | What happens |
|---|---|
| `past` | Trip is over. One terminal row, no LLM call. |
| `beyond` | Starts past day 16. Placeholder naming the date it firms up. No LLM call. |
| `partial` | Starts inside, runs off the end. Narrated as far as the data reaches, and says so. |
| `covered` | Fully forecastable. The normal case. |

A trip carries lat/lon but no timezone, so trip weather is fetched with
`timezone=auto` and the resolved zone comes back in the response. Mud is
recomputed per trip day rather than copied from "now" — what matters is whether
the trails are soft *when you get there*, and `computeMud()` answers that when
you re-anchor it on each day.

Coordinates of exactly `0, 0` are refused rather than forecast. It's a real
point in the Gulf of Guinea, so Open-Meteo answers happily, and the result is a
confident outlook for open ocean.

## Setup

```bash
npm ci
cp .env.example .env      # then fill it in
chmod 600 .env
```

`.env` needs the **secret** (`service_role`) key, not the publishable/anon one.
`reports` has no insert policy at all, so RLS rejects every write from the
publishable key. `db.js` checks for this specific mistake and fails loudly.

## Running

```bash
node run-scheduled.js              # real run, writes to Supabase
node run-scheduled.js --dry-run    # everything except the write
node run-scheduled.js --trips-only # skip the daily report
MOCK_SYNTH=1 node run-scheduled.js # skip the CLI, canned narrative

node run-trip.js --trip <uuid>              # one trip
node run-trip.js --trip <uuid> --dry-run
node run-trip.js --trip <uuid> --today 2026-08-01   # horizon testing

node listener.js                   # the daemon, in the foreground
node test-synth.js && node test-trip.js     # unit tests
```

`--today` is the handle for exercising the horizon without waiting for the
calendar: point it before a trip to see the placeholder, after it to see the
past-trip row.

### Exit codes

`run-scheduled.js`:

| Code | Meaning |
|---|---|
| 0 | Report written, narrative from Claude |
| 1 | **Nothing written** — weather or DB failure. The previous report stands and its age tells the story. |
| 2 | Something written but degraded: the daily report fell back, or a trip refresh failed |

2 is non-zero on purpose. The row landed so the page stays useful, but a
persistent Claude outage should look failed rather than quietly degrade forever.
`MOCK_SYNTH=1` also exits 2, because mock prose genuinely isn't Claude prose and
the database shouldn't claim otherwise (`source='fallback'`).

`run-trip.js` is deliberately different — 0 covers the placeholder cases, which
are correct outcomes rather than degraded ones:

| Code | Meaning |
|---|---|
| 0 | Report written as intended — Claude narrative, placeholder, or the trip was deleted mid-run |
| 1 | **Nothing written** — weather or DB failure |
| 2 | Written, but Claude failed and the deterministic summary was used |

## Failure behaviour

- **Open-Meteo down** → 3 attempts with backoff, then exit 1. Nothing is
  written; there is no code path that produces a partial row.
- **Air quality down** → logged, run continues. `score.js` scores fine with
  `aqi: null`.
- **Claude fails or returns junk** → one retry with the validation error fed
  back, then a deterministic template from the score data, `source='fallback'`.
- **Supabase down** → exit 1 after synthesis. Next tick retries.
- **Realtime socket drops** → supabase-js reconnects with backoff, and every
  resubscribe runs the gap-fill sweep. Events fired during the gap are gone, so
  the sweep asks the database the same question directly: which trips were
  edited more recently than their newest report?
- **Listener process dies** → `Restart=always`, then the same sweep on startup.
- **Trip deleted mid-synthesis** → the insert hits the FK on `reports.trip_id`
  and is treated as a no-op, not a failure. Synthesis takes over a minute, so
  the window is real.
- **Both entry points fire at once** → serialized by `flock`. See below.

## The lock

`run-scheduled.js` and `listener.js` are separate processes that must never
call Claude concurrently, so both funnel through `flock` on
`/run/lock/ride-report.lock`. The listener spawns `run-trip.js` as a child
rather than calling `runTrip()` in-process specifically so that one mechanism
covers both paths.

They wait differently, and the difference is deliberate:

- **Listener: `flock -w 600`** — waits. A scheduled run that skips just happens
  three hours later; an *edit* that skips is an outlook the rider never gets.
- **Timer: `flock -w 300 -E 75`** — also waits, which changed in Phase 4. It
  used to be `-n` (skip), correct back when the only other lock holder was
  another scheduled run that wrote the same daily report anyway. The listener
  broke that: it holds the lock to synthesize a *trip*, writing no daily report
  at all, so a skipped tick would strand the page's headline content for three
  hours. Exit 75 now means "waited five minutes and gave up", which means
  something is genuinely wedged.

The listener also keeps its own in-process queue, so it runs one trip at a time
instead of spawning ten children that all sit blocked on the same lock.

The model is asked to copy `day_score`/`windows`/`mud` through verbatim, but
`pipeline.js` re-asserts them from `score.js` output regardless. Code is a
better enforcer of "the numbers are the score engine's job" than a prompt is.

## systemd

```bash
sudo cp systemd/ride-report.{service,timer} /etc/systemd/system/
sudo cp systemd/ride-report-listener.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ride-report.timer
sudo systemctl enable --now ride-report-listener.service

systemctl list-timers ride-report.timer
systemctl status ride-report-listener
journalctl -u ride-report.service -n 50 --no-pager
journalctl -u ride-report-listener -f          # follow the daemon
sudo systemctl start ride-report.service       # run once, now
```

The timer runs at 05:10, 08:10, 11:10, 14:10, 17:10, 20:10 Central.
`Persistent=true` catches up one missed run after downtime.

The listener is `Type=simple` with `Restart=always` and
`StartLimitIntervalSec=0` — a long Supabase outage must not trip the default
rate limiter and leave it down after the outage clears. It is deliberately
*not* wrapped in `flock`: it doesn't synthesize, it spawns children that do, and
wrapping the daemon would hold the lock for its entire lifetime and permanently
lock out the timer.

The child pipeline shells out to `claude`, so both units set
`Environment=HOME=/home/adams` — without it the CLI can't find its OAuth
credentials and every run silently degrades to the fallback narrative.

Both units hardcode
`/home/adams/projects/Adams-Lair/projects/ride-report/worker` as
`WorkingDirectory` and `EnvironmentFile`. Cloning elsewhere means editing those
lines in each.

## Tending

Each run spins up the whole CLI for one completion — tens of seconds on a Pi,
and it consumes the same Pro rate-limit window as your interactive sessions.
Fine on a timer; don't build anything latency-sensitive on this path.

That window is also why the listener debounces. Five edits to one trip in ten
seconds produce one run, not five — the superseded four would have spent your
own quota narrating a trip you were still in the middle of describing. A
scheduled tick now costs one call for the daily report plus one per trip in
range, so a fistful of upcoming trips is the thing most likely to make this
budget feel tight.

The stored OAuth token occasionally needs a re-login (`claude` over SSH, then
`/login`). A stale `generated_at` on the page is the tripwire until Phase 5 adds
a real heartbeat.
