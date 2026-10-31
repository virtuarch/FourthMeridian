/**
 * components/platform/widgets/jobs-matrix-view.ts  (UX-P1 · Agent 4)
 *
 * The Overview's compact jobs matrix vocabulary. Pure, React-free,
 * clock-injected. It reuses the Jobs surface's words (`jobs-view.ts`,
 * `job-health-format.ts`) and adds only what a four-cell row needs — it
 * classifies nothing and counts nothing the route did not already count.
 *
 * ── NEXT DUE IS DERIVED, NEVER PLANNED ───────────────────────────────────────
 * `nextExpectedAt` is the health authority's arithmetic over the newest run
 * and the cadence — the same arithmetic the dispatcher uses — and the
 * dispatcher's wake itself is unobservable. So the cell shows that derived
 * instant when the authority produced one; for a job that never ran the
 * authority states it is due "at the next wake" and computes no time (a time
 * nobody computed would be a fabrication); and when the authority produced
 * nothing for a job that has run, the cell says so rather than guessing.
 */

import type {
  PlatformJobHealthCounts,
  PlatformJobRow,
} from "@/app/api/platform/platform-ops/job-health/route";
import { relTime } from "./job-health-format";
import { fmtUtc } from "./jobs-view";

/** "never ran" is its own word — not a time, not a zero, not healthy. */
export const NEVER_RAN_WORD = "never ran";
/** The authority's own statement for a job with no run: due at the next dispatcher wake. */
export const NEXT_WAKE_WORD = "at the next wake";
/** A job that has run but for which the authority derived no next instant. */
export const NEXT_NOT_DERIVED_REASON = "not derived";

export const MATRIX_FOOTNOTE =
  "Observed from the JobRun ledger. The dispatcher tick is unobservable, so next due is the health authority's derivation from the newest run and the cadence — never a planned slot. A job that never ran is due at the next wake.";

export interface MatrixCell {
  value: string;
  qualifier: string;
}

/** LAST RUN: relative first (the operator's question), the UTC instant as the qualifier. */
export function lastRunCell(row: PlatformJobRow, nowMs?: number): MatrixCell | null {
  const utc = fmtUtc(row.lastStartedAt, true);
  if (utc == null) return null;
  return { value: relTime(row.lastStartedAt, nowMs), qualifier: utc };
}

export type NextDueCell =
  | { kind: "time"; value: string; qualifier: string }
  | { kind: "wake" }
  | { kind: "unknown" };

/** NEXT DUE — see the module header. */
export function nextDueCell(row: PlatformJobRow, nowMs?: number): NextDueCell {
  const utc = fmtUtc(row.nextExpectedAt, true);
  if (utc != null) return { kind: "time", value: `due ${relTime(row.nextExpectedAt, nowMs)}`, qualifier: utc };
  if (row.lastStartedAt == null) return { kind: "wake" };
  return { kind: "unknown" };
}

/** CONSECUTIVE FAILURES — the route's own streak, worded only when it is non-zero. */
export function failuresCell(row: PlatformJobRow): string | null {
  if (row.consecutiveFailures <= 0) return null;
  return `${row.consecutiveFailures} consecutive failure${row.consecutiveFailures === 1 ? "" : "s"}`;
}

/**
 * The summary line, read from the route's OWN counts in worst-first order.
 * Zero counts are omitted except `healthy`, which is always stated so a fleet
 * with nothing wrong still reads as a fleet rather than as an empty line.
 */
export function summaryLine(counts: PlatformJobHealthCounts): string {
  const parts: string[] = [];
  if (counts.dead > 0) parts.push(`${counts.dead} dead`);
  if (counts.failing > 0) parts.push(`${counts.failing} failing`);
  if (counts.overdue > 0) parts.push(`${counts.overdue} overdue`);
  if (counts.neverRan > 0) parts.push(`${counts.neverRan} ${NEVER_RAN_WORD}`);
  if ((counts.skipped ?? 0) > 0) parts.push(`${counts.skipped} skipped (cost freeze)`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  parts.push(`${counts.healthy} healthy`);
  return parts.join(" · ");
}
