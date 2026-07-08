"use client";

/**
 * components/dashboard/PersonalHero.tsx
 *
 * SP-2A-4b — the Personal Space hero, extracted (moved, not rewritten) from
 * DashboardClient's Overview branch. Per the unified-shell doctrine, hero
 * content is the one sanctioned per-Space divergence: this component is what
 * page.tsx will inject through SpaceDashboard's `renderHero` seam in
 * SP-2A-4c. Until then, DashboardClient consumes it transitionally so there
 * is exactly one copy of the hero code.
 *
 * Owns (state + JSX moved verbatim):
 *  - day-zero "Connect your first account" card (accountCount === 0)
 *  - ViewCurrencyOverride row (MC1 P4 Slice 8 — the ephemeral view-as
 *    override is a PERSONAL-dashboard-only affordance by doctrine; it must
 *    never move into the shared shell itself)
 *  - KPI row (net worth / assets / liabilities / cash-flow / FICO) and its
 *    click-through targets
 *  - Net Worth / Allocation two-column charts
 *  - NetWorthChartModal (expand) + Cash Flow GlassModal, with their
 *    open/series state (chartExpanded / chartSeries / cashFlowModalOpen)
 *
 * Stays in the host and arrives as props (shared with other tabs there):
 *  chartInterval (Investments/Banking charts read it too), viewOverride /
 *  effectiveDisplayCurrency (Banking/Transactions consume them), and all
 *  derived data (classification totals, cashFlow, allocation, snapshots).
 */

import { useState } from "react";
import { Landmark, Maximize2 } from "lucide-react";
import { NetWorthChart, Interval } from "@/components/charts/NetWorthChart";
import { NetWorthChartModal, type SeriesKey } from "@/components/charts/NetWorthChartModal";
import { AllocationChart } from "@/components/charts/AllocationChart";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { KpiRow } from "@/components/dashboard/widgets/KpiRow";
import { RecentTransactionsPanel } from "@/components/dashboard/widgets/RecentTransactionsPanel";
import { ConnectAccountButton } from "@/components/dashboard/ConnectAccountButton";
import { DisplayCurrencyProvider } from "@/lib/currency-context";
import { ViewCurrencyOverride, type ViewOverride } from "@/components/dashboard/widgets/ViewCurrencyOverride";
import type { Snapshot, Transaction } from "@/types";

export interface PersonalHeroProps {
  /** Day-zero gate — the hero renders the setup card when 0. */
  accountCount: number;
  snapshots:    Snapshot[];
  /** Cash Flow modal content (same rows the Banking tab already shows). */
  transactions: Transaction[];

  // KPI row derived data (computed in the host — shared with other tabs)
  estimated:          boolean;
  netWorth:           number;
  netWorthChangePct:  number | null;
  totalAssets:        number;
  totalLiabilities:   number;
  cashFlowMTD:        number;
  cashFlowEstimated:  boolean;
  cashFlowChangePct:  number | null;
  ficoScore:          number | null;
  allocation: {
    cash:        number;
    investments: number;
    crypto:      number;
    debt:        number;
    realAssets:  number;
  };

  /** Shared chart interval — Investments/Banking charts read it too. */
  chartInterval:          Interval;
  onChartIntervalChange:  (i: Interval) => void;

  // MC1 view-as override — state owned by the host (Banking consumes it too)
  spaceCurrency:            string;
  effectiveDisplayCurrency: string;
  viewOverride:             ViewOverride | null;
  onViewOverrideChange:     (o: ViewOverride | null) => void;

  /** FICO KPI tile click-through (routes to the host's credit surface). */
  onCreditClick: () => void;
}

export function PersonalHero({
  accountCount,
  snapshots,
  transactions,
  estimated,
  netWorth,
  netWorthChangePct,
  totalAssets,
  totalLiabilities,
  cashFlowMTD,
  cashFlowEstimated,
  cashFlowChangePct,
  ficoScore,
  allocation,
  chartInterval,
  onChartIntervalChange,
  spaceCurrency,
  effectiveDisplayCurrency,
  viewOverride,
  onViewOverrideChange,
  onCreditClick,
}: PersonalHeroProps) {
  // Chart expand + cash-flow modal state — owned by the hero (nothing else
  // reads it). Moved verbatim from DashboardClient.
  const [chartExpanded,     setChartExpanded]     = useState(false);
  const [chartSeries,       setChartSeries]       = useState<SeriesKey>("netWorth");
  const [cashFlowModalOpen, setCashFlowModalOpen] = useState(false);

  if (accountCount === 0) {
    return (
      /* Day-zero Overview (v2.5 honesty slice): one consolidated setup card
         instead of an all-zero KPI strip, empty charts, and empty previews.
         Uses the existing ConnectAccountButton — no new concepts. */
      <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-8 text-center">
        <Landmark size={24} className="text-[var(--text-muted)] mx-auto mb-3" />
        <p className="text-base font-semibold text-[var(--text-primary)]">Connect your first account</p>
        <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-md mx-auto leading-relaxed">
          Net worth, cash flow, and activity appear here once an account is
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
      {/* KPI strip — Net Worth, Assets, Liabilities, Cash Flow, Credit Score */}
      <div className="mb-2 flex justify-end">
        {/* MC1 P4 Slice 8 — ephemeral view-as override (preview only) */}
        <ViewCurrencyOverride
          spaceCurrency={spaceCurrency}
          override={viewOverride}
          onChange={onViewOverrideChange}
        />
      </div>
      <DisplayCurrencyProvider currency={effectiveDisplayCurrency}>
      <KpiRow
        estimated={estimated}
        netWorth={netWorth}
        netWorthChangePct={netWorthChangePct}
        totalAssets={totalAssets}
        totalLiabilities={totalLiabilities}
        cashFlowMTD={cashFlowMTD}
        cashFlowEstimated={cashFlowEstimated}
        cashFlowChangePct={cashFlowChangePct}
        ficoScore={ficoScore}
        onNetWorthClick={() => { setChartSeries("netWorth"); setChartExpanded(true); }}
        onAssetsClick={() => { setChartSeries("totalAssets"); setChartExpanded(true); }}
        onLiabilitiesClick={() => { setChartSeries("totalDebt"); setChartExpanded(true); }}
        onCashFlowClick={() => setCashFlowModalOpen(true)}
        onCreditClick={onCreditClick}
      />
      </DisplayCurrencyProvider>

      {/* Net Worth / Allocation — two columns on desktop. The AI
          Daily Brief panel was removed from this row (Space
          Template Redesign): its pipeline is a stub (D5 —
          run-ai-advice never runs), and a hero-adjacent slot can't
          be held by a placeholder. The slot returns as "Briefing"
          when D5 ships. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
        <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
          <div className="flex items-center justify-between px-1 mb-2">
            <p className="text-sm font-semibold text-[var(--text-primary)]">Net Worth</p>
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
            fill
          />
        </GlassPanel>

        <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)] px-1 mb-2">Allocation</p>
          <AllocationChart
            cash={allocation.cash}
            investments={allocation.investments}
            crypto={allocation.crypto}
            debt={allocation.debt}
            realAssets={allocation.realAssets}
          />
        </GlassPanel>

      </div>

      {/* Expanded chart modal — the Net Worth / Assets /
          Liabilities KPI tile modal (IA refactor point 4), just opened
          pre-focused on a different series of the same chart. */}
      {chartExpanded && (
        <NetWorthChartModal
          snapshots={snapshots}
          initialInterval={chartInterval}
          initialSeries={chartSeries}
          onClose={() => { setChartExpanded(false); setChartSeries("netWorth"); }}
        />
      )}

      {/* Cash Flow KPI tile modal — the real transactions behind the Cash
          Flow (MTD) number, reusing RecentTransactionsPanel as-is. */}
      {cashFlowModalOpen && (
        <GlassModal
          title="Cash Flow"
          subtitle="Every transaction behind this month's number"
          onClose={() => setCashFlowModalOpen(false)}
          size="lg"
        >
          <RecentTransactionsPanel transactions={transactions} previewCount={transactions.length} />
        </GlassModal>
      )}
    </>
  );
}
