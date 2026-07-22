"use client";

/**
 * components/space/widgets/investments/HoldingsConcentration.tsx
 *
 * The Concentration read-surface — a DIFFERENT question from Allocation. Allocation
 * answers "what percentage is each thing?"; Concentration answers "how exposed am I?":
 * the largest single name, the top-5 cluster, and the largest sector. It reuses the ONE
 * concentration formula (via computeAllocation, the same the AI assembler + the
 * Allocation panel use) — no second definition, no new data.
 *
 * Presentation only, and honest: metrics are relative to the VALUED invested total; a
 * portfolio with nothing analyzable (all cash / unvalued) renders nothing rather than
 * a fabricated zero.
 */

import { useMemo } from "react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { computeAllocation } from "@/lib/investments/investments-allocation-core";
import type { ConcentrationClassification } from "@/lib/investments/concentration";
import { DataCard } from "@/components/atlas/DataCard";

const CLASSIFICATION_PRESENTATION: Record<
  Exclude<ConcentrationClassification, "INSUFFICIENT_DATA">,
  { label: string; color: string }
> = {
  DIVERSIFIED:         { label: "Diversified",             color: "var(--accent-positive)" },
  MODERATE:            { label: "Moderately concentrated", color: "var(--text-secondary)" },
  CONCENTRATED:        { label: "Concentrated",            color: "var(--accent-warning)" },
  HIGHLY_CONCENTRATED: { label: "Highly concentrated",     color: "var(--accent-negative)" },
};

function pct(w: number | null): string {
  return w == null ? "—" : `${(w * 100).toFixed(1)}%`;
}

function Row({ label, value, valueNode }: { label: string; value?: string; valueNode?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      <span className="text-sm tabular-nums text-[var(--text-secondary)]">{valueNode ?? value}</span>
    </div>
  );
}

export function HoldingsConcentration({
  holdings,
  accounts,
}: {
  holdings: ValuedHoldingRow[];
  accounts: { id: string; name: string }[];
}) {
  const { concentration, bySector, valuedTotal } = useMemo(() => {
    const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
    return computeAllocation(holdings, accountNames);
  }, [holdings, accounts]);

  // Nothing analyzable — render nothing rather than a fabricated zero.
  if (concentration.classification === "INSUFFICIENT_DATA" || valuedTotal <= 0) return null;

  const cls = CLASSIFICATION_PRESENTATION[concentration.classification];
  const topSector = bySector[0] ?? null;

  return (
    <DataCard title="Concentration">
      <div className="mt-1 flex flex-col divide-y divide-[var(--border-hairline)]">
        <Row
          label="Largest holding"
          valueNode={
            <>
              {concentration.topSymbol && <span className="text-[var(--text-muted)]">{concentration.topSymbol} </span>}
              {pct(concentration.topWeight)}
            </>
          }
        />
        <Row label="Top 5 holdings" value={pct(concentration.top5Weight)} />
        {topSector && (
          <Row
            label="Largest sector"
            valueNode={
              <>
                <span className="text-[var(--text-muted)]">{topSector.label} </span>
                {(topSector.share * 100).toFixed(0)}%
              </>
            }
          />
        )}
      </div>
      <p className="mt-3 text-xs">
        <span className="font-semibold" style={{ color: cls.color }}>{cls.label}</span>
        {concentration.effectiveHoldings != null && (
          <span className="text-[var(--text-muted)]"> · {concentration.effectiveHoldings.toFixed(1)} effective holdings</span>
        )}
      </p>
    </DataCard>
  );
}
