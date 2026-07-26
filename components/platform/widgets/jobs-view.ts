/**
 * components/platform/widgets/jobs-view.ts  (S4 · the Jobs surface)
 *
 * The Jobs surface's presentation vocabulary. Pure, React-free, clock-injected,
 * and testable without rendering anything.
 *
 * ── WHAT IT MAY DO ───────────────────────────────────────────────────────────
 * Turn a value `GET /api/platform/platform-ops/job-health` already served into
 * the exact words the table shows, and ORDER/SELECT rows using statuses that
 * route's own authority (`lib/jobs/health.ts` → `classifyJobHealth`) already
 * assigned.
 *
 * ── WHAT IT MUST NOT DO ──────────────────────────────────────────────────────
 * Decide what any value IS. There is no health maths here, no cadence
 * arithmetic, no next-run derivation, no re-counting of a figure the route
 * already counted. `attentionCount()` reads the route's OWN `counts` object
 * rather than re-classifying rows, and `ATTENTION_STATUSES` is a restatement of
 * exactly the three fields that object exposes — not a fresh opinion about which
 * jobs matter. The moment this file classifies a job, `lib/jobs/health.ts` has
 * been forked and two parts of the product start disagreeing about the fleet.
 *
 * ── THE AUTHORITY GAP THIS FILE IS BUILT AROUND ──────────────────────────────
 * The prototype's Jobs table has a POLICY column (Paused until… / Skip next /
 * Disabled) and a row command menu. Fourth Meridian has NO job-policy authority:
 * nothing declares, stores, or resolves whether a job is held. OPS-2D shipped an
 * ADMISSION authority ("may this work begin?"), which is a different concept for
 * a different subject and does not answer for scheduled jobs.
 *
 * So policy is not fabricated and it is not silently dropped. The column stays —
 * the layout is the spec — and every cell renders the absence in words
 * (`POLICY_UNRECORDED_REASON`). An EMPTY policy cell would be the lie: in the
 * prototype empty means "an operator declared nothing", and here it would mean
 * "nobody records this at all". Those are different facts and the surface says
 * which one is true.
 *
 * ── SOURCE IS DERIVED, NOT ASSUMED ───────────────────────────────────────────
 * `jobSource()` reads `nextExpectedAt`, which the health authority computes from
 * the registry's declared fire slot (`nextExpectedRun(hourUTC, minuteUTC)`). A
 * row that carries one is registry-scheduled, by construction. A row that does
 * not is NOT quietly relabelled `vercel.json` — the response does not say where
 * else it might be declared, so it returns null and the caller renders the
 * no-authority chip. Guessing a provenance is the same defect as guessing a
 * policy.
 */

import type {
  PlatformJobHealthCounts,
  PlatformJobRow,
} from "@/app/api/platform/platform-ops/job-health/route";
import type { JobHealthStatus } from "@/lib/jobs/health";
import { fmtCadence, severityRank } from "./job-health-format";

// ── Filters ───────────────────────────────────────────────────────────────────

/**
 * The prototype ships three filter pills: All · Attention · Has policy.
 *
 * "Has policy" is OMITTED rather than rendered empty or disabled. A pill reading
 * "Has policy 0" would assert a count from an authority that does not exist —
 * the exact "zero is not the same as unobserved" substitution the honesty
 * doctrine forbids — and a permanently disabled third pill would imply the
 * capability is merely switched off. Two pills, both answerable.
 */
export type JobsFilter = "all" | "attention";

export const JOBS_FILTERS: readonly JobsFilter[] = ["all", "attention"];

export const FILTER_LABELS: Record<JobsFilter, string> = {
  all: "All",
  attention: "Attention",
};

/**
 * The statuses `PlatformJobHealthCounts` groups as needing an operator.
 *
 * This is a RESTATEMENT of the route's own count fields (`dead`, `failing`,
 * `overdue`), not a severity judgement of this file's own — `attentionCount()`
 * below reads those fields directly, and `jobs.test.ts` pins the two against
 * each other so they can never drift apart.
 *
 * `never-ran` is deliberately absent: a just-registered job that has not reached
 * its first slot is not a fault, and the route counts it separately for exactly
 * that reason. It is also never folded into "healthy" — it carries its own muted
 * status word everywhere it appears.
 */
export const ATTENTION_STATUSES: readonly JobHealthStatus[] = ["dead", "failing", "overdue"];

/** The attention figure, read from the route's counts — never re-derived from rows. */
export function attentionCount(counts: PlatformJobHealthCounts): number {
  return counts.dead + counts.failing + counts.overdue;
}

/**
 * Worst-first, then alphabetical — the ordering `OpsJobHealthWidget` has always
 * used, through `job-health-format`'s shared rank table. Presentation only: the
 * rank comes from the same module that owns the status labels, so ordering and
 * wording can never disagree about which state is worse.
 */
export function orderJobs(rows: readonly PlatformJobRow[]): PlatformJobRow[] {
  return [...rows].sort(
    (a, b) => severityRank(a.status) - severityRank(b.status) || a.job.localeCompare(b.job),
  );
}

/**
 * Filter + search, both PURE CLIENT-SIDE over rows the route already returned.
 * No refetch, no second query, no server round trip — this narrows what is on
 * screen and never changes what is true.
 */
export function filterJobs(
  rows: readonly PlatformJobRow[],
  filter: JobsFilter,
  query: string,
): PlatformJobRow[] {
  const base =
    filter === "attention"
      ? rows.filter((r) => ATTENTION_STATUSES.includes(r.status))
      : [...rows];
  const q = query.trim().toLowerCase();
  return q ? base.filter((r) => r.job.toLowerCase().includes(q)) : base;
}

// ── Policy: the missing authority, stated ─────────────────────────────────────

/** Rendered in every POLICY cell. Not "None declared" — nothing declares. */
export const POLICY_UNRECORDED_REASON = "not recorded";

/** The panel's longer form of the same fact. */
export const POLICY_UNRECORDED_NOTE =
  "Fourth Meridian does not record job policy. Nothing declares, stores, or resolves whether a job is paused, skipped, or disabled, so this row is blank for every job — it is not evidence that an operator declared nothing.";

/** The surface footnote's policy clause. */
export const POLICY_FOOTNOTE =
  "Policy is operator-declared — and Fourth Meridian records none today, so no row can show one. The column is kept so the absence is visible rather than implied.";

// ── Source ────────────────────────────────────────────────────────────────────

/** The one provenance this response can prove. */
export const JOB_SOURCE_REGISTRY = "registry";

/**
 * Where this job's SCHEDULE is declared, or null when the response cannot say.
 *
 * `nextExpectedAt` is the health authority's own read of the registry slot
 * (`nextExpectedRun(hourUTC, minuteUTC, now)`), so its presence proves a registry
 * declaration. Its absence proves only ignorance — never `vercel.json`.
 */
export function jobSource(row: PlatformJobRow): string | null {
  return row.nextExpectedAt ? JOB_SOURCE_REGISTRY : null;
}

// ── Time ──────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "26 Jul 09:12" (+ " UTC" when asked). UTC parts only — never a locale format:
 * an operator comparing this against a cron slot must read the same clock the
 * registry declares, on any machine.
 *
 * Lives here rather than in `job-health-format.ts` deliberately: that module is
 * imported by a sibling workstream's surface and extending it would widen a
 * shared contract for one caller.
 */
export function fmtUtc(iso: string | null | undefined, withZone = false): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const s = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withZone ? `${s} UTC` : s;
}

// ── Cell shapes ───────────────────────────────────────────────────────────────

/**
 * A two-line table cell. `null` from any builder below means THE VALUE WAS NOT
 * OBSERVED — the caller renders `Unavailable` with the stated reason, never an
 * em-dash on its own and never a zero.
 */
export interface CellLines {
  value: string;
  qualifier: string;
}

/**
 * The job's second identity line. The prototype reads "Daily · 06:00 UTC"; the
 * slot list is not on this response (the registry's `hourUTC`/`minuteUTC` never
 * cross the API boundary), so only the cadence is claimed. `nextExpectedAt` is
 * ONE upcoming slot, not the declared set — for `sync-crypto` (four daily fires)
 * printing it here as "the" slot would be false three quarters of the time.
 */
export function cadenceLine(row: PlatformJobRow): string {
  const c = fmtCadence(row.expectedEveryHours);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/** Reason shown when the ledger holds no run for this job. */
export const NEVER_RAN_REASON = "never run";
/** Reason shown when the response carries no registry slot for this job. */
export const NO_SLOT_REASON = "no registry slot";

/**
 * LAST RECORDED EXECUTION — observed, from the JobRun ledger.
 * Null when the job has never run. "Never run" is not "healthy" and is not a
 * time, so it never renders as one.
 */
export function lastExecutionCell(
  row: PlatformJobRow,
  relative: (iso: string | null) => string,
): CellLines | null {
  const value = fmtUtc(row.lastStartedAt);
  if (value == null) return null;
  return { value, qualifier: relative(row.lastStartedAt) };
}

/**
 * NEXT EXPECTED — derived by the health authority from the registry slot.
 * Null when that authority could not derive one.
 */
export function nextExpectedCell(row: PlatformJobRow): CellLines | null {
  const value = fmtUtc(row.nextExpectedAt);
  if (value == null) return null;
  return { value, qualifier: "expected" };
}

// ── Facts with no authority on this response ──────────────────────────────────

/**
 * Per-RUN ledger rows (status, duration, trigger and deployment sha per
 * execution) are what the prototype's execution strip and runtime sparkline are
 * drawn from. This response carries WINDOW AGGREGATES only — last, average,
 * counts — and no route exposes the per-job run list. Both charts are therefore
 * omitted and this sentence is rendered in their place, rather than plotting a
 * one-point line that would imply a one-run ledger.
 */
export const NO_RUN_SERIES_NOTE =
  "Per-run history is not exposed. The job-health authority reports this window as aggregates — last, average and counts — so there is no run-by-run series to plot and no deployment boundary to draw.";

/** Blast radius, commands, and the decision log all need the same absent authority. */
export const NO_CONTROL_AUTHORITY_NOTE =
  "No job control authority exists. Nothing in Fourth Meridian can pause, resume, skip, disable, or manually trigger a scheduled job, and no operator decision about a job is recorded anywhere — so there is nothing to offer here and nothing to list.";

export const NO_MAINTENANCE_AUTHORITY_REASON =
  "Maintenance mode is unavailable — no job control authority exists";

export const NO_COMMANDS_REASON = "no job control authority";

/** Metadata the registry holds but never serialises. */
export const NOT_ON_RESPONSE_REASON = "not on this response";
