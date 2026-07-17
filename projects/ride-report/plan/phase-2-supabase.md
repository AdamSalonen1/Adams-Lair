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

## RLS

- `reports`: **anon SELECT** (public read). Writes only via service role
  (bypasses RLS) — no anon/authed insert policy at all.
- `trips`: anon SELECT, **authenticated** INSERT/UPDATE/DELETE.
  - ⚠️ Decision to confirm: public trip reads mean visitors can see when
    you're away from home. If that's uncomfortable, restrict trips SELECT to
    authenticated and have the page hide the trips section when logged out.
    Default in this plan: public read (it's a personal site; your call).
- `updated_at` maintained by a trigger (`moddatetime` extension or a 3-line
  trigger function).

## Auth (single user)

- Supabase email magic-link auth; disable signups after creating the one
  account (Dashboard → Auth → disable new user signups).
- Page gets a small, unobtrusive login (footer link → email field). Session
  persists via supabase-js; logged-in state reveals the trip add/edit UI.

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
- Trips section: list upcoming trips (+ their reports when they exist);
  add/edit/delete behind auth.

## Exit criteria

- [ ] `schema.sql` applies cleanly to a fresh project
- [ ] A hand-inserted `reports` row renders on the page with correct staleness
- [ ] Trip CRUD works from the page (phone included) when logged in
- [ ] Logged out: writes fail (verify RLS actually blocks, don't trust the UI)
- [ ] Anon key in page source grants nothing beyond intended SELECTs

## Notes

- Free tier pauses projects after ~1 week of inactivity. From Phase 3 on, the
  worker's uploads count as activity; until then, opening the page does.
  Revisit in Phase 5.
