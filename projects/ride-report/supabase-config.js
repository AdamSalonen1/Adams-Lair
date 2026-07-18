// Where this page finds its Supabase project. Fill in both values from
// Dashboard -> Project Settings -> API Keys.
//
// Both are safe to commit to a public repo. The publishable (anon) key is
// public by design: it names the project, it does not grant access. Row-level
// security is what protects the data — see supabase/schema.sql.
//
// The SECRET (service_role) key must NEVER appear in this file, or anywhere
// else in this repo. It bypasses RLS, and GitHub Pages serves whatever is
// committed here verbatim. It lives in the Pi's .env and nowhere else.
//
// Left blank, the page degrades to its Phase 1 self: the client-side score
// still renders, there is just no narrative and no trips.

export const SUPABASE_URL = 'https://itapesopzbqguatkwmjq.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_N17zDgv8yet1PVT6Erepdw_E0POwIpD';
