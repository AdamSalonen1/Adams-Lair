# Daily Dozen — Project Plan

A finite, curated feed of popular short-form video. Once a day it fetches
**~12 trending YouTube Shorts** and shows *only* those. Watch the dozen and
you're done — no infinite scroll, no autoplay-next, no algorithm working to
keep you there.

The whole thesis in one line: **the feed is finite on purpose.** The apps this
replaces are engineered to have no stopping point; this one is nothing but
stopping points.

> Working name is *Daily Dozen* (`projects/daily-dozen/`). Renaming later is a
> cheap find-and-replace — don't let naming block anything.

## Why this is allowed (the TOS story)

Two official YouTube APIs do the two jobs, and nothing else touches the content:

- **Discovery** — the [YouTube Data API v3](https://developers.google.com/youtube/v3)
  (`search.list` + `videos.list`) finds trending short-form video. The API key
  is a server-side secret; it never ships to the browser.
- **Playback** — the [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
  embeds each video in YouTube's own sanctioned player.

No downloading, no re-hosting, no scraping. We store video **IDs** plus a little
public metadata (title, channel, duration), overwritten daily. That's well
inside the Data API's stored-data rules (refresh within 30 days — we refresh in
24 hours) and every video links back to YouTube.

## Architecture

```
┌────────────────────────┐   reads today's feed (publishable key + RLS)
│  GitHub Pages          │◄──────────────────────────────────────┐
│  projects/daily-dozen/ │                                        │
│  • finite feed UI      │                                     ┌──┴──────────────┐
│  • IFrame Player embed │                                     │  Supabase       │
│  • localStorage        │       write feed (secret key)       │  shorts_feeds   │
│    progress            │                                     │  (one row/day)  │
└────────────────────────┘                                     └──▲──────────────┘
                                                                   │
        ┌──────────────┐   search.list + videos.list              │
        │  YouTube     │◄────────────────────────────── ┌─────────┴────────┐
        │  Data API    │   (API key in the Pi's .env)    │  Raspberry Pi    │
        └──────────────┘                                 │  worker          │
                                                         │  • systemd timer │
                                                         │  • once daily    │
                                                         └──────────────────┘
```

This reuses Ride Report's exact spine — GitHub Pages front, Supabase in the
middle, an outbound-only Pi worker on a systemd timer behind it — so the moving
parts and their failure modes are already understood. Daily Dozen is the
*simpler* of the two: the feed is public, non-personal content, so there is
**no auth, no per-user rows, no Realtime, and no Claude synthesis** in the core.

## Decisions already made (and why)

| Decision | Why |
|---|---|
| Reuse the Ride Report Pi + Supabase + Pages stack | The pattern is built, documented, and running. One `.env`, one systemd timer, one public-read table — nothing here is a new kind of thing. |
| Discovery: `search.list` (`order=viewCount`, `videoDuration=short`, `publishedAfter`≈48h, `regionCode`, `type=video`) → hydrate with `videos.list` | `chart=mostPopular` is dominated by long-form music videos and trailers and surfaces almost no Shorts. A recency-bounded, view-sorted `short` search is what actually surfaces *trending short-form*. ~101 quota units/day against a 10,000/day budget. |
| Filter after hydration: `status.embeddable`, `contentDetails.duration` ≤ ~60s, not age-restricted/region-blocked | A non-embeddable video is a dead tile. Duration ≤ 60s biases toward true Shorts (the API has no `isShort` flag). Filtering *after* the `videos.list` hydration means the dozen that ships is a dozen that actually plays. |
| One row **per day** (`feed_date` primary key); page reads today's, falls back to newest | A stable "today," free history for a later "yesterday's dozen," and a clean idempotent upsert. Same read shape as Ride Report's newest-daily-report. |
| Feed is **world-readable** under RLS; writes only via the **secret key** on the Pi | Trending Shorts are public — nothing to hide, unlike Ride Report's trips. Copies the "publishable key ships in JS, service key lives only in the Pi's `.env`" model verbatim. |
| **No keyless client fallback** (Ride Report has one; this can't) | Discovery *requires* the API key server-side — there is no honest client-only degraded mode. A missing day shows the last available dozen with a date label and a "not fetched yet" note. It never fabricates a feed. |
| **Manual advance only** — completion reveals "Next," never autoplays it; `rel=0`, `modestbranding`, `playsinline` | Autoplay-next *is* the doomscroll mechanic. Removing it — and keeping YouTube's related-video end screen from taking over — is the entire point of the app. |
| Progress in **localStorage keyed by `feed_date`** | Per-device, no accounts. A refresh resumes where you left off; a new day is a new key, so it resets itself. Finishing the dozen is a hard stop. |

## Phases

Each phase is independently shippable and has explicit exit criteria. Implement
one per session; don't start a phase until the previous one's exit criteria pass.

| Phase | Doc | Deliverable |
|---|---|---|
| 1 | [phase-1-finite-feed.md](phase-1-finite-feed.md) | Client-only page: reads a committed `feed.sample.json`, plays a finite dozen through the IFrame Player, tracks progress, hard-stops at the end. No backend. |
| 2 | [phase-2-supabase.md](phase-2-supabase.md) | Supabase `shorts_feeds` schema + public-read RLS; page renders today's feed (fallback to newest) from a real row. |
| 3 | [phase-3-pi-worker.md](phase-3-pi-worker.md) | Pi worker: `search.list` → `videos.list` → filter/rank → upsert today's row. systemd timer, on the desktop first then the Pi. |
| 4 | [phase-4-hardening.md](phase-4-hardening.md) | Staleness UX (heartbeat), retention/pruning, attribution + config, edge cases. Stretch: history view, "why it's trending" blurb. |

## Constants

- **Region:** `US` (`regionCode`), English-biased (`relevanceLanguage=en`)
- **Dozen size:** 12 (configurable; the target, not a hard floor on a thin day)
- **Short cutoff:** duration ≤ 60s for the sample/default; revisit if 3-min
  Shorts should qualify
- **Feed timezone / "today":** `America/Chicago`, to match Ride Report and Adam
- **Fetch cadence:** once daily (early morning Central) — trends don't turn over
  fast enough to justify more, and the point is one sitting per day
