# Ride Report — Supabase

The data plane the rest of the project pivots on. Two tables, two policies, and
one rule worth internalising: **RLS is the only thing protecting this data.**
The page ships the publishable key in plain JavaScript, so every guarantee here
is a policy in `schema.sql`, not a secret.

| File | Job |
|---|---|
| `schema.sql` | Tables, constraints, RLS policies, `updated_at` trigger, Realtime publication. Re-runnable. |
| `verify-rls.mjs` | Proves the policies hold, from outside the browser. |

## Applying

Paste `schema.sql` into the SQL editor, or `psql "$SUPABASE_DB_URL" -f schema.sql`.

Every statement is idempotent — `create ... if not exists`, `drop policy if
exists` before each `create policy`, constraints dropped and re-added. Editing a
policy and re-running the whole file is the intended workflow, not a migration
event. Nothing in it drops data.

## The dashboard steps SQL can't do

1. **Auth → disable new signups**, after creating your own account. The schema is
   multi-tenant-shaped, but the project is a single tenant until you decide
   otherwise.
2. **Auth → URL Configuration → Redirect URLs.** `sendMagicLink()` asks to come
   back to the exact page it was called from. If that URL isn't listed, Supabase
   silently redirects to the project's Site URL instead and the session looks
   like it vanished. Both spellings of the page are reachable, so list both —
   whichever one you didn't add is the one you'll hit:

   ```
   https://<user>.github.io/Adams-Lair/projects/ride-report/index.html
   https://<user>.github.io/Adams-Lair/projects/ride-report/
   ```

   A trailing `*` wildcard on the directory covers both if you prefer.
3. **Project Settings → API Keys**: the publishable key goes in
   `../supabase-config.js`. The secret key goes in the Pi's `.env` and nowhere
   else — it bypasses RLS entirely, and this repo is public.

## Verifying

```bash
node verify-rls.mjs                                  # anon checks only
SUPABASE_SERVICE_KEY=sb_secret_... node verify-rls.mjs   # seeds first; run on the Pi
```

Without the secret key it can only check that anonymous callers see nothing —
which is trivially true when there is nothing to see. With it, the script seeds
a trip, a trip report and a daily report first, so each "sees nothing" assertion
has something real to fail to see, then cleans up after itself.

## Getting a first daily report

The Phase 3 worker is the supported way in:

```bash
cd ../worker && MOCK_SYNTH=1 node run-scheduled.js
```

That writes a real row with `source='fallback'` and canned prose, without
spending any Claude quota. The page picks it up on the next load.

## Notes

- `reports` is append-only. The page reads the newest row per kind; the worker
  only ever inserts. There are no insert/update/delete policies for anyone,
  because the only writer holds the secret key and bypasses RLS.
- The free tier pauses a project after ~1 week of inactivity. From Phase 3 on,
  the worker's uploads count as activity.
