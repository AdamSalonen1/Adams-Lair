-- Daily Dozen — Supabase data plane (Phase 2)
--
-- Apply in the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f schema.sql
--
-- Re-runnable on purpose: every statement is idempotent, so tweaking a policy
-- and re-applying the whole file is a normal thing to do, not a migration
-- event. Nothing here drops data.
--
-- Where this lives: the free tier caps a Supabase org at two projects, so this
-- schema is applied INTO the existing Ride Report project rather than one of its
-- own. Everything below is namespaced to Daily Dozen's own objects — a
-- `shorts_feeds` table and a `dozen_worker_status` heartbeat — and touches none
-- of Ride Report's `trips` / `reports` / `worker_status`. That co-tenancy is the
-- one reason the heartbeat here is NOT the shared `worker_status` row: two
-- workers writing the same single-row table would each clobber the other's
-- "is the Pi alive" answer. See dozen_worker_status below.
--
-- The security model in one paragraph: RLS is the only thing protecting this
-- data. The page ships the publishable (anon) key in plain JavaScript, because
-- that key is public by design — it names the project, it does not grant access.
-- Both tables here are world-readable, on purpose: trending Shorts are public,
-- non-personal content, and the heartbeat says nothing about anyone's
-- whereabouts. Writes happen only with the secret (service_role) key on the Pi,
-- which bypasses RLS; there is deliberately no insert/update/delete policy for
-- anyone else.

-- ===== The feed =====
--
-- One row per calendar day, keyed by `feed_date`. The page asks for today's row
-- and falls back to the newest, so a stable "today", a free history for a later
-- "yesterday's dozen" view, and a clean idempotent upsert all fall out of the
-- primary key. `items` is the frozen Phase-1 item shape, stored verbatim:
--   [{ video_id, title, channel_title, published_at, duration_sec, view_count }]

create table if not exists shorts_feeds (
  feed_date    date primary key,
  generated_at timestamptz not null default now(),
  region       text not null default 'US',
  items        jsonb not null            -- the frozen Phase-1 item shape
);

alter table shorts_feeds enable row level security;

comment on table shorts_feeds is
  'One trending-Shorts feed per day (feed_date PK). World-readable: nothing here is private. Written only by the Pi worker with the secret key.';
comment on column shorts_feeds.items is
  'The frozen Phase-1 item array: [{ video_id, title, channel_title, published_at, duration_sec, view_count }]. Every item is embeddable and within the duration cutoff — the worker filters before it writes.';

-- World-readable: trending Shorts are public, and nothing here is anyone's
-- business to hide. This is a deliberate contrast with Ride Report, where
-- `reports` splits public/owner-only because a trip narrative leaks whereabouts.
-- Here every row is public, so the policy is a plain `using (true)` — do not
-- "harden" it into a filter, there is nothing here to scope a read to.
--
-- No insert/update/delete policy for any role. The Pi writes with the secret
-- key, which bypasses RLS. If you ever find yourself adding a write policy here,
-- the page has started doing something the Pi should be doing.
drop policy if exists "read feeds" on shorts_feeds;
create policy "read feeds" on shorts_feeds
  for select to anon, authenticated using (true);

-- ===== Worker heartbeat =====
--
-- A twin of Ride Report's `worker_status`, kept under its own name because both
-- projects share one Postgres database (see the header). One row, forever — the
-- `id = 1` check is what makes that true rather than merely intended: a stray
-- curl or the worker's own create-if-missing path would otherwise be one typo
-- from a second row, and "what is the worker's status" would stop having one
-- answer. The page reads this with `limit 1` and no ordering, which is only
-- correct because the constraint holds.
--
-- This exists so the page (Phase 4) can tell two silences apart. A feed that is
-- from yesterday because it's 6 AM and the timer hasn't fired yet is normal. The
-- same stale feed with no successful run behind it means the Pi is down.
-- `shorts_feeds` alone cannot distinguish those; a row that says "I tried" can.
--
-- Every scheduled run writes here, INCLUDING the ones that fail. A heartbeat
-- that only beats when things go well reads as healthy right up until the
-- machine is dead.

create table if not exists dozen_worker_status (
  id                  smallint primary key default 1 check (id = 1),
  last_run_at         timestamptz,
  last_ok_at          timestamptz,
  last_error          text,
  last_item_count     smallint            -- how many survived the filter last time
);

alter table dozen_worker_status enable row level security;

-- Seed the singleton so a plain PATCH works and the page has something to read
-- before the worker's first run. Idempotent: re-applying this file never
-- clobbers a live heartbeat.
insert into dozen_worker_status (id) values (1) on conflict (id) do nothing;

comment on table dozen_worker_status is
  'Single-row heartbeat for the Daily Dozen Pi worker. Separate from Ride Report''s worker_status because both share one database. Written by every run, successful or not. World-readable — keep it free of anything private.';
comment on column dozen_worker_status.last_run_at is
  'Start of the most recent scheduled run, whatever became of it. This is the "is the Pi alive" field.';
comment on column dozen_worker_status.last_ok_at is
  'Last time a feed row actually landed. Left untouched by a failed run, so the gap since is the length of the outage.';
comment on column dozen_worker_status.last_error is
  'Why the last run was not clean, truncated to one short line by the worker. PUBLIC — the page deliberately never renders it; it is here for curl and journalctl.';
comment on column dozen_worker_status.last_item_count is
  'How many videos survived the filter on the last run. A number below the dozen size flags a thin day without the page having to re-read the feed.';

-- Public to read, secret-key-only to write. Public on purpose: the whole point
-- is that a visitor's browser can tell "stale because it's 6 AM" from "stale
-- because the Pi is down", and it can only do that if it is allowed to ask.
drop policy if exists "read dozen worker status" on dozen_worker_status;
create policy "read dozen worker status" on dozen_worker_status
  for select to anon, authenticated using (true);

-- No insert/update/delete policies, for any role — same reasoning as
-- shorts_feeds. The worker writes with the secret key.
