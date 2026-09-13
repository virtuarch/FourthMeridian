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
 * SEMANTICS); the dead-job detector derives the 6-hourly expectation from
 * those slots (lib/jobs/cadence.ts). Unlocked by the Vercel plan upgrade off Hobby
 * (sub-daily cron now permitted); vercel.json restores the paid-tier
 * multi-slot schedule. The stale "deferred — R7" ruling for sync-crypto is
 * retired: jobs/sync-crypto.ts was always production-ready — only the schedule
 * was gated, and the tier that gated it is gone.
 *
 * UNIFIED WALLET REFRESH (2026-09-13): sync-crypto sweeps EVERY syncable wallet
 * (BTC, ETH, SOL and any chain the sync registry can read) through
 * lib/crypto/wallet-refresh.ts, not Bitcoin only; sync-crypto-continuation at :30
 * finishes anything its work budget deferred.
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

import type { RefreshSourceKind } from "@/lib/platform/refresh-policy.core";

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
   * Optional — absent means DERIVED from the fire slots (lib/jobs/cadence.ts
   * slotPeriodHours: once daily → 24, [0,6,12,18] → 6), so no entry has to
   * restate its own schedule. Set it only for a job whose expectation differs
   * from its slots. Read ONLY by the health check; the dispatcher never
   * consults it.
   */
  expectedEveryHours?: number;
  /**
   * PLATFORM OPS POLICIES (Slice 1) — the source kind this job REFRESHES, when
   * it is a refresh job. This binding is what lets scheduler capability be
   * DERIVED ("wallets are attempted every 6 hours because the job bound to
   * WALLET fires at [0,6,12,18]") instead of hand-copied into a constant, and
   * what lets job health carry the source's refresh policy beside the job's
   * own attempt expectation.
   */
  refreshes?: RefreshSourceKind;
  /**
   * The primary job this entry finishes deferred work for. A continuation is
   * the SAME refresh opportunity 30 minutes later, never an opportunity of its
   * own — capability derivation excludes it, so the :30 slot can never be
   * mistaken for a 30-minute cadence.
   */
  continuationOf?: string;
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
    refreshes: "BANK",
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
  // CH-3 — the wallet sweep, every 6 hours (00/06/12/18 UTC via the multi-slot
  // hourUTC array). The 06:00 tick co-tenants with sync-banks / fetch-fx-rates
  // (the dispatcher ledgers each job per-slot individually, so co-tenancy is
  // fine). Its 6-hourly health expectation is DERIVED from those slots, and its
  // `refreshes: "WALLET"` binding is what scheduler capability derives the
  // wallet attempt period from. Idempotent + never-throws; the job body also
  // regenerates wealth history for the wallets it synced (the regen step the
  // 965e0bd route wiring anticipated for this cron path). Enabled by the Vercel
  // plan upgrade off Hobby.
  {
    name: "sync-crypto",
    hourUTC: [0, 6, 12, 18],
    minuteUTC: 0,
    refreshes: "WALLET",
    run: async () => (await import("@/jobs/sync-crypto")).syncCrypto(),
  },
  {
    // The wallet sweep's continuation: wallets the :00 run's work budget deferred.
    // The :30 ticks of these hours already fire (vercel.json). The sweep skips
    // wallets not yet due, so with nothing deferred this run is one query.
    // `continuationOf` keeps it OUT of the attempt period: it is the same
    // opportunity, 30 minutes on, not a 30-minute cadence.
    name: "sync-crypto-continuation",
    hourUTC: [0, 6, 12, 18],
    minuteUTC: 30,
    refreshes: "WALLET",
    continuationOf: "sync-crypto",
    run: async () => (await import("@/jobs/sync-crypto")).syncCrypto({ continuation: true }),
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
  // W2 — the goals purge arm was deleted with the Goals retirement (cascades
  // own goal-row cleanup; no surface can trash a goal). The registration stays
  // because scheduler/ops/health surfaces reference the job by name; each run
  // is an honest no-op until a future trash-retention arm lands.
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
