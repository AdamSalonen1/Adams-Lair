# Ride Report — Project Plan

A cycling-focused weather report for Adam's Lair. Answers three questions before a ride:

1. **How good of a day is it** for a ride / outdoor activity?
2. **What times will be ideal?**
3. **Has it rained recently?** (muddy trails make for a lousy ride)

Plus **trip planning**: save future rides, get a synthesized outlook that updates
automatically as forecasts firm up.

> Working name is *Ride Report* (`projects/ride-report/`). Renaming later is a
> cheap find-and-replace — don't let naming block anything.

## Architecture

```
┌─────────────────────┐        reads (anon key + RLS)
│  GitHub Pages       │◄───────────────────────────────┐
│  static site        │                                │
│  projects/          │   trip writes (Supabase auth)  │
│  ride-report/       │────────────────────────────►┌──┴───────────────┐
│                     │                             │  Supabase        │
│  fallback: client-  │                             │  trips, reports  │
│  side score from    │                             │  (free tier)     │
│  keyless Open-Meteo │                             └──▲───────▲───────┘
└─────────────────────┘                                │       │
                                     upload reports    │       │ Realtime
                                     (service key)     │       │ WebSocket
                                                    ┌──┴───────┴───────┐
      ┌──────────────┐   forecast + air quality     │  Raspberry Pi    │
      │  Open-Meteo  │◄──────────────────────────── │  outbound-only   │
      │  (free, no   │                              │  worker          │
      │  API key)    │                              │  • systemd timer │
      └──────────────┘                              │  • Realtime      │
                                                    │    listener      │
      ┌──────────────┐   headless `claude -p`       │                  │
      │  Claude Code │◄──────────────────────────── │                  │
      │  (Pro sub)   │                              └──────────────────┘
      └──────────────┘
```

## Decisions already made (and why)

| Decision | Why |
|---|---|
| Site stays on GitHub Pages | Free, effectively always up. The Pi going down degrades the experience; it never takes the site down. |
| Weather data: Open-Meteo | Free, **keyless** (so the browser fallback needs no backend), hourly forecast + separate air-quality API + `past_days` for the mud check. |
| Rule-based score runs client-side, always | Permanent degraded mode. If the Pi/Supabase/Claude are all down, the page still answers "is today good for a ride." |
| Synthesis via headless Claude Code (`claude -p`) on the Pi | Bills against the existing Pro subscription — no separate API account. Personal-automation use of print mode is what it's for. |
| Pi is **outbound-only** | No port forwarding, no tunnel, no exposure. It fetches weather, runs Claude, pushes to Supabase. |
| Supabase Realtime for trip events (not webhooks, not 1s polling) | Webhooks would require the Pi to accept inbound traffic. Realtime is an outbound WebSocket the Pi holds open — push semantics, Pi stays private. |
| Worker in Node | Claude Code already requires Node on the Pi, and supabase-js has the first-class Realtime client. Zero extra runtime. |
| Script does all I/O; Claude only transforms text | Deterministic fetch/upload via code; the LLM gets JSON in, returns JSON out. No agent-loop nondeterminism in the pipeline. |

## Phases

Each phase is independently shippable and has explicit exit criteria. Implement
one per session; don't start a phase until the previous one's exit criteria pass.

| Phase | Doc | Deliverable |
|---|---|---|
| 1 | [phase-1-score-mvp.md](phase-1-score-mvp.md) | Client-only page: live rideability score, best windows, mud risk. No backend. |
| 2 | [phase-2-supabase.md](phase-2-supabase.md) | Supabase schema + auth; page reads reports, trip CRUD works. |
| 3 | [phase-3-pi-worker.md](phase-3-pi-worker.md) | Scheduled worker: fetch → score → `claude -p` → upload. Runs on desktop first, then Pi. |
| 4 | [phase-4-realtime-trips.md](phase-4-realtime-trips.md) | Realtime listener: add/edit a trip → synthesized outlook appears within ~a minute. |
| 5 | [phase-5-hardening.md](phase-5-hardening.md) | Heartbeat/staleness UX, failure handling, prompt tuning, stretch ideas. |

## Constants

- **Home location:** Fargo, ND — `46.8772, -96.7898`, timezone `America/Chicago`
- **Units:** °F, mph, inches
- **Forecast horizon:** Open-Meteo caps at 16 days — trips beyond that get a
  "too far out, will firm up" placeholder until they enter the window.
