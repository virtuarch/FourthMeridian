/**
 * lib/jobs/cadence-policy.core.ts  (P1 HUMAN OPERABILITY — Platform scheduling control)
 *
 * WHEN SHOULD A JOB RUN NEXT? — Fourth Meridian's EXECUTION POLICY, as a pure
 * resolver over three facts, kept apart from Vercel's WAKE schedule.
 *
 *   wake        vercel.json fires /api/jobs/dispatch every WAKE_EVERY_MINUTES.
 *               Infrastructure. Decides nothing.
 *   cadence     how often THIS job should execute — resolved here:
 *                 REFRESH_POLICY   a refresh job (sync-banks, sync-crypto): the
 *                                  source kind's refresh policy IS its cadence —
 *                                  one knob, never two (refresh_cadence_bank/wallet)
 *                 FOLLOWS_PRIMARY  a continuation: runs after its primary
 *                                  reported deferred work, never on its own clock
 *                 SETTING          an editable job with an override row
 *                                  (job_cadence_hours_<name>, bounded by the
 *                                  registry's code-owned min/max)
 *                 DEFAULT          an editable job with no row: its historical
 *                                  daily anchor's period
 *                 INVALID_SETTING  a row that cannot be read: the default is in
 *                                  force and the view says so
 *                 FIXED            maintenance and deletion jobs: not editable
 *                                  (process-deletions' 24h is legal semantics —
 *                                  the 7-day grace — not an operator preference)
 *   due         from the JobRun ledger: no run yet, or the newest run started at
 *               least (cadence − tolerance) ago. NOT due while a run is in
 *               flight (a `running` row younger than the in-flight window), so
 *               two wakes never execute one job twice.
 *
 * ⚠️ PURE. No I/O, no clock but `now`, type-only imports of the registry facts.
 * The loader (cadence-policy.ts) does the reads; this file is reachable from the
 * auth path through scheduler capability, so it must stay cheap and inert
 * (lib/jobs/registry-boundary.test.ts).
 */

import type { ScheduledJobFacts } from "@/lib/jobs/registry.core";
import { slotPeriodHours } from "@/lib/jobs/cadence";
import type { RefreshPolicy, RefreshSourceKind } from "@/lib/platform/refresh-policy.core";

/** How often Vercel wakes the dispatcher. Infrastructure, mirrored in vercel.json ("*​/15 * * * *"). */
export const WAKE_EVERY_MINUTES = 15;
/** A job is due a little BEFORE its cadence elapses, so a wake 4 minutes early does not push it a whole wake later. */
export const DUE_TOLERANCE_MS = 5 * 60_000;
/** A `running` row younger than this is a live run; older is the documented crash shape. Route maxDuration (300 s) + margin. */
export const IN_FLIGHT_WINDOW_MS = 6 * 60_000;
/** A continuation runs no sooner than this after its primary started. */
export const CONTINUATION_DELAY_MS = 15 * 60_000;
/** The widest bound any editable job may take. */
export const MAX_CADENCE_HOURS = 168;

export const JOB_CADENCE_SETTING_PREFIX = "job_cadence_hours_";

export type JobCadenceOrigin = "REFRESH_POLICY" | "FOLLOWS_PRIMARY" | "SETTING" | "DEFAULT" | "INVALID_SETTING" | "FIXED";

export interface JobCadencePolicy {
  job: string;
  /** The cadence in force, in hours. */
  hours: number;
  origin: JobCadenceOrigin;
  defaultHours: number;
  /** Bounds for an editable job; for others the single admissible value. */
  minHours: number;
  maxHours: number;
  /** True when an operator may change it THROUGH ITS OWN setting (not via the refresh policy). */
  editable: boolean;
  /** The PlatformSetting key that governs it: the job's own key, the refresh-cadence key, or null (FIXED / FOLLOWS_PRIMARY). */
  settingKey: string | null;
  /** For FOLLOWS_PRIMARY: the primary job. */
  primary: string | null;
  /** The refresh source kind for REFRESH_POLICY and FOLLOWS_PRIMARY. */
  sourceKind: RefreshSourceKind | null;
  /** One sentence an operator can read. */
  note: string;
  /** Changes whenever the effective cadence or its row changes. Opaque; for invalidation and ledger stamping. */
  version: string;
}

export interface JobCadenceSettingRow {
  value: string;
  updatedAt: Date;
}

/** `job_cadence_hours_<name>` for an editable job; null otherwise. */
export function jobCadenceSettingKey(job: Pick<ScheduledJobFacts, "name" | "cadence" | "refreshes" | "continuationOf">): string | null {
  return job.cadence && !job.refreshes && !job.continuationOf ? `${JOB_CADENCE_SETTING_PREFIX}${job.name}` : null;
}

/** The default period of a job: its historical daily anchor. */
export function defaultCadenceHours(job: Pick<ScheduledJobFacts, "hourUTC" | "expectedEveryHours">): number {
  return job.expectedEveryHours ?? slotPeriodHours(job.hourUTC);
}

export function parseCadenceHours(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return n >= min && n <= max ? n : null;
}

/**
 * Pure: the cadence policy for one job, given its setting row (if any), the
 * resolved refresh policies, and — for a continuation — its primary's policy.
 */
export function resolveJobCadence(
  job: ScheduledJobFacts,
  row: JobCadenceSettingRow | null,
  refreshPolicies: Readonly<Record<RefreshSourceKind, Pick<RefreshPolicy, "expectedEveryHours" | "version" | "origin">>>,
  primaryPolicy?: JobCadencePolicy | null,
): JobCadencePolicy {
  const defaultHours = defaultCadenceHours(job);

  if (job.continuationOf) {
    const hours = primaryPolicy?.hours ?? (job.refreshes ? refreshPolicies[job.refreshes].expectedEveryHours : defaultHours);
    return {
      job: job.name, hours, origin: "FOLLOWS_PRIMARY", defaultHours: hours, minHours: hours, maxHours: hours,
      editable: false, settingKey: null, primary: job.continuationOf, sourceKind: job.refreshes ?? null,
      note: `Runs only after ${job.continuationOf} reports deferred work; it has no cadence of its own.`,
      version: `${job.name}:follows:${primaryPolicy?.version ?? "default"}`,
    };
  }

  if (job.refreshes) {
    const policy = refreshPolicies[job.refreshes];
    return {
      job: job.name, hours: policy.expectedEveryHours, origin: "REFRESH_POLICY", defaultHours,
      minHours: policy.expectedEveryHours, maxHours: policy.expectedEveryHours,
      editable: false, settingKey: job.refreshes === "BANK" ? "refresh_cadence_bank" : "refresh_cadence_wallet",
      primary: null, sourceKind: job.refreshes,
      note: `Governed by the ${job.refreshes === "BANK" ? "bank" : "wallet"} refresh policy — one knob for expectation and execution.`,
      version: `${job.name}:refresh:${policy.version}`,
    };
  }

  if (!job.cadence) {
    return {
      job: job.name, hours: defaultHours, origin: "FIXED", defaultHours, minHours: defaultHours, maxHours: defaultHours,
      editable: false, settingKey: null, primary: null, sourceKind: null,
      note: "Fixed cadence: maintenance and deletion work runs on the product's own schedule, not an operator preference.",
      version: `${job.name}:fixed:${defaultHours}`,
    };
  }

  const { minHours, maxHours } = job.cadence;
  const parsed = row ? parseCadenceHours(row.value, minHours, maxHours) : null;
  const origin: JobCadenceOrigin = !row ? "DEFAULT" : parsed !== null ? "SETTING" : "INVALID_SETTING";
  const hours = parsed ?? defaultHours;
  return {
    job: job.name, hours, origin, defaultHours, minHours, maxHours,
    editable: true, settingKey: `${JOB_CADENCE_SETTING_PREFIX}${job.name}`, primary: null, sourceKind: null,
    note: origin === "DEFAULT" ? `Default: every ${defaultHours} hours.`
      : origin === "SETTING" ? `Override: every ${hours} hours (allowed ${minHours}–${maxHours}).`
      : `The stored override "${row?.value ?? ""}" is unreadable or out of bounds; the default of ${defaultHours} hours is in force.`,
    version: `${job.name}:${origin}:${hours}:${row ? row.updatedAt.toISOString() : "default"}`,
  };
}

/** Resolve every job, primaries before their continuations, in registry order. */
export function resolveJobCadences(
  jobs: readonly ScheduledJobFacts[],
  rows: ReadonlyMap<string, JobCadenceSettingRow>,
  refreshPolicies: Readonly<Record<RefreshSourceKind, Pick<RefreshPolicy, "expectedEveryHours" | "version" | "origin">>>,
): Map<string, JobCadencePolicy> {
  const out = new Map<string, JobCadencePolicy>();
  for (const job of jobs) {
    if (job.continuationOf) continue;
    const key = jobCadenceSettingKey(job);
    out.set(job.name, resolveJobCadence(job, key ? rows.get(key) ?? null : null, refreshPolicies));
  }
  for (const job of jobs) {
    if (!job.continuationOf) continue;
    out.set(job.name, resolveJobCadence(job, null, refreshPolicies, out.get(job.continuationOf) ?? null));
  }
  return out;
}

// ── Due-ness ──────────────────────────────────────────────────────────────────

/** What the ledger says about one job's newest run. */
export interface JobLedgerFact {
  /** Newest JobRun.startedAt for the job; null when it never ran. */
  lastStartedAt: Date | null;
  lastStatus: string | null;
  /** The newest COMPLETED run's summary (for a primary's `deferred` count). */
  lastSummary?: unknown;
}

export type JobDueReason = "NEVER_RAN" | "CADENCE_ELAPSED" | "PRIMARY_DEFERRED";
export type JobSkipReason = "NOT_YET_DUE" | "IN_FLIGHT" | "NO_DEFERRED_WORK" | "PRIMARY_NOT_RUN" | "CONTINUATION_TOO_SOON" | "ALREADY_CONTINUED";

export type JobDueDecision =
  | { due: true; reason: JobDueReason; dueSinceMs: number }
  | { due: false; reason: JobSkipReason; nextDueAt: Date | null };

const HOUR_MS = 3_600_000;

/** A `running` row younger than the in-flight window means a run is live right now. */
export function isInFlight(fact: JobLedgerFact | null | undefined, now: Date): boolean {
  return !!fact && fact.lastStatus === "running" && fact.lastStartedAt !== null
    && now.getTime() - fact.lastStartedAt.getTime() < IN_FLIGHT_WINDOW_MS;
}

/** The instant a job becomes due again: last start + cadence − tolerance. Null when it never ran (due now). */
export function nextDueAt(fact: JobLedgerFact | null | undefined, policy: Pick<JobCadencePolicy, "hours">): Date | null {
  if (!fact?.lastStartedAt) return null;
  return new Date(fact.lastStartedAt.getTime() + policy.hours * HOUR_MS - DUE_TOLERANCE_MS);
}

/** The primary's newest completed summary reports deferred work. Reads `summary.deferred` (jobs/sync-crypto.ts). */
export function primaryReportedDeferred(summary: unknown): boolean {
  const d = (summary as { deferred?: unknown } | null | undefined)?.deferred;
  return typeof d === "number" && d > 0;
}

/**
 * PURE — is `job` due at `now`? A primary is due by cadence; a continuation is
 * due only when its primary's newest run reported deferred work, started at least
 * CONTINUATION_DELAY_MS ago, and the continuation has not run since.
 */
export function decideJobDue(
  job: Pick<ScheduledJobFacts, "name" | "continuationOf">,
  policy: Pick<JobCadencePolicy, "hours">,
  fact: JobLedgerFact | null | undefined,
  now: Date,
  primaryFact?: JobLedgerFact | null,
): JobDueDecision {
  if (isInFlight(fact, now)) return { due: false, reason: "IN_FLIGHT", nextDueAt: null };

  if (job.continuationOf) {
    if (!primaryFact?.lastStartedAt) return { due: false, reason: "PRIMARY_NOT_RUN", nextDueAt: null };
    if (!primaryReportedDeferred(primaryFact.lastSummary)) return { due: false, reason: "NO_DEFERRED_WORK", nextDueAt: null };
    const earliest = primaryFact.lastStartedAt.getTime() + CONTINUATION_DELAY_MS;
    if (now.getTime() < earliest) return { due: false, reason: "CONTINUATION_TOO_SOON", nextDueAt: new Date(earliest) };
    if (fact?.lastStartedAt && fact.lastStartedAt.getTime() >= primaryFact.lastStartedAt.getTime()) {
      return { due: false, reason: "ALREADY_CONTINUED", nextDueAt: null };
    }
    return { due: true, reason: "PRIMARY_DEFERRED", dueSinceMs: now.getTime() - earliest };
  }

  if (!fact?.lastStartedAt) return { due: true, reason: "NEVER_RAN", dueSinceMs: 0 };
  const at = nextDueAt(fact, policy)!;
  if (now.getTime() >= at.getTime()) return { due: true, reason: "CADENCE_ELAPSED", dueSinceMs: now.getTime() - at.getTime() };
  return { due: false, reason: "NOT_YET_DUE", nextDueAt: at };
}
