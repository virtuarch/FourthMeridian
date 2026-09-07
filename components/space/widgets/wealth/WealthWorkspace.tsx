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
 *             wrappers are folded into the page's own).
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
} from "@/lib/wealth/wealth-mode";
import { buildPortfolioValueSeries } from "@/lib/investments/portfolio-series";
import { classifyAccounts } from "@/lib/account-classifier";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceChrome, useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { ExpenseBaseline } from "@/lib/liquidity/expense-baseline";
import type { SpaceAccount } from "@/lib/space/dashboard-types";
import { Chips } from "@/components/atlas/Chips";
import { EvidenceDrawer } from "@/components/space/shell/EvidenceDrawer";
import { LiquidityWorkspace } from "@/components/space/widgets/liquidity/LiquidityWorkspace";
import { InvestmentsWorkspace } from "@/components/space/widgets/investments/InvestmentsWorkspace";
import { DebtWorkspace } from "@/components/space/widgets/debt/DebtWorkspace";
import { WealthHero } from "./WealthHero";
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
  slice = "all",
  onSliceChange,
  focusSection = null,
  active = true,
  cash,
  debt,
  onEnvelopeChange,
  backfillInProgress,
}: {
  spaceId:          string;
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
  /** The Assets balance-history slice (All · Cash · Investments) — URL-synced by the host. */
  slice?:           AssetsSlice;
  onSliceChange?:   (s: AssetsSlice) => void;
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
    <div className="flex justify-center px-1">
      <Chips
        options={WEALTH_MODES.map((m) => ({ id: m, label: WEALTH_MODE_LABELS[m] }))}
        value={mode}
        onChange={(m) => onModeChange?.(m)}
        ariaLabel="Net worth view"
        className="justify-center"
      />
    </div>
  );

  // ── Debt — the complete Debt workspace as a mode ────────────────────────────
  if (mode === "debt") {
    return (
      <div className="space-y-6 min-w-0">
        {modeSelector}
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
        />
      </div>
    );
  }

  // ── The Assets slice control (chart header) ─────────────────────────────────
  const sliceControl = mode === "assets" ? (
    <Chips
      options={ASSETS_SLICES.map((s) => ({ id: s, label: ASSETS_SLICE_LABELS[s] }))}
      value={slice}
      onChange={(s) => onSliceChange?.(s)}
      ariaLabel="Assets series"
    />
  ) : undefined;

  // ── The embedded Assets sections (Cash · Investments) ───────────────────────
  // Same hooks, same authorities, same surfaces as the former peer lenses; each
  // keeps its own per-figure trust and stays silent toward the shell.
  const assetsSectionsBody = mode === "assets" ? (
    <>
      <section id="wealth-cash" className="scroll-mt-20 border-t border-[var(--border-hairline)] pt-8">
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
      <section id="wealth-investments" className="scroll-mt-20 border-t border-[var(--border-hairline)] pt-8">
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
    </>
  ) : null;

  // Part-6 — while a backfill is running, the snapshot series is still being
  // written, so a partial WealthResult must NOT render as if final.
  if (backfillInProgress) {
    return (
      <div className="space-y-6 min-w-0">
        {modeSelector}
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
        {assetsSectionsBody}
      </div>
    );
  }

  const canViewEvidence = !!envelope.evidence?.rows?.length;

  return (
    <>
      <div className="space-y-8 sm:space-y-10 min-w-0">
        {modeSelector}

        {/* ① Hero — the headline scalar of the page's subject. */}
        <div id="wealth-summary" className="scroll-mt-20">
          <WealthHero result={result} currency={displayCurrency} envelope={envelope} metric={metric} />
        </div>

        {/* ② Trend — the dominant honesty chart; in Assets, sliceable. */}
        <div id="wealth-trend" className="scroll-mt-20">
          <WealthTrendChart
            result={result}
            currency={displayCurrency}
            metric={metric}
            investedSeries={investedSeries}
            headerRight={sliceControl}
            onSelectPoint={handleSelectPoint}
          />
        </div>

        {/* ③ Composition (7) + ④ Change ledger / what-moved-it (5). */}
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-8 items-start">
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
