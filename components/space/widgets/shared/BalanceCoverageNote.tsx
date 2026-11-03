"use client";

/**
 * components/space/widgets/shared/BalanceCoverageNote.tsx  (PB-8 — owner ruling 2026-10-30)
 *
 * Under the Net Worth / Assets / Debt trend: when the plotted window reaches back
 * before an account's balance-history floor (a mortgage connected yesterday, a
 * card whose history cannot be walked), says the history there is PARTIAL — a
 * missing debt is never $0 owed. The sibling of ValuationCoverageNote (prices);
 * rides the same one data-health read and renders nothing while loading or when
 * the window starts on/after the floor; on a FAILED read it says completeness
 * could not be read (S2 sweep).
 */

import { useSpaceIdContext } from "@/components/space/space-id-context";
import { useSpaceBalanceCoverage } from "@/components/space/PerspectiveEmptyState";
import { BALANCE_COVERAGE_UNREADABLE_CHART_NOTE, balanceCoverageNote, balanceCoverageSidesFor, isBalanceCoverageUnavailable, type ClientBalanceCoverage } from "@/lib/connections/balance-coverage.core";

export function BalanceCoverageNote({ from, metric, coverage: given }: {
  from: string | null;
  metric: string;
  /** Fixture-driven renders only; the page always reads the Space's data-health. */
  coverage?: ClientBalanceCoverage;
}) {
  const live = useSpaceBalanceCoverage(useSpaceIdContext());
  const coverage = given !== undefined ? given : live;
  // S2 sweep — a FAILED coverage read: say so under a series it governs (its change is withheld above).
  if (isBalanceCoverageUnavailable(coverage) && balanceCoverageSidesFor(metric).length > 0) {
    return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-balance-coverage-note="unavailable">{BALANCE_COVERAGE_UNREADABLE_CHART_NOTE}</p>;
  }
  // S2 2026-11-03 — LOADING renders nothing (balanceCoverageNote knows no floor yet):
  // the note is pending, never a sentence that the resolved read then contradicts.
  const note = balanceCoverageNote(coverage, balanceCoverageSidesFor(metric), from);
  if (!note) return null;
  return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-balance-coverage-note>{note}</p>;
}
