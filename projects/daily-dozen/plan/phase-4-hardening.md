# Phase 4 — Hardening & polish

**Deliverable:** The edges that make it a thing you trust daily rather than a demo.

## Staleness UX (heartbeat)

Reuse Ride Report's `worker_status` heartbeat verbatim — one world-readable row,
written by every run including failures. The page uses it to tell two silences
apart, exactly as Ride Report does:

- Feed is from yesterday **and** the worker ran ok this morning → "today's dozen
  isn't up yet" (normal, it's before the 6:30 fetch or a thin day).
- Feed is stale **and** no successful run behind it → "the fetcher's down"
  (honest about the outage; still shows the last good dozen).

Never render the raw `last_error` to a visitor — same rule as Ride Report.

## Retention

Prune `shorts_feeds` to the last N days (keep enough for a "yesterday's dozen"
view, drop the rest), following Ride Report's `pruneDailyReports()` — and, like
it, only prune *after* a new row has landed, so the table can never be emptied.
Keeps stored API data well inside the 30-day refresh rule.

## Attribution & config

- Every card links to the video on YouTube and names the channel — good
  citizenship and TOS-friendly.
- Lift `REGION` / `MAX_DURATION_SEC` / `DOZEN_SIZE` into clear config so a second
  region or a 3-minute-Short experiment is a value change, not a code change.

## Edge cases

- A day where fewer than a dozen survive the filter: show what there is, labeled
  honestly ("8 today"), don't pad with worse videos.
- An item that goes unavailable *between* fetch and watch: the Phase 1
  unavailable-tile path already covers it; confirm it still reads well against a
  live feed.

## Stretch

- **Yesterday's dozen** — a small history view off the retained rows. The one
  concession to "a bit more," and a bounded one.
- **Why it's trending** — an optional one-line blurb per video from headless
  `claude -p` on the Pi (reusing Ride Report's Pro-subscription pattern), written
  at fetch time into the item. Pure flavor; the feed works without it.
- **Region/category toggles** — if one region's trends get stale, a second
  `regionCode` is ~100 more quota units, i.e. free.

## Exit criteria

- The page distinguishes "not fetched yet" from "fetcher down" without ever
  showing a raw error.
- Old feed rows are pruned, and never below the current one.
- A thin-feed day renders honestly rather than padding or breaking.
