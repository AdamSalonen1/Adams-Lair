# Daily Dozen — Supabase

The data plane between the Pi worker and the page. Two tables, two policies, and
one rule worth internalising: **RLS is the only thing protecting this data.** The
page ships the publishable key in plain JavaScript, so every guarantee here is a
policy in `schema.sql`, not a secret.

Unlike Ride Report, there is nothing private here — trending Shorts and a worker
heartbeat are both world-readable. So both policies are a plain `using (true)`;
the security story is entirely about **who can write** (only the Pi, with the
secret key), not who can read.

| Table | Read | Write |
|---|---|---|
| `shorts_feeds` | public | secret key only |
| `dozen_worker_status` | public | secret key only |

| File | Job |
|---|---|
| `schema.sql` | Tables, RLS policies, the heartbeat singleton seed. Re-runnable. |
| `verify-rls.mjs` | Proves the policies hold, from outside the browser. |

## One shared project

The free tier caps a Supabase org at two projects, so Daily Dozen does **not**
get its own — its tables live inside the **Ride Report** project. `schema.sql` is
written to touch only Daily Dozen's own objects (`shorts_feeds`,
`dozen_worker_status`) and leaves Ride Report's `trips` / `reports` /
`worker_status` alone.

The one place this co-tenancy shows through: the heartbeat is a **separate table**
(`dozen_worker_status`), not Ride Report's shared `worker_status`. Two workers
writing the same single-row table would each clobber the other's "is the Pi
alive" answer, so each app keeps its own.

`../supabase-config.js` therefore holds the *same* URL and publishable key as
Ride Report's. That's expected, not a copy-paste slip.

## Applying

Paste `schema.sql` into the SQL editor, or `psql "$SUPABASE_DB_URL" -f schema.sql`.

Every statement is idempotent — `create ... if not exists`, `drop policy if
exists` before each `create policy`, an `on conflict do nothing` seed. Editing a
policy and re-running the whole file is the intended workflow, not a migration
event. Nothing in it drops data.

> If you applied an earlier version that had only `shorts_feeds`, re-run the
> whole file once to pick up the `dozen_worker_status` heartbeat the Phase 3
> worker writes to. Until you do, the worker still publishes feeds fine — it
> just logs that the heartbeat write had nowhere to land.

## The dashboard step SQL can't do

**Project Settings → API Keys**: the publishable key goes in
`../supabase-config.js` (already filled in, shared with Ride Report). The secret
key goes in the Pi's `worker/.env` and nowhere else — it bypasses RLS entirely,
and this repo is public. There is no auth and no redirect-URL setup here; Daily
Dozen has no accounts.

## Verifying

```bash
node verify-rls.mjs                                      # anon checks only
SUPABASE_SERVICE_KEY=sb_secret_... node verify-rls.mjs   # seeds a row first
```

Without the secret key it can only check that anonymous callers can read the feed
and cannot write it. With it, the script seeds a throwaway feed row on a far-past
sentinel date — so it can never be mistaken for a real "today" or become the
newest-row fallback — proves anon sees it but cannot update or delete it, then
cleans up.

The `dozen_worker_status` checks need no seeding: `schema.sql` creates the
singleton. If the table doesn't exist yet (a project applied before the Phase 3
heartbeat was added), those checks are skipped with a note rather than failing.

## Getting a first feed row

The Phase 3 worker is the supported way in:

```bash
cd ../worker && MOCK_YOUTUBE=1 node run-daily.js
```

That writes a real `shorts_feeds` row for today from a canned candidate set,
without spending any YouTube quota. The page picks it up on the next load. For a
one-off hand-seed without the worker, insert a row with the secret key:

```bash
curl -X POST "$SUPABASE_URL/rest/v1/shorts_feeds" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY" \
  -H "Content-Type: application/json" -H "Prefer: resolution=merge-duplicates" \
  -d '{"feed_date":"2026-07-20","region":"US","items":[ ... ]}'
```

## Notes

- `shorts_feeds` is one row per day, pruned to the last N days by the scheduled
  worker (Phase 4). The page reads today's row and falls back to the newest, so a
  missing morning shows yesterday's dozen with an honest date label rather than
  an empty page. Pruning only happens *after* a new row lands, so the table can
  never be emptied.
- `dozen_worker_status` is one row, forever — the `check (id = 1)` is what keeps
  it that way. `schema.sql` seeds it, so re-applying the file never clobbers a
  live heartbeat. It is public to read on purpose: the page's staleness story is
  that a visitor's browser can tell "stale because it's 6 AM" from "stale because
  the Pi is down", and it can only do that if it's allowed to ask. Keep the
  columns boring — `last_error` in particular is world-readable, which is why the
  worker truncates it to one short line and the page never renders it.
- The free tier pauses a project after ~1 week of inactivity. From Phase 3 on,
  the worker's daily uploads count as activity for the whole shared project, so
  Ride Report and Daily Dozen keep each other awake. `dozen_worker_status`'s
  `last_run_at` is the cheapest confirmation the Pi is still writing.
