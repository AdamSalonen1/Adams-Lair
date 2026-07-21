# Daily Dozen — Pi Worker

`search.list` → `videos.list` → filter/rank → Supabase upsert. One systemd timer,
once each morning. The Pi stays outbound-only: it makes two HTTPS calls to Google
and one to Supabase, and exposes nothing.

The script does all the work — there is no LLM in the core (unlike Ride Report).
Discovery is a `search.list` (paged) then a `videos.list`; the taste is a filter
and a velocity rank, both pure functions in `youtube.js`. The filter also aims
the feed at an English-speaking audience — see "Aiming the feed…" below. Every
field the page renders comes from `videos.list` metadata, trimmed to the frozen
Phase-1 item shape before it's stored.

One thing worth stating up front: this worker writes into the **same Supabase
project as Ride Report** (free tier caps an org at two projects). It touches only
Daily Dozen's own tables, and its heartbeat is a separate row —
`dozen_worker_status`, not Ride Report's `worker_status` — so the two workers
never clobber each other. See `../supabase/README.md`.

## Files

| File | Job |
|---|---|
| `config.js` | Tuning knobs from env (region, cutoff, dozen size, retention) + the time helpers. Pure. |
| `youtube.js` | The two API calls, and the pure filter/rank/shape. The only file that talks to YouTube. |
| `db.js` | Supabase REST upsert, heartbeat, retention + a tiny `.env` loader. Writes with the secret key. |
| `run-daily.js` | Timer entry point. Orchestrates one run; owns the exit-code contract. |
| `mock/videos.sample.json` | Canned `videos.list`-shaped candidates for `MOCK_YOUTUBE`. |
| `test-youtube.js` | Pure-function checks for parse/filter/rank/shape. No network. |
| `systemd/` | The service + timer. |

No runtime dependencies — `npm ci` installs nothing. Everything talks to Supabase
and YouTube over plain `fetch`.

## Setup

```bash
cp .env.example .env      # then fill it in
chmod 600 .env
```

`.env` needs a **YouTube Data API v3 key** and the Supabase **secret**
(`sb_secret_...`) key — not the publishable/anon one. `shorts_feeds` has no insert
policy, so RLS rejects every write from the publishable key; `db.js` checks for
that specific mistake and fails loudly. The `SUPABASE_URL` / `SUPABASE_SECRET_KEY`
are the same pair already in `../../ride-report/worker/.env`.

The discovery step has **no client-only fallback**: without the API key there is
no honest way to find trending video, so the worker refuses rather than fabricate
a feed. Use `MOCK_YOUTUBE=1` to run the rest of the pipeline without a key.

## Running

```bash
node run-daily.js                    # real run: fetch, filter, upsert today's row
node run-daily.js --dry-run          # everything except the write (and the heartbeat)
MOCK_YOUTUBE=1 node run-daily.js     # skip the API, build the dozen from mock/, still writes
npm test                             # pure-function checks (node test-youtube.js)
```

`MOCK_YOUTUBE=1` writes a real `shorts_feeds` row from a canned candidate set —
twelve genuinely embeddable IDs plus four deliberately-bad ones (too long,
embedding off, age-restricted, region-blocked) so the filter is exercised, not
bypassed. The page picks up the row on its next load. It spends no quota.

Config knobs (all optional, defaults in `.env.example`): `REGION`,
`RELEVANCE_LANGUAGE`, `REQUIRE_LATIN_TITLE`, `SEARCH_QUERY`, `SEARCH_PAGES`,
`MAX_DURATION_SEC`, `DOZEN_SIZE`, `PUBLISHED_WITHIN_HOURS`, `RETENTION_DAYS`. A
second region, an English-only feed, or a 3-minute-Short experiment is a value
change, not a code change.

## Discovery, and the quota

| Call | Part | Cost |
|---|---|---|
| `search.list` | `q=#shorts`, `type=video`, `videoDuration=short`, `order=viewCount`, `publishedAfter`=now−48h, `regionCode`, `relevanceLanguage=en`, `maxResults=50`, paged ×`SEARCH_PAGES` | 100 units/page |
| `videos.list` | `contentDetails,status,statistics,snippet` on those IDs, batched ≤50 | 1 unit/batch |

The `q` term is **required**, not decorative: `search.list` with no query returns
zero rows however it's ordered (an unanchored `order=viewCount` search matches
nothing — the project plan's query spec omitted this). `SEARCH_QUERY` (default
`#shorts`) anchors it to short-form; the filter and velocity rank do the curation.

≈ **202 units/day** at the default `SEARCH_PAGES=2` against a 10,000/day quota —
two orders of magnitude of headroom, so retries, more pages, and a second region
later are free. `chart=mostPopular` is deliberately *not* used: it's dominated by
long-form music videos and trailers and surfaces almost no Shorts. A
recency-bounded, view-sorted `short` search is what actually surfaces trending
short-form.

The **filter** keeps only `status.embeddable === true`, duration ≤
`MAX_DURATION_SEC`, not age-restricted, and not region-blocked for `REGION` — so
the dozen that ships is a dozen that actually plays; no dead tiles. The **rank**
is view *velocity* (`viewCount / hours_since_published`, floored at one hour), so
a 6-hour rocket outranks a 2-day-old video with more lifetime views. Top
`DOZEN_SIZE` win.

### Aiming the feed at an English-speaking (American) audience

`regionCode`/`relevanceLanguage` on the search are only *biases*, not filters. On
a global `order=viewCount` search that isn't nearly enough: Indian and other
non-English mega-channels post the highest-view Shorts on the platform, so the
raw candidate set — and then the velocity rank — skews heavily Hindi/CJK/etc.

So the filter carries a hard language gate, on two signals because neither alone
suffices:

1. **`lang-mismatch`** — the video *declares* a language (`defaultAudioLanguage`
   or `defaultLanguage`) that isn't `RELEVANCE_LANGUAGE`. Precise, but most Shorts
   never set it.
2. **`non-latin-title`** — the title is written predominantly in a non-Latin
   script (Devanagari, CJK, Arabic, …). Blunt, but it catches the content signal
   (1) misses for lack of metadata. Emoji and digits don't count as letters, so
   an emoji-heavy English title is safe; a title with no letters at all is kept.
   `REQUIRE_LATIN_TITLE=0` turns this off for a deliberately non-Latin feed.

Because the gate can cut a global page of 50 down hard, `SEARCH_PAGES` (default 2)
pulls a second page so the English survivors still comfortably fill a dozen. Both
drops show up in the run's dropped-reason tally, so a suddenly-thin feed is
diagnosable rather than mysterious.

## Exit codes

The contract with systemd:

| Code | Meaning |
|---|---|
| 0 | A fresh dozen was written (`DOZEN_SIZE` items) |
| 1 | **Nothing written** — API or DB failure. Yesterday's row still stands and its date label tells the story. |
| 2 | Written but **degraded** — fewer than `DOZEN_SIZE` survived the filter on a thin day |

2 is non-zero on purpose: the row lands so the page stays useful, but a persistent
shortfall should show red in `systemctl status`, not hide behind a green check.
Zero survivors is treated as a failed fetch (exit 1), not a degraded one — writing
an empty feed would blank the page, so yesterday's is left standing instead.

## The heartbeat

Every run updates the single `dozen_worker_status` row, **including the runs that
fail**. A heartbeat that only beats on good days reads as healthy right up until
the machine is dead.

| Column | Written when | Means |
|---|---|---|
| `last_run_at` | every run | the Pi is awake and the timer is firing |
| `last_ok_at` | only when a feed row landed | the last time this actually worked |
| `last_error` | every run, `null` when clean | why the last run wasn't clean |
| `last_item_count` | when a feed was written | how many survived — a low number flags a thin day |

A failed run deliberately omits `last_ok_at`, so the stored value keeps pointing
at the last run that worked and the gap since it *is* the length of the outage.
That's why the write is a `PATCH`, not an upsert. Phase 4's page reads this to
tell "not fetched yet this morning" from "the fetcher's down". `last_error` is
world-readable, so `db.js` truncates it to one short line; the page never renders
it.

> If `dozen_worker_status` doesn't exist yet, the heartbeat write logs one
> harmless warning and the run still succeeds — re-apply `../supabase/schema.sql`
> to add the table.

## Retention

After a successful write, the run prunes `shorts_feeds` rows older than
`RETENTION_DAYS` (default 14 — enough for a "yesterday's dozen" view). Pruning
only happens once a row has landed *this run*, which is the whole safety argument:
there is always today's row newer than the cutoff, so a Pi returning from a long
outage prunes its backlog instead of emptying the table. Well inside the Data
API's 30-day stored-data rule.

## systemd

```bash
sudo cp systemd/daily-dozen.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daily-dozen.timer

systemctl list-timers 'daily-dozen*'
journalctl -u daily-dozen.service -n 50 --no-pager
sudo systemctl start daily-dozen.service       # run once, now
```

The timer fires at **06:30 Central** with `Persistent=true`, so a Pi that was off
overnight catches up one missed run shortly after boot rather than waiting for
tomorrow. `Type=oneshot`, wrapped in `flock` on its own `/run/lock/daily-dozen.lock`
— separate from Ride Report's lock. Unlike Ride Report it uses `flock -n` (skip if
a run is already in flight) rather than `-w` (wait): Ride Report waits because its
Realtime listener holds the lock to write a *trip*; Daily Dozen has no listener,
so the only possible contender is another daily run writing the same feed, and
declining is right. `SuccessExitStatus=0 75` keeps a skip (75) green.

`WorkingDirectory` and `EnvironmentFile` are hardcoded to
`/home/adams/projects/Adams-Lair/projects/daily-dozen/worker`. Cloning elsewhere
means editing both lines.

## Failure behaviour

- **YouTube down / transient** → 3 attempts with backoff, then exit 1. Nothing is
  written; there is no code path that produces a partial row.
- **Quota exceeded / bad key** → recognised from the API's `reason` and failed
  immediately (no pointless retries), exit 1. The reason lands in `last_error`.
- **Everything filtered out** → exit 1, yesterday's row stands.
- **Thin day (some but < a dozen)** → the short feed is written, exit 2, and
  `last_item_count` records how many.
- **Supabase down** → exit 1 after discovery. Next tick retries. The heartbeat
  write fails too, which is expected and swallowed — bookkeeping must never be the
  thing that turns a good run red.
