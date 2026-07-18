#!/usr/bin/env node
// Entry point for the systemd timer.
//
// Exit codes are the contract with systemd:
//   0  report written from Claude
//   1  nothing written (weather or DB failure) — previous report still stands
//   2  report written, but from the deterministic fallback
//
// 2 is deliberately non-zero: the row landed, so the page stays useful, but
// `systemctl status` should show the run as failed so a persistent Claude
// outage is visible rather than silently degrading forever.

import { loadEnv } from './db.js';
import { runDaily } from './pipeline.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

async function main() {
  await loadEnv();

  const startedAt = new Date();
  console.log(`[run] starting ${startedAt.toISOString()}${dryRun ? ' (dry run)' : ''}`);

  const { row, source, degraded } = await runDaily({ dryRun });

  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`[run] done in ${elapsed}s — source=${source} row=${row?.id ?? '(none)'}`);

  return degraded ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Nothing was written. Log the reason plainly; the next tick retries.
    console.error(`[run] FAILED — no report written: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
