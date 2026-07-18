"use client";

/**
 * components/space/widgets/investments/InvestmentsWorkspace.tsx
 *
 * The Investments WORKSPACE — owns Investments data consumption + display conversion,
 * and emits its trust envelope outward. The composition is EDITORIAL (the Net Worth /
 * prototype idiom), not a dense dashboard: a bare lede, the read surfaces stacked with
 * generous rhythm, the honesty stated up front.
 *
 *   ① InvestmentsHero   — portfolio value + period change + valued/total coverage
 *   ② Excluded          — positions that couldn't be valued, stated ABOVE the ledger
 *   ③ Balance history   — Portfolio Value Over Time (the dominant analytical visual)
 *   ④ Holdings          — the weight-bar ledger (the bar IS the allocation view) →
 *                         RightPanel detail (the Atlas panel primitive)
 *   ⑤ This period       — Activity + What Changed
 *   ⑥ Connections
 *
 * DATA (never cross-derived — PCS-1): CURRENT portfolio from `data.current`
 * (getCurrentPositions); as-of/compare + period change from `data.historical` (A10). The
 * Portfolio Value series is the canonical persisted SpaceSnapshot window. All money is
 * display-converted through the ONE canonical seam; the envelope is emitted from the
 * UNCONVERTED historical (trust is currency-agnostic).
 *
 * "How well", never "where" (the scoping rule): Wealth owns the scalar ("where is my
 * money"), Investments owns holdings + what happened. Per-holding gain/loss and cost
 * basis are NOT in the historical data and are never fabricated in the headline; cost
 * basis (where Plaid supplies it, current view) lives in the holding detail only.
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { Info, Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import type { ConversionContext } from "@/lib/money/types";
import { convertInvestmentsSpaceData } from "@/lib/investments/display-conversion";
import { convertPortfolioValueSeries } from "@/lib/investments/portfolio-series";
import { Surface, Block } from "@/components/atlas/Surface";
import { useInvestmentsSpaceData } from "./useInvestmentsSpaceData";
import { InvestmentsActivityCard } from "./InvestmentsActivityCard";
import { InvestmentsBridgeCard } from "./InvestmentsBridgeCard";
import { InvestmentConnectionsCard } from "./InvestmentConnectionsCard";
import { PortfolioValueChart } from "./PortfolioValueChart";
import { InvestmentsHero } from "./InvestmentsHero";
import { HoldingsLedger } from "./HoldingsLedger";

/** The Investments workspace's own section anchors — what the sidebar shows as
 *  "what's inside" this workspace (each maps to a scroll-target id below). */
const INVESTMENTS_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",         anchor: "investments-summary" },
  { label: "Balance history", anchor: "investments-history" },
  { label: "Holdings",        anchor: "investments-holdings" },
  { label: "This period",     anchor: "investments-activity" },
];

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

  // Trust envelope — resolved from the UNCONVERTED historical (currency-agnostic tiers),
  // reusing the ONE canonical resolver. Memoized so the effect only fires on change, and
  // the SAME envelope drives the hero's confidence chip (they can never disagree).
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: raw?.historical ?? null }),
    [raw],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  // Display-currency conversion (pure; identity when reporting === target).
  const data = useMemo(() => (raw && ctx ? convertInvestmentsSpaceData(raw, ctx, asOf) : raw), [raw, ctx, asOf]);
  const series = useMemo(() => (ctx ? convertPortfolioValueSeries(rawSeries, ctx, asOf) : rawSeries), [rawSeries, ctx, asOf]);

  const historicalMode = !!data && asOf < today && data.historical != null;
  const primary = data ? (historicalMode && data.historical ? data.historical : data.current) : null;

  // Publish section anchors to the sidebar once real holdings exist (cleared on unmount).
  const publishSections = useSpaceSectionsPublisher();
  const showSections = !!primary && (primary.holdings.length > 0 || primary.portfolio.unvaluedCount > 0);
  useEffect(() => {
    publishSections(showSections ? INVESTMENTS_SECTIONS : []);
    return () => publishSections([]);
  }, [publishSections, showSections]);

  if (!data || !primary) {
    if (error) {
      return (
        <Surface className="p-8">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[var(--text-muted)]">Couldn&rsquo;t load your investments.</p>
            <button onClick={reload} className="text-xs font-semibold text-[var(--meridian-400)] hover:underline">Retry</button>
          </div>
        </Surface>
      );
    }
    return <div className="flex items-center justify-center py-16"><Loader2 size={18} className="animate-spin text-[var(--text-faint)]" /></div>;
  }

  const reportingCurrency = primary.reportingCurrency;
  const reconciliation = data.historical?.reconciliation ?? null;
  const flows = data.historical?.flows ?? null;
  const figureLabel = data.trust?.figureLabel ?? (primary.portfolio.unvaluedCount > 0 ? "Valued holdings" : "Portfolio value");
  // HIST-1D — shared-Space scope disclosure (currency-agnostic; from the UNCONVERTED contract).
  const scopeDivergence = raw?.scopeDivergence ?? null;

  const isEmpty = primary.holdings.length === 0 && primary.portfolio.unvaluedCount === 0;
  if (isEmpty) {
    return (
      <div className="space-y-8 min-w-0">
        <InvestmentsHero
          portfolio={primary.portfolio} reconciliation={reconciliation}
          reportingCurrency={reportingCurrency} figureLabel={figureLabel} asOf={asOf} envelope={envelope}
        />
        <Surface className="px-4 py-8 text-center">
          <TrendingUp size={22} className="mx-auto text-[var(--text-faint)]" />
          <p className="mt-2 text-sm font-medium text-[var(--text-secondary)]">No holdings for this date</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Connect a brokerage or exchange, or pick a later date, to see your holdings here.</p>
          <Link href="/dashboard/connections" className="mt-3 inline-block text-sm font-semibold text-[var(--meridian-400)] hover:underline">
            Connect an investment account →
          </Link>
        </Surface>
        <InvestmentConnectionsCard spaceId={spaceId} />
      </div>
    );
  }

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0">
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-faint)]">
          <Loader2 size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      {/* ① Lede — portfolio value, period change, valued/total coverage. */}
      <div id="investments-summary" className="scroll-mt-20">
        <InvestmentsHero
          portfolio={primary.portfolio} reconciliation={reconciliation}
          reportingCurrency={reportingCurrency} figureLabel={figureLabel} asOf={asOf} envelope={envelope}
        />
      </div>

      {/* ② Excluded — the positions left out of the headline, stated up front. */}
      {primary.portfolio.unvaluedCount > 0 && (
        <ExcludedDisclosure count={primary.portfolio.unvaluedCount} reason={primary.portfolio.unvalued[0]?.reason} />
      )}

      {/* HIST-1D — shared-Space scope disclosure (transparency only; no number changes). */}
      {scopeDivergence && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--surface-inset)", color: "var(--text-muted)" }} role="note">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span><span className="font-medium text-[var(--text-secondary)]">{scopeDivergence.title}.</span> {scopeDivergence.note}</span>
        </div>
      )}

      {/* ③ Balance history — Portfolio Value Over Time. */}
      <Block id="investments-history" label="Balance history">
        <Surface className="p-4">
          <PortfolioValueChart points={series} currency={reportingCurrency} asOf={asOf} compareTo={compareTo} />
        </Surface>
      </Block>

      {/* ④ Holdings — the weight-bar ledger; the bar IS the allocation view. */}
      <Block
        id="investments-holdings"
        label="Holdings"
        hint={<span className="text-[11px] tabular-nums text-[var(--text-faint)]">{primary.holdings.length}</span>}
        action={<span className="text-[11px] text-[var(--text-faint)]">Bar shows share of portfolio</span>}
      >
        <HoldingsLedger holdings={primary.holdings} reportingCurrency={reportingCurrency} accounts={accounts} />
      </Block>

      {/* ⑤ This period — Activity + What Changed. */}
      <Block id="investments-activity" label="This period">
        <div className="grid gap-4 lg:grid-cols-2 items-start min-w-0">
          <Surface className="p-4 min-w-0"><InvestmentsActivityCard flows={flows} /></Surface>
          <Surface className="p-4 min-w-0"><InvestmentsBridgeCard reconciliation={reconciliation} flows={flows} /></Surface>
        </div>
      </Block>

      {/* ⑥ Connections — renders its own panel only when an account needs attention. */}
      <InvestmentConnectionsCard spaceId={spaceId} />
    </div>
  );
}

/** The exclusion, stated up front (prototype thesis): positions that couldn't be
 *  valued are named ABOVE the ledger, not buried below it. We'd rather be short than
 *  wrong — a partial subtotal that admits what it left out beats a false-complete one. */
function ExcludedDisclosure({ count, reason }: { count: number; reason?: string }): ReactNode {
  return (
    <Surface tone="sunken" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
      <span className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide" style={{ background: "var(--glass-ultrathin)", color: "var(--text-secondary)" }}>
        Excluded
      </span>
      <p className="text-xs text-[var(--text-muted)]">
        <span className="tabular-nums text-[var(--text-secondary)]">{count}</span> position{count === 1 ? "" : "s"} couldn&rsquo;t be valued for this date
        {reason ? ` — ${reason}` : ""}<span className="text-[var(--text-secondary)]"> — not counted above.</span>
      </p>
      <span className="ml-auto text-[10px] text-[var(--text-faint)]">We&rsquo;d rather be short than wrong.</span>
    </Surface>
  );
}
