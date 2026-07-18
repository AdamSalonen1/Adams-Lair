# Ride Report — Pi Worker

Fetch → score → `claude -p` → Supabase, on a systemd timer.

The script does all the I/O. Claude only turns numbers into a sentence: it gets
JSON on stdin and returns JSON on stdout, with no tools and no agent loop. Every
number in the stored payload comes from `../score.js` — the same module the
browser runs — so a "72" means the same thing in both places.

## Files

| File | Job |
|---|---|
| `pipeline.js` | One full run. Shared by the timer and (Phase 4) the Realtime listener. |
| `run-scheduled.js` | Timer entry point. Owns exit codes. |
| `openmeteo.js` | Fetch with timeout/retry. Imports `shapeWeather` from `../weather.js`. |
| `synth.js` | `claude -p`, JSON extraction, validation, one retry, deterministic fallback. |
| `db.js` | Supabase REST insert + a tiny `.env` loader. No dependencies. |
| `prompt.md` | The synthesis prompt, versioned like code. |
| `test-synth.js` | Pure-function checks for the guardrails. No network. |

Zero runtime dependencies — `npm ci` installs nothing. Phase 4 adds
`@supabase/supabase-js` for the Realtime socket.

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
MOCK_SYNTH=1 node run-scheduled.js # skip the CLI, canned narrative
node test-synth.js                 # guardrail unit tests
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Report written, narrative from Claude |
| 1 | **Nothing written** — weather or DB failure. The previous report stands and its age tells the story. |
| 2 | Report written, but from the deterministic fallback |

2 is non-zero on purpose. The row landed so the page stays useful, but a
persistent Claude outage should look failed rather than quietly degrade forever.
`MOCK_SYNTH=1` also exits 2, because mock prose genuinely isn't Claude prose and
the database shouldn't claim otherwise (`source='fallback'`).

## Failure behaviour

- **Open-Meteo down** → 3 attempts with backoff, then exit 1. Nothing is
  written; there is no code path that produces a partial row.
- **Air quality down** → logged, run continues. `score.js` scores fine with
  `aqi: null`.
- **Claude fails or returns junk** → one retry with the validation error fed
  back, then a deterministic template from the score data, `source='fallback'`.
- **Supabase down** → exit 1 after synthesis. Next tick retries.

The model is asked to copy `day_score`/`windows`/`mud` through verbatim, but
`pipeline.js` re-asserts them from `score.js` output regardless. Code is a
better enforcer of "the numbers are the score engine's job" than a prompt is.

## systemd

```bash
sudo cp systemd/ride-report.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ride-report.timer

systemctl list-timers ride-report.timer
journalctl -u ride-report.service -n 50 --no-pager
sudo systemctl start ride-report.service   # run once, now
```

Runs at 05:10, 08:10, 11:10, 14:10, 17:10, 20:10 Central. `Persistent=true`
catches up one missed run after downtime. `ExecStart` is wrapped in `flock -n`
on `/run/lock/ride-report.lock`; Phase 4's listener takes the same lock so
scheduled and event-driven runs never overlap.

The unit hardcodes `/home/adams/projects/Adams-Lair/projects/ride-report/worker`
as `WorkingDirectory` and `EnvironmentFile`. Cloning elsewhere means editing
both lines.

## Tending

Each run spins up the whole CLI for one completion — tens of seconds on a Pi,
and it consumes the same Pro rate-limit window as your interactive sessions.
Fine on a timer; don't build anything latency-sensitive on this path.

The stored OAuth token occasionally needs a re-login (`claude` over SSH, then
`/login`). A stale `generated_at` on the page is the tripwire until Phase 5 adds
a real heartbeat.
