"use client";

/**
 * components/space/widgets/investments/InvestmentsWorkspace.tsx
 *
 * The Investments WORKSPACE — owns Investments data consumption + display conversion,
 * and emits its trust envelope outward (SD-4D+ §1/§16). Composition (SD-4 §2/§18):
 *
 *   KPI strip
 *   → Portfolio Value Over Time            (the dominant analytical visual)
 *   → Holdings (grid ↔ detail) + Allocation (donut)
 *   → Period Activity + What Changed
 *   → Connections
 *
 * DATA (never cross-derived — PCS-1): CURRENT portfolio from `data.current`
 * (getCurrentPositions); as-of/compare + period change from `data.historical` (A10). The
 * Portfolio Value series is the canonical persisted SpaceSnapshot window (investments +
 * crypto, no double-count) served alongside the contract. All money is display-converted
 * through the ONE canonical seam; the envelope is emitted from the UNCONVERTED historical
 * (trust is currency-agnostic). No new monolith — Holdings/chart/allocation are extracted
 * domain-local components composed here.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { ConversionContext } from "@/lib/money/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { convertInvestmentsSpaceData } from "@/lib/investments/display-conversion";
import { convertPortfolioValueSeries } from "@/lib/investments/portfolio-series";
import { useInvestmentsSpaceData } from "./useInvestmentsSpaceData";
import { InvestmentAllocationPanel } from "./InvestmentAllocationPanel";
import { InvestmentsActivityCard } from "./InvestmentsActivityCard";
import { InvestmentsBridgeCard } from "./InvestmentsBridgeCard";
import { InvestmentConnectionsCard } from "./InvestmentConnectionsCard";
import { InvestmentKpiStrip } from "./InvestmentKpiStrip";
import { PortfolioValueChart } from "./PortfolioValueChart";
import { HoldingsSection } from "./HoldingsSection";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      <p className="text-sm font-semibold px-1 mb-2 text-[var(--text-primary)]">{title}</p>
      {children}
    </GlassPanel>
  );
}

export function InvestmentsWorkspace({
  spaceId, asOf, compareTo, active, today, accounts, ctx, onEnvelopeChange,
}: {
  spaceId:   string;
  asOf:      string;
  compareTo: string | null;
  active:    boolean;
  today:     string;
  accounts:  { id: string; name: string }[];
  ctx?:      ConversionContext;
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  const { data: raw, series: rawSeries, loading, error, reload } = useInvestmentsSpaceData(spaceId, asOf, compareTo, active);

  // Emit the trust envelope from the UNCONVERTED historical (currency-agnostic tiers),
  // reusing the ONE canonical resolver — the host owns no Investments data.
  useEffect(() => {
    onEnvelopeChange(resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: raw?.historical ?? null }));
  }, [raw, onEnvelopeChange]);

  // Display-currency conversion (pure; identity when reporting === target).
  const data = useMemo(() => (raw && ctx ? convertInvestmentsSpaceData(raw, ctx, asOf) : raw), [raw, ctx, asOf]);
  const series = useMemo(() => (ctx ? convertPortfolioValueSeries(rawSeries, ctx, asOf) : rawSeries), [rawSeries, ctx, asOf]);

  if (!data) {
    if (error) {
      return (
        <div className="rounded-2xl border p-8" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Couldn’t load your investments.</p>
            <button onClick={reload} className="text-xs font-semibold text-[var(--meridian-400)] hover:underline">Retry</button>
          </div>
        </div>
      );
    }
    return <div className="flex items-center justify-center py-16"><Loader2 size={18} className="animate-spin text-[var(--text-faint)]" /></div>;
  }

  const historicalMode = asOf < today && data.historical != null;
  const primary = historicalMode && data.historical ? data.historical : data.current;
  const reportingCurrency = primary.reportingCurrency;
  const reconciliation = data.historical?.reconciliation ?? null;
  const flows = data.historical?.flows ?? null;
  const figureLabel = data.trust?.figureLabel ?? (primary.portfolio.unvaluedCount > 0 ? "Valued holdings" : "Portfolio value");

  const isEmpty = primary.holdings.length === 0 && primary.portfolio.unvaluedCount === 0;
  if (isEmpty) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
        <div className="min-w-0 lg:col-span-8">
          <Panel title="Holdings">
            <div className="py-6 text-center">
              <TrendingUp size={22} className="mx-auto text-[var(--text-faint)]" />
              <p className="mt-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>No holdings for this date</p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Connect a brokerage or exchange, or pick a later date, to see your holdings here.</p>
              <Link href="/dashboard/connections" className="mt-3 inline-block text-sm font-semibold text-[var(--meridian-400)] hover:underline">Connect an investment account →</Link>
            </div>
          </Panel>
        </div>
        <div className="min-w-0 lg:col-span-4"><InvestmentConnectionsCard spaceId={spaceId} /></div>
      </div>
    );
  }

  return (
    <div className="space-y-4 min-w-0">
      {loading && (
        <div className="flex items-center gap-1.5 text-xs px-1" style={{ color: "var(--text-faint)" }}>
          <Loader2 size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      {/* ① KPI strip. */}
      <InvestmentKpiStrip portfolio={primary.portfolio} reconciliation={reconciliation} activity={data.activity}
        reportingCurrency={reportingCurrency} figureLabel={figureLabel} asOf={asOf} />

      {/* ② Portfolio Value Over Time — the dominant visual (§2). */}
      <Panel title="Portfolio Value Over Time">
        <PortfolioValueChart points={series} currency={reportingCurrency} asOf={asOf} compareTo={compareTo} />
      </Panel>

      {/* ③ Holdings (grid ↔ detail) + Allocation. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
        <div className="min-w-0 lg:col-span-8">
          <HoldingsSection holdings={primary.holdings} reportingCurrency={reportingCurrency} accounts={accounts} />
        </div>
        <div className="min-w-0 lg:col-span-4">
          <Panel title="Allocation">
            <InvestmentAllocationPanel holdings={primary.holdings} accounts={accounts} reportingCurrency={reportingCurrency} />
          </Panel>
        </div>
      </div>

      {/* ④ Period Activity + What Changed. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start min-w-0">
        <Panel title="Period Activity"><InvestmentsActivityCard flows={flows} /></Panel>
        <Panel title="What Changed"><InvestmentsBridgeCard reconciliation={reconciliation} flows={flows} /></Panel>
      </div>

      {/* ⑤ Connections — renders its own titled panel only when an account needs attention. */}
      <InvestmentConnectionsCard spaceId={spaceId} />
    </div>
  );
}
