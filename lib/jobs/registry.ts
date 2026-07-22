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
 * SCHEDULE SEMANTICS: each entry names its daily UTC fire slot(s) on a
 * half-hour boundary (minuteUTC ∈ {0, 30}). Slot matching (not exact-minute
 * matching) makes dispatch robust to Vercel firing a cron a few minutes late
 * — see dueJobs() in lib/jobs/dispatch.ts. The 06:00/06:30/07:00 slots are
 * EXACTLY the three pre-S2 vercel.json schedules; the S3 maintenance jobs
 * occupy the 07:30 slot the paid-tier cron expression ("0,30 6-7 * * *")
 * already fires — S3 adds NO vercel.json entry. A job that repeats INTRADAY
 * sets hourUTC to an ARRAY of fire hours (all on the one minuteUTC slot): one
 * registry entry, one health report, N daily fires — CH-3 sync-crypto fires at
 * [0, 6, 12, 18]. vercel.json must trigger the dispatcher at every slot any
 * entry lists (CH-3 restored the paid-tier multi-slot cron off the Hobby tier).
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
 * S4 (2026-07-07): notification-retry — the F16 outbox consumer
 * (jobs/retry-notifications.ts) — registered on the 07:30 slot, sequenced
 * AFTER notification-cleanup so freshly aged-out notifications are never
 * re-mailed.
 *
 * CH-3 (2026-07-14): sync-crypto registered — the BTC wallet sweep, every 6
 * hours ([0, 6, 12, 18] UTC via the multi-slot hourUTC array; see SCHEDULE
 * SEMANTICS), expectedEveryHours:6 so the dead-job detector tracks the
 * 6-hourly cadence for free. Unlocked by the Vercel plan upgrade off Hobby
 * (sub-daily cron now permitted); vercel.json restores the paid-tier
 * multi-slot schedule. The stale "deferred — R7" ruling for sync-crypto is
 * retired: jobs/sync-crypto.ts was always production-ready — only the schedule
 * was gated, and the tier that gated it is gone.
 *
 * DELIBERATELY NOT HERE (S0 rulings): dead-job detection (S5) ·
 * run-ai-advice, take-snapshot (v2.6b / deferred — R7).
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
  /**
   * Daily fire hour(s), UTC. A single number fires once daily; an array fires
   * once at each listed hour (all on the same minuteUTC slot) — the intraday
   * repeat shape (CH-3 sync-crypto: [0, 6, 12, 18]). dueJobs() matches either.
   */
  hourUTC: number | number[];
  /** Fire minute — half-hour slots only (the dispatch matching granularity). */
  minuteUTC: 0 | 30;
  /**
   * Expected cadence for dead-job detection (OPS-4 S5, lib/jobs/health.ts).
   * Optional — absent means daily (every current job). Read ONLY by the
   * health check; the dispatcher never consults it.
   */
  expectedEveryHours?: number;
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
  // A8-3A — daily historical security-price fetch, grouped with fetch-fx-rates
  // as the other external daily-value-series fetch. VENDOR-GATED: no-op (returns
  // "no-provider" before any DB work) until a licensed price vendor is wired into
  // lib/prices/registry.ts (A8-3B, externally blocked). Idempotent and safe to
  // re-run — a day already covered (incl. by A8-2 same-day capture) is skipped.
  {
    name: "fetch-security-prices",
    hourUTC: 6,
    minuteUTC: 30,
    run: async () => (await import("@/jobs/fetch-security-prices")).fetchSecurityPrices(),
  },
  // CH-3 — BTC wallet balance sweep, every 6 hours (00/06/12/18 UTC via the
  // multi-slot hourUTC array). The 06:00 tick co-tenants with sync-banks /
  // fetch-fx-rates (the dispatcher ledgers each job per-slot individually, so
  // co-tenancy is fine). expectedEveryHours:6 lets ops_job_health flag a
  // stalled sweep for free. Idempotent + never-throws (jobs/sync-crypto.ts →
  // syncAllBtcWallets); the job body also regenerates wealth history for the
  // wallets it synced (the regen step the 965e0bd route wiring anticipated for
  // this cron path). Enabled by the Vercel plan upgrade off Hobby.
  {
    name: "sync-crypto",
    hourUTC: [0, 6, 12, 18],
    minuteUTC: 0,
    expectedEveryHours: 6,
    run: async () => (await import("@/jobs/sync-crypto")).syncCrypto(),
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
  // S4 — the NotificationDelivery outbox consumer (bounded attempts;
  // claim-first duplicate-send prevention). MUST stay after
  // notification-cleanup in this slot: cleanup first, then retry, so an
  // aged-out notification is closed as obsolete rather than re-mailed.
  {
    name: "notification-retry",
    hourUTC: 7,
    minuteUTC: 30,
    run: async () => (await import("@/jobs/retry-notifications")).retryNotifications(),
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
  // OPS-5 S5 — the alert-evaluation pass. Rides the 07:30 slot (already covered
  // by the single dispatcher cron — no vercel.json change), sequenced LAST so it
  // reads the freshest state after the 06:00/06:30 sync/fx jobs. Consumes the
  // existing job-health / connection-health / resource-freshness authorities and
  // emails the operator (OPS-1) on any breach; its own JobRun row is the alert
  // history + suppression store. Never throws (evaluatePlatformAlerts is
  // best-effort), so the alerter can never itself become a failing job.
  {
    name: "evaluate-alerts",
    hourUTC: 7,
    minuteUTC: 30,
    run: async () => (await import("@/jobs/evaluate-alerts")).evaluateAlerts(),
  },
];
