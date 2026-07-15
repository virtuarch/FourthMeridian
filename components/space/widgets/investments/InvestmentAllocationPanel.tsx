"use client";

/**
 * components/space/widgets/investments/InvestmentAllocationPanel.tsx
 *
 * The Investments "Allocation" panel — the "how concentrated / diversified am I?"
 * question the shipped perspective didn't answer. Presentation only: it reduces
 * the already-valued `ValuedHoldingRow[]` through the pure
 * investments-allocation-core (no new fetch, no valuation math), and renders four
 * composition breakdowns (asset class · sector · account · currency) as
 * token-native weight bars — the same `share`-bar idiom InvestmentsHoldings uses.
 *
 * "Show intelligence before configuration": the concentration read (reusing the
 * shared formula the AI assembler uses) sits at the top as a one-line insight,
 * above the dimension toggle. Honesty: only valued holdings are broken down; any
 * unvalued remainder is disclosed as a count, never folded in at zero.
 *
 * Renders inner content only — the workspace wraps it in its `Panel` card.
 */

import { useMemo, useState } from "react";
import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import { formatCurrency } from "@/lib/format";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import type { ConcentrationClassification } from "@/lib/investments/concentration";
import { computeAllocation, type AllocationSlice } from "@/lib/investments/investments-allocation-core";

type Dimension = "assetClass" | "sector" | "account" | "currency";

const DIMENSIONS: { id: Dimension; label: string }[] = [
  { id: "assetClass", label: "Asset class" },
  { id: "sector",     label: "Sector" },
  { id: "account",    label: "Account" },
  { id: "currency",   label: "Currency" },
];

// Concentration classification → label + accent (INSUFFICIENT_DATA is never shown).
const CONCENTRATION_PRESENTATION: Record<
  Exclude<ConcentrationClassification, "INSUFFICIENT_DATA">,
  { label: string; color: string }
> = {
  DIVERSIFIED:         { label: "Diversified",           color: "var(--accent-positive)" },
  MODERATE:            { label: "Moderately concentrated", color: "var(--text-secondary)" },
  CONCENTRATED:        { label: "Concentrated",          color: "var(--accent-warning)" },
  HIGHLY_CONCENTRATED: { label: "Highly concentrated",   color: "var(--accent-negative)" },
};

function AllocationBars({ slices, currency }: { slices: AllocationSlice[]; currency: string }) {
  if (slices.length === 0) {
    return <p className="text-xs px-1 py-4 text-center" style={{ color: "var(--text-muted)" }}>Nothing to break down on this axis.</p>;
  }
  return (
    <div className="space-y-2.5">
      {slices.map((s) => {
        const pct = Math.max(0, Math.min(100, s.share * 100));
        return (
          <div key={s.key} className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>{s.label}</span>
              <span className="text-xs shrink-0 tabular-nums" style={{ color: "var(--text-muted)" }}>
                <span style={{ color: "var(--text-secondary)" }}>{formatCurrency(s.value, currency)}</span>
                <span className="mx-1">·</span>
                {pct.toFixed(1)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-inset)" }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--meridian-400)" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function InvestmentAllocationPanel({
  holdings,
  accounts,
  reportingCurrency,
}: {
  holdings:          ValuedHoldingRow[];
  accounts:          { id: string; name: string }[];
  reportingCurrency: string;
}) {
  const [dimension, setDimension] = useState<Dimension>("assetClass");

  const allocation = useMemo(() => {
    const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
    return computeAllocation(holdings, accountNames);
  }, [holdings, accounts]);

  // Nothing valued to break down (e.g. holdings present but all unvalued).
  if (allocation.valuedTotal <= 0) {
    return (
      <p className="text-xs px-1 py-4 text-center" style={{ color: "var(--text-muted)" }}>
        No valued holdings to break down{allocation.unvaluedCount > 0 ? ` — ${allocation.unvaluedCount} position${allocation.unvaluedCount === 1 ? "" : "s"} couldn’t be valued` : ""}.
      </p>
    );
  }

  const slices =
    dimension === "assetClass" ? allocation.byAssetClass
    : dimension === "sector"   ? allocation.bySector
    : dimension === "account"  ? allocation.byAccount
    : allocation.byCurrency;

  const c = allocation.concentration;
  const conc = c.classification !== "INSUFFICIENT_DATA" ? CONCENTRATION_PRESENTATION[c.classification] : null;

  return (
    <div>
      {/* Concentration insight — intelligence before configuration. */}
      {conc && (
        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 px-1 mb-3 text-xs">
          <span className="font-semibold" style={{ color: conc.color }}>{conc.label}</span>
          {c.effectiveHoldings != null && (
            <span style={{ color: "var(--text-muted)" }}>· {c.effectiveHoldings.toFixed(1)} effective holdings</span>
          )}
          {c.topSymbol && c.topWeight != null && (
            <span style={{ color: "var(--text-muted)" }}>· top {c.topSymbol} {(c.topWeight * 100).toFixed(0)}%</span>
          )}
        </div>
      )}

      {/* Dimension toggle. */}
      <SegmentedControl
        options={DIMENSIONS}
        value={dimension}
        onChange={setDimension}
        aria-label="Allocation dimension"
        className="mb-3"
      />

      <AllocationBars slices={slices} currency={reportingCurrency} />

      {/* Honest unvalued remainder — disclosed, never folded into the bars. */}
      {allocation.unvaluedCount > 0 && (
        <p className="text-[11px] px-1 mt-3" style={{ color: "var(--text-faint)" }}>
          {allocation.unvaluedCount} position{allocation.unvaluedCount === 1 ? "" : "s"} couldn’t be valued and {allocation.unvaluedCount === 1 ? "is" : "are"} excluded from these shares.
        </p>
      )}
    </div>
  );
}
