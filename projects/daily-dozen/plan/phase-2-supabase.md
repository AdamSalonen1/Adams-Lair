# Phase 2 — Supabase read path

**Deliverable:** The page renders today's dozen from a real Supabase row instead
of `feed.sample.json`. A hand-seeded row is enough to prove it end to end; the Pi
that writes rows for real is Phase 3.

## Schema — `supabase/schema.sql`

Idempotent and RLS-first, in the exact style of
[ride-report/supabase/schema.sql](../../ride-report/supabase/schema.sql).

```sql
create table if not exists shorts_feeds (
  feed_date    date primary key,
  generated_at timestamptz not null default now(),
  region       text not null default 'US',
  items        jsonb not null            -- the frozen Phase-1 item shape
);
alter table shorts_feeds enable row level security;

-- World-readable: trending Shorts are public, nothing here is anyone's business
-- to hide. No insert/update/delete policy for any role — the Pi writes with the
-- secret key, which bypasses RLS.
drop policy if exists "read feeds" on shorts_feeds;
create policy "read feeds" on shorts_feeds
  for select to anon, authenticated using (true);
```

Contrast with Ride Report on purpose: there, `reports` splits public/owner-only
because a trip narrative leaks whereabouts. Here every row is public, so the
policy is a plain `using (true)` — and that difference is worth a comment in the
file so nobody "hardens" it into uselessness later.

## Read path

- `supabase-config.js` — copy Ride Report's: the publishable (anon) URL + key,
  safe to commit, with the loud comment that the secret key never appears here.
- `feed.js` — reimplement `loadFeed()` over the plain-REST `publicRead()` pattern
  from [ride-report/supabase.js](../../ride-report/supabase.js). Ask for today's
  row by `feed_date`; if absent, fall back to newest by `order=feed_date.desc`.
  Same return shape as Phase 1, so `app.js` doesn't change.

```
shorts_feeds?feed_date=eq.<today>&select=feed_date,generated_at,region,items&limit=1
shorts_feeds?select=feed_date,generated_at,region,items&order=feed_date.desc&limit=1
```

- Keep `feed.sample.json` as an offline fallback / dev seed; a query param or a
  blank config drops back to it, mirroring Ride Report's degrade-to-Phase-1 move.

## Exit criteria

- Page renders from a hand-seeded `shorts_feeds` row via the publishable key.
- Anon can read the feed and **only** the feed (RLS verified — no writes, no other
  tables), the way [ride-report/supabase/verify-rls.mjs](../../ride-report/supabase/verify-rls.mjs)
  checks its policies.
- Missing-today falls back to the newest row and the UI labels the date ("Friday's
  dozen") so a stale feed is honest, not silent.
- Blanking `supabase-config.js` degrades cleanly to `feed.sample.json`.
