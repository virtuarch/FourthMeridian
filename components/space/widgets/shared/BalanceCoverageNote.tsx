"use client";

/**
 * components/space/widgets/shared/BalanceCoverageNote.tsx  (PB-8 — owner ruling 2026-10-30)
 *
 * Under the Net Worth / Assets / Debt trend: when the plotted window reaches back
 * before an account's balance-history floor (a mortgage connected yesterday, a
 * card whose history cannot be walked), says the history there is PARTIAL — a
 * missing debt is never $0 owed. The sibling of ValuationCoverageNote (prices);
 * rides the same one data-health read and renders nothing while loading, on a
 * failed read, or when the window starts on/after the floor.
 */

import { useSpaceIdContext } from "@/components/space/space-id-context";
import { useSpaceBalanceCoverage } from "@/components/space/PerspectiveEmptyState";
import { balanceCoverageNote, balanceCoverageSidesFor, type BalanceCoverage } from "@/lib/connections/balance-coverage.core";

export function BalanceCoverageNote({ from, metric, coverage: given }: {
  from: string | null;
  metric: string;
  /** Fixture-driven renders only; the page always reads the Space's data-health. */
  coverage?: BalanceCoverage | null;
}) {
  const live = useSpaceBalanceCoverage(useSpaceIdContext());
  const coverage = given !== undefined ? given : live;
  const note = balanceCoverageNote(coverage, balanceCoverageSidesFor(metric), from);
  if (!note) return null;
  return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-balance-coverage-note>{note}</p>;
}
