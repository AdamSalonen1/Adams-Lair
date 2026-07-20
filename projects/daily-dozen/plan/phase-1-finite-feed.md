# Phase 1 — The finite feed (no backend)

**Deliverable:** A client-only page that reads a committed `feed.sample.json`,
plays that fixed dozen through the IFrame Player API one at a time, tracks what
you've watched, and hard-stops on a "that's the dozen, come back tomorrow"
screen. This is the whole UX proven before any data pipeline exists.

Everything here is deliberately built so the Phase 2 swap — sample JSON for a
Supabase row — touches one function.

## Files

- `index.html` — page shell, reuses the site nav/footer/`css/style.css`, adds
  its own `daily-dozen.css`
- `daily-dozen.css` — feed layout, the vertical Short player frame, progress bar,
  end screen
- `app.js` — orchestration: load the feed, render the current card, own the
  watched-state and progress, show the end screen
- `player.js` — a thin wrapper over the IFrame Player API: build a player for a
  video ID, resolve when it reports `ENDED`, surface load errors
- `feed.js` — `loadFeed()`: in Phase 1 it just fetches `feed.sample.json`. Phase 2
  reimplements the body to read Supabase; the signature and return shape don't move.
- `feed.sample.json` — a real dozen of Short IDs for offline dev (see "Sample data")

## Feed contract (frozen here, honored by every later phase)

```json
{
  "feed_date": "2026-07-20",
  "generated_at": "2026-07-20T11:00:00Z",
  "region": "US",
  "items": [
    {
      "video_id": "abc123XYZ",
      "title": "…",
      "channel_title": "…",
      "published_at": "2026-07-19T14:00:00Z",
      "duration_sec": 41,
      "view_count": 1830000
    }
  ]
}
```

`loadFeed()` returns this object (or `null` if nothing is available). `app.js`
never learns where it came from — that's what keeps Phase 2 a one-function change.

## Behavior

- **Finite render.** Show exactly `items` — one card at a time, current video in
  the player, the rest as a short "up next" ledger so the end is always in sight.
  No scroll that loads more, because there is no more.
- **Manual advance.** Player vars: `rel=0`, `modestbranding=1`, `playsinline=1`,
  and **autoplay off**. When a video reports `ENDED`, mark it watched and reveal
  a **Next** button — never auto-advance. A **Skip** is allowed (finite feed, not
  a homework assignment), and also marks the item done.
- **Progress.** "3 of 12" plus a bar. Persist watched indices in `localStorage`
  under `daily-dozen:<feed_date>`. A refresh resumes; a new day is a new key and
  resets on its own.
- **Hard stop.** After the last item: a full-card "That's the dozen. Come back
  tomorrow." screen — no replay-loop nudge, no "recommended for you." Optionally a
  small countdown to the next feed. This screen is the product.
- **Unavailable item.** If the player reports an error for an ID (deleted, went
  private, embedding disabled), show a tidy "this one's unavailable" tile with a
  "watch on YouTube" link and let Next move on. Graceful here; Phase 3's worker
  filters these out at the source so it's rare.

## Sample data

`feed.sample.json` holds real video IDs so the player actually renders, but it is
**dev scaffolding, not a curated feed** — embeddability can lapse for any video,
and only Phase 3's `videos.list` check guarantees it. Include at least one very
short clip so the `ENDED` → Next flow is quick to exercise by hand. If a sample
embed is unavailable, that's the sample aging, not a bug — the unavailable-item
path above is exactly what should catch it.

## Exit criteria

- Exactly the sample dozen renders; there is no way to load a 13th.
- Playing a video to the end reveals **Next** and never autoplays it; the counter
  climbs 1→12; the last item yields the hard-stop screen.
- Progress survives a refresh mid-way (resumes, doesn't restart) and a new
  `feed_date` starts clean.
- No related-video end screen hijacks the player.
- Swapping `loadFeed()`'s body for a stub that returns `null` degrades to a calm
  "no feed yet" state, not a broken page — proof the Phase 2 seam is real.

## Verification

Serve over `http(s)://` (the IFrame API won't run from `file://`):
`python -m http.server` from the repo root, open
`/projects/daily-dozen/index.html`. Drive it with headless Chrome for a
screenshot, per the usual flow. Confirm each exit criterion by hand.
