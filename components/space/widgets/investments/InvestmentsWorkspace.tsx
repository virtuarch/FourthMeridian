"use client";

/**
 * components/space/widgets/investments/InvestmentsWorkspace.tsx
 *
 * The Investments WORKSPACE — the single boundary that OWNS Investments data
 * consumption (SD-4D+ §1/§16). It:
 *   • owns `useInvestmentsSpaceData` (the canonical InvestmentsSpaceData contract) —
 *     the host no longer fetches Investments data,
 *   • owns display-currency conversion (`convertInvestmentsSpaceData`, SD-4D) — pure,
 *     reporting → selected display currency, canonical facts untouched,
 *   • EMITS its trust envelope outward (`onEnvelopeChange`) so the shell's Completeness
 *     chip stays canonical WITHOUT the host owning the fetch — the narrow bridge:
 *         Workspace data → resolvePerspectiveEnvelope → shell trust surface.
 *
 * DATA (never cross-derived — PCS-1): CURRENT portfolio from `data.current`
 * (getCurrentPositions); as-of/compare + period change from `data.historical` (A10).
 * When the shell As Of is a PAST date, historical becomes the primary portfolio.
 *
 * COMPOSITION (mockup-inspired, SUPPORTED metrics only): KPI strip → Holdings (top 5 +
 * modal) with a side column Allocation (donut) → Period Activity → Change Bridge →
 * Connections. The envelope is emitted from the UNCONVERTED historical (trust tiers are
 * currency-agnostic); the visible values are display-converted.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { ConversionContext } from "@/lib/money/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { convertInvestmentsSpaceData } from "@/lib/investments/display-conversion";
import { useInvestmentsSpaceData } from "./useInvestmentsSpaceData";
import { InvestmentsHoldings } from "./InvestmentsHoldings";
import { InvestmentAllocationPanel } from "./InvestmentAllocationPanel";
import { InvestmentsActivityCard } from "./InvestmentsActivityCard";
import { InvestmentsBridgeCard } from "./InvestmentsBridgeCard";
import { InvestmentConnectionsCard } from "./InvestmentConnectionsCard";
import { InvestmentKpiStrip } from "./InvestmentKpiStrip";

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      <p className="text-sm font-semibold px-1 mb-2 text-[var(--text-primary)]">{title}</p>
      {children}
    </GlassPanel>
  );
}

export function InvestmentsWorkspace({
  spaceId,
  asOf,
  compareTo,
  active,
  today,
  accounts,
  ctx,
  onEnvelopeChange,
}: {
  spaceId:   string;
  /** Resolved shell As Of (YYYY-MM-DD). */
  asOf:      string;
  /** Resolved shell Compare To (already guarded to < asOf, or null). */
  compareTo: string | null;
  /** Fetch gate — the Investments workspace being open (declared investmentsHistory need). */
  active:    boolean;
  /** The shell's "today" — when asOf < today the historical portfolio is primary. */
  today:     string;
  accounts:  { id: string; name: string }[];
  /** Display-currency conversion context (absent ⇒ reporting currency shown verbatim). */
  ctx?:      ConversionContext;
  /** Bridge to the shell trust surface — the host relays this to PerspectiveShell. */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  const { data: raw, loading, error, reload } = useInvestmentsSpaceData(spaceId, asOf, compareTo, active);

  // Emit the trust envelope for the shell chip from the UNCONVERTED historical result
  // (trust tiers/counts are currency-agnostic). Reuses the ONE canonical resolver — no
  // duplicated trust logic; the host owns no Investments data to compute this.
  useEffect(() => {
    onEnvelopeChange(resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: raw?.historical ?? null }));
  }, [raw, onEnvelopeChange]);

  // Display-currency conversion (pure). Identity when reporting === display target.
  const data = useMemo(() => (raw && ctx ? convertInvestmentsSpaceData(raw, ctx, asOf) : raw), [raw, ctx, asOf]);

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
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" />
      </div>
    );
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
              <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                Connect a brokerage or exchange, or pick a later date, to see your holdings here.
              </p>
              <Link href="/dashboard/connections" className="mt-3 inline-block text-sm font-semibold text-[var(--meridian-400)] hover:underline">
                Connect an investment account →
              </Link>
            </div>
          </Panel>
        </div>
        <div className="min-w-0 lg:col-span-4">
          <InvestmentConnectionsCard spaceId={spaceId} />
        </div>
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

      <InvestmentKpiStrip
        portfolio={primary.portfolio}
        reconciliation={reconciliation}
        activity={data.activity}
        reportingCurrency={reportingCurrency}
        figureLabel={figureLabel}
        asOf={asOf}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
        <div className="min-w-0 lg:col-span-7 xl:col-span-8">
          <Panel title="Holdings">
            <InvestmentsHoldings holdings={primary.holdings} reportingCurrency={reportingCurrency} accounts={accounts} />
          </Panel>
        </div>

        <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
          <Panel title="Allocation">
            <InvestmentAllocationPanel holdings={primary.holdings} accounts={accounts} reportingCurrency={reportingCurrency} />
          </Panel>
          <Panel title="Period Activity">
            <InvestmentsActivityCard flows={flows} />
          </Panel>
          <Panel title="What Changed">
            <InvestmentsBridgeCard reconciliation={reconciliation} flows={flows} />
          </Panel>
          <InvestmentConnectionsCard spaceId={spaceId} />
        </div>
      </div>
    </div>
  );
}
