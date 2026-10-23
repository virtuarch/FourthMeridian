/**
 * lib/jobs/cadence.ts  (PLATFORM OPS POLICIES — Slice 1)
 *
 * WHAT THE DEPLOYED SCHEDULE CAN ATTEMPT — derived from the registry, never copied.
 *
 * The registry declares WHEN each job fires (hourUTC / minuteUTC). Two facts
 * about refresh work are derivable from those slots and nowhere else:
 *
 *   slotPeriodHours(job)              how often ONE job gets an opportunity to
 *                                     run — the widest gap between its fire slots
 *                                     (a once-daily job: 24; [0,6,12,18]: 6).
 *   attemptPeriodHours(jobs, kind)    how often a SOURCE KIND is attempted — the
 *                                     slot period of the job(s) that refresh it.
 *
 * ⚠️ A CONTINUATION IS NOT A CADENCE. `sync-crypto-continuation` fires 30 minutes
 * after `sync-crypto` to finish what the work budget deferred. It is the SAME
 * refresh opportunity, not a second one, so it is excluded from the period: a
 * naive derivation over every job binding WALLET would compute a 30-minute
 * cadence and promise a refresh nothing attempts. `continuationOf` is what makes
 * that exclusion structural.
 *
 * ⚠️ PURE. No registry import beyond its types, no clock, no I/O. The binding to
 * the real registry is lib/platform/scheduler-capability.ts; the test that this
 * derivation still matches vercel.json is lib/jobs/cadence.test.ts.
 */

import type { RefreshSourceKind } from "@/lib/platform/refresh-policy.core";

/** The slot facts a scheduled job declares — the subset cadence derivation reads. */
export interface SlotFacts {
  name: string;
  hourUTC: number | number[];
  minuteUTC: 0 | 30;
  /** The source kind this job refreshes, when it is a refresh job. */
  refreshes?: RefreshSourceKind;
  /** The primary job this entry finishes work for. Never an opportunity of its own. */
  continuationOf?: string;
}

const HOURS_PER_DAY = 24;

/**
 * The widest gap, in hours, between a job's consecutive fire slots over a day
 * (wrapping midnight). A single daily hour is 24. The WIDEST gap is the honest
 * figure: an operator promised "every N hours" must never wait longer than N.
 */
export function slotPeriodHours(hourUTC: number | number[]): number {
  const hours = [...new Set(Array.isArray(hourUTC) ? hourUTC : [hourUTC])].sort((a, b) => a - b);
  if (hours.length <= 1) return HOURS_PER_DAY;
  let widest = 0;
  for (let i = 0; i < hours.length; i++) {
    const next = i + 1 < hours.length ? hours[i + 1] : hours[0] + HOURS_PER_DAY;
    widest = Math.max(widest, next - hours[i]);
  }
  return widest;
}

/** Fire slots as "HH:MM" UTC labels, sorted. */
export function slotLabels(job: Pick<SlotFacts, "hourUTC" | "minuteUTC">): string[] {
  const hours = [...new Set(Array.isArray(job.hourUTC) ? job.hourUTC : [job.hourUTC])].sort((a, b) => a - b);
  return hours.map((h) => `${String(h).padStart(2, "0")}:${String(job.minuteUTC).padStart(2, "0")}`);
}

export interface RefreshFamily<J extends SlotFacts = SlotFacts> {
  /** Jobs that ARE the refresh opportunity for this source kind. */
  primary: J[];
  /** Jobs that finish a primary's deferred work. Never counted as an opportunity. */
  continuations: J[];
}

/** The jobs bound to a source kind, split into opportunities and their continuations. */
export function refreshFamily<J extends SlotFacts>(jobs: readonly J[], kind: RefreshSourceKind): RefreshFamily<J> {
  const bound = jobs.filter((j) => j.refreshes === kind);
  return {
    primary: bound.filter((j) => !j.continuationOf),
    continuations: bound.filter((j) => !!j.continuationOf),
  };
}

/**
 * How often the deployed schedule ATTEMPTS a source kind: the slot period of its
 * primary refresh job. Null when no registered job refreshes the kind — a fact
 * the caller must surface, never default. With several primaries, the most
 * frequent one is the attempt period (a rarer sibling adds opportunities, it
 * does not remove them).
 */
export function attemptPeriodHours(jobs: readonly SlotFacts[], kind: RefreshSourceKind): number | null {
  const { primary } = refreshFamily(jobs, kind);
  if (primary.length === 0) return null;
  return Math.min(...primary.map((j) => slotPeriodHours(j.hourUTC)));
}

/** The UTC slots at which a source kind is attempted (primary jobs only), sorted. */
export function attemptSlotsUTC(jobs: readonly SlotFacts[], kind: RefreshSourceKind): string[] {
  const { primary } = refreshFamily(jobs, kind);
  return [...new Set(primary.flatMap(slotLabels))].sort();
}
