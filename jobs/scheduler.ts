/**
 * jobs/scheduler.ts
 *
 * Background job scheduler. Runs inside the Next.js server process via
 * instrumentation.ts (or a standalone Node process in Docker).
 *
 * Jobs:
 *  - sync-banks:    every 4 hours (stub until Plaid integration is wired)
 *  - sync-crypto:   every hour    (stub)
 *  - take-snapshot: daily at 00:05 local time
 *  - run-ai-advice: twice on trading days, once on weekends
 *  - purge-trash:   daily at 01:00 — permanently deletes goals trashed > 7 days ago
 */

import { purgeTrash } from "./purge-trash";

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

export function startScheduler() {
  // Purge trashed goals older than 7 days — runs daily at 01:00 UTC
  scheduleDaily(purgeTrash, 1, 0);

  console.log("[scheduler] Started — trash purge registered (01:00 UTC daily)");
}
