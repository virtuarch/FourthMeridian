/**
 * jobs/scheduler.ts
 *
 * Background job scheduler. Runs inside the Next.js server process via
 * instrumentation.ts (or a standalone Node process in Docker).
 *
 * NOTE: startScheduler() is not yet invoked anywhere (no instrumentation.ts
 * hook exists in this project). Wiring up that entrypoint is a separate,
 * pre-existing gap that predates and is independent of the Plaid sync work
 * below — purgeTrash() has the same "registered but never started" status.
 * Until that's wired up, scheduled jobs are reachable only by calling
 * startScheduler() (or the individual job functions) explicitly, e.g. from a
 * one-off script or a future cron-triggered API route.
 *
 * Jobs:
 *  - sync-banks:    every 4 hours — incremental Plaid /transactions/sync for
 *                    every active PlaidItem (see jobs/sync-banks.ts)
 *  - sync-crypto:   every hour    (stub)
 *  - take-snapshot: daily at 00:05 local time
 *  - run-ai-advice: twice on trading days, once on weekends
 *  - purge-trash:   daily at 01:00 — permanently deletes goals trashed > 7 days ago
 */

import { purgeTrash } from "./purge-trash";
import { syncBanks } from "./sync-banks";

// Lightweight cron-style scheduler using setInterval.
// Replace with node-cron or BullMQ for production resilience.

const MINUTE = 60_000;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

function scheduleDaily(fn: () => Promise<void>, hourUTC: number, minuteUTC = 5) {
  function msUntilNext() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUTC, minuteUTC, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    setTimeout(async () => {
      try { await fn(); } catch (e) { console.error("[scheduler]", e); }
      setInterval(async () => {
        try { await fn(); } catch (e) { console.error("[scheduler]", e); }
      }, DAY);
    }, msUntilNext());
  }

  schedule();
}

/** Runs `fn` after `initialDelayMs`, then repeatedly every `intervalMs`. */
function scheduleInterval(fn: () => Promise<unknown>, intervalMs: number, initialDelayMs = 0) {
  setTimeout(async () => {
    try { await fn(); } catch (e) { console.error("[scheduler]", e); }
    setInterval(async () => {
      try { await fn(); } catch (e) { console.error("[scheduler]", e); }
    }, intervalMs);
  }, initialDelayMs);
}

export function startScheduler() {
  // Purge trashed goals older than 7 days — runs daily at 01:00 UTC
  scheduleDaily(purgeTrash, 1, 0);

  // Sync Plaid transactions for every active item — every 4 hours, starting
  // 1 minute after the scheduler boots (avoids contending with cold-start work).
  scheduleInterval(syncBanks, 4 * HOUR, MINUTE);

  console.log("[scheduler] Started — trash purge (01:00 UTC daily), bank sync (every 4h) registered");
}
