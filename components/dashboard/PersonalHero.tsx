"use client";

/**
 * components/dashboard/PersonalHero.tsx
 *
 * The Personal Space Overview body — the one sanctioned per-Space divergence
 * injected into SpaceDashboard through the `renderHero` seam (SP-2A-4a).
 *
 * Canonical Personal Overview (SP Overview refinement + correction pass):
 *
 *   A — Net Worth summary card (the shell's SummaryWidget presenter, wrapped
 *       in the same GlassPanel treatment as the rest of the Overview so it
 *       reads as a solid card, not the faint section fill)
 *   B — Net Worth chart (full width, the primary visualization)
 *   C — Allocation (responsive donut — larger on wide layouts)
 *
 * The currency "view as" control (A-top in the layout spec) is rendered ABOVE
 * this body by the shell's `overviewTopSlot` seam (PersonalDashboard owns it),
 * so it sits at the very top of the Overview. Perspectives + Recent Activity
 * follow, rendered by the shell's own doorways.
 *
 * No Cash Flow / Credit KPI tiles here: Cash Flow is represented through
 * Perspectives, and Credit belongs with the Debt perspective later. The
 * reusable KpiRow tile capability is preserved for that future use.
 *
 * Currency: this subtree renders inside the host's DisplayCurrencyProvider
 * (PersonalDashboard), so every value here follows the effective display
 * currency / "view as" override automatically.
 */

import { useState } from "react";
import { Landmark, Maximize2 } from "lucide-react";
import { NetWorthChart, Interval } from "@/components/charts/NetWorthChart";
import { NetWorthChartModal, type SeriesKey } from "@/components/charts/NetWorthChartModal";
import { AllocationChart } from "@/components/charts/AllocationChart";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { SummaryWidget } from "@/components/space/widgets/SummaryWidget";
import { ConnectAccountButton } from "@/components/dashboard/ConnectAccountButton";
import { useDisplayCurrency } from "@/lib/currency-context";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot } from "@/types";

export interface PersonalHeroProps {
  /** Day-zero gate — the hero renders the setup card when 0. */
  accountCount: number;
  snapshots:    Snapshot[];

  // Card A (Net Worth summary) — aggregates derived in the host.
  estimated:        boolean;
  netWorth:         number;
  totalAssets:      number;
  totalLiabilities: number;
  allocation: {
    cash:        number;
    investments: number;
    crypto:      number;
    debt:        number;
    realAssets:  number;
  };

  /** Shared chart interval — owned by the host. */
  chartInterval:          Interval;
  onChartIntervalChange:  (i: Interval) => void;

  /**
   * MC1 — effective conversion context (the "view as" override, or the Space's
   * own context). Forwarded to the Net Worth chart + modal so their plotted
   * values convert, not just their labels. `snapshotCurrency` is the currency
   * the snapshot totals are stamped in (the Space's reporting currency).
   */
  ctx?:              ConversionContext;
  snapshotCurrency?: string;
}

export function PersonalHero({
  accountCount,
  snapshots,
  estimated,
  netWorth,
  totalAssets,
  totalLiabilities,
  allocation,
  chartInterval,
  onChartIntervalChange,
  ctx,
  snapshotCurrency,
}: PersonalHeroProps) {
  // Chart expand modal state — owned by the hero (nothing else reads it).
  const [chartExpanded, setChartExpanded] = useState(false);
  const [chartSeries,   setChartSeries]   = useState<SeriesKey>("netWorth");

  // MC1 P4 — aggregate labels follow the effective display currency supplied
  // by the host's provider (which honors the "view as" override).
  const displayCurrency = useDisplayCurrency();
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: displayCurrency, maximumFractionDigits: 0 }).format(n);
  const est = estimated ? "≈ " : "";

  if (accountCount === 0) {
    return (
      /* Day-zero Overview (v2.5 honesty slice): one consolidated setup card
         instead of an all-zero card, empty chart, and empty allocation.
         Uses the existing ConnectAccountButton — no new concepts. */
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-8 text-center">
        <Landmark size={24} className="text-[var(--text-muted)] mx-auto mb-3" />
        <p className="text-base font-semibold text-[var(--text-primary)]">Connect your first account</p>
        <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-md mx-auto leading-relaxed">
          Net worth, allocation, and activity appear here once an account is
          connected. Everything on this dashboard is computed from real data —
          sections appear as their data exists.
        </p>
        <div className="flex justify-center mt-5">
          <ConnectAccountButton />
        </div>
      </GlassPanel>
    );
  }

  return (
    <>
      {/* A — Net Worth summary card. The exact shell SummaryWidget presenter
          (net worth / total assets / total debt), wrapped in the standard
          GlassPanel card treatment so it reads solid like B and C. */}
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
        <p className="text-sm font-semibold text-[var(--text-primary)] px-1 mb-2">Net Worth</p>
        <SummaryWidget
          primary={{
            value: `${est}${fmt(netWorth)}`,
            label: "Net worth across all shared accounts",
            color: netWorth >= 0 ? "white" : "red",
            size:  "3xl",
          }}
          stats={[
            { label: "Total assets", value: `${est}${fmt(totalAssets)}`,      accent: "green" },
            { label: "Total debt",   value: `${est}${fmt(totalLiabilities)}`, accent: "red"   },
          ]}
          emptyHeadline="No accounts shared yet"
          emptySubline="Share accounts on the Spaces page to see net worth."
        />
      </GlassPanel>

      {/* B — Net Worth chart: the primary visualization, full width. */}
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
        <div className="flex items-center justify-between px-1 mb-2">
          <p className="text-sm font-semibold text-[var(--text-primary)]">Net Worth over time</p>
          <button
            onClick={() => setChartExpanded(true)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors touch-manipulation"
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <NetWorthChart
          snapshots={snapshots}
          interval={chartInterval}
          onIntervalChange={onChartIntervalChange}
          ctx={ctx}
          snapshotCurrency={snapshotCurrency}
          fill
        />
      </GlassPanel>

      {/* C — Allocation. Responsive donut: larger on wide/full-width layouts,
          compact on narrow screens. */}
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
        <p className="text-sm font-semibold text-[var(--text-primary)] px-1 mb-2">Allocation</p>
        <AllocationChart
          cash={allocation.cash}
          investments={allocation.investments}
          crypto={allocation.crypto}
          debt={allocation.debt}
          realAssets={allocation.realAssets}
          size="responsive"
        />
      </GlassPanel>

      {/* Expanded chart modal — opened from the chart's maximize control. */}
      {chartExpanded && (
        <NetWorthChartModal
          snapshots={snapshots}
          initialInterval={chartInterval}
          initialSeries={chartSeries}
          ctx={ctx}
          snapshotCurrency={snapshotCurrency}
          onClose={() => { setChartExpanded(false); setChartSeries("netWorth"); }}
        />
      )}
    </>
  );
}
