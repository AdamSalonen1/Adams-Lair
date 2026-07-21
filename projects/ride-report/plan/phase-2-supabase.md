# Phase 2 — Supabase Data Plane

**Goal:** stand up the database the whole system pivots on. After this phase the
page can *read* synthesized reports (manually inserted for now) and Adam can
*write* trips from the page. No Pi, no LLM yet.

## Setup

- Create a free-tier Supabase project (pick the closest US region).
- Keep the **service role key off this machine's repo entirely** — it goes in the
  Pi's `.env` in Phase 3. The **anon key is public by design** and ships in
  page JS; RLS is what protects the data.
- Save the schema as `projects/ride-report/supabase/schema.sql` in the repo so
  the project is reproducible.

## Schema

```sql
create table trips (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id)
                  on delete cascade default auth.uid(),
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

create table reports (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('daily', 'trip')),
  trip_id      uuid references trips (id) on delete cascade,
  generated_at timestamptz not null default now(),
  source       text not null check (source in ('claude', 'fallback')),
  payload      jsonb not null
);

create index reports_daily_latest on reports (kind, generated_at desc);
create index reports_by_trip on reports (trip_id, generated_at desc);
```

`payload` shape (produced by the worker, rendered by the page):

```json
{
  "day_score": 82,
  "summary": "prose narrative...",
  "windows": [{"start": "...", "end": "...", "avgScore": 85}],
  "mud": {"risk": "damp", "weightedPrecip": 0.22},
  "model": {"name": "...", "duration_ms": 0}
}
```

Trip reports use the same envelope plus per-day entries for multi-day trips.

## RLS (multi-tenant-shaped, single user today)

**Settled design (2026-07-17):** trips are owner-scoped and reports split by
kind. This closes the "visitors can see when you're away" leak now, and makes
friends-scale multi-user a signup toggle later instead of a migration.

- `trips`: owner-only, all operations. No anon policy at all — logged-out
  visitors get empty rows, not errors.

  ```sql
  create policy "own trips" on trips for all
    using (user_id = auth.uid()) with check (user_id = auth.uid());
  ```

- `reports`: daily reports public; **trip reports visible only to the trip's
  owner**. This split is load-bearing — trip narratives carry the same
  dates/locations that hiding `trips` protects, so a blanket public read on
  `reports` would leak everything through the back door.

  ```sql
  create policy "read reports" on reports for select
    using (
      kind = 'daily'
      or exists (
        select 1 from trips t
        where t.id = reports.trip_id and t.user_id = auth.uid()
      )
    );
  ```

  Writes only via service role (bypasses RLS) — no insert/update policies
  for anon or authenticated at all.
- `updated_at` maintained by a trigger (`moddatetime` extension or a 3-line
  trigger function).

## Auth (multi-tenant shape, one tenant)

- Supabase email magic-link auth. Create Adam's account, then disable new
  signups (Dashboard → Auth → disable new user signups).
- supabase-js manages per-browser sessions (JWT + refresh) automatically —
  there is nothing to build for "different users have different sessions";
  that's just how it works.
- `trips.user_id` defaults to `auth.uid()`, so page insert code never sets
  ownership explicitly.
- Page gets a small, unobtrusive login (footer link → email field). Session
  persists via supabase-js; logged-in state reveals the trip add/edit UI.
- **Friends-scale later** = re-enable signups; schema and policies already
  hold. Deliberately out of scope until then: per-user home locations (the
  daily report is Adam's), and note that synthesizing other users' trips
  draws on Adam's Pro usage window — a genuinely public multi-user version
  moves synthesis to an API key first (see Phase 3 notes).

## Realtime (prep for Phase 4, do it now)

Enable the Realtime publication on `trips`:

```sql
alter publication supabase_realtime add table trips;
```

## Page changes

- Add `@supabase/supabase-js` (CDN ESM import — no build step on this site).
- On load, fetch latest `daily` report:
  - `generated_at` < 4 h old → render narrative prominently, score alongside
  - 4–24 h old → render with a visible "report from {time}" staleness badge
  - missing/older → client-side Phase 1 score only (which renders regardless —
    the narrative is an enhancement layer, never the page's spine)
- Trips section renders only when a session exists. RLS is the enforcement
  (anon queries return empty rows regardless); hiding the section is just
  tidiness, not security.

## Exit criteria

- [ ] `schema.sql` applies cleanly to a fresh project
- [ ] A hand-inserted daily `reports` row renders on the page with correct
      staleness
- [ ] Trip CRUD works from the page (phone included) when logged in
- [ ] Anon (curl with the anon key, not just the UI): zero `trips` rows, zero
      `kind='trip'` reports, daily reports readable, trip writes rejected
- [ ] Logged in: own trips and their reports visible; the trips section
      appears only with a session

## Notes

- Free tier pauses projects after ~1 week of inactivity. From Phase 3 on, the
  worker's uploads count as activity; until then, opening the page does.
  Revisit in Phase 5.
