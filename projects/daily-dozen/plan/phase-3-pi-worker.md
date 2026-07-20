# Phase 3 — The Pi worker (real discovery)

**Deliverable:** A Node worker that asks the YouTube Data API for trending
short-form video, filters it down to a dozen that will actually embed, and upserts
today's `shorts_feeds` row with the secret key. Runs on the desktop first, then on
the Pi under a systemd timer — same shape as
[ride-report/worker](../../ride-report/worker).

## Files — `worker/`

- `youtube.js` — the two API calls and the filter/rank
- `db.js` — service-key upsert of today's row + a `worker_status` heartbeat
  (copy Ride Report's `db.js` heartbeat wholesale)
- `run-daily.js` — entry point for the timer; the exit-code contract below
- `package.json`, `.env.example` — `YOUTUBE_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SECRET_KEY`, optional `REGION`, `MAX_DURATION_SEC`, `DOZEN_SIZE`
- `systemd/daily-dozen.{service,timer}` — copy Ride Report's `flock` /
  `Persistent=true` / `SuccessExitStatus` / heartbeat pattern

## Discovery

1. **`search.list`** — `part=snippet`, `type=video`, `videoDuration=short`,
   `order=viewCount`, `publishedAfter`=now−48h, `regionCode`, `relevanceLanguage=en`,
   `maxResults=50`. Cost: 100 units. Returns candidate IDs (recent + high-view).
2. **`videos.list`** — `part=contentDetails,status,statistics,snippet` on those IDs
   (batched, ≤50 per call). Cost: 1 unit. This is where the real metadata lives.
3. **Filter:** keep only `status.embeddable === true`,
   `contentDetails.duration` ≤ `MAX_DURATION_SEC` (default 60), not age-restricted
   (`contentDetails.contentRating` / `status`), not region-blocked
   (`contentDetails.regionRestriction`).
4. **Rank:** by a velocity metric — `viewCount / hours_since_published` — so a
   6-hour-old rocket outranks a 2-day-old video with more lifetime views. Take the
   top `DOZEN_SIZE`.
5. **Write:** upsert `shorts_feeds` for today (`on conflict (feed_date) do update`)
   with the trimmed item shape from Phase 1.

Total ≈ 101 units/day against a 10,000/day quota — two orders of magnitude of
headroom, so retries and a second region later are free.

## Exit-code contract (from Ride Report)

- `0` — a fresh dozen was written
- `1` — nothing written (API or DB failure); yesterday's row still stands
- `2` — written but degraded (e.g. fewer than `DOZEN_SIZE` survived the filter on
  a thin day) — the row lands, but `systemctl status` shows red so a persistent
  shortfall is visible

Every run writes the heartbeat, including failures — the page uses it in Phase 4
to tell "not fetched yet this morning" from "the Pi is down."

## systemd

- `daily-dozen.timer`: `OnCalendar=*-*-* 06:30 America/Chicago`, `Persistent=true`
  (catch up one missed run after downtime), a small `RandomizedDelaySec`.
- `daily-dozen.service`: `Type=oneshot`, `flock` (its own lock file, separate from
  Ride Report's), `EnvironmentFile=.env`, `SuccessExitStatus=0`.

## Exit criteria

- A real dozen lands in `shorts_feeds` end to end and the page renders it.
- Every item is embeddable and ≤ the duration cutoff (spot-checked against the
  live page — no dead tiles).
- Quota accounting confirmed well under budget.
- The timer fires on schedule and catches up after the Pi is powered off overnight.
