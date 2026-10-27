"use client";

/**
 * components/space/widgets/investments/InvestmentsWorkspace.tsx
 *
 * The Investments WORKSPACE — an investment RESEARCH surface, editorial not dashboard:
 * an overview lede, then the analytical surfaces stacked for exploration, then detail
 * on demand. It owns Investments data consumption + display conversion and emits its
 * trust envelope outward.
 *
 *   ① InvestmentsHero        — portfolio value + period change + valued/total coverage
 *                              (standalone only — embedded, the Assets hero states it)
 *   ② Balance history        — invested value over time (the SHARED Net Worth chart)
 *      Accuracy status        — "Partial · N of M valued", only when partial
 *   ③ Holdings               — top-few weight-bar ledger; "View all" → LeftPanel browser
 *                              → RightPanel detail (the Atlas panel primitives)
 *   ④ Allocation             — "what do I own?" (the shared donut breakdown)
 *   ⑤ Concentration          — "how exposed am I?" (largest / top-5 / sector)
 *   ⑥ Accounts               — every investment account at its balance
 *   ⑦ This period            — the opening→in→out→change→closing movement bridge
 *
 * v2.7 visual-first — the Activity narrative and the Excluded banner are gone
 * (the bridge states the period's money in/out; the accuracy chip states coverage).
 *
 * DATA (never cross-derived — PCS-1): CURRENT portfolio from `data.current`; as-of/
 * compare + period change from `data.historical` (A10). The Balance-history series is
 * the canonical persisted SpaceSnapshot window (investments + crypto, no double-count).
 * All money is display-converted through the ONE canonical seam; the envelope is emitted
 * from the UNCONVERTED historical (trust is currency-agnostic). No new data contracts.
 *
 * OVERVIEW-CONSOLIDATION — Investments is no longer a peer Overview lens. This
 * workspace now renders EMBEDDED as the INVESTMENTS SECTION of the unified Net
 * Worth → Assets page (`embedded`): the same data hook, the same contract, the
 * same bridge / holdings / allocation / concentration / accounts surfaces.
 * Embedded, it (a) draws no hero (the page's Investments hero states the
 * slice; the accuracy chip states any partial valuation), (b)
 * omits its own balance-history chart — the Assets chart directly above slices to
 * the SAME stocks + crypto series, carrying this lens's three-state confidence and
 * "N of M positions valued" disclosure per point — and (c) publishes neither
 * sidebar sections nor the shell envelope: the Assets page owns both, while the
 * section keeps its own per-figure TrustIndicator.
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Info, Loader2, TrendingUp } from "lucide-react";
import Link from "next/link";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import type { ConversionContext } from "@/lib/money/types";
import { convertInvestmentsSpaceData } from "@/lib/investments/display-conversion";
import { convertPortfolioValueSeries } from "@/lib/investments/portfolio-series";
import { Surface, Block } from "@/components/atlas/Surface";
import { DataCard } from "@/components/atlas/DataCard";
import { useInvestmentsSpaceData } from "./useInvestmentsSpaceData";
// B-6 — THE today/history switch (one comparison, shared with the server).
import { isHistoricalDay } from "@/lib/time/basis";
import { InvestmentsBridgeCard } from "./InvestmentsBridgeCard";
import { InvestmentAccountsLedger } from "./InvestmentAccountsLedger";
import { InvestmentAllocationPanel, ALLOCATION_GROUPINGS } from "./InvestmentAllocationPanel";
import { Dropdown } from "@/components/atlas/Dropdown";
import type { AllocationDimension } from "@/lib/investments/investments-allocation-core";
import { InvestmentsHero } from "./InvestmentsHero";
import { InvestmentsBalanceHistory } from "./InvestmentsBalanceHistory";
import { useHistoryExploration } from "@/components/history/useHistoryExploration";
import { HoldingsLedger } from "./HoldingsLedger";
import { HoldingsConcentration } from "./HoldingsConcentration";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";

/** The Investments workspace's own section anchors — what the sidebar shows as
 *  "what's inside" this workspace (each maps to a scroll-target id below). */
const INVESTMENTS_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",         anchor: "investments-summary" },
  { label: "Balance history", anchor: "investments-history" },
  { label: "Holdings",        anchor: "investments-holdings" },
  { label: "Allocation",      anchor: "investments-allocation" },
  { label: "Concentration",   anchor: "investments-concentration" },
  { label: "This period",     anchor: "investments-period" },
];

export function InvestmentsWorkspace({
  spaceId, asOf, compareTo, active, today, accounts, ctx, onEnvelopeChange, embedded = false,
}: {
  spaceId:   string;
  asOf:      string;
  compareTo: string | null;
  active:    boolean;
  today:     string;
  accounts:  { id: string; name: string }[];
  ctx?:      ConversionContext;
  /** Omitted when embedded — the Assets page owns the shell slot. */
  onEnvelopeChange?: (env: PerspectiveEnvelope) => void;
  /** Rendered as the Investments section inside Net Worth → Assets (see header). */
  embedded?: boolean;
}) {
  const { data: raw, series: rawSeries, loading, error, reload, serverToday } = useInvestmentsSpaceData(spaceId, asOf, compareTo, active);
  // v2.7 — the Allocation grouping, owned here so its Dropdown can sit in the
  // Block header (Net Worth idiom); the panel renders the chosen axis.
  const [allocationDimension, setAllocationDimension] = useState<AllocationDimension>("assetClass");
  // V26-S3-DETAIL — which historical point the reader asked about. The chart
  // reports a DATE and nothing else; the panel asks the canonical historical
  // authority what that date was made of.
  // v2.6 — the INVESTMENTS root, through the ONE shared explorer. The legacy
  // per-lens drawer is retired: two drawers meant two answers to the same
  // question, which is what this arc exists to remove.
  const exploration = useHistoryExploration();
  const handleSelectPoint = useCallback(
    (dateISO: string) => {
      const pts = rawSeries ?? [];
      const first = pts[0]?.date ?? dateISO;
      const last = pts[pts.length - 1]?.date ?? dateISO;
      exploration.openPoint("investments", dateISO, first, last);
    },
    [rawSeries, exploration],
  );

  // Trust envelope — resolved from the UNCONVERTED historical (currency-agnostic tiers),
  // reusing the ONE canonical resolver. Memoized so the effect only fires on change, and
  // the SAME envelope drives the hero's confidence chip (they can never disagree).
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "investments", investmentsResult: raw?.historical ?? null }),
    [raw],
  );
  useEffect(() => { onEnvelopeChange?.(envelope); }, [envelope, onEnvelopeChange]);

  // Display-currency conversion (pure; identity when reporting === target).
  const data = useMemo(() => (raw && ctx ? convertInvestmentsSpaceData(raw, ctx, asOf) : raw), [raw, ctx, asOf]);
  const series = useMemo(() => (ctx ? convertPortfolioValueSeries(rawSeries, ctx, asOf) : rawSeries), [rawSeries, ctx, asOf]);

  // B-6 — SERVER-AUTHORITATIVE classification (lib/time/basis.ts): asOf is
  // historical iff the SERVER's UTC day says so. `serverToday` rides every
  // /space-data response; the client `today` prop is only the pre-first-fetch
  // fallback (where `data` is null and this is false regardless). Before B-6
  // this compared the client clock while lib/history/account-series.ts compared
  // the server's — around midnight the same date sat on both sides at once.
  const historicalMode = !!data && isHistoricalDay(asOf, serverToday ?? today) && data.historical != null;
  const primary = data ? (historicalMode && data.historical ? data.historical : data.current) : null;

  // Publish section anchors to the sidebar once real holdings exist (cleared on unmount).
  const publishSections = useSpaceSectionsPublisher();
  const showSections = !!primary && (primary.holdings.length > 0 || primary.portfolio.unvaluedCount > 0);
  useEffect(() => {
    if (embedded) return; // the Assets page publishes ONE list for the whole page
    publishSections(showSections ? INVESTMENTS_SECTIONS : []);
    return () => publishSections([]);
  }, [publishSections, showSections, embedded]);

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

  // The investment ACCOUNTS behind the canonical figure (current day). An account
  // with a balance but no holdings is still an investment asset — it is listed,
  // not replaced by "No holdings" (lib/investments/investment-accounts.ts).
  const accountsLedger = !historicalMode && data.accounts && data.accounts.rows.length > 0 ? (
    <Block id="investments-accounts" label="Accounts"
      hint={<span className="text-[11px] tabular-nums text-[var(--text-faint)]">{data.accounts.rows.length}</span>}>
      <InvestmentAccountsLedger slice={data.accounts} />
    </Block>
  ) : null;

  const isEmpty = primary.holdings.length === 0 && primary.portfolio.unvaluedCount === 0;
  if (isEmpty && accountsLedger) {
    // Balances without security-level holdings: the accounts ARE the investment
    // picture. No $0 "portfolio value", no "connect a brokerage" — the money is here.
    return <div className="space-y-8 min-w-0">{accountsLedger}</div>;
  }
  if (isEmpty) {
    return (
      <div className="space-y-8 min-w-0">
        {!embedded && (
          <InvestmentsHero
            attribution={data?.historical?.attribution ?? null}
            portfolio={primary.portfolio} reconciliation={reconciliation}
            reportingCurrency={reportingCurrency} figureLabel={figureLabel} asOf={asOf} envelope={envelope}
          />
        )}
        <Surface className="px-4 py-8 text-center">
          <TrendingUp size={22} className="mx-auto text-[var(--text-faint)]" />
          <p className="mt-2 text-sm font-medium text-[var(--text-secondary)]">No holdings for this date</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Connect a brokerage or exchange, or pick a later date, to see your holdings here.</p>
          <Link href="/dashboard/connections" className="mt-3 inline-block text-sm font-semibold text-[var(--meridian-400)] hover:underline">
            Connect an investment account →
          </Link>
        </Surface>
      </div>
    );
  }

  // v2.7 visual-first — valuation accuracy as ONE compact status chip, shown
  // only when the valuation is partial ("Partial · 3 of 5 valued"); the reason
  // is the chip's accessible description. Replaces the Excluded banner and the
  // section hero's "N of M positions valued" line. The section's own trust chip
  // (the investments envelope) sits beside it, silent on the clean tier.
  const unvalued = primary.portfolio.unvaluedCount;
  const statusRow = (
    <div className="flex flex-wrap items-center gap-2 empty:hidden" data-investments-status>
      {unvalued > 0 && (
        <ValuationAccuracyChip
          valued={primary.portfolio.valuedCount}
          total={primary.portfolio.valuedCount + unvalued}
          reason={primary.portfolio.unvalued[0]?.reason}
        />
      )}
      {embedded && <TrustIndicator variant="compact" envelope={envelope} />}
    </div>
  );

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!">
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-faint)]">
          <Loader2 size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      {/* ① Lede — standalone only. Embedded (Assets → Investments), the page's
          own Investments hero states the slice; no second "Valued holdings" card. */}
      {!embedded && (
        <div id="investments-summary" className="scroll-mt-20">
          <InvestmentsHero
            attribution={data?.historical?.attribution ?? null}
            portfolio={primary.portfolio} reconciliation={reconciliation}
            reportingCurrency={reportingCurrency} figureLabel={figureLabel} asOf={asOf} envelope={envelope}
          />
        </div>
      )}

      {/* ② Balance history — invested value over time (the SHARED Net Worth chart).
           Embedded, the unified Assets chart above already slices to this SAME
           series WITH this lens's per-point confidence + coverage disclosures
           (wealth-trend-points.ts), so a second identical chart is not drawn. */}
      {!embedded && (
        <div id="investments-history" className="scroll-mt-20">
          <InvestmentsBalanceHistory points={series} currency={reportingCurrency} asOf={asOf} compareTo={compareTo} onSelectPoint={handleSelectPoint} />
        </div>
      )}

      {/* Valuation accuracy (only when partial) + the section's trust chip. */}
      {statusRow}

      {/* HIST-1D — shared-Space scope disclosure (transparency only; no number changes). */}
      {scopeDivergence && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--surface-inset)", color: "var(--text-muted)" }} role="note">
          <Info size={13} className="mt-0.5 shrink-0" aria-hidden />
          <span><span className="font-medium text-[var(--text-secondary)]">{scopeDivergence.title}.</span> {scopeDivergence.note}</span>
        </div>
      )}

      {/* ③ Holdings — top-few weight-bar ledger; the bar IS the allocation view. */}
      <Block
        id="investments-holdings"
        label="Holdings"
        hint={<span className="text-[11px] tabular-nums text-[var(--text-faint)]">{primary.holdings.length}</span>}
        action={<span className="text-[11px] text-[var(--text-faint)]">Top by value · bar shows share</span>}
      >
        <HoldingsLedger holdings={primary.holdings} reportingCurrency={reportingCurrency} accounts={accounts} />
      </Block>

      {/* ④ Allocation — "what do I own?" (the shared donut breakdown). */}
      <div id="investments-allocation" className="scroll-mt-20">
        {/* v2.7 — the grouping Dropdown sits in the Block header, outside and above
            the donut, exactly as Net Worth's "Where it sits" card does. */}
        <Block label="Allocation" action={<Dropdown options={ALLOCATION_GROUPINGS} value={allocationDimension} onChange={setAllocationDimension} ariaLabel="Allocation grouping" />}>
          <DataCard>
            <InvestmentAllocationPanel
              holdings={primary.holdings} accounts={accounts}
              reportingCurrency={reportingCurrency} showConcentrationInsight={false}
              dimension={allocationDimension}
            />
          </DataCard>
        </Block>
      </div>

      {/* ⑤ Concentration — "how exposed am I?" (largest / top-5 / sector). */}
      <div id="investments-concentration" className="scroll-mt-20">
        <Block label="Concentration">
          <HoldingsConcentration holdings={primary.holdings} accounts={accounts} />
        </Block>
      </div>

      {/* ⑥ Accounts — every investment account at its balance; holdings enrich it. */}
      {accountsLedger}

      {/* ⑦ This period — the opening → in → out → change → closing movement bridge. */}
      <div id="investments-period" className="scroll-mt-20">
        <Block label="This period">
          <Surface className="p-4"><InvestmentsBridgeCard reconciliation={reconciliation} flows={flows} attribution={data?.historical?.attribution ?? null} /></Surface>
        </Block>
      </div>
    </div>
  );
}

/**
 * v2.7 visual-first — the valuation-accuracy status: a visible chip
 * ("Partial · 3 of 5 valued") whose reason (which positions, why, and that they
 * are not counted) is its title AND its accessible description. Never a prose
 * banner; rendered only when at least one position could not be valued.
 */
export function ValuationAccuracyChip({ valued, total, reason }: { valued: number; total: number; reason?: string }): ReactNode {
  const id = `valuation-accuracy-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const missing = total - valued;
  const detail = `${missing} position${missing === 1 ? "" : "s"} couldn't be valued for this date${reason ? ` — ${reason}` : ""} — not counted in the figures.`;
  return (
    <>
      <span
        role="note"
        title={detail}
        aria-describedby={id}
        data-valuation-accuracy
        className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[11px] font-medium tabular-nums"
        style={{ color: "var(--accent-warning)", background: "color-mix(in srgb, var(--accent-warning) 12%, transparent)" }}
      >
        Partial · {valued} of {total} valued
      </span>
      <span id={id} className="sr-only">{detail}</span>
    </>
  );
}
