/**
 * lib/jobs/registry.ts  (OPS-4 S2)
 *
 * THE typed registry of scheduled background jobs — the successor to the
 * retired jobs/scheduler.ts intent table (S2 retirement decision:
 * docs/initiatives/ops4/OPS4_S2_DISPATCHER_CLOSEOUT.md). The dispatcher
 * (lib/jobs/dispatch.ts, invoked by the single Vercel cron at
 * app/api/jobs/dispatch/route.ts) selects due entries from this table and
 * executes each through runJob().
 *
 * SCHEDULE SEMANTICS: each entry names one daily UTC fire slot on a
 * half-hour boundary (hourUTC + minuteUTC ∈ {0, 30}). Slot matching (not
 * exact-minute matching) makes dispatch robust to Vercel firing a cron a few
 * minutes late — see dueJobs() in lib/jobs/dispatch.ts. The slots below are
 * EXACTLY the three pre-S2 vercel.json schedules; S2 changes orchestration,
 * never timing.
 *
 * ADDING A JOB = adding an entry here (plus its vercel.json slot if it needs
 * a new fire time). Registered bodies MUST be idempotent and safe to re-run
 * — the standing house discipline (every current body documents it).
 *
 * DELIBERATELY NOT HERE (S0 rulings; S2 scope): purge-trash / RateLimit
 * sweep / snapshot cadence / digests (S3) · notification retry (S4) ·
 * dead-job detection (S5) · run-ai-advice, sync-crypto (v2.6b — R7).
 *
 * IMPORT-LIGHT BY DESIGN: job bodies are dynamic-imported inside each run()
 * — never at module load. Several bodies transitively import provider
 * modules that validate env at import time (lib/plaid/client.ts throws
 * without PLAID_CLIENT_ID), so a static import would make the registry —
 * and therefore the dispatcher and its unit tests — unloadable in any
 * credential-free context. Type-only imports below are erased at compile.
 */

import type { ProcessDeletionsResult } from "@/jobs/process-deletions";
import type { NotificationCleanupResult } from "@/lib/notifications/cleanup";

/** One daily scheduled unit of work. */
export interface ScheduledJob {
  /** JobRun ledger name — must stay stable across S2 (pre/post comparison). */
  name: string;
  /** Daily fire hour, UTC. */
  hourUTC: number;
  /** Fire minute — half-hour slots only (the dispatch matching granularity). */
  minuteUTC: 0 | 30;
  /** The job body. Result becomes the JobRun summary (counts/kinds/IDs only). */
  run: () => Promise<unknown>;
}

// ── process-deletions composed body ──────────────────────────────────────────
//
// The whole scheduled unit of work — account purge + the OPS-3 S6
// notification-retention tail — as ONE body, so the ledger records what the
// schedule actually does (S1 shape preserved: one "process-deletions" JobRun).
// Single definition site: the dispatcher and the fallback route
// (app/api/jobs/process-deletions) both run THIS function.
//
// The cleanup tail stays best-effort/non-fatal and keeps riding this job
// (S0 ruling R4; OPS-3 F7): a cleanup failure never fails the purge run. It
// relocates to its own registration in S3, not before.

export interface ProcessDeletionsRunResult {
  deletions: ProcessDeletionsResult;
  notificationCleanup: NotificationCleanupResult | { error: string };
}

export async function runProcessDeletions(): Promise<ProcessDeletionsRunResult> {
  const { processDeletions } = await import("@/jobs/process-deletions");
  const { cleanupNotifications } = await import("@/lib/notifications/cleanup");

  const deletions = await processDeletions();

  // OPS-3 S6 — notification retention (best-effort tail; never fails the run).
  let notificationCleanup: NotificationCleanupResult | { error: string };
  try {
    notificationCleanup = await cleanupNotifications();
  } catch (err) {
    console.error("[process-deletions] notification cleanup failed (non-fatal):", err);
    notificationCleanup = { error: err instanceof Error ? err.message : String(err) };
  }

  return { deletions, notificationCleanup };
}

// ── The registry ─────────────────────────────────────────────────────────────

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  // Pre-S2 slot: vercel.json "0 6 * * *"
  {
    name: "sync-banks",
    hourUTC: 6,
    minuteUTC: 0,
    run: async () => (await import("@/jobs/sync-banks")).syncBanks(),
  },
  // Pre-S2 slot: vercel.json "30 6 * * *"
  {
    name: "fetch-fx-rates",
    hourUTC: 6,
    minuteUTC: 30,
    run: async () => (await import("@/jobs/fetch-fx-rates")).fetchFxRates(),
  },
  // Pre-S2 slot: vercel.json "0 7 * * *"
  { name: "process-deletions", hourUTC: 7, minuteUTC: 0, run: runProcessDeletions },
];
