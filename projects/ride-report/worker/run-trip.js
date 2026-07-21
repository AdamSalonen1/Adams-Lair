#!/usr/bin/env node
// Entry point for one trip's synthesis. Invoked by the Realtime listener as a
// child process, and usable by hand:
//
//   node run-trip.js --trip <uuid>
//   node run-trip.js --trip <uuid> --dry-run
//   node run-trip.js --trip <uuid> --today 2026-08-01   # horizon testing
//
// The listener spawns this under `flock` rather than calling runTrip() in
// process, so that the file lock — not a JavaScript variable — is what stops
// the listener and the systemd timer from synthesizing at the same time. One
// mechanism, both paths, and it keeps working if a third caller ever appears.
//
// Exit codes, deliberately NOT the same as run-scheduled.js's:
//   0  report written as intended — a Claude narrative, or a placeholder for a
//      trip beyond the horizon (which is a correct outcome, not a degraded one)
//   1  nothing written — weather or DB failure
//   2  report written from the deterministic fallback because Claude failed

import { loadEnv } from './db.js';
import { runTrip } from './pipeline.js';

function parseArgs(argv) {
  const args = { tripId: null, dryRun: false, today: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--trip') args.tripId = argv[++i];
    else if (arg === '--today') args.today = argv[++i];
    else if (arg.startsWith('--trip=')) args.tripId = arg.slice(7);
    else if (arg.startsWith('--today=')) args.today = arg.slice(8);
  }
  return args;
}

async function main() {
  const { tripId, dryRun, today } = parseArgs(process.argv.slice(2));
  if (!tripId) throw new Error('usage: node run-trip.js --trip <uuid> [--dry-run] [--today YYYY-MM-DD]');

  await loadEnv();

  const startedAt = new Date();
  console.log(`[trip] starting ${tripId} at ${startedAt.toISOString()}${dryRun ? ' (dry run)' : ''}`);

  const { row, source, degraded, placeholder, skipped } = await runTrip(tripId, { dryRun, today });

  const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  if (skipped) {
    console.log(`[trip] done in ${elapsed}s — skipped (${skipped})`);
    return 0;
  }

  const how = placeholder ? 'placeholder' : source;
  console.log(`[trip] done in ${elapsed}s — ${how} row=${row?.id ?? '(none)'}`);

  return degraded ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[trip] FAILED — no report written: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
