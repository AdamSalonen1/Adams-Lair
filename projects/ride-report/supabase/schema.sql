-- Ride Report — Supabase data plane (Phase 2)
--
-- Apply in the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f schema.sql
--
-- Re-runnable on purpose: every statement is idempotent, so tweaking a policy
-- and re-applying the whole file is a normal thing to do, not a migration
-- event. Nothing here drops data.
--
-- The security model in one paragraph: RLS is the only thing protecting this
-- data. The page ships the publishable (anon) key in plain JavaScript, because
-- that key is public by design — it names the project, it does not grant
-- access. `trips` is owner-only. `reports` splits by kind: daily reports are
-- world-readable, trip reports only by the trip's owner. That split is
-- load-bearing — a trip narrative carries the same "he's out of town on these
-- dates" signal that hiding `trips` exists to protect, so a blanket public read
-- on `reports` would leak it right back out. Writes to `reports` happen only
-- with the secret (service_role) key, which bypasses RLS; there is deliberately
-- no insert policy for anyone else.

-- ===== Tables =====

create table if not exists trips (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid()
                  references auth.users (id) on delete cascade,
  title         text not null,
  location_name text not null default 'Fargo, ND',
  lat           double precision not null default 46.8772,
  lon           double precision not null default -96.7898,
  start_date    date not null,
  end_date      date not null,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists reports (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('daily', 'trip')),
  trip_id      uuid references trips (id) on delete cascade,
  generated_at timestamptz not null default now(),
  source       text not null check (source in ('claude', 'fallback')),
  payload      jsonb not null
);

-- A trip that ends before it starts is not a trip, and Phase 4 would happily
-- ask Open-Meteo for a negative date range. Cheaper to make it unrepresentable.
alter table trips drop constraint if exists trips_dates_ordered;
alter table trips add constraint trips_dates_ordered
  check (end_date >= start_date);

-- Keeps `kind` and `trip_id` from disagreeing. This is a security constraint
-- wearing an integrity constraint's clothes: the read policy below hands out
-- every kind='daily' row to the public, so a trip narrative mislabelled
-- 'daily' would be published to the world. Stated as an equivalence, it also
-- rejects the reverse (a kind='trip' row with no owner to scope it to, which
-- nothing could ever read).
--
-- Written as drop-then-add rather than an inline CHECK so it also lands on a
-- project whose tables already exist.
alter table reports drop constraint if exists reports_kind_matches_trip_id;
alter table reports add constraint reports_kind_matches_trip_id
  check ((kind = 'trip') = (trip_id is not null));

create index if not exists reports_daily_latest on reports (kind, generated_at desc);
create index if not exists reports_by_trip on reports (trip_id, generated_at desc);

comment on table trips is
  'Trips Adam is planning. Owner-scoped: never readable by anonymous visitors.';
comment on table reports is
  'Append-only history of synthesized reports. The page reads the newest row; the worker only ever inserts.';
comment on column reports.payload is
  'Worker output: { day_score, summary, headline?, windows[], mud{risk,weightedPrecip}, model{} }. Numbers come from score.js, prose from Claude.';
comment on column reports.source is
  '''claude'' when the narrative came from the model, ''fallback'' when it was generated deterministically from the score data.';

-- ===== updated_at =====
--
-- A local function rather than the moddatetime extension, so this file is
-- self-contained and does not depend on which schema extensions landed in.

create or replace function set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trips_set_updated_at on trips;
create trigger trips_set_updated_at
  before update on trips
  for each row execute function set_updated_at();

-- ===== Row-level security =====
--
-- Enabling RLS is the load-bearing line. Policies without it are decoration:
-- the table stays world-readable and every policy below is silently ignored.

alter table trips enable row level security;
alter table reports enable row level security;

-- Owner-only, all operations. There is deliberately no anon policy: a
-- logged-out visitor querying /trips gets an empty array and HTTP 200, not an
-- error. Table privileges are left at Supabase's defaults for exactly this
-- reason — a REVOKE would turn "nothing to see here" into a 401 that tells a
-- visitor there is something worth hiding.
drop policy if exists "own trips" on trips;
create policy "own trips" on trips
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Daily reports public; trip reports owner-only.
--
-- The EXISTS subquery reads `trips`, which has RLS enabled — so it sees only
-- the caller's own trips anyway. The explicit user_id check is therefore
-- redundant, and kept: this policy should be correct when read on its own, not
-- conditionally correct depending on a policy in another file section.
drop policy if exists "read reports" on reports;
create policy "read reports" on reports
  for select
  to anon, authenticated
  using (
    kind = 'daily'
    or exists (
      select 1 from trips t
      where t.id = reports.trip_id
        and t.user_id = auth.uid()
    )
  );

-- No insert/update/delete policies on `reports`, for any role. The worker
-- writes with the secret key, which bypasses RLS entirely. If you ever find
-- yourself adding one here, the page has started doing something the Pi
-- should be doing.

-- ===== Realtime =====
--
-- `trips` only. The Pi's listener opens a WebSocket to this publication and
-- synthesizes whatever changes.
--
-- `reports` is deliberately NOT published. The page needs to know when a fresh
-- trip outlook lands, and a subscription is the prettier way to learn it — but
-- it would mean putting a table whose entire security story is "trip narratives
-- are owner-only" onto a broadcast channel, and trusting Realtime's RLS
-- handling to keep it that way. The page polls instead, for ninety seconds
-- after a save. That is a worse mechanism and a better trade.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found — skipping Realtime setup';
  elsif not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trips'
  ) then
    alter publication supabase_realtime add table trips;
    raise notice 'trips added to supabase_realtime';
  end if;
end
$$;
