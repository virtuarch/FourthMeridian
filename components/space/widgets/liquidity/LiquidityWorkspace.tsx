"use client";

/**
 * components/space/widgets/liquidity/LiquidityWorkspace.tsx
 *
 * The Liquidity WORKSPACE — rebuilt in the editorial idiom (the Debt redesign), presentation
 * only. It reuses the SD-6B LiquiditySpaceData contract + useLiquiditySpaceData hook + every
 * figure authority VERBATIM (no data / contract / engine / trust change) and re-composes them
 * as a stacked, generously-spaced read surface rather than a 12-col KPI card grid:
 *
 *   ① Summary        LiquidityHero          — accessible cash + coverage + window delta + trust
 *                                             (standalone only — see OVERVIEW-CONSOLIDATION)
 *   ② Balance history LiquidityBalanceHistory — the cashNow tier over time (shared TrendChart)
 *   ③ Resilience     coverage · concentration · reachability mix (+ accessible cash, embedded)
 *   ④ Distribution   CashDistribution       — total cash by account / institution / type (donut;
 *                                             grouping Dropdown in the Block header, default account)
 *   ⑤ Cash accounts  CashAccountsLedger     — every cash account, Available, status → AccountDetail
 *   ⑥ What changed   the shell-bridged driver window → Cash Flow doorway
 *
 * v2.7 Cash accounts — the former Sources ledger (reachable-only rows by horizon) is
 * REPLACED by ④ + ⑤. They state TOTAL CASH (every checking + savings ADJUSTED balance —
 * v2.7-P0 — restricted included: classifyAccounts' totalLiquid + totalRestrictedCash, the
 * net-worth "Cash" figure), and the ledger footer reconciles it to the Resilience
 * tile's ACCESSIBLE CASH (reachableNow) by pure subtraction of per-account figures.
 * The two are labelled distinctly and never conflated.
 *
 * ── The live anchor + the time machine (unchanged) ──────────────────────────────────────
 * The account-array surfaces (the Hero headline, Cash accounts, Resilience) are the LIVE
 * CURRENT ANCHOR — per-account readings of money you can reach RIGHT NOW, sourced from the
 * visibility-filtered `accounts` array (they cannot be reconstructed per-account historically,
 * and are never faked into the past). The TEMPORAL layer is the hero + trend (and the lens
 * verdict / trust envelope, read from the atAsOf lens):
 *   • present day  → the current lens verdict + the per-account Cash distribution/ledger.
 *   • historical   → the atAsOf lens verdict + trust; the distribution + ledger stay, labelled
 *                    "Current balances". (v2.7 — the former reconstructed-tiers section, with
 *                    its per-tier delta chips and "Net accessible change" row, was REMOVED at
 *                    the owner's request; the historical contract/route is untouched.)
 *
 * The Hero SAYS this in a historical view (the headline is present-day; only the trend, verdict,
 * and trust honour the selected date) rather than letting a present-day figure pass as as-of.
 *
 * FX posture (no new authority): the current-anchor surfaces convert live balances through the
 * existing ConversionContext seam. The historical endpoints pass through the pure
 * `convertLiquiditySpaceData` (the ONE canonical money authority) per-date; the cashNow chart
 * series passes through `convertCashHistory`. A missing rate degrades to an honest `estimated`
 * (≈) flag, never a silent relabel. The lede prose (`verdict`) stays the engine's self-consistent
 * reporting-currency sentence.
 *
 * Owns NO time state — asOf / compareTo / today are shell props threaded into the hook.
 *
 * OVERVIEW-CONSOLIDATION — Liquidity is no longer a peer Overview lens. This
 * workspace now renders EMBEDDED as the CASH SECTION of the unified Net Worth →
 * Assets page (`embedded`): the same data hook, the same figure authorities, the
 * same Sources / Resilience / What-changed surfaces. Embedded, it (a) draws no
 * hero — v2.7 visual-first moves the accessible-cash figure, its ≈ marker, its
 * trust chip and its present-day / withheld disclosures into a fourth Resilience
 * tile (the page's own Cash hero states the slice), (b) omits its own balance-history chart —
 * the Assets chart directly above slices to the SAME cashNow series — and (c)
 * publishes neither sidebar sections nor the shell envelope: the Assets page owns
 * both, while the Cash section keeps its own per-figure TrustIndicator so mixed
 * evidence is never flattened into page-wide certainty.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { classifyAccounts } from "@/lib/account-classifier";
import { reachableNow, accessTotals } from "@/components/space/widgets/liquidity-adapters";
import { formatAggregateMoney, useAggregateCurrency } from "@/components/space/widgets/display-money";
import { formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Snapshot, Transaction } from "@/types";
import type { LensResult } from "@/lib/perspective-engine/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import { convertLiquiditySpaceData } from "@/lib/liquidity/display-conversion";
import { clipCashHistory, convertCashHistory } from "@/lib/liquidity/cash-history";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import { Surface, Block } from "@/components/atlas/Surface";
import { TransactionCoverageNote } from "@/components/space/trust/TransactionCoverageNote";
import { LiquidityHero, type LiquidityWindowChange, type LiquidityCoverage } from "./LiquidityHero";
import { LiquidityBalanceHistory } from "./LiquidityBalanceHistory";
import { useHistoryExploration } from "@/components/history/useHistoryExploration";
import { CashDistribution } from "./CashDistribution";
import { CashAccountsLedger } from "./CashAccountsLedger";
import { Dropdown } from "@/components/atlas/Dropdown";
import {
  buildCashAccounts, CASH_GROUPINGS, DEFAULT_CASH_GROUPING, type CashGrouping, type CashLedgerAccount,
} from "./cash-accounts";
import { reachableDisclosure } from "@/lib/balances/reachable";
import { buildSourceRows } from "./liquidity-sources-util";
import { LiquidityWhatChangedCard } from "./LiquidityWhatChangedCard";
import { useLiquiditySpaceData } from "./useLiquiditySpaceData";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import { describeExpenseBaseline } from "@/lib/liquidity/expense-baseline";

function fmtMoney(v: number, ctx?: ConversionContext): string {
  // REVIEW-3 B-5 — no context ⇒ no currency claim (display-money.ts).
  return formatAggregateMoney(v, ctx);
}

export function LiquidityWorkspace({
  spaceId,
  asOf,
  compareTo,
  today,
  active,
  accounts,
  ctx,
  snapshots,
  snapshotCurrency,
  expenseBaseline,
  presentLens,
  transactions,
  transactionsMeta,
  txCtx,
  period,
  onOpenCashFlow,
  onEnvelopeChange,
  embedded = false,
}: {
  /** Rendered as the Cash section inside Net Worth → Assets (see header). */
  embedded?: boolean;
  spaceId: string;
  /** Resolved closing date (YYYY-MM-DD) from the shell. */
  asOf: string;
  /** Resolved opening date, or null; drives the comparison delta. */
  compareTo: string | null;
  /** The shell's "today"; asOf >= today (no comparison) ⇒ present-day (no fetch). */
  today: string;
  /** Gate — only fetch the historical contract while the Liquidity workspace is open. */
  active: boolean;
  /** The host's SpaceAccount rows (structurally): the liquidity fields plus the
   *  freshness / aggregate fields the Cash accounts ledger reads. */
  accounts: CashLedgerAccount[];
  ctx?: ConversionContext;
  /** The host's already-read Balance-Over-Time snapshots (the SAME array Wealth/Debt read) —
   *  the cashNow series is clipped from it. No new fetch (L0 — Debt precedent). */
  snapshots?: Snapshot[] | null;
  /** The stamped currency of the snapshot series (the history basis). */
  snapshotCurrency: string;
  /** The Space's monthly-expense baseline (emergency_fund_progress config), or null.
   *  Drives the honest Coverage stat; absent ⇒ no coverage shown (never fabricated). */
  /** v2.6-ASSESS-3 — the RESOLVED baseline + its basis, from the server. Null
   *  when neither a declared nor a measured figure exists: the surface then shows
   *  no coverage, exactly as before. */
  expenseBaseline?: import("@/lib/liquidity/expense-baseline").ExpenseBaseline | null;
  /** The host's already-fetched present-day liquidity lens (lensResults["liquidity"]).
   *  Reused as `current` on the present-day branch (byte-identical, no round-trip). */
  presentLens?: LensResult | null;
  /** S4 — the shell-bridged transaction window for the What Changed panel (current
   *  anchor; transaction-window filtering relative to today, NOT a balance-as-of read). */
  transactions?: Transaction[] | null;
  /** TX-2A — coverage state for the transaction-derived "What changed" drivers;
   *  surfaces an honest caveat when the shared read was capped. null ⇒ no note. */
  transactionsMeta?: TransactionsCoverage | null;
  txCtx?: ConversionContext;
  period?: CashFlowPeriod;
  onOpenCashFlow?: () => void;
  /** Emit the trust envelope up to the shell Completeness chip (the host owns no
   *  Liquidity data). Present-day ⇒ the current lens; historical ⇒ the atAsOf lens.
   *  Omitted when embedded — the Assets page owns the shell slot. */
  onEnvelopeChange?: (env: PerspectiveEnvelope) => void;
}) {
  // v2.6 — the LIQUIDITY root. Its children are TIERS, not buckets: liquidity
  // classifies by how fast an asset converts, and has no liability side at all.
  const exploration = useHistoryExploration();

  // Activate the canonical contract: fetch the whole historical envelope when a past
  // date / comparison is requested; synthesize the current-only contract from the
  // host lens present-day (no fetch).
  const { data: rawData, loading, error, reload } = useLiquiditySpaceData({
    spaceId,
    asOf,
    compareTo,
    today,
    active,
    presentLens: presentLens ?? null,
  });

  // Display-currency pass (SD-6B FX correctness): convert the reporting-currency historical
  // endpoints into the selected display currency at each endpoint's own date. IDENTITY when
  // display == reporting (the common case). This forecloses the symbol-only relabel bug.
  const data = useMemo(
    () => (rawData ? convertLiquiditySpaceData(rawData, ctx) : null),
    [rawData, ctx],
  );

  const atAsOf = data?.atAsOf ?? null;
  const showAsOf = atAsOf != null && atAsOf.status === "ok";
  // The lens the lede reads: the reconstructed as-of lens when historical, else the live
  // current lens (data.current === the host present lens present-day).
  const ledeLens: LensResult | null = showAsOf ? atAsOf : (data?.current ?? null);

  // The trust envelope from whichever endpoint is on screen — computed ONCE and shared by
  // the shell (onEnvelopeChange) and the Hero's TrustIndicator, so the two can never disagree.
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "liquidity", lensResult: ledeLens }),
    [ledeLens],
  );
  useEffect(() => { onEnvelopeChange?.(envelope); }, [envelope, onEnvelopeChange]);

  // FIGURES OF RECORD — present-day, from the accounts array (never the lens). The Hero
  // headline (cashNow tier) is the SAME figure the Cash accounts ledger's Available sums.
  const classification = useMemo(() => classifyAccounts(accounts, ctx), [accounts, ctx]);
  // v2.6-L3 — the headline is REACHABLE cash, not the ledger sum. The copy under
  // it has always read "reachable right now"; on the live corpus the ledger sum
  // was $13,674.16 while $8,000 of it was not reachable at all. Same authority
  // the Sources ledger rows use, so the headline and its ledger still agree.
  const reach = useMemo(() => reachableNow(accounts as never, ctx), [accounts, ctx]);
  const cashNow = reach.total;
  // 2026-10-07 — "within days" is KNOWN brokerage + crypto (liquidityAccess);
  // retirement/HSA and unverified investments are owned, not reachable soon.
  const reachableSoon = accessTotals(accounts as never, ctx).marketable;
  const sharePctNow = classification.totalAssets > 0 ? (cashNow / classification.totalAssets) * 100 : null;
  // Count the sources that actually CONTRIBUTE to the headline — an account
  // whose reachable figure is unknown is excluded from the total, so counting it
  // as a source would describe money the figure does not include.
  const nowSourceCount = reach.coveredCount;
  // v2.7 Cash accounts — the per-account TOTAL CASH rows + the reconciliation to
  // `reach` (pure helper; the classifier's conversion + reachableForAccount).
  const cashAccounts = useMemo(() => buildCashAccounts(accounts, ctx), [accounts, ctx]);
  // The Cash distribution grouping — its control is a Dropdown in the Block
  // header (the Net Worth "Where it sits · By class ▾" idiom). Default By account.
  const [cashGrouping, setCashGrouping] = useState<CashGrouping>(DEFAULT_CASH_GROUPING);
  // The existing reachable disclosure, shown under the Accessible cash tile.
  const reachDisclosure = reachableDisclosure(reach, (n) => fmtMoney(n, ctx));

  // REVIEW-3 B-5 — the display-currency AUTHORITY is the fallback, never a
  // build-time USD literal (display-money.ts).
  const displayCurrency = useAggregateCurrency(ctx);
  const historical = asOf < today;

  // ② Balance history — the cashNow tier over time, clipped to the shell window from the
  // host snapshots (no new fetch) + per-date FX. The chart is the ONLY honestly-continuous
  // historical surface (per-account panels stay present-day).
  const cashHistory = useMemo(
    () => convertCashHistory(clipCashHistory(snapshots ?? [], asOf, compareTo, snapshotCurrency), ctx),
    [snapshots, asOf, compareTo, snapshotCurrency, ctx],
  );

  // Balance-history WINDOW delta for the Hero (cashNow snapshot basis — the figure the chart
  // states). Only real when ≥2 in-window points exist; never invented.
  const change = useMemo<LiquidityWindowChange | null>(() => {
    const pts = cashHistory?.points ?? [];
    if (pts.length < 2) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const abs = last.cashNow - first.cashNow;
    const pct = first.cashNow !== 0 ? (abs / first.cashNow) * 100 : null;
    return { abs, pct, fromLabel: formatDate(first.date) };
  }, [cashHistory]);

  // Coverage months — honest ONLY when a monthly-expense baseline exists (never fabricated).
  //
  // v2.6-ASSESS-3 — the baseline arrives ALREADY RESOLVED from the server, which
  // ran the one authority (`lib/liquidity/expense-baseline.ts`: declared outranks
  // measured, non-positive refuses). Nothing about which figure wins is decided
  // here, and the measured average is never recomputed in React — this component
  // divides and labels.
  //
  // Until ASSESS-3 this surface could only ever see the DECLARED figure, so on a
  // corpus where no Space declared one it showed no coverage at all while the
  // assessment engine graded the same position from the measured average.
  const coverage = useMemo<LiquidityCoverage | null>(() => {
    if (!expenseBaseline || cashNow <= 0) return null;
    return {
      months:          cashNow / expenseBaseline.amount,
      monthlyExpenses: expenseBaseline.amount,
      basis:           expenseBaseline.basis,
      ...(expenseBaseline.measuredOver ? { measuredOver: expenseBaseline.measuredOver } : {}),
    };
  }, [expenseBaseline, cashNow]);

  // Cash concentration signal (Resilience) — the top reachable-now source's share of cashNow,
  // via the SAME one-FX-pass the ledger uses (no bespoke FX here). Present-day anchor.
  const concentration = useMemo(() => {
    const nowRows = buildSourceRows(accounts, ctx).filter((r) => r.horizon === "now");
    const total = nowRows.reduce((s, r) => s + r.value, 0);
    if (total <= 0 || nowRows.length === 0) return null;
    const top = nowRows[0]; // buildSourceRows is sorted largest-first
    return { topName: top.account.name, topShare: top.value / total, count: nowRows.length };
  }, [accounts, ctx]);

  // The lens verdict SENTENCE (prose only — never a figure of record).
  const verdict = ledeLens && ledeLens.status === "ok" && ledeLens.verdict ? ledeLens.verdict : null;
  const verdictAsOf = verdict
    ? (showAsOf ? formatDate(asOf) : (ledeLens?.provenance.dataAsOf ? formatDate(ledeLens.provenance.dataAsOf) : null))
    : null;
  const redactions = verdict ? (ledeLens?.provenance.redactions?.length ?? 0) : 0;

  // Publish section anchors to the sidebar (cleared on unmount). Embedded, the
  // Assets page publishes ONE list for the whole page; this section stays quiet.
  const publishSections = useSpaceSectionsPublisher();
  useEffect(() => {
    if (embedded) return;
    const sections: SpaceChromeSection[] = [
      { label: "Summary",         anchor: "liquidity-summary" },
      { label: "Balance history", anchor: "liquidity-history" },
      { label: "Cash accounts",   anchor: "liquidity-sources" },
      { label: "Resilience",      anchor: "liquidity-resilience" },
      ...(period ? [{ label: "Activity", anchor: "liquidity-activity" }] : []),
    ];
    publishSections(sections);
    return () => publishSections([]);
  }, [publishSections, period, embedded]);

  const liquidityPoints = cashHistory?.points ?? [];
  const handleSelectPoint = useCallback(
    (dateISO: string) => {
      const first = liquidityPoints[0]?.date ?? dateISO;
      const last = liquidityPoints[liquidityPoints.length - 1]?.date ?? dateISO;
      exploration.openPoint("liquidity", dateISO, first, last);
    },
    [liquidityPoints, exploration],
  );

  const approx = classification.estimated ? "≈ " : "";

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!">
      {loading && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-faint)]">
          <RefreshCw size={12} className="animate-spin" aria-label="Refreshing" /> Updating…
        </div>
      )}

      {/* ① Summary — the editorial lede. Embedded (Assets → Cash), the page's
          own Cash hero states the slice and its accessible-cash figure moves into
          the Resilience grid below, so no second hero card is drawn. */}
      {!embedded && (
        <div id="liquidity-summary" className="scroll-mt-20">
          <LiquidityHero
            cashNow={cashNow}
            reachableSoon={reachableSoon}
            sharePctNow={sharePctNow}
            sourceCount={nowSourceCount}
            coverage={coverage}
            estimated={classification.estimated}
            currency={displayCurrency}
            asOf={asOf}
            today={today}
            historical={historical}
            change={change}
            // The headline uses reachable cash whenever ANY account supplied a
            // current-state claim; the window delta is computed from the ledger
            // snapshot series, so the two bases diverge exactly then.
            deltaBasisDiffers={reach.coveredCount > 0 && cashNow !== classification.totalLiquid}
            envelope={envelope}
            verdict={verdict}
            verdictAsOf={verdictAsOf}
            redactions={redactions}
          />
        </div>
      )}

      {/* ② Balance history — accessible cash over time, the SHARED TrendChart.
           Embedded, the unified Assets chart above already slices to this SAME
           series (WealthChartPoint.cash === totalCash + totalSavings), so a second
           identical chart is not drawn; the as-of retry affordance stays. */}
      {(!embedded || error) && (
        <div id="liquidity-history" className="scroll-mt-20">
          {!embedded && (
            <LiquidityBalanceHistory
              history={cashHistory}
              currency={displayCurrency}
              asOf={asOf}
              compareTo={compareTo}
              onSelectPoint={handleSelectPoint}
            />
          )}
          {error && (
            <button
              type="button"
              onClick={reload}
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <RefreshCw size={11} /> Couldn&rsquo;t load as-of history — retry
            </button>
          )}
        </div>
      )}

      {/* ③ Resilience & Risk — directly under the chart, always visible (v2.7
          visual-first): coverage, cash concentration, reachability mix and,
          embedded, the accessible-cash figure (present-day anchor). */}
      <Block id="liquidity-resilience" label="Resilience & risk">
        <div className={`grid grid-cols-2 gap-3 sm:gap-4 items-stretch min-w-0 ${embedded ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
          {/* Emergency coverage — conditional on a monthly-expense baseline. */}
          <Surface className="p-3 sm:p-4 min-w-0">
            <SubHeading>Emergency coverage</SubHeading>
            {coverage ? (
              <>
                <p className="text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: coverage.months >= 6 ? "var(--accent-positive)" : coverage.months >= 3 ? "#f59e0b" : "var(--accent-negative)" }}>
                  {coverage.months.toFixed(1)} months
                </p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)] [overflow-wrap:anywhere]">
                  {/* v2.6-ASSESS-2 — name the baseline (declared vs measured). MONEY-PRECISION-2:
                      a clause, so whole dollars. */}
                  {describeExpenseBaseline(
                    { amount: coverage.monthlyExpenses, basis: coverage.basis, ...(coverage.measuredOver ? { measuredOver: coverage.measuredOver } : {}) },
                    (n: number) => formatCurrencyWhole(n, displayCurrency),
                  )}
                </p>
              </>
            ) : (
              <>
                <p className="text-xl sm:text-2xl font-semibold tabular-nums text-[var(--text-faint)]">—</p>
                <p className="mt-1 text-[11px] text-[var(--text-faint)]">Set a monthly expense target</p>
              </>
            )}
          </Surface>

          {/* Cash concentration — is reachable cash spread out or in one account? */}
          <Surface className="p-3 sm:p-4 min-w-0">
            <SubHeading>Cash concentration</SubHeading>
            {concentration ? (
              <>
                <p className="text-xl sm:text-2xl font-semibold tabular-nums" style={{ color: concentration.topShare >= 0.7 ? "#f59e0b" : "var(--text-primary)" }}>
                  {(concentration.topShare * 100).toFixed(0)}%
                </p>
                <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                  in <span className="text-[var(--text-secondary)]">{concentration.topName}</span>
                  {concentration.count > 1 ? ` · ${concentration.count} accounts` : ""}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-[var(--text-faint)]">No reachable cash yet.</p>
            )}
          </Surface>

          {/* Reachability mix — how much is reachable now vs within days (retirement /
              HSA and unverified investments are restricted: in neither). */}
          <Surface className="p-3 sm:p-4 min-w-0">
            <SubHeading>Reachability</SubHeading>
            {cashNow + reachableSoon > 0 ? (
              <>
                <ReachBar now={cashNow} soon={reachableSoon} />
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
                  <span className="inline-flex items-center gap-1.5"><Dot color="#22c55e" />Now {fmtMoney(cashNow, ctx)}</span>
                  <span className="inline-flex items-center gap-1.5"><Dot color="#3b82f6" />Days {fmtMoney(reachableSoon, ctx)}</span>
                </p>
              </>
            ) : (
              <p className="text-[11px] text-[var(--text-faint)]">No reachable assets yet.</p>
            )}
          </Surface>

          {/* Accessible cash — embedded only: the figure the former section hero
              stated (reachable now, the Sources ledger's own authority), with its
              ≈ estimated marker, its own trust chip, and the present-day /
              withheld disclosures as concise lines. */}
          {embedded && (
            <Surface className="p-3 sm:p-4 min-w-0" data-accessible-cash>
              <div className="flex items-start justify-between gap-2">
                <SubHeading>Accessible cash</SubHeading>
                <TrustIndicator variant="compact" envelope={envelope} />
              </div>
              <p className="text-xl sm:text-2xl font-semibold tabular-nums text-[var(--text-primary)] [overflow-wrap:anywhere]">
                {approx}{formatCurrency(cashNow, displayCurrency)}
              </p>
              {sharePctNow != null && (
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{sharePctNow.toFixed(0)}% of assets</p>
              )}
              {historical && (
                <p className="mt-1 text-[11px] text-[var(--text-faint)]">Balances are current — trend reflects {formatDate(asOf)}</p>
              )}
              {reachDisclosure && (
                <p className="mt-1 text-[11px] text-[var(--text-faint)]" data-reach-disclosure>{reachDisclosure}</p>
              )}
              {redactions > 0 && (
                <p className="mt-1 text-[11px] text-[var(--text-faint)]">{redactions} account detail{redactions === 1 ? "" : "s"} withheld</p>
              )}
              <TrustIndicator variant="inline" envelope={envelope} className="mt-1" />
            </Surface>
          )}
        </div>
      </Block>

      {/* ④ Distribution + ⑤ Cash accounts (v2.7) — present-day TOTAL CASH by where
          it is held. Historical As-Of: no reconstructed tier section (removed at
          the owner's request) — the hero + trend honour the As-Of, and the
          distribution + ledger are labelled "Current balances", never as-of. */}
      <div id="liquidity-sources" className="scroll-mt-20 space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!">
        <Block
          id="liquidity-distribution"
          label="Cash distribution"
          hint={<span className="text-[11px] text-[var(--text-faint)]">{historical ? "Current balances" : "Total cash"}</span>}
          action={<Dropdown options={CASH_GROUPINGS} value={cashGrouping} onChange={setCashGrouping} ariaLabel="Cash distribution grouping" />}
        >
          <CashDistribution summary={cashAccounts} currency={displayCurrency} grouping={cashGrouping} />
        </Block>
        <Block
          id="liquidity-accounts"
          label="Cash accounts"
          hint={<span className="text-[11px] tabular-nums text-[var(--text-faint)]">{cashAccounts.accountCount}</span>}
          action={historical ? <span className="text-[11px] text-[var(--text-faint)]">Current balances</span> : undefined}
        >
          <CashAccountsLedger
            spaceId={spaceId}
            accounts={accounts}
            summary={cashAccounts}
            ctx={ctx}
            currency={displayCurrency}
          />
        </Block>
      </div>

      {/* ⑥ What changed — every liquidity driver for the shell-bridged window, with a
           doorway to the Cash Flow workspace. CURRENT ANCHOR (window relative to today).
           Fully visible at every width (v2.7 visual-first: no disclosure, no top-N cut). */}
      {period && (
        <Block id="liquidity-activity" label={`What changed · ${periodLabel(period)}`}>
          <Surface className="p-4 min-w-0">
            {/* TX-2A — honest caveat for the transaction-derived drivers when the
                shared read was capped (TX-2). Nothing when complete; no fold change. */}
            <TransactionCoverageNote coverage={transactionsMeta} variant="history" className="mb-3" />
            <LiquidityWhatChangedCard
              transactions={transactions}
              accounts={accounts}
              period={period}
              ctx={txCtx}
              asOf={asOf}
              onOpenCashFlow={onOpenCashFlow}
            />
          </Surface>
        </Block>
      )}
    </div>
  );
}

/** The quiet in-Surface heading (Block owns the section label; this labels a sub-panel). */
function SubHeading({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</p>;
}

function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/** A two-segment reachability bar — now (green) vs within days (blue). Pure presentation. */
function ReachBar({ now, soon }: { now: number; soon: number }) {
  const total = now + soon || 1;
  const nowPct = (now / total) * 100;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-inset)]">
      <div className="h-full" style={{ width: `${nowPct}%`, backgroundColor: "#22c55e" }} />
      <div className="h-full" style={{ width: `${100 - nowPct}%`, backgroundColor: "#3b82f6" }} />
    </div>
  );
}
