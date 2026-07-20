// Daily Dozen — where the day's feed comes from. Nothing here touches the DOM.
//
// Phase 1: the feed is a committed sample file. Phase 2 reimplements the *body*
// of loadFeed() over Supabase's plain-REST read (the publicRead() pattern in
// ride-report/supabase.js) — the signature and the returned shape do not move,
// which is the whole reason app.js never learns where its dozen came from.

const SAMPLE_URL = './feed.sample.json';

/**
 * The day's feed, or null if there isn't one to show. Never throws — a missing
 * or malformed feed is a calm empty state, not a broken page. The finiteness of
 * the app depends on `items` being exactly what gets rendered, so this is also
 * where a feed is sanity-checked into a shape the UI can trust.
 *
 * @returns {Promise<null | {feed_date: string, generated_at?: string, region?: string, items: Array}>}
 */
export async function loadFeed() {
  try {
    const res = await fetch(SAMPLE_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return normalizeFeed(await res.json());
  } catch (err) {
    console.warn('Daily Dozen: could not load the feed —', err);
    return null;
  }
}

/**
 * Keep only items with a usable video id, and only the fields the UI reads.
 * A feed with no valid items is treated as no feed at all: better a clean
 * "nothing today" than a player pointed at nothing.
 */
function normalizeFeed(feed) {
  if (!feed || !Array.isArray(feed.items)) return null;

  const items = feed.items
    .filter((it) => it && typeof it.video_id === 'string' && it.video_id.trim())
    .map((it) => ({
      video_id: it.video_id.trim(),
      title: typeof it.title === 'string' ? it.title : '',
      channel_title: typeof it.channel_title === 'string' ? it.channel_title : '',
      duration_sec: Number.isFinite(it.duration_sec) ? it.duration_sec : null,
      view_count: Number.isFinite(it.view_count) ? it.view_count : null,
      published_at: typeof it.published_at === 'string' ? it.published_at : null,
    }));

  if (!items.length) return null;

  return {
    feed_date: typeof feed.feed_date === 'string' ? feed.feed_date : null,
    generated_at: typeof feed.generated_at === 'string' ? feed.generated_at : null,
    region: typeof feed.region === 'string' ? feed.region : null,
    items,
  };
}
