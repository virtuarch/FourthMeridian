/**
 * lib/jobs/registry.core.ts  (PERF-1 — the scheduling facts, without the bodies)
 *
 * THE single authority for WHAT is scheduled and WHEN: every job's name, its
 * daily UTC fire slot(s), the source kind it refreshes, and the job it is a
 * continuation of. lib/jobs/registry.ts composes these facts with the job
 * bodies into SCHEDULED_JOBS — it never restates a slot, a name or a binding.
 *
 * WHY THIS FILE EXISTS. Scheduler capability ("can the deployed schedule honour
 * a 6-hour wallet cadence?") is asked on the AUTH path: lib/auth.ts →
 * lib/platform-settings.ts → lib/platform/scheduler-capability.ts. Until this
 * split it read SCHEDULED_JOBS from lib/jobs/registry.ts, whose run() thunks
 * dynamic-import every job body. "Dynamic import ⇒ free at module load" is true
 * for Node, but NOT for the bundler: webpack compiles every import() target
 * into the importing route's compilation. So every authenticated route — even
 * /api/spaces — compiled sync-banks, sync-crypto, the Plaid SDK and the rest of
 * the jobs tree (34e592c; measured 54 → 260 app files for /api/spaces). A
 * capability question needs slots, never bodies.
 *
 * IMPORT RULE: type-only imports. Nothing here may import an executable
 * module; lib/jobs/registry-boundary.test.ts walks the closure (static AND
 * dynamic imports, as the bundler does) and fails if a job body, the
 * executable registry, or a provider SDK becomes reachable from the auth path.
 *
 * SCHEDULE SEMANTICS — P1 HUMAN OPERABILITY (2026-10-08). Three things that
 * used to be one are now kept apart:
 *
 *   WAKE        vercel.json wakes the dispatcher every 15 minutes. It decides
 *               nothing; it is infrastructure cadence (lib/jobs/cadence-policy.core.ts
 *               WAKE_EVERY_MINUTES).
 *   EXECUTION   Fourth Meridian decides whether a job is DUE from the JobRun
 *               ledger and a bounded, audited per-job cadence
 *               (lib/jobs/cadence-policy.core.ts). A refresh job's cadence IS the
 *               source kind's refresh policy (refresh_cadence_bank/wallet); fx,
 *               prices and alerts carry their own editable cadence setting; the
 *               maintenance and deletion jobs are FIXED.
 *   ENTITLEMENT what a CUSTOMER may refresh — lib/entitlements, not here.
 *
 * `hourUTC` / `minuteUTC` remain as each job's HISTORICAL daily anchor: they
 * derive its DEFAULT cadence (lib/jobs/cadence.ts slotPeriodHours — once daily
 * → 24h, [0,6,12,18] → 6h) and nothing else. The dispatcher no longer matches
 * them (a wake at any minute may run any due job).
 *
 * ORDER IS EXECUTION ORDER within a wake (the dispatcher runs the due jobs
 * sequentially in registry order) — keep it when editing.
 */

import type { RefreshSourceKind } from "@/lib/platform/refresh-policy.core";

/** Everything a scheduled job declares except its body. */
export interface ScheduledJobFacts {
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
   * the SAME refresh opportunity a little later, never an opportunity of its
   * own — capability derivation excludes it, and the dispatcher runs it only
   * when its primary's newest run reported deferred work.
   */
  continuationOf?: string;
  /**
   * P1 — the OPERATOR-EDITABLE cadence bounds for a job whose cadence is its
   * own PlatformSetting (`job_cadence_hours_<name>`). Code-owned floor and
   * ceiling: the floor is the provider/economic safety bound (an archive that
   * closes daily gains nothing from hourly fetches; an alert pass needs the
   * authorities to have moved). Absent on a FIXED job (maintenance, deletions)
   * and on refresh jobs, whose cadence is the source kind's refresh policy.
   */
  cadence?: { minHours: number; maxHours: number };
}

/**
 * Infers each entry's `name` as a literal (so the executable registry can be
 * typed exhaustively against ScheduledJobName) while keeping every other field
 * exactly ScheduledJobFacts — `as const` would make `hourUTC` a readonly tuple
 * that the SlotFacts consumers do not accept.
 */
function declareJobs<const N extends string>(
  jobs: readonly (ScheduledJobFacts & { name: N })[],
): readonly (ScheduledJobFacts & { name: N })[] {
  return jobs;
}

/** The facts, in registry (= per-slot execution) order. */
export const SCHEDULED_JOB_FACTS = declareJobs([
  // Pre-S2 slot: vercel.json "0 6 * * *"
  { name: "sync-banks", hourUTC: 6, minuteUTC: 0, refreshes: "BANK" },
  // Pre-S2 slot: vercel.json "30 6 * * *"
  { name: "fetch-fx-rates", hourUTC: 6, minuteUTC: 30, cadence: { minHours: 6, maxHours: 168 } },
  // A8-3A — daily historical security-price fetch, grouped with fetch-fx-rates
  // as the other external daily-value-series fetch (vendor-gated no-op until a
  // licensed price vendor is wired).
  { name: "fetch-security-prices", hourUTC: 6, minuteUTC: 30, cadence: { minHours: 6, maxHours: 168 } },
  // CH-3 — the wallet sweep, every 6 hours. Its 6-hourly health expectation is
  // DERIVED from these slots, and `refreshes: "WALLET"` is what scheduler
  // capability derives the wallet attempt period from.
  { name: "sync-crypto", hourUTC: [0, 6, 12, 18], minuteUTC: 0, refreshes: "WALLET" },
  // The wallet sweep's continuation: wallets the :00 run's work budget deferred.
  // `continuationOf` keeps it OUT of the attempt period: it is the same
  // opportunity, 30 minutes on, not a 30-minute cadence.
  {
    name: "sync-crypto-continuation", hourUTC: [0, 6, 12, 18], minuteUTC: 30,
    refreshes: "WALLET", continuationOf: "sync-crypto",
  },
  // Pre-S2 slot: vercel.json "0 7 * * *". Single-purpose since S3.
  { name: "process-deletions", hourUTC: 7, minuteUTC: 0 },
  // ── S3 maintenance slot (07:30 — already covered by the single cron) ──────
  { name: "notification-cleanup", hourUTC: 7, minuteUTC: 30 },
  // S4 — MUST stay after notification-cleanup in this slot: cleanup first, then
  // retry, so an aged-out notification is closed as obsolete rather than re-mailed.
  { name: "notification-retry", hourUTC: 7, minuteUTC: 30 },
  { name: "purge-trash", hourUTC: 7, minuteUTC: 30 },
  { name: "rate-limit-sweep", hourUTC: 7, minuteUTC: 30 },
  // OPS-5 S5 — sequenced LAST so it reads the freshest state of each slot.
  // OPERATIONALIZATION P0 (2026-10-07): every :30 slot the dispatcher already
  // fires (vercel.json "0,30 0,6,7,12,18"), not once daily at 07:30 — a breach
  // is noticed within ~6h instead of up to 24h, and the 20h re-notify window
  // (lib/alerts/evaluate.ts) keeps an ongoing one at about one mail a day.
  // Derived cadence: slotPeriodHours([0,6,7,12,18]) = 6 (the widest gap), so
  // job-health calls it overdue after 8h of silence — honest for a job that
  // never waits longer than 6h between opportunities.
  // P1 — editable down to hourly: the pass is a read over the authorities and a
  // suppressed re-notification, so a tighter cadence costs reads, not mail.
  { name: "evaluate-alerts", hourUTC: [0, 6, 7, 12, 18], minuteUTC: 30, cadence: { minHours: 1, maxHours: 168 } },
]);

/** Every registered job name — the key set lib/jobs/registry.ts must give a body to. */
export type ScheduledJobName = (typeof SCHEDULED_JOB_FACTS)[number]["name"];
