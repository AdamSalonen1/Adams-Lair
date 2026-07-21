#!/usr/bin/env node
// Entry point for the systemd timer. One job: discover today's dozen and upsert
// it, then write the heartbeat.
//
// Exit codes are the contract with systemd:
//   0  a fresh dozen was written (DOZEN_SIZE items)
//   1  nothing written (API or DB failure) — yesterday's row still stands
//   2  written but degraded — fewer than DOZEN_SIZE survived the filter on a
//      thin day. The row lands so the page stays useful, but `systemctl status`
//      shows red so a persistent shortfall is visible rather than silent.
//
// Every run writes the heartbeat, INCLUDING failures — that's what lets the page
// (Phase 4) tell "not fetched yet this morning" from "the Pi is down".

import { loadConfig, todayInZone } from './config.js';
import { discoverDozen } from './youtube.js';
import { loadEnv, upsertFeed, recordHeartbeat, pruneFeeds } from './db.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

// Stamped once, up here, so success and failure report the same start time — and
// so the failure path has one even when main() threw before computing anything.
const ranAt = new Date().toISOString();

async function main() {
  await loadEnv();
  const config = loadConfig();
  const now = new Date();
  const today = todayInZone(config.feedTimezone, now);

  console.log(
    `[run] starting ${ranAt}${dryRun ? ' (dry run)' : ''}${config.mock ? ' (mock)' : ''}`
    + ` — feed_date=${today}, region=${config.region}, target=${config.dozenSize}, cutoff=${config.maxDurationSec}s`,
  );

  const { items, stats, quotaUnits } = await discoverDozen(config, {
    apiKey: process.env.YOUTUBE_API_KEY,
    now,
  });

  const droppedNote = Object.entries(stats.dropped).map(([r, n]) => `${r}:${n}`).join(', ') || 'none';
  console.log(
    `[run] ${stats.candidates} candidate(s) -> ${stats.survived} survived -> kept ${stats.kept}`
    + ` (dropped: ${droppedNote}); ~${quotaUnits} quota units`,
  );

  // Zero survivors is a failed fetch, not a degraded one: writing an empty feed
  // would blank the page. Leave yesterday's row standing and exit 1.
  if (!items.length) throw new Error('no videos survived the filter — nothing to write');

  const generatedAt = new Date().toISOString();
  if (!dryRun) {
    const row = await upsertFeed({ feedDate: today, region: config.region, items, generatedAt });
    console.log(`[run] upserted shorts_feeds for ${row?.feed_date ?? today} with ${items.length} item(s)`);
    // Only after a row has landed this run — the invariant that keeps prune from
    // ever emptying the table (see pruneFeeds).
    await pruneFeeds({ keepDays: config.retentionDays, today });
  } else {
    console.log(`[run] dry run — would have written ${items.length} item(s) for ${today}`);
  }

  const degraded = items.length < config.dozenSize;
  return {
    code: degraded ? 2 : 0,
    okAt: dryRun ? null : generatedAt,
    itemCount: items.length,
    error: degraded ? `thin day: only ${items.length} of ${config.dozenSize} survived the filter` : null,
  };
}

// Two handlers on one .then(), not .then().catch(): chaining a .catch() would
// also catch a throw from the success handler, whose first act after a good run
// must not be miscounted as a failure. This way the failure path is reachable
// only from main() itself failing.
main().then(
  async ({ code, okAt, itemCount, error }) => {
    if (!dryRun) await recordHeartbeat({ ranAt, okAt, itemCount, error });
    if (error) console.warn(`[run] degraded: ${error}`);
    console.log(`[run] done — exit ${code}`);
    return code;
  },
  async (err) => {
    // Nothing was written. Log plainly; the next tick retries.
    console.error(`[run] FAILED — no feed written: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    // Still writes a heartbeat — with no okAt, so last_ok_at keeps pointing at
    // the last run that worked and the gap since is the outage length. This is
    // the case the whole table exists for; skipping it would leave the page's
    // status green throughout an outage.
    if (!dryRun) await recordHeartbeat({ ranAt, error: err });
    return 1;
  },
).then((code) => process.exit(code));
