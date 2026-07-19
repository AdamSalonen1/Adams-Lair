#!/usr/bin/env node
// Long-running daemon: watch `trips` over Supabase Realtime, synthesize on
// change.
//
// The Pi stays outbound-only. This is a WebSocket the Pi *opens* to Supabase —
// there is no inbound port, no webhook, no tunnel, and nothing to expose to the
// internet. That constraint is the whole reason this is a daemon rather than an
// HTTP endpoint.
//
// Two rules keep it sane, and everything else here is in service of them:
//
//   1. Debounce per trip. Five edits in ten seconds must produce one Claude
//      run, not five. Each trip id waits DEBOUNCE_MS of quiet before it fires.
//      The Pro usage window is shared with interactive Claude Code sessions;
//      burning it on superseded edits is rude to your future self.
//
//   2. Single-flight. This process and the systemd timer are separate programs
//      that must never synthesize concurrently, so the pipeline runs as a child
//      process under `flock` on a shared lockfile rather than in-process. A
//      file lock is the only mechanism that can coordinate two processes; a
//      variable in here would coordinate nothing.
//
// The in-process queue is a second, narrower guard: it stops this process from
// spawning ten children that all sit blocked on the same lock.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

import { loadEnv, tripsNeedingSynthesis } from './db.js';
import { nowInZone } from './openmeteo.js';
import { DEFAULT_LOCATION } from './pipeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_TRIP = path.join(HERE, 'run-trip.js');

const DEBOUNCE_MS = Number(process.env.LISTENER_DEBOUNCE_MS || 5_000);
const LOCK_FILE = process.env.RIDE_LOCK_FILE || '/run/lock/ride-report.lock';
const FLOCK = process.env.FLOCK_PATH || '/usr/bin/flock';
// How long a run will wait for the lock. Comfortably longer than a scheduled
// run takes, so a collision means "wait your turn", not "give up".
const LOCK_WAIT_S = Number(process.env.LISTENER_LOCK_WAIT_S || 600);
// Backstop for a child that wedges in a way its own timeouts don't catch —
// without this, one stuck run silently stops the queue forever.
const CHILD_TIMEOUT_MS = Number(process.env.LISTENER_CHILD_TIMEOUT_MS || 900_000);

function log(...parts) {
  console.log(`[listener ${new Date().toISOString()}]`, ...parts);
}

function logError(...parts) {
  console.error(`[listener ${new Date().toISOString()}]`, ...parts);
}

// ===== Queue =====
//
// `debouncing` holds trips still absorbing edits; `queue` holds trips ready to
// run. A Set, so a trip edited again while it sits in the queue collapses to
// one run — and a trip edited while its run is *in flight* correctly earns a
// second one, because it re-enters the queue behind the running job.

const debouncing = new Map();
const queue = new Set();
let draining = false;
let shuttingDown = false;

function scheduleTrip(tripId, reason) {
  const existing = debouncing.get(tripId);
  if (existing) {
    clearTimeout(existing);
    log(`trip ${tripId} — ${reason}, debounce restarted`);
  } else {
    log(`trip ${tripId} — ${reason}, firing in ${DEBOUNCE_MS}ms`);
  }

  debouncing.set(tripId, setTimeout(() => {
    debouncing.delete(tripId);
    enqueue(tripId);
  }, DEBOUNCE_MS));
}

/** Skip the debounce — for trips already known to be stale. */
function enqueue(tripId) {
  queue.add(tripId);
  drain();
}

async function drain() {
  if (draining || shuttingDown) return;
  draining = true;

  try {
    while (queue.size && !shuttingDown) {
      const tripId = queue.values().next().value;
      queue.delete(tripId);
      await synthesizeTrip(tripId);
    }
  } finally {
    draining = false;
  }
}

/**
 * Run the pipeline for one trip, as a child process under flock.
 *
 * `-w` rather than the timer's `-n`: a scheduled run that skips because the
 * lock is held simply happens on the next tick three hours later, but an edit
 * that skips is an outlook the rider never gets. So this one waits.
 */
function synthesizeTrip(tripId) {
  return new Promise((resolve) => {
    const args = [
      '-w', String(LOCK_WAIT_S),
      LOCK_FILE,
      process.execPath, RUN_TRIP, '--trip', tripId,
    ];

    log(`trip ${tripId} — running (waiting up to ${LOCK_WAIT_S}s for the lock)`);
    const startedAt = Date.now();

    const child = spawn(FLOCK, args, {
      cwd: HERE,
      // Inheriting stdio puts the child's own [trip]/[pipeline] lines straight
      // into this unit's journal, so one `journalctl -u` tells the whole story.
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      logError(`trip ${tripId} — child exceeded ${CHILD_TIMEOUT_MS}ms, killing it`);
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);

    const finish = (note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      log(`trip ${tripId} — ${note} after ${elapsed}s`);
      resolve();
    };

    child.on('error', (err) => {
      logError(`trip ${tripId} — could not spawn: ${err.message}`);
      finish('spawn failed');
    });

    child.on('close', (code) => {
      // Never rethrown: one trip failing must not take down the daemon or stall
      // the queue behind it. The exit code is the whole story, and it's logged.
      if (code === 0) finish('done');
      else if (code === 2) finish('done, but degraded to the fallback narrative (exit 2)');
      else if (code === 1) finish('FAILED — nothing written (exit 1)');
      else finish(`exited ${code}`);
    });
  });
}

// ===== Gap fill =====

/**
 * Events that fire while the socket is down are gone — Realtime does not replay
 * them. So on every (re)subscribe, ask the database the question the socket
 * would have answered: which trips have been edited more recently than their
 * newest report? Those are exactly the events that were missed.
 *
 * This also covers the cold start, where every trip that has never been
 * synthesized looks stale and correctly gets queued.
 */
async function gapFill(reason) {
  const today = nowInZone(DEFAULT_LOCATION.timezone).slice(0, 10);

  try {
    const stale = await tripsNeedingSynthesis(today);
    if (!stale.length) {
      log(`gap-fill (${reason}): nothing stale`);
      return;
    }

    log(`gap-fill (${reason}): ${stale.length} trip(s) behind — ${stale.map((t) => t.title).join(', ')}`);
    for (const trip of stale) enqueue(trip.id);
  } catch (err) {
    // A failed sweep is not fatal: the scheduled run is the second safety net,
    // and the next reconnect sweeps again.
    logError(`gap-fill (${reason}) failed: ${err.message}`);
  }
}

// ===== Realtime =====

function handleTripChange(payload) {
  const { eventType, new: row, old } = payload;

  if (eventType === 'DELETE') {
    // Nothing to do: the FK cascade took its reports with it.
    log(`trip ${old?.id ?? '(unknown)'} deleted — reports cascaded, nothing to synthesize`);
    return;
  }

  if (!row?.id) {
    logError(`${eventType} event with no row id — ignoring`);
    return;
  }

  // Note there is no feedback loop to guard against here: synthesis writes to
  // `reports`, never to `trips`, so nothing this daemon does can re-trigger it.
  scheduleTrip(row.id, eventType.toLowerCase());
}

async function main() {
  await loadEnv();

  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url) throw new Error('SUPABASE_URL is not set (see .env.example)');
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set (see .env.example)');

  log(`starting — watching trips at ${url}`);
  log(`debounce=${DEBOUNCE_MS}ms lock=${LOCK_FILE} lockWait=${LOCK_WAIT_S}s`);

  const supabase = createClient(url, key, {
    // A daemon has no browser storage and no user to refresh a token for. The
    // secret key is the identity, and it does not expire.
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const channel = supabase
    .channel('trips-watch')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'trips' },
      handleTripChange,
    )
    .subscribe((status, err) => {
      // Boring logs are the goal: every state change gets a timestamped line so
      // a week of silence reads as a week of health, not a week of ambiguity.
      log(`channel status: ${status}${err ? ` — ${err.message}` : ''}`);

      if (status === 'SUBSCRIBED') {
        // Both the first subscribe and every reconnect land here, which is
        // exactly when the missed-events question needs asking.
        gapFill(status.toLowerCase());
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // supabase-js reconnects with backoff on its own; Restart=always
        // backstops the case where the process itself is what died.
        logError(`channel ${status} — waiting for supabase-js to reconnect`);
      }
    });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — shutting down`);

    for (const timer of debouncing.values()) clearTimeout(timer);
    debouncing.clear();

    try {
      await supabase.removeChannel(channel);
    } catch (err) {
      logError(`could not close the channel cleanly: ${err.message}`);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logError(`FAILED to start: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
