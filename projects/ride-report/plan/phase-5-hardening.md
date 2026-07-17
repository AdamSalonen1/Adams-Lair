# Phase 5 — Hardening & Polish

**Goal:** make the system boring. Everything here assumes Phases 1–4 work; this
phase makes failures visible, tunes the prose, and closes the loose ends noted
along the way.

## Heartbeat & staleness (the honest UI)

- Add a `worker_status` table (single row): `last_run_at`, `last_ok_at`,
  `last_error`, `source_of_last_report`. Every pipeline run upserts it —
  including failed runs.
- Page renders a subtle status treatment (small dot / footnote, not a
  dashboard): green if `last_ok_at` < 4 h, amber with "report from {time}" if
  stale, and quietly drops to score-only when the narrative is too old to
  trust. The page never pretends a stale narrative is current — `generated_at`
  is always visible on the report itself.
- `source: 'fallback'` reports render with a small "auto-generated (no
  narrative)" note so Claude-outage days are distinguishable at a glance.

## Failure drills (actually run these)

- [ ] Unplug the Pi for a day → page degrades to client-side score + staleness
      messaging; nothing errors
- [ ] Revoke/expire Claude auth on the Pi → fallback reports flow, heartbeat
      shows the error, re-login recovers
- [ ] Supabase unreachable from the browser → Phase 1 fallback renders
- [ ] Pi power-cycled → timer and listener both come back enabled without SSH

## Supabase housekeeping

- **Free-tier pause:** the worker writes several times daily, which should
  count as activity — verify after a quiet week that the project hasn't
  paused. If it ever does, the fix is opening the dashboard; note it in the
  README rather than engineering around it.
- **Report retention:** prune `daily` reports older than ~30 days from the
  scheduled run (keep trip reports until their trip cascades away). One-user
  scale never *needs* this; tidy is tidy.
- **Backup:** trips are the only data with feelings. Monthly `supabase db dump`
  (or a worker job that snapshots trips to JSON on the Pi) is plenty.

## Security pass

- [ ] Re-verify RLS with the anon key via curl: reports SELECT-only, trips
      writes rejected, `worker_status` SELECT-only
- [ ] Confirm signups are still disabled in Supabase auth
- [ ] Confirm the public repo contains no `.env`, no service key, no session
      artifacts (`git log -p` the worker dir once to be sure)
- [ ] Revisit the "public trips reveal you're away" decision from Phase 2 now
      that real trips exist

## Prompt tuning (the fun part)

With a few weeks of real reports:

- Tighten `prompt.md` for voice — cut anything that reads like a TV forecast;
  it should sound like a riding buddy who checked the radar.
- Feed the synthesis yesterday's report payload for continuity ("still soggy
  from Tuesday's rain" beats amnesia). Cheap: it's one extra JSON blob in.
- Consider a weekly "outlook" report (`kind: 'daily'` stays, cadence Sunday
  evening) summarizing the riding week ahead — one extra timer entry, zero new
  architecture.

## Stretch ideas (unranked, unpromised)

- **Wind vs. route direction:** Fargo is flat; wind *is* the terrain. A hint
  like "west wind 15 — ride out west, cruise home" from `wind_direction_10m`.
- **Forecast retrospectives:** log forecast-vs-actual for report dates; let a
  monthly Claude run grade the forecasts ("mud calls were right 8 of 9 times").
- **Multi-location:** the pipeline is already parameterized; a location picker
  on the page is mostly UI work.
- **PWA/home-screen icon** so it opens like an app from the phone.
- **Season memory:** a `notes.md` the synthesis can append observations to —
  trail-condition folklore accumulating over a season.

## Exit criteria

- [ ] All four failure drills pass
- [ ] Security pass checklist clean
- [ ] Two weeks of unattended operation with zero SSH interventions
- [ ] The report reads like it was written for a cyclist, not by a weather app
