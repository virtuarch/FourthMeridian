/**
 * components/platform/widgets/scheduler-view.ts  (PM-1 · S3)
 *
 * The Scheduler surface's presentation vocabulary. Pure, React-free,
 * clock-injected, and testable without rendering anything — the house pattern
 * `platform-health-view.ts` already establishes for a consolidated surface.
 *
 * ── WHAT IT MAY DO ───────────────────────────────────────────────────────────
 * Turn a value `GET /api/platform/platform-ops/scheduler` ALREADY SERVES into
 * the exact words used to show it.
 *
 * ── WHAT IT MUST NOT DO ──────────────────────────────────────────────────────
 * Decide anything. There is no slot arithmetic here, no overdue detection, no
 * "is the scheduler alive" verdict, and no clock read — `lib/jobs/health.ts` and
 * `lib/platform/scheduler/observation-core.ts` already own every one of those,
 * and a second opinion computed at render time is how a surface starts
 * disagreeing with the authority it claims to report.
 *
 * ── THE EPISTEMIC SPLIT IS THE LAYOUT ────────────────────────────────────────
 * OBSERVED figures are rows that exist. EXPECTED figures are configuration and
 * are evidence of nothing. Every phrase below belongs to exactly one of the two
 * and says which, because a time with no statement of its derivation is what
 * lets "last recorded execution" be read as "the dispatcher just ticked".
 *
 * ── ABSENCE IS NEVER ZERO ────────────────────────────────────────────────────
 * A missing time returns `null` and the caller renders `Unavailable` with the
 * reason. It never becomes `00:00`, and it never becomes a dash with no
 * explanation.
 */

import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";

// ── The hints that stop a column being misread ────────────────────────────────

/**
 * Static LABELS ("Observed", "Last recorded execution", …) deliberately stay
 * inline in the component. They are UI copy with no derivation, and
 * `lib/platform/scheduler/observation.test.ts` asserts the epistemic groups are
 * legible in the widget source itself — a structural guard that indirection
 * through a constant would blind rather than satisfy.
 *
 * What lives here is the phrasing that carries a CLAIM: what a column may be
 * read to mean, where a figure came from, and why one is absent.
 */
export const OBSERVED_HINT = "Read from the JobRun ledger. These are recorded facts.";
export const EXPECTED_HINT =
  "Derived from the job registry in code. These are predictions, not measurements.";

// ── The four figures ──────────────────────────────────────────────────────────

/**
 * The hint that stops the external-cron count being read as "jobs we watch".
 * Copied from `ExternalCronObservation`'s own doc comment — the observation
 * authority already states exactly what the gap is.
 */
export const EXTERNAL_CRON_HINT =
  "Jobs the ledger recorded but the registry does not declare, so they have no health report and no alert coverage.";

export const EXTERNAL_CRON_DERIVATION = "Observed in the ledger, not declared by the registry";
export const NEXT_SLOT_DERIVATION = "Derived from the schedules declared in the job registry";
export const JOBS_IN_SLOT_DERIVATION = "Declared configuration, not evidence that anything ran";

/**
 * The reasons an absent figure gives for being absent. Each names the observation
 * that was not made, never the value that would have been reassuring.
 */
export const NO_EXECUTION_REASON = "no execution recorded in the window";
export const NO_SLOT_REASON = "no slot declared by the registry";
export const UNREADABLE_TIME_REASON = "recorded timestamp unreadable";

/** The subject named in the failure sentence when the route could not be asked. */
export const SCHEDULER_SUBJECT = "Scheduler observation";

// ── Formatters ────────────────────────────────────────────────────────────────

/**
 * The UTC wall-clock face of an instant — `07:30`. Null in, null out; an
 * unparseable timestamp is also null, so the caller says "unreadable" rather
 * than rendering `NaN:NaN` or, worse, midnight.
 *
 * UTC is not a display preference here: every scheduling figure in this product
 * is declared in UTC (`lib/jobs/registry.ts` fire hours), so rendering an
 * operator's local hour beside a registry-declared one would invite exactly the
 * comparison that is wrong.
 */
export function utcClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(11, 16);
}

/** True when a timestamp exists but cannot be read — a different fact from absent. */
export function isUnreadable(iso: string | null | undefined): boolean {
  return iso != null && iso !== "" && utcClock(iso) == null;
}

/**
 * The one-line reading of a scheduling instant. `relative` is supplied by the
 * caller from `job-health-format`'s `relTime`, which already owns signed
 * relative time for the whole platform (past → "3h ago", future → "in 5h").
 */
export function clockQualifier(relative: string): string {
  return `${relative} · UTC`;
}

/**
 * Where "last recorded execution" came from, plus how much the window actually
 * held. The window count is production data the previous widget rendered and is
 * kept — on the DERIVATION line, which is where a figure's provenance belongs,
 * rather than promoted to a fourth headline the prototype does not have.
 */
export function lastExecutionDerivation(recordedExecutions: number): string {
  const tail =
    recordedExecutions === 0
      ? "none recorded in the window"
      : `${recordedExecutions} recorded in the window`;
  return `From job runs (not dispatcher ticks) · ${tail}`;
}

/** The external crons, named. Null when none were observed — the caller words it. */
export function externalCronNames(
  crons: SchedulerObservationResponse["observed"]["externalCrons"],
): string | null {
  if (crons.length === 0) return null;
  return crons.map((c) => c.job).join(" · ");
}

export const NO_EXTERNAL_CRONS_QUALIFIER = "none observed in the window";

/** The jobs the registry declares for the next slot, named. */
export function jobsInSlotQualifier(jobs: readonly string[]): string {
  return jobs.length === 0 ? "no jobs declared for that slot" : jobs.join(" · ");
}

/** The header note. A configuration count, in the slot the prototype gives one. */
export function registeredJobsNote(registeredJobs: number): string {
  return `${registeredJobs} registered ${registeredJobs === 1 ? "job" : "jobs"}`;
}

// ── Provenance ────────────────────────────────────────────────────────────────

/** The module that actually answers for every EXPECTED figure on this surface. */
export const EXPECTED_PROVENANCE = "lib/jobs/registry";
export const EXPECTED_PROVENANCE_DETAIL = "declared slots";

/**
 * The prototype prints the literal cron expression from `vercel.json` here.
 * Nothing in this product reads `vercel.json` at runtime — the deployment owns
 * the tick and the platform does not — so the cadence is stated as ABSENT with
 * its reason instead of being transcribed from a file the route never opened.
 */
export const CRON_CADENCE_REASON =
  "dispatch cadence lives in vercel.json, which this platform does not read";
