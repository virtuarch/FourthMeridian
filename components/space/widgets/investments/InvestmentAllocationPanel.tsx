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
import { BreakdownWidget, type BreakdownItem } from "@/components/space/widgets/BreakdownWidget";
import { formatCurrency } from "@/lib/format";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import type { ConcentrationClassification } from "@/lib/investments/concentration";
import {
  computeAllocation, holdingsInSlice,
  type AllocationSlice, type AllocationDimension,
} from "@/lib/investments/investments-allocation-core";
import { RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { AllocationSliceDetail } from "./AllocationSliceDetail";

type Dimension = AllocationDimension;

const DIMENSIONS: { id: Dimension; label: string; noun: string }[] = [
  { id: "assetClass", label: "Asset class", noun: "asset class" },
  { id: "sector",     label: "Sector",      noun: "sector" },
  { id: "account",    label: "Account",     noun: "account" },
  { id: "currency",   label: "Currency",    noun: "currency" },
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

/** Map canonical allocation slices → the shared BreakdownWidget item contract.
 *  `share` is scale-invariant so the widget re-derives percentages from `value`. */
function toBreakdownItems(slices: AllocationSlice[]): BreakdownItem[] {
  return slices.map((s) => ({ id: s.key, label: s.label, value: s.value }));
}

export function InvestmentAllocationPanel({
  holdings,
  accounts,
  reportingCurrency,
  showConcentrationInsight = true,
}: {
  holdings:          ValuedHoldingRow[];
  accounts:          { id: string; name: string }[];
  reportingCurrency: string;
  /** The one-line concentration insight above the dimension toggle. Set false when a
   *  dedicated Concentration surface renders alongside (avoids saying it twice). */
  showConcentrationInsight?: boolean;
}) {
  const [dimension, setDimension] = useState<Dimension>("assetClass");
  // UX-CLOSE-3 — one selection, local to this card. Same idiom as the ledgers.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const accountNames = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );
  const allocation = useMemo(
    () => computeAllocation(holdings, accountNames),
    [holdings, accountNames],
  );

  // A key means a different thing on each axis ("EQUITY" vs an accountId), so a
  // carried-over selection would resolve to nothing. Clear it with the axis.
  const changeDimension = (next: Dimension) => {
    setSelectedKey(null);
    setDimension(next);
  };

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
  const noun = DIMENSIONS.find((d) => d.id === dimension)?.noun ?? "slice";

  // Resolve the open selection against the CURRENT axis. Selecting through the
  // shared key functions means these rows sum to the segment's value.
  const selectedSlice = selectedKey != null ? slices.find((s) => s.key === selectedKey) ?? null : null;
  const selectedRows = selectedSlice ? holdingsInSlice(holdings, dimension, selectedSlice.key) : [];

  return (
    <div>
      {/* Concentration insight — intelligence before configuration. */}
      {showConcentrationInsight && conc && (
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

      {/* Dimension selector — a dropdown (§10). No shared Select primitive exists,
          so this mirrors the app's inline <select> token recipe (ViewCurrencyOverride). */}
      <label className="sr-only" htmlFor="alloc-dim">Allocation dimension</label>
      <select
        id="alloc-dim"
        value={dimension}
        onChange={(e) => changeDimension(e.target.value as Dimension)}
        className="mb-3 w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--text-secondary)] focus:border-[var(--meridian-400)] focus:outline-none"
      >
        {DIMENSIONS.map((d) => <option key={d.id} value={d.id}>By {d.label.toLowerCase()}</option>)}
      </select>

      {/* Canonical shared donut (BreakdownWidget) — the same primitive wealth +
          liquidity use, so the Investments allocation reads as one system. */}
      <BreakdownWidget
        items={toBreakdownItems(slices)}
        viewMode="donut"
        itemNoun={noun}
        formatValue={(v) => formatCurrency(v, reportingCurrency)}
        emptyHeadline="Nothing to break down"
        emptySubline="No valued holdings on this axis."
        onSelect={(i) => setSelectedKey(i.id)}
        selectedId={selectedKey}
        selectLabel={(i) => `${i.label} — show positions`}
      />

      {/* Honest unvalued remainder — disclosed, never folded into the shares. */}
      {allocation.unvaluedCount > 0 && (
        <p className="text-[11px] px-1 mt-3" style={{ color: "var(--text-faint)" }}>
          {allocation.unvaluedCount} position{allocation.unvaluedCount === 1 ? "" : "s"} couldn’t be valued and {allocation.unvaluedCount === 1 ? "is" : "are"} excluded from these shares.
        </p>
      )}

      {/* INSPECT — the positions behind the selected slice. */}
      <RightPanel open={selectedSlice != null} onClose={() => setSelectedKey(null)} ariaLabel="Allocation slice detail">
        {selectedSlice && (
          <>
            <PanelHeader
              eyebrow={DIMENSIONS.find((d) => d.id === dimension)?.label}
              title={selectedSlice.label}
            />
            <PanelContent>
              <AllocationSliceDetail
                rows={selectedRows}
                sliceValue={selectedSlice.value}
                valuedTotal={allocation.valuedTotal}
                reportingCurrency={reportingCurrency}
                accountName={(id) => accountNames[id] ?? "Unknown account"}
                showAccount={dimension !== "account"}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </div>
  );
}
