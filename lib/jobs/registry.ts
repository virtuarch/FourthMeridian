/**
 * lib/jobs/registry.ts  (OPS-4 S2 · S3)
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
 * minutes late — see dueJobs() in lib/jobs/dispatch.ts. The 06:00/06:30/
 * 07:00 slots are EXACTLY the three pre-S2 vercel.json schedules; the S3
 * maintenance jobs occupy the 07:30 slot the existing cron expression
 * ("0,30 6-7 * * *") already fires — S3 adds NO vercel.json entry.
 *
 * ADDING A JOB = adding an entry here (plus its vercel.json slot if it needs
 * a new fire time). Registered bodies MUST be idempotent and safe to re-run
 * — the standing house discipline (every current body documents it).
 * Multiple jobs in one slot run sequentially, each isolated, each its own
 * JobRun row.
 *
 * S3 (2026-07-07): notification cleanup relocated OFF the process-deletions
 * tail into its own registration (exactly as the OPS-3 headers promised);
 * process-deletions is single-purpose again. purge-trash runs for the first
 * time in production (7-day goal-trash retention promise now true).
 * rate-limit-sweep bounds the RateLimit table (rows were never deleted
 * anywhere). DEFERRED WITH REASONS (see OPS4_S3_CLOSEOUT): digests (no
 * template, no frequency preference, no already-digested marker — design +
 * schema surface, not a registration) · snapshot cadence (stale-balance
 * semantics unresolved: the daily sync refreshes transactions, not
 * balances — a scheduled snapshot would stamp stale balances as fresh
 * daily facts).
 *
 * DELIBERATELY NOT HERE (S0 rulings): notification retry (S4) · dead-job
 * detection (S5) · run-ai-advice, sync-crypto, take-snapshot (v2.6b /
 * deferred — R7).
 *
 * IMPORT-LIGHT BY DESIGN: job bodies are dynamic-imported inside each run()
 * — never at module load. Several bodies transitively import provider
 * modules that validate env at import time (lib/plaid/client.ts throws
 * without PLAID_CLIENT_ID), so a static import would make the registry —
 * and therefore the dispatcher and its unit tests — unloadable in any
 * credential-free context.
 */

/** One daily scheduled unit of work. */
export interface ScheduledJob {
  /** JobRun ledger name — must stay stable (pre/post ledger comparison). */
  name: string;
  /** Daily fire hour, UTC. */
  hourUTC: number;
  /** Fire minute — half-hour slots only (the dispatch matching granularity). */
  minuteUTC: 0 | 30;
  /** The job body. Result becomes the JobRun summary (counts/kinds/IDs only). */
  run: () => Promise<unknown>;
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
  // Pre-S2 slot: vercel.json "0 7 * * *". Single-purpose since S3 — the
  // OPS-3 notification-cleanup tail moved to its own 07:30 registration.
  {
    name: "process-deletions",
    hourUTC: 7,
    minuteUTC: 0,
    run: async () => (await import("@/jobs/process-deletions")).processDeletions(),
  },
  // ── S3 maintenance slot (07:30 — already covered by the single cron) ──────
  // OPS-3 S6 retention, relocated off the process-deletions tail (the move
  // both file headers promised). Isolation now comes from the dispatcher's
  // per-job try/catch instead of an inline non-fatal wrapper: a cleanup
  // failure is its own failed JobRun and can never touch the purge run.
  {
    name: "notification-cleanup",
    hourUTC: 7,
    minuteUTC: 30,
    run: async () => (await import("@/lib/notifications/cleanup")).cleanupNotifications(),
  },
  // First production scheduling ever — makes the 7-day goal-trash retention
  // promise true (dormant since the v1.0 scheduler that never ran).
  {
    name: "purge-trash",
    hourUTC: 7,
    minuteUTC: 30,
    run: async () => (await import("@/jobs/purge-trash")).purgeTrash(),
  },
  // Bounds the RateLimit table (rows were never deleted anywhere — OPS-4
  // investigation §4.6).
  {
    name: "rate-limit-sweep",
    hourUTC: 7,
    minuteUTC: 30,
    run: async () => (await import("@/jobs/sweep-rate-limits")).sweepRateLimits(),
  },
];
