// Daily Dozen — discovery. The only file that talks to the YouTube Data API.
//
// A search, a hydrate, then a filter and a rank:
//   1. search.list  — recent + high-view short-form candidates (100 units/page;
//                     SEARCH_PAGES pages, so the English filter has slack)
//   2. videos.list  — the real metadata for those IDs (1 unit, batched)
//   3. filter       — keep only what will embed AND reads as English/American:
//                     a playable Short, in-region, and not in another language
//                     (regionCode/relevanceLanguage on the search are only biases,
//                     so the hard language gate is here). See filterReason.
//   4. rank         — by view *velocity*, so a 6-hour rocket beats a 2-day-old
//                     video with more lifetime views; take the top dozen
//
// The filter/rank/shape are pure functions of their inputs (no clock, no
// network) so test-youtube.js can pin "now" and exercise every branch. The I/O
// adds what the browser never needs: timeouts and a bounded retry, so a dead
// network fails fast and loud instead of hanging a systemd unit.

import { readFile } from 'node:fs/promises';
import { isoHoursAgo } from './config.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 3;
const VIDEOS_BATCH = 50; // videos.list caps at 50 ids per call

// ===== Pure core: parse, filter, rank, shape =====

/**
 * ISO 8601 duration (`PT1M5S`, `PT59S`, `PT2M`) to whole seconds, or null if it
 * doesn't parse. Days/weeks never appear on a video, so H/M/S is enough.
 */
export function parseDurationSec(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

/**
 * Whether a hydrated video is worth putting on the page, and if not, why. The
 * "why" is for the run's log and the dropped-reason tally, not for anyone's
 * eyes but the journal.
 *
 * A non-embeddable video is a dead tile. Over-long biases away from true Shorts
 * (the API has no isShort flag). Age-restricted won't play in an embed anyway,
 * and a region block means it won't play *here*. Off-language means it isn't for
 * this feed's audience — see the two language signals below.
 */
export function filterReason(video, { maxDurationSec, region, relevanceLanguage = 'en', requireLatinTitle = true } = {}) {
  if (!video || !video.id) return 'no-id';
  if (video.status?.embeddable !== true) return 'not-embeddable';

  const duration = parseDurationSec(video.contentDetails?.duration);
  if (duration == null) return 'no-duration';
  if (duration > maxDurationSec) return 'too-long';

  if (video.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') return 'age-restricted';

  const rr = video.contentDetails?.regionRestriction;
  if (rr && region) {
    if (Array.isArray(rr.blocked) && rr.blocked.includes(region)) return 'region-blocked';
    if (Array.isArray(rr.allowed) && !rr.allowed.includes(region)) return 'region-blocked';
  }

  // Aim the feed at an English-speaking (American) audience. Two signals, because
  // neither alone is enough: search.list's regionCode/relevanceLanguage are only
  // biases, so globally-viral non-English Shorts still arrive on raw view count.
  //   1. If the video *declares* a language and it isn't ours, drop it. Precise,
  //      but most Shorts leave defaultAudioLanguage/defaultLanguage unset.
  //   2. If the title is written mostly in a non-Latin script, drop it. Blunt,
  //      but it catches the Hindi/CJK/etc. content that (1) misses for lack of
  //      metadata — which is exactly what was dominating the feed.
  const want = (relevanceLanguage || 'en').toLowerCase().split('-')[0];
  const declared = (video.snippet?.defaultAudioLanguage || video.snippet?.defaultLanguage || '')
    .toLowerCase().split('-')[0];
  if (want && declared && declared !== want) return 'lang-mismatch';
  if (requireLatinTitle && isNonLatinTitle(video.snippet?.title)) return 'non-latin-title';

  return null; // keep it
}

/**
 * Whether a title is written predominantly in a non-Latin script (Devanagari,
 * CJK, Arabic, Cyrillic, …). Only *letters* count, so digits, punctuation, and
 * emoji don't sway it — an emoji-heavy English title still reads as Latin. A
 * title with no letters at all (pure emoji/numbers) can't be judged and is
 * treated as Latin: we drop only on positive evidence of another script, never
 * on absence of one.
 */
export function isNonLatinTitle(title) {
  if (typeof title !== 'string') return false;
  const letters = title.match(/\p{Letter}/gu) || [];
  if (!letters.length) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length < 0.5;
}

/**
 * View velocity: lifetime views over hours since publication, floored at one
 * hour so a video that went up minutes ago can't divide its way to infinity.
 * The whole point of ranking on this rather than raw views is recency — a
 * trending feed should feel like *today*, not an all-time leaderboard.
 */
export function velocity(video, now = Date.now()) {
  const views = Number(video.statistics?.viewCount);
  const published = Date.parse(video.snippet?.publishedAt ?? '');
  if (!Number.isFinite(views) || !Number.isFinite(published)) return 0;
  const hours = Math.max(1, (now - published) / 3_600_000);
  return views / hours;
}

/** A hydrated video to the frozen Phase-1 feed item shape — only the fields the page reads. */
export function toItem(video) {
  return {
    video_id: video.id,
    title: video.snippet?.title ?? '',
    channel_title: video.snippet?.channelTitle ?? '',
    published_at: video.snippet?.publishedAt ?? null,
    duration_sec: parseDurationSec(video.contentDetails?.duration),
    view_count: Number.isFinite(Number(video.statistics?.viewCount)) ? Number(video.statistics.viewCount) : null,
  };
}

/**
 * Filter, rank by velocity, take the top `dozenSize`, and shape into feed items.
 * Returns the items plus a stats block the run logs and the heartbeat stores:
 * how many candidates came in, how many survived the filter, how many were kept,
 * and a tally of why the rest were dropped.
 *
 * `survived < dozenSize` is the "thin day" the exit-code contract calls degraded:
 * the row still lands with what there is, honestly short rather than padded.
 */
export function selectDozen(videos, config, now = Date.now()) {
  const dropped = {};
  const survivors = [];

  for (const video of videos ?? []) {
    const reason = filterReason(video, config);
    if (reason) { dropped[reason] = (dropped[reason] || 0) + 1; continue; }
    survivors.push(video);
  }

  survivors.sort((a, b) => velocity(b, now) - velocity(a, now));
  const kept = survivors.slice(0, config.dozenSize);

  return {
    items: kept.map(toItem),
    stats: {
      candidates: (videos ?? []).length,
      survived: survivors.length,
      kept: kept.length,
      dropped,
    },
  };
}

// ===== I/O =====

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'request' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep raw text for the error */ }

    if (!res.ok) {
      // The Data API returns { error: { message, errors: [{ reason }] } }. The
      // reason ('quotaExceeded', 'keyInvalid', ...) is the part worth surfacing
      // at 6:30 AM, so pull it out of the body rather than just the status.
      const reason = json?.error?.errors?.[0]?.reason;
      const message = json?.error?.message || text.slice(0, 200);
      throw new Error(`${label} failed: HTTP ${res.status}${reason ? ` [${reason}]` : ''} — ${message}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(fn, { attempts = DEFAULT_ATTEMPTS, label = 'request' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A quota or key error will fail identically on every retry — don't burn
      // three attempts (and three log lines) on something that cannot recover.
      if (/\[(quotaExceeded|keyInvalid|forbidden|badRequest)\]/.test(err.message)) throw err;
      if (i < attempts) {
        const waitMs = 2000 * i;
        console.warn(`[youtube] ${label} attempt ${i}/${attempts} failed (${err.message}); retrying in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

/**
 * search.list — recent, high-view, short-form candidate IDs. `order=viewCount`
 * within a `publishedAfter` window is what surfaces *trending short-form*;
 * chart=mostPopular is dominated by long-form and surfaces almost no Shorts.
 * 100 quota units per page.
 *
 * Pulls up to `config.searchPages` pages (50 IDs each). One page is plenty of
 * raw candidates for a dozen, but the English filter downstream can cut a global
 * view-sorted page down hard, so a second page keeps the dozen from going thin.
 *
 * A `q` term is required, not optional: search.list with no query returns zero
 * rows however it's ordered (verified against the live API). `config.searchQuery`
 * ('#shorts' by default) anchors it to short-form; the filter and velocity rank
 * below do the actual curation.
 *
 * @returns {Promise<{ids: string[], pages: number}>} deduped IDs and how many
 *   pages were actually fetched (fewer than requested if the results ran out) —
 *   the caller needs the page count to bill quota honestly.
 */
export async function searchShortIds(config, { apiKey, now = new Date() } = {}) {
  const ids = new Set();
  let pageToken;
  let pages = 0;

  do {
    const url = new URL(`${API_BASE}/search`);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('q', config.searchQuery);
    url.searchParams.set('videoDuration', 'short');
    url.searchParams.set('order', 'viewCount');
    url.searchParams.set('publishedAfter', isoHoursAgo(config.publishedWithinHours, now));
    url.searchParams.set('regionCode', config.region);
    url.searchParams.set('relevanceLanguage', config.relevanceLanguage);
    url.searchParams.set('maxResults', String(config.searchMaxResults));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('key', apiKey);

    const data = await withRetry(() => fetchJson(url, { label: 'search.list' }), { label: 'search.list' });
    pages += 1;
    for (const it of data.items ?? []) {
      const id = it.id?.videoId;
      if (typeof id === 'string' && id) ids.add(id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken && pages < config.searchPages);

  return { ids: [...ids], pages };
}

/**
 * videos.list — the real metadata (duration, embeddable, restrictions, stats)
 * for the candidate IDs. Batched at 50; search returns at most 50, so this is
 * one call in practice, but the batching keeps a wider search honest. 1 unit
 * per call.
 */
export async function hydrateVideos(ids, config, { apiKey } = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += VIDEOS_BATCH) {
    const batch = ids.slice(i, i + VIDEOS_BATCH);
    const url = new URL(`${API_BASE}/videos`);
    url.searchParams.set('part', 'contentDetails,status,statistics,snippet');
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('maxResults', String(batch.length));
    url.searchParams.set('key', apiKey);
    const data = await withRetry(() => fetchJson(url, { label: 'videos.list' }), { label: 'videos.list' });
    out.push(...(data.items ?? []));
  }
  return out;
}

/** The canned candidate set for MOCK_YOUTUBE — videos.list-shaped, so it runs the real filter/rank. */
async function loadMockCandidates() {
  const raw = await readFile(new URL('./mock/videos.sample.json', import.meta.url), 'utf8');
  return JSON.parse(raw);
}

/**
 * The whole discovery pipeline: candidates -> hydrate -> filter -> rank -> items.
 * Returns `{ items, stats, quotaUnits }`. `MOCK_YOUTUBE` swaps the two API calls
 * for a canned candidate set and spends no quota, so the full filter/rank/upsert
 * path runs on any machine without a key.
 */
export async function discoverDozen(config, { apiKey, now = new Date() } = {}) {
  if (config.mock) {
    const candidates = await loadMockCandidates();
    console.log(`[youtube] MOCK_YOUTUBE — ${candidates.length} canned candidate(s), no quota spent`);
    return { ...selectDozen(candidates, config, now.getTime()), quotaUnits: 0 };
  }

  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not set (see .env.example) — discovery has no client-only fallback');

  const { ids, pages } = await searchShortIds(config, { apiKey, now });
  console.log(`[youtube] search.list returned ${ids.length} candidate id(s) across ${pages} page(s)`);
  if (!ids.length) return { items: [], stats: { candidates: 0, survived: 0, kept: 0, dropped: {} }, quotaUnits: 100 * pages };

  const videos = await hydrateVideos(ids, config, { apiKey });
  const quotaUnits = 100 * pages + Math.ceil(ids.length / VIDEOS_BATCH); // search 100/page + 1/hydrate batch
  return { ...selectDozen(videos, config, now.getTime()), quotaUnits };
}
