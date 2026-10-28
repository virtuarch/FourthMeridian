"use client";

/**
 * components/space/widgets/wealth/ValuationCoverageNote.tsx  (owner requirement 2026-10-28)
 *
 * Under the Net Worth / Assets trend: when an asset's balance history reaches
 * further back than its stored daily prices, says so — the chart starts at the
 * price floor because earlier days refuse (never valued at zero). Rides the
 * Space's one data-health read; renders nothing while loading, on a failed
 * read, or when prices are not what bounds the plotted window.
 */

import { useSpaceIdContext } from "@/components/space/space-id-context";
import { useSpaceValuationCoverage } from "@/components/space/PerspectiveEmptyState";
import { valuationCoverageNote } from "@/lib/connections/valuation-coverage.core";

export function ValuationCoverageNote({ from }: { from: string | null }) {
  const coverage = useSpaceValuationCoverage(useSpaceIdContext());
  const note = valuationCoverageNote(coverage, from);
  if (!note) return null;
  return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-valuation-coverage-note>{note}</p>;
}
