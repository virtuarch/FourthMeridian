"use client";

/**
 * components/space/widgets/investments/InvestmentsWorkspace.tsx
 *
 * SD-4A/SD-4C — the extracted Investments WORKSPACE: the single boundary that owns
 * all Investments composition (moved out of the SpaceDashboard host) over the
 * canonical `InvestmentsSpaceData` contract (PCS-1D), finally activated end-to-end.
 *
 * DATA (never cross-derived — the PCS-1 invariant):
 *   • The CURRENT portfolio (value · holdings · allocation) is sourced from
 *     `data.current` → getCurrentPositions(). This replaces the old A10-at-today
 *     path as the canonical current view.
 *   • The HISTORICAL / as-of view (`data.historical`) is A10 verbatim; it drives the
 *     period change (KPI value-delta, the Change Bridge) and, when the shell As Of is
 *     a PAST date, becomes the primary portfolio shown. Current and historical are
 *     read from the ONE composed contract but each keeps its own authority.
 *   • `data.activity` (= historical.flows) drives Net Contributions / Income / the
 *     Period Activity card; `data.trust` supplies the honest figure label.
 *
 * COMPOSITION (mockup-inspired, SUPPORTED metrics only — see InvestmentKpiStrip for
 * the omitted/unsupported cards): a supported KPI strip, then Holdings (dominant) with
 * a side column of Allocation → Period Activity → Change Bridge ("What Changed") →
 * Connections. Widgets are reused unchanged with clean props.
 *
 * Props-in / render-out. The host still fetches the contract (transitional
 * orchestration: the shell trust chip reads `data.historical`) and threads it in;
 * display-currency conversion is a scoped SD-4D follow-up (values are reporting-
 * currency verbatim, consistently labeled — never a mixed-currency masquerade).
 */

import type { ReactNode } from "react";
import { Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { InvestmentsSpaceData } from "@/lib/investments/space-data-core";
import { InvestmentsHoldings } from "./InvestmentsHoldings";
import { InvestmentAllocationPanel } from "./InvestmentAllocationPanel";
import { InvestmentsActivityCard } from "./InvestmentsActivityCard";
import { InvestmentsBridgeCard } from "./InvestmentsBridgeCard";
import { InvestmentConnectionsCard } from "./InvestmentConnectionsCard";
import { InvestmentKpiStrip } from "./InvestmentKpiStrip";

/** SectionCard solid-lede card language (matches the sibling perspectives). */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      <p className="text-sm font-semibold px-1 mb-2 text-[var(--text-primary)]">{title}</p>
      {children}
    </GlassPanel>
  );
}

export function InvestmentsWorkspace({
  data,
  loading,
  error,
  onRetry,
  accounts,
  spaceId,
  asOf,
  today,
}: {
  data:     InvestmentsSpaceData | null;
  loading:  boolean;
  error:    boolean;
  onRetry:  () => void;
  accounts: { id: string; name: string }[];
  spaceId:  string;
  /** Resolved shell As Of (YYYY-MM-DD). */
  asOf:     string;
  /** The shell's "today" — when asOf < today we show the historical portfolio. */
  today:    string;
}) {
  // Loading (no data yet) — a centered spinner. A refetch over existing data never
  // blanks it (the hook keeps the last result).
  if (!data) {
    if (error) {
      return (
        <div className="rounded-2xl border p-8" style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Couldn’t load your investments.</p>
            <button onClick={onRetry} className="text-xs font-semibold text-[var(--meridian-400)] hover:underline">Retry</button>
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

  // As-of in the PAST ⇒ the historical portfolio is the primary view; otherwise the
  // canonical CURRENT portfolio (getCurrentPositions). Both carry `holdings` +
  // `portfolio`; the change/period story always comes from the historical slice.
  const historicalMode = asOf < today && data.historical != null;
  const primary = historicalMode && data.historical ? data.historical : data.current;
  const reportingCurrency = primary.reportingCurrency;
  const reconciliation = data.historical?.reconciliation ?? null;
  const flows = data.historical?.flows ?? null;
  const figureLabel =
    data.trust?.figureLabel ?? (primary.portfolio.unvaluedCount > 0 ? "Valued holdings" : "Portfolio value");

  // Empty — no holdings and nothing unvalued: the connect CTA.
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
      {/* A refetch (As Of / Compare To nudge) never blanks the grid; a quiet inline
          spinner signals the refresh while the last data stays visible. */}
      {loading && (
        <div className="flex items-center gap-1.5 text-xs px-1" style={{ color: "var(--text-faint)" }}>
          <Loader2 size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}
      {/* ── KPI strip — supported figures only (value · net contributions · income). */}
      <InvestmentKpiStrip
        portfolio={primary.portfolio}
        reconciliation={reconciliation}
        activity={data.activity}
        reportingCurrency={reportingCurrency}
        figureLabel={figureLabel}
      />

      {/* ── Analytical grid — Holdings (dominant) + side column. Mobile/tablet stack
           in source order: Holdings → Allocation → Activity → Bridge → Connections. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
        <div className="min-w-0 lg:col-span-7 xl:col-span-8">
          <Panel title="Holdings">
            <InvestmentsHoldings
              holdings={primary.holdings}
              reportingCurrency={reportingCurrency}
              accounts={accounts}
            />
          </Panel>
        </div>

        <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
          <Panel title="Allocation">
            <InvestmentAllocationPanel
              holdings={primary.holdings}
              accounts={accounts}
              reportingCurrency={reportingCurrency}
            />
          </Panel>
          <Panel title="Period Activity">
            <InvestmentsActivityCard flows={flows} />
          </Panel>
          <Panel title="What Changed">
            <InvestmentsBridgeCard reconciliation={reconciliation} flows={flows} />
          </Panel>
          {/* Renders its own titled panel only when an account needs attention; null otherwise. */}
          <InvestmentConnectionsCard spaceId={spaceId} />
        </div>
      </div>
    </div>
  );
}
