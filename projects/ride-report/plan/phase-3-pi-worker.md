# Phase 3 — Pi Worker (Scheduled Path)

**Goal:** the synthesis pipeline — fetch → score → `claude -p` → upload — running
on a timer. Developed and proven on the desktop first; the Pi is just the final
`git clone`.

**Principle:** the script does all I/O; Claude only transforms text. Weather
fetching and Supabase uploads are deterministic code. The LLM receives JSON on
stdin and returns JSON on stdout. Nothing else.

## Layout

```
projects/ride-report/worker/
  package.json        node >= 20, type: module
  pipeline.js         orchestrates one run (shared by timer + Phase 4 listener)
  openmeteo.js        fetch + shape (worker twin of weather.js; keep tiny)
  synth.js            claude -p invocation, JSON validation, retry
  db.js               Supabase REST upsert using service key
  prompt.md           the synthesis prompt, versioned like code
  run-scheduled.js    entry point for the timer
  systemd/
    ride-report.service
    ride-report.timer
  .env.example        SUPABASE_URL, SUPABASE_SERVICE_KEY, MOCK_SYNTH
```

`pipeline.js` imports **`../score.js`** — the same pure module the browser uses.
One scoring brain, two consumers. (Real `.env` never enters the repo — the repo
is public and GH Pages serves it verbatim.)

## The synthesis step (`synth.js`)

```
score+weather JSON on stdin
  → claude -p <prompt> --output-format json --model sonnet
  → parse CLI JSON envelope, extract result text
  → parse result as report payload JSON
  → validate shape (required keys, types, score in 0–100)
  → invalid? one retry with the validation error appended to the prompt
  → still invalid? fall back: deterministic template from the score data,
    source = 'fallback' (report row always lands; prose is best-effort)
```

Prompt notes (`prompt.md`):

- Demand **strict JSON only** matching the Phase 2 payload shape — no prose
  around it.
- Give it the computed score/windows/mud as ground truth to narrate, not
  recompute. The numbers are the score engine's job.
- Voice: the site's — plainspoken, a little wry, zero weather-anchor filler.

`MOCK_SYNTH=1` skips the CLI and returns canned payload — lets the whole
pipeline run on any machine without touching the Pro subscription.

## Failure handling

- Claude Code failure (rate-limit window shared with your own sessions, auth
  expiry, network): log it, write the `fallback` report anyway, exit non-zero.
  Next timer tick retries naturally. Staleness/source surfacing is the UI's
  job (Phases 2 & 5) — the worker just records honestly.
- Open-Meteo failure: exit non-zero without writing anything; the previous
  report stands and its age tells the story.

## Scheduling

`ride-report.timer`: `OnCalendar=05..21/3:10` (every 3 h, 5 AM–9 PM Central —
forecast models don't update faster, and 2 AM reports serve no one).
`ride-report.service`: `Type=oneshot`, `WorkingDirectory=` the worker dir,
`EnvironmentFile=.env`. Wrap `ExecStart` in `flock -n` on a lockfile — Phase 4's
listener shares the same lock so scheduled and event-driven runs never overlap.

## Pi setup checklist

1. Raspberry Pi OS **64-bit** (Pi 4 or 5), SSH enabled
2. Node 20 LTS (NodeSource) — required by Claude Code anyway
3. Install Claude Code; run `claude` once via SSH, `/login` with the **Pro**
   account; confirm `claude -p "say hi"` works headless afterward
4. `git clone` the repo; `npm ci` in `worker/`
5. Create `.env` from `.env.example` (service key lives here and only here)
6. `MOCK_SYNTH=1 node run-scheduled.js` → row lands in Supabase
7. Real run → narrative lands
8. Install + enable the systemd units; `systemctl list-timers` shows it

## Exit criteria

Status as of 2026-07-18. Built and verified directly on the Pi
(`adams-blackbox`) rather than desktop-first — the desktop was unavailable, so
the "prove it on the desktop, clone to the Pi" order was inverted.

- [x] ~~Full pipeline passes on the **desktop**~~ — **N/A, inverted.** Proven on
      the Pi with `MOCK_SYNTH=1`, `--dry-run`, and for real. The desktop has
      never run this code.
- [~] Pipeline passes on the **Pi** — yes, both by hand and via
      `systemctl start`. Timer is enabled and firing; **the 48 h unattended
      soak is still outstanding** (started 2026-07-18 ~09:55 CDT).
- [x] Killing the network mid-run produces a clean logged failure, not a
      corrupt/partial report row — verified two ways: no network at all
      (`unshare -n` → 3 backoff attempts → exit 1, nothing written), and
      Supabase unreachable *after* synthesis succeeded (exit 1, no row).
- [x] Malformed LLM output triggers retry-then-fallback — verified by sabotaging
      the prompt via `SYNTH_PROMPT_PATH`. Forcing `day_score: 999` was rejected
      and the retry succeeded; forcing never-JSON failed twice and produced the
      deterministic fallback with `source='fallback'`, exit 2. Plus 26
      pure-function checks in `test-synth.js`. **The "renders fine on the page"
      half is unverified — see below.**
- [ ] Page now shows a Pi-generated narrative with correct freshness —
      **blocked, not done.** `app.js` and `index.html` contain zero Supabase
      references: Phase 2's "Page changes" section was never implemented in this
      repo. The worker is writing rows that nothing reads yet. Anon reads *were*
      verified at the API level (daily readable, trips empty, writes 401), so
      the data side is ready for whoever picks that up.

## Notes

- Each run spins up the whole CLI for one completion — seconds of Node startup
  on a Pi. Irrelevant on a timer; just don't build anything latency-sensitive
  on this path.
- Rare tending: stored OAuth occasionally needs a re-login; the CLI updates
  itself. A stale `generated_at` on the page is the tripwire (Phase 5 adds a
  proper heartbeat).
