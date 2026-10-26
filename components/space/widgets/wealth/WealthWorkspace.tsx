"use client";

/**
 * components/space/widgets/wealth/WealthWorkspace.tsx  (SD-5 · OVERVIEW-CONSOLIDATION)
 *
 * The Net Worth WORKSPACE — the render + composition boundary for the
 * historical Wealth lens, and (since the Overview consolidation) the ONE host
 * of the three page-level MODES the Net Worth page is read through:
 *
 *   Total   — the net-worth experience (default): hero → balance history →
 *             composition + what-moved-it → explanation / evidence.
 *   Assets  — total assets, with the SAME instruments re-aimed at assets, the
 *             balance history SLICEABLE (All · Cash · Investments), and Cash +
 *             Investments living INSIDE the page as sections (the former
 *             Liquidity and Investments workspaces, embedded — same hooks, same
 *             authorities, same surfaces; only their duplicate hero/chart
 *             wrappers are folded into the page's own). RWA-1 adds a third
 *             section, Real assets — the user's manual estimates (homes,
 *             vehicles, valuables) with Add asset / Update value / Archive.
 *   Debt    — the complete Debt workspace, rendered as a mode.
 *
 * Cash and Investments are NOT navigation. Navigation represents concepts;
 * sections represent depth.
 *
 *   host-fetched, SHARED snapshots (Debt / Cash / Investments read the same rows)
 *        + shell time (asOf / compareTo)  + display ConversionContext
 *     → convertWealthSnapshots(...)   ← per-date display-currency FX (this workspace)
 *     → computeWealthTimeMachine(...) ← THE canonical Wealth read model (unchanged)
 *     → WealthResult
 *     → the surfaces + the shell trust envelope (emitted up via onEnvelopeChange)
 *
 * TRUST OWNERSHIP (the consolidation's one structural constraint): the shell
 * shows ONE envelope. In Total and Assets this workspace emits the Wealth
 * envelope; the embedded Cash / Investments sections emit nothing upward and
 * keep their OWN per-figure TrustIndicators. In Debt, the Debt workspace emits
 * its own envelope and this workspace stays silent. The same rule governs the
 * sidebar: exactly one publisher per mode.
 *
 * The workspace owns NO time state (asOf/compareTo are shell props), does NOT
 * fetch snapshots (a Space-level shared resource), and does NOT own the mode or
 * slice (URL-synced in useSpaceNavigation — the evolved `?metric=` mechanism).
 */

import { summarizeCryptoPricing } from "@/lib/prices/current-quote.core";
import { CompactSectionTabs, compactHidden } from "@/components/space/compact/CompactSectionTabs";
import { assetsCompactVisibility } from "@/components/space/compact/compact-sections";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  computeWealthTimeMachine,
  type WealthResult,
} from "@/lib/wealth/wealth-time-machine";
import { convertWealthSnapshots } from "@/lib/wealth/display-conversion";
import {
  ASSETS_SLICES, ASSETS_SLICE_LABELS, WEALTH_MODES, WEALTH_MODE_LABELS, wealthSeriesKey,
  type AssetsSlice, type WealthMode,
  type DebtSection,
} from "@/lib/wealth/wealth-mode";
import { buildPortfolioValueSeries } from "@/lib/investments/portfolio-series";
import { classifyAccounts } from "@/lib/account-classifier";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceChrome, useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import { SpaceReadFailure } from "@/components/space/SpaceReadFailure";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { ExpenseBaseline } from "@/lib/liquidity/expense-baseline";
import type { SpaceAccount } from "@/lib/space/dashboard-types";
import { Chips } from "@/components/atlas/Chips";
import { EvidenceDrawer } from "@/components/space/shell/EvidenceDrawer";
import { LiquidityWorkspace } from "@/components/space/widgets/liquidity/LiquidityWorkspace";
import { InvestmentsWorkspace } from "@/components/space/widgets/investments/InvestmentsWorkspace";
import { DebtWorkspace } from "@/components/space/widgets/debt/DebtWorkspace";
import { RealAssetsSection } from "./RealAssetsSection";
import { WealthHero, wealthSecondaryRows, SecondaryChange } from "./WealthHero";
import { CompactKpiStrip } from "@/components/space/compact/CompactKpiStrip";
import { formatCurrency } from "@/lib/currency";
import { WealthTrendChart } from "./WealthTrendChart";
import { useHistoryExploration } from "@/components/history/useHistoryExploration";
import type { LensRoot } from "@/lib/history/lens-root-node";
import { WealthChangeLedger } from "./WealthChangeLedger";
import { WealthCompositionCard } from "./WealthCompositionCard";
import { WealthExplanationCard } from "./WealthExplanationCard";
import { WealthUnavailable } from "./wealth-ui";

/** The Total mode's section anchors — the sidebar's "what's inside". */
export const WEALTH_TOTAL_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",         anchor: "wealth-summary" },
  { label: "Balance history", anchor: "wealth-trend" },
  { label: "Composition",     anchor: "wealth-composition" },
  { label: "What moved it",   anchor: "wealth-ledger" },
  { label: "Explanation",     anchor: "wealth-explanation" },
];

/**
 * The Assets mode's section anchors. Summary → Balance history → Composition →
 * What moved it are the wealth instruments (they need snapshot history); Cash and
 * Investments are the embedded sections (they carry their own data and render
 * regardless). Built per render so every published row has an element.
 */
export function assetsSections(args: { hasHistory: boolean }): SpaceChromeSection[] {
  return [
    ...(args.hasHistory ? [
      { label: "Summary",         anchor: "wealth-summary" },
      { label: "Balance history", anchor: "wealth-trend" },
      { label: "Composition",     anchor: "wealth-composition" },
      { label: "What moved it",   anchor: "wealth-ledger" },
    ] : []),
    { label: "Cash",        anchor: "wealth-cash" },
    { label: "Investments", anchor: "wealth-investments" },
    { label: "Real assets", anchor: "wealth-real-assets" },
  ];
}

/** Inputs the embedded CASH section (the former Liquidity workspace) needs. */
export interface WealthCashInputs {
  expenseBaseline?: ExpenseBaseline | null;
  presentLens?:     LensResult | null;
  transactions?:    Transaction[] | null;
  transactionsMeta?: TransactionsCoverage | null;
  txCtx?:           ConversionContext;
  period?:          CashFlowPeriod;
  onOpenCashFlow?:  () => void;
}

/** Inputs the DEBT mode (the Debt workspace) needs beyond the shared ones. */
export interface WealthDebtInputs {
  ficoScore?:      number | null;
  ficoUpdatedAt?:  string;
  presentLens?:    LensResult | null;
  targetCurrency?: string;
}

export function WealthWorkspace({
  spaceId,
  snapshots,
  snapshotCurrency,
  asOf,
  compareTo,
  historicalCompareTo,
  today,
  accounts,
  ctx,
  mode = "total",
  onModeChange,
  modeSelectorVisibility = "always",
  freshnessLabel = null,
  timePreset,
  slice = "all",
  onSliceChange,
  debtSection = "all",
  onDebtSectionChange,
  focusSection = null,
  active = true,
  cash,
  debt,
  onEnvelopeChange,
  backfillInProgress,
  spaceType,
  snapshotsError = null,
  onRetrySnapshots,
}: {
  spaceId:          string;
  /**
   * RWA-2B — "PERSONAL" | "SHARED", display-only: the Real assets section offers
   * "Update past net worth?" only in a PERSONAL Space (the amend route refuses a
   * SHARED one anyway). Absent ⇒ never offered (fail closed).
   */
  spaceType?:       string;
  snapshots:        Snapshot[] | null | undefined;
  /** The currency the snapshot totals are stamped in (the FX from-currency). */
  snapshotCurrency: string;
  asOf:             string;
  compareTo:        string | null;
  /** compareTo clamped strictly earlier than asOf — the historical routes the
   *  embedded Cash / Investments / Debt data hooks call 400 otherwise. */
  historicalCompareTo: string | null;
  today:            string;
  /** The Space's visibility-filtered accounts — the ONE array every mode reads. */
  accounts:         SpaceAccount[];
  /** Display ConversionContext — `ctx.target` is the member's selected display currency. */
  ctx?:             ConversionContext;
  /** The page-level subject (Total · Assets · Debt) — URL-synced by the host. */
  mode?:            WealthMode;
  onModeChange?:    (m: WealthMode) => void;
  /**
   * Where the Total · Assets · Debt selector is SHOWN. "belowLg" — only below
   * the `lg` breakpoint, for a host whose desktop sidebar carries these three
   * views nested under Net Worth (a customer Space). The same selector, the same
   * `mode` state; display only — the exact complement of the sidebar's `lg:block`.
   */
  modeSelectorVisibility?: "always" | "belowLg";
  /** v2.7 P0 — the canonical freshness claim for the compact hero (null ⇒ "As of <snapshot date>"). */
  freshnessLabel?: string | null;
  /** v2.7 R6 — the shell slice id, for the compact AI entry link only (allowlisted there). */
  timePreset?: string;
  /** The Assets balance-history slice (All · Cash · Investments) — URL-synced by the host. */
  slice?:           AssetsSlice;
  onSliceChange?:   (s: AssetsSlice) => void;
  /** COMPACT DASHBOARD (P3) — the compact Debt category (All · Credit · Loans), host-owned (?section=). */
  debtSection?:          DebtSection;
  onDebtSectionChange?:  (s: DebtSection) => void;
  /** A one-shot Assets section to scroll to on arrival (a legacy lens deep link). */
  focusSection?:    "cash" | "investments" | null;
  /** Gate for the embedded historical fetches — true while this is the open lens. */
  active?:          boolean;
  cash?:            WealthCashInputs;
  debt?:            WealthDebtInputs;
  onSwitchLens?:    (lensId: string) => void;
  /** Bridge the workspace's trust envelope up to the shell Completeness/Evidence chip. */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
  /** Part-6 — a snapshot backfill is actively running for this Space. */
  backfillInProgress?: boolean;
  /**
   * UI-006 — the shared snapshot read FAILED (the sentence to show), or null.
   * A failure is never "No wealth history yet": with no history loaded it
   * replaces the empty state; over stale history it is a one-line notice.
   */
  snapshotsError?: string | null;
  onRetrySnapshots?: () => void;
}) {
  // ── v2.6 — shared historical exploration ───────────────────────────────────
  const exploration = useHistoryExploration();

  // ── Effective display currency + per-date FX (display-currency ACTIVATION) ──
  const canConvert = !!(ctx && snapshotCurrency);
  const displayCurrency = canConvert ? ctx!.target : (snapshotCurrency ?? ctx?.target ?? "USD");
  const convertedSnapshots = useMemo(
    () => (canConvert ? convertWealthSnapshots(snapshots ?? [], snapshotCurrency!, ctx!) : (snapshots ?? [])),
    [snapshots, snapshotCurrency, ctx, canConvert],
  );
  const result: WealthResult = useMemo(
    () => computeWealthTimeMachine({
      snapshots: convertedSnapshots,
      asOf,
      compareTo,
      currency: displayCurrency,
    }),
    [convertedSnapshots, asOf, compareTo, displayCurrency],
  );

  // The canonical Investments series over the SAME converted rows — the ONE
  // classifier of per-point confidence / coverage the Investments lens plotted.
  // Joined onto the Assets chart when it is sliced to Investments; never a second
  // valuation (the values are stocks + crypto on the same row either way).
  const investedSeries = useMemo(
    () => buildPortfolioValueSeries(convertedSnapshots, displayCurrency),
    [convertedSnapshots, displayCurrency],
  );

  // The series the page plots — resolved from mode + slice (wealth-mode.ts).
  const metric = wealthSeriesKey(mode, slice);

  const chartPoints = result.chart.points;
  // THE SUBJECT SELECTS THE ROOT. A user looking at Assets and clicking a point
  // is asking about Assets, not about Net Worth. The Cash / Investments slices
  // resolve to the liquidity / investments roots — the same questions the former
  // peer lenses asked.
  const metricRoot: LensRoot =
    metric === "totalAssets" ? "assets"
    : metric === "cash" ? "liquidity"
    : metric === "invested" ? "investments"
    : metric === "totalLiabilities" ? "debt"
    : metric === "liquidNetWorth" ? "liquid-net-worth"
    : "net-worth";

  const handleSelectPoint = useCallback(
    (dateISO: string) => {
      const first = chartPoints[0]?.date ?? dateISO;
      const last = chartPoints[chartPoints.length - 1]?.date ?? dateISO;
      exploration.openPoint(metricRoot, dateISO, first, last);
    },
    [chartPoints, exploration, metricRoot],
  );

  // V25-FINAL-1 — FX incompleteness of the CURRENT net-worth composition.
  const fxUnconverted = useMemo(
    () => (ctx && accounts && accounts.length > 0 ? classifyAccounts(accounts, ctx).unconverted : false),
    [accounts, ctx],
  );

  // Trust envelope — resolved from THIS workspace's own result, emitted up to the
  // shell chip in Total / Assets. In Debt the Debt workspace owns the slot.
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: result, currency: displayCurrency, fxUnconverted }),
    [result, displayCurrency, fxUnconverted],
  );
  useEffect(() => {
    if (mode === "debt") return; // DebtWorkspace emits its own
    onEnvelopeChange(envelope);
  }, [envelope, onEnvelopeChange, mode]);

  // Sidebar — ONE publisher per mode. Total: the wealth slots (once history
  // exists, not mid-backfill). Assets: the wealth slots + Cash + Investments
  // (the embedded sections publish nothing). Debt: DebtWorkspace publishes.
  const publishSections = useSpaceSectionsPublisher();
  const hasWealthSlots = !backfillInProgress && result.hasHistory;
  useEffect(() => {
    if (mode === "debt") return;
    publishSections(
      mode === "assets"
        ? assetsSections({ hasHistory: hasWealthSlots })
        : hasWealthSlots ? WEALTH_TOTAL_SECTIONS : [],
    );
    return () => publishSections([]);
  }, [publishSections, hasWealthSlots, mode]);

  // Legacy-link arrival (?perspective=liquidity | investments): scroll ONCE to
  // the section the old lens was, and light its sidebar row. Deferred until the
  // shared snapshots have landed (the wealth slots above the section mount
  // then, and would otherwise push the target back down). Consumed once —
  // never on a later slice change, which the user made deliberately.
  const { setActiveSection } = useSpaceChrome();
  const focused = useRef(false);
  const snapshotsLoaded = snapshots != null && !backfillInProgress;
  useEffect(() => {
    if (focused.current || !focusSection || mode !== "assets" || !snapshotsLoaded) return;
    focused.current = true;
    const label = focusSection === "cash" ? "Cash" : "Investments";
    // Next paint: the slots above render in the same commit as `hasHistory`.
    const t = window.setTimeout(() => {
      document.getElementById(`wealth-${focusSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveSection(label);
    }, 50);
    return () => window.clearTimeout(t);
  }, [focusSection, mode, snapshotsLoaded, setActiveSection]);

  // Evidence drawer — workspace-owned. Opened from the Explanation card.
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  // ── The page-level subject selector (Total · Assets · Debt) ─────────────────
  // The evolved WealthMetric switcher, promoted out of the chart header: it
  // represents the SUBJECT of the page, so it sits under the shell, above the hero.
  const modeSelector = (
    <div
      data-wealth-mode-row
      className={["flex justify-center px-1", modeSelectorVisibility === "belowLg" ? "lg:hidden" : ""].join(" ").trim()}
    >
      {modeSelectorVisibility === "belowLg" ? (
        /* v2.7 P0 — compact-only (the row is lg:hidden for this host): the
           prominent full-width segmented selector over the SAME mode/handler. */
        <div className="lg:hidden w-full">
          <CompactSectionTabs
            ariaLabel="Net worth view"
            variant="primary"
            value={mode}
            onChange={(m) => onModeChange?.(m)}
            tabs={WEALTH_MODES.map((m) => ({ id: m, label: WEALTH_MODE_LABELS[m], controls: [] }))}
          />
        </div>
      ) : (
        <Chips
          options={WEALTH_MODES.map((m) => ({ id: m, label: WEALTH_MODE_LABELS[m] }))}
          value={mode}
          onChange={(m) => onModeChange?.(m)}
          ariaLabel="Net worth view"
          className="justify-center"
        />
      )}
    </div>
  );

  // UI-006 — the snapshot read failed but earlier history is on screen.
  const staleSnapshotsNotice = snapshotsError && snapshots != null ? (
    <SpaceReadFailure variant="inline" what="wealth history" message={snapshotsError} onRetry={onRetrySnapshots} />
  ) : null;

  // ── Debt — the complete Debt workspace as a mode ────────────────────────────
  if (mode === "debt") {
    return (
      <div className="space-y-6 min-w-0">
        {modeSelectorVisibility !== "belowLg" && modeSelector}
        {snapshotsError && (
          <SpaceReadFailure
            variant={snapshots != null ? "inline" : "card"}
            what="wealth history"
            message={snapshotsError}
            onRetry={onRetrySnapshots}
          />
        )}
        <DebtWorkspace
          spaceId={spaceId}
          asOf={asOf}
          compareTo={historicalCompareTo}
          today={today}
          active={active}
          accounts={accounts}
          ctx={ctx}
          snapshots={snapshots}
          snapshotCurrency={snapshotCurrency}
          ficoScore={debt?.ficoScore}
          ficoUpdatedAt={debt?.ficoUpdatedAt}
          presentLens={debt?.presentLens ?? null}
          targetCurrency={debt?.targetCurrency}
          onEnvelopeChange={onEnvelopeChange}
          timePreset={timePreset}
          // COMPACT DASHBOARD (P3) — the compact hierarchy inside Debt: Debt hero →
          // Total · Assets · Debt (this lg:hidden selector) → All · Credit · Loans.
          compactModeSelector={modeSelectorVisibility === "belowLg" ? modeSelector : undefined}
          compactSection={debtSection}
          onCompactSectionChange={onDebtSectionChange}
        />
      </div>
    );
  }

  // ── The Assets slice control (chart header) ─────────────────────────────────
  // COMPACT DASHBOARD (P2): below lg the category tabs carry the slice, so the
  // chart-header chips are compact-hidden (max-lg:hidden — unchanged on desktop).
  const sliceControl = mode === "assets" ? (
    <Chips
      options={ASSETS_SLICES.map((s) => ({ id: s, label: ASSETS_SLICE_LABELS[s] }))}
      value={slice}
      onChange={(s) => onSliceChange?.(s)}
      ariaLabel="Assets series"
      className="max-lg:hidden"
    />
  ) : undefined;

  // ── COMPACT DASHBOARD (P2) — Assets category tabs (<lg only) ────────────────
  // All · Cash · Investments ARE the existing slice (?slice=, replace-written),
  // so the chart series and the visible content can never disagree. A tab shows
  // its sections on compact; the others are max-lg:hidden (display:none below
  // lg — not focusable, not exposed). At ≥1024px every section renders as today.
  //   All         — the complete Assets experience (incl. Real assets)
  //   Cash        — the Cash/Liquidity section
  //   Investments — Investments (incl. crypto) + Real assets as a DISTINCT
  //                 subsection: navigation only, never a reclassification
  const compact = assetsCompactVisibility(slice);
  const assetsTabs = mode === "assets" ? (
    <CompactSectionTabs
      ariaLabel="Assets category"
      value={slice}
      onChange={(s) => onSliceChange?.(s)}
      tabs={ASSETS_SLICES.map((s) => ({
        id: s,
        label: ASSETS_SLICE_LABELS[s],
        controls: s === "cash" ? ["wealth-cash"]
          : s === "investments" ? ["wealth-investments", "wealth-real-assets"]
          : ["wealth-cash", "wealth-investments", "wealth-real-assets"],
      }))}
    />
  ) : null;

  // ── The embedded Assets sections (Cash · Investments · Real assets) ─────────
  // Same hooks, same authorities, same surfaces as the former peer lenses; each
  // keeps its own per-figure trust and stays silent toward the shell.
  const assetsSectionsBody = mode === "assets" ? (
    <>
      <section id="wealth-cash" className={`scroll-mt-20 border-t border-[var(--border-hairline)] pt-8 ${compactHidden(!compact.cash)}`.trim()}>
        <SectionTitle>Cash</SectionTitle>
        <LiquidityWorkspace
          embedded
          spaceId={spaceId}
          asOf={asOf}
          compareTo={historicalCompareTo}
          today={today}
          active={active}
          accounts={accounts}
          ctx={ctx}
          snapshots={snapshots}
          snapshotCurrency={snapshotCurrency}
          expenseBaseline={cash?.expenseBaseline}
          presentLens={cash?.presentLens ?? null}
          transactions={cash?.transactions}
          transactionsMeta={cash?.transactionsMeta}
          txCtx={cash?.txCtx}
          period={cash?.period}
          onOpenCashFlow={cash?.onOpenCashFlow}
        />
      </section>
      <section id="wealth-investments" className={`scroll-mt-20 border-t border-[var(--border-hairline)] pt-8 ${compactHidden(!compact.investments)}`.trim()}>
        <SectionTitle>Investments</SectionTitle>
        <InvestmentsWorkspace
          embedded
          spaceId={spaceId}
          asOf={asOf}
          compareTo={historicalCompareTo}
          active={active}
          today={today}
          accounts={accounts}
          ctx={ctx}
        />
      </section>
      <section id="wealth-real-assets" className={`scroll-mt-20 border-t border-[var(--border-hairline)] pt-8 ${compactHidden(!compact.realAssets)}`.trim()}>
        <SectionTitle>Real assets</SectionTitle>
        {/* COMPACT DASHBOARD (P2) — on the Investments tab, say what the grouping is
            (and is not): navigation only. Real assets keep their own classification,
            valuation history and details; they are not securities and are not part
            of the Investments figures or chart above. */}
        {slice === "investments" && (
          <p className="lg:hidden -mt-3 mb-5 text-[12px] leading-snug text-[var(--text-muted)]" data-compact-real-assets-note>
            Grouped here for navigation. Real assets keep their own valuations and are not counted in the Investments figures or chart above.
          </p>
        )}
        <RealAssetsSection spaceId={spaceId} spaceType={spaceType} active={active} />
      </section>
    </>
  ) : null;

  // Part-6 — while a backfill is running, the snapshot series is still being
  // written, so a partial WealthResult must NOT render as if final.
  if (backfillInProgress) {
    return (
      <div className="space-y-6 min-w-0">
        {modeSelector}
        {assetsTabs}
        <div
          className="rounded-2xl border p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[220px]"
          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
        >
          <Loader2 className="animate-spin" size={26} style={{ color: "var(--meridian-400)" }} />
          <div className="max-w-sm">
            <p className="text-sm font-semibold text-[var(--text-primary)]">Creating your 30-day snapshot history…</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              We&rsquo;re reconstructing balance history from the accounts you just connected.
              This can take a few minutes — the chart appears here the moment it&rsquo;s ready.
            </p>
          </div>
        </div>
        {assetsSectionsBody}
      </div>
    );
  }

  // UI-006 — nothing loaded AND the read failed: say so, never "No wealth history yet".
  if (snapshotsError && !result.hasHistory) {
    return (
      <div className="space-y-6 min-w-0">
        {modeSelector}
        {assetsTabs}
        <SpaceReadFailure what="wealth history" message={snapshotsError} onRetry={onRetrySnapshots} />
        {assetsSectionsBody}
      </div>
    );
  }

  if (!result.hasHistory) {
    return (
      <div className="space-y-6 min-w-0">
        {modeSelector}
        <div
          className="rounded-2xl border p-8"
          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
        >
          <WealthUnavailable message="No wealth history yet. Once this Space accrues daily snapshots (or you connect accounts), the historical Wealth perspective builds itself — nothing is fabricated in the meantime." />
        </div>
        {assetsTabs}
        {assetsSectionsBody}
      </div>
    );
  }

  const canViewEvidence = !!envelope.evidence?.rows?.length;

  // v2.7 R4 — the compact KPI strip under the chart: the hero's OWN secondary
  // stat rows (Total: Assets · Liabilities · Liquid NW; Assets: Cash ·
  // Investments), which the compact hero hides. Same rows, same as-of figures,
  // same change formatting — stated once on compact, never on desktop.
  const kpiItems = result.asOfState.found
    ? wealthSecondaryRows(result, metric).map((row) => ({
        key: row.key,
        label: row.label,
        value: formatCurrency(result.asOfState[row.key], displayCurrency),
        change: <SecondaryChange delta={result.deltas?.[row.key]} goodDirection={row.goodDirection} currency={displayCurrency} className="" />,
      }))
    : [];

  return (
    <>
      <div className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!">
        {modeSelectorVisibility !== "belowLg" && modeSelector}
        {staleSnapshotsNotice}

        {/* ① Hero — the headline scalar of the page's subject. */}
        <div id="wealth-summary" className="scroll-mt-20">
          <WealthHero result={result} currency={displayCurrency} envelope={envelope} metric={metric} freshnessLabel={freshnessLabel} timePreset={timePreset}
            cryptoPriceNote={result.asOfState.date === today ? summarizeCryptoPricing((accounts ?? []).map((a) => a.cryptoPrice)) : null} />
        </div>

        {/* COMPACT DASHBOARD (P2) — the compact hierarchy is hero → Total · Assets ·
            Debt → category tabs → content. The selector here is lg:hidden
            (modeSelectorVisibility "belowLg"), so its position is invisible at ≥1024px. */}
        {modeSelectorVisibility === "belowLg" && modeSelector}
        {assetsTabs}

        {/* ② Trend — the dominant honesty chart; in Assets, sliceable. */}
        {/* v2.7 R4 — compact-only (max-lg:*) tightening of the chart header and
            legend; at ≥1024px these utilities never apply. */}
        <div id="wealth-trend" className="scroll-mt-20 max-lg:[&>section>div:first-child]:mb-3 max-lg:[&>section>div:last-child>div:last-child]:mt-2 max-lg:[&>section>div:last-child>div:last-child]:gap-x-3 max-lg:[&>section>div:last-child>div:last-child]:text-[10px]">
          <WealthTrendChart
            result={result}
            currency={displayCurrency}
            metric={metric}
            investedSeries={investedSeries}
            headerRight={sliceControl}
            onSelectPoint={handleSelectPoint}
          />
        </div>

        <CompactKpiStrip ariaLabel={`${mode === "assets" ? "Assets" : "Net worth"} breakdown`} items={kpiItems} />

        {/* ③ Composition (7) + ④ Change ledger / what-moved-it (5). */}
        <div className={`grid gap-6 lg:grid-cols-12 lg:gap-8 items-start ${compactHidden(mode === "assets" && !compact.composition)}`.trim()}>
          <div id="wealth-composition" className="scroll-mt-20 min-w-0 lg:col-span-7">
            <WealthCompositionCard result={result} currency={displayCurrency} accounts={accounts} ctx={ctx} metric={metric} />
          </div>
          <div id="wealth-ledger" className="scroll-mt-20 min-w-0 lg:col-span-5">
            <WealthChangeLedger result={result} currency={displayCurrency} metric={metric} />
          </div>
        </div>

        {/* ⑤ Total: Explanation. Assets: the Cash + Investments sections. */}
        {mode === "total" && (
          <div id="wealth-explanation" className="scroll-mt-20">
            <WealthExplanationCard
              result={result}
              currency={displayCurrency}
              onViewEvidence={canViewEvidence ? () => setEvidenceOpen(true) : undefined}
            />
          </div>
        )}
        {assetsSectionsBody}
      </div>
      {envelope.evidence && (
        <EvidenceDrawer
          open={evidenceOpen}
          onClose={() => setEvidenceOpen(false)}
          evidence={envelope.evidence}
        />
      )}
    </>
  );
}

/** The embedded section's title row — the page's section register (a Block label). */
function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="mb-5 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</h2>
  );
}
