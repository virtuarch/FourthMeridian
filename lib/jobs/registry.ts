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
 *
 * …BUT NOT BUNDLE-LIGHT (PERF-1). A dynamic import is free at Node module load,
 * yet webpack compiles every import() target into the compilation of whatever
 * route reaches this file. So this module is the EXECUTABLE registry, and
 * importing it puts the whole jobs tree (Plaid SDK included) into the
 * importer's routes. Code that only needs to know WHAT is scheduled and WHEN
 * should read lib/jobs/registry.core.ts, which holds the facts this file
 * composes; the shared request path (auth, session, platform settings,
 * scheduler capability) MUST — lib/jobs/registry-boundary.test.ts enforces it.
 *
 * ONE AUTHORITY: names, slots, `refreshes` and `continuationOf` live ONLY in
 * registry.core.ts. This file adds exactly one body per name, and JOB_BODIES
 * is typed over ScheduledJobName — a missing or an unknown name is a compile
 * error, so the two halves cannot drift.
 */

import {
  SCHEDULED_JOB_FACTS,
  type ScheduledJobFacts,
  type ScheduledJobName,
} from "@/lib/jobs/registry.core";

export type { ScheduledJobFacts, ScheduledJobName } from "@/lib/jobs/registry.core";

/** One scheduled unit of work: its facts (registry.core.ts) plus its body. */
export interface ScheduledJob extends ScheduledJobFacts {
  /** The job body. Result becomes the JobRun summary (counts/kinds/IDs only). */
  run: () => Promise<unknown>;
}

// ── The bodies ───────────────────────────────────────────────────────────────
//
// Registered bodies MUST be idempotent and safe to re-run. Key order mirrors
// SCHEDULED_JOB_FACTS for readability; execution order comes from the facts.

const JOB_BODIES: { readonly [N in ScheduledJobName]: ScheduledJob["run"] } = {
  "sync-banks": async () => (await import("@/jobs/sync-banks")).syncBanks(),
  "fetch-fx-rates": async () => (await import("@/jobs/fetch-fx-rates")).fetchFxRates(),
  // A8-3A — VENDOR-GATED: no-op (returns "no-provider" before any DB work)
  // until a licensed price vendor is wired into lib/prices/registry.ts (A8-3B,
  // externally blocked). Idempotent and safe to re-run — a day already covered
  // (incl. by A8-2 same-day capture) is skipped.
  "fetch-security-prices": async () => (await import("@/jobs/fetch-security-prices")).fetchSecurityPrices(),
  // CH-3 — idempotent + never-throws; the body also regenerates wealth history
  // for the wallets it synced (the regen step the 965e0bd route wiring
  // anticipated for this cron path).
  "sync-crypto": async () => (await import("@/jobs/sync-crypto")).syncCrypto(),
  // The continuation runs the SAME body; the sweep skips wallets not yet due,
  // so with nothing deferred this run is one query.
  "sync-crypto-continuation": async () => (await import("@/jobs/sync-crypto")).syncCrypto({ continuation: true }),
  "process-deletions": async () => (await import("@/jobs/process-deletions")).processDeletions(),
  // OPS-3 S6 retention, relocated off the process-deletions tail. Isolation
  // comes from the dispatcher's per-job try/catch: a cleanup failure is its own
  // failed JobRun and can never touch the purge run.
  "notification-cleanup": async () => (await import("@/lib/notifications/cleanup")).cleanupNotifications(),
  // S4 — the NotificationDelivery outbox consumer (bounded attempts;
  // claim-first duplicate-send prevention).
  "notification-retry": async () => (await import("@/jobs/retry-notifications")).retryNotifications(),
  // W2 — the goals purge arm was deleted with the Goals retirement. The
  // registration stays because scheduler/ops/health surfaces reference the job
  // by name; each run is an honest no-op until a future trash-retention arm lands.
  "purge-trash": async () => (await import("@/jobs/purge-trash")).purgeTrash(),
  // Bounds the RateLimit table (OPS-4 investigation §4.6).
  "rate-limit-sweep": async () => (await import("@/jobs/sweep-rate-limits")).sweepRateLimits(),
  // OPS-5 S5 — never throws (evaluatePlatformAlerts is best-effort), so the
  // alerter can never itself become a failing job. Its own JobRun row is the
  // alert history + suppression store.
  "evaluate-alerts": async () => (await import("@/jobs/evaluate-alerts")).evaluateAlerts(),
};

// ── The registry ─────────────────────────────────────────────────────────────

/** The facts, in their order, each with its body. Built once: closures are stable. */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = SCHEDULED_JOB_FACTS.map(
  (facts) => ({ ...facts, run: JOB_BODIES[facts.name] }),
);
