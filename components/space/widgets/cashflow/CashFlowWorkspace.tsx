"use client";

/**
 * components/space/widgets/cashflow/CashFlowWorkspace.tsx  (SD-6C · editorial convergence)
 *
 * The Cash Flow AND Spending workspaces — one component, two PAGES (`view`).
 * v2.7 FINAL PERSPECTIVE UX PASS (owner decision, 2026-10-27): Cash Flow and
 * Spending are SEPARATE perspectives with their own lens id, URL, heading and
 * hero; the former Cash Flow ⇄ Spending segmented toggle is gone everywhere.
 *
 * Both pages consume the ONE canonical composition contract (buildCashFlowSpaceData,
 * "composes, computes none") for the selected window; the canonical As-of clock,
 * the trust stamp/envelope and every drill-down are unchanged from SD-6C. Each page
 * reads ONE axis of the same DayFacts:
 *
 *   CASH FLOW (liquidity — actual cash movement through bank accounts)
 *     ① Net cash flow hero → Cash In / Cash Out summaries
 *     ② Activity heatmap (daily cash movement)
 *     ③ Transfers & movements — what moved that is NOT cash in/out, stated as what
 *        it is (unresolved transfers, card charges, …) with a neutral "Review"
 *     ④ Where cash came from (cash in by source) — only when cash arrived
 *     ⑤ What changed (deterministic observations)
 *
 *   SPENDING (economic — purchases across payment methods)
 *     ① Total spending hero → credit / direct breakdown (economicSpendByTier)
 *     ② Where it went — distribution donut with the category ledger beneath it
 *     ③ Spending activity heatmap (spending by day)
 *     ④ Observations (the spending-relevant deterministic insights)
 *
 * The period is the flow time group's (independent of Net Worth's — see
 * lib/space/perspective-time-groups.ts); the heatmap's Month · Quarter · Year
 * write it through `onSelectPeriod`, so the header and the heatmap agree.
 */

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { Waves } from "lucide-react";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import {
  periodLabel,
  isExplicitPeriod,
  type CashFlowPeriod, type ExplicitCashFlowPeriod, periodKey } from "@/lib/transactions/cash-flow";
import { formatDate } from "@/lib/format";
import { formatAggregateMoney, useAggregateCurrency } from "@/components/space/widgets/display-money";
import { liquidityIdsByReason, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { economicSpendByTier, type CashFlowPerspective as CashFlowPerspectiveMode } from "@/lib/transactions/cash-flow-projection";
import { isCostFlow, isRefund } from "@/lib/transactions/flow-predicates";
import { cashFlowStamp, compareCashFlow } from "@/lib/transactions/cash-flow-compare";
import { buildCashFlowSpaceData } from "@/lib/transactions/cash-flow-space-data";
import { resolveFinancialWindow } from "@/lib/perspectives/financial-window";
import type { TimePreset } from "@/lib/perspectives/time-range";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import { Surface, Block } from "@/components/atlas/Surface";
import { TransactionCoverageNote } from "@/components/space/trust/TransactionCoverageNote";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import { SpaceReadFailure } from "@/components/space/SpaceReadFailure";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { DebtPaymentsWidget } from "@/components/space/widgets/DebtPaymentsWidget";
import { TransactionSliceDrawer, useTransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";
import { CashFlowInsightsCard } from "./CashFlowInsightsCard";
import { CashFlowCategoryLedger } from "./CashFlowCategoryLedger";
import { CashFlowHero, type CashFlowHeroChange } from "./CashFlowHero";
import { CashFlowMovements, movementLines } from "./CashFlowMovements";
import { SpendingDistribution, SpendingHero, SpendingTierBreakdown } from "./SpendingSections";
import { spendingDonutModel } from "./spending-distribution";
import { previousEquivalentPeriod } from "./cash-flow-insights";

export type FlowView = "cashFlow" | "spending";

/** The axis each page reads (never toggled). */
export const VIEW_AXIS: Record<FlowView, CashFlowPerspectiveMode> = { cashFlow: "liquidity", spending: "economic" };

/** The section anchors each page can publish (the sidebar's "what's inside"), in page order. */
export const CASHFLOW_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",     anchor: "cashflow-summary" },
  { label: "Activity",    anchor: "cashflow-activity" },
  { label: "Movements",   anchor: "cashflow-movements" },
  { label: "Cash in",     anchor: "cashflow-income" },
  { label: "What changed", anchor: "cashflow-insights" },
];
export const SPENDING_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",      anchor: "spending-summary" },
  { label: "Where it went", anchor: "spending-distribution" },
  { label: "Activity",     anchor: "spending-activity" },
  { label: "Observations", anchor: "spending-insights" },
];

/** Page relevance over the deterministic observations (ids only). Cash Flow drops
 *  what another section already states (top category → Spending; credit charges and
 *  unresolved transfers → Transfers & movements); Spending keeps the spending ones. */
const CASH_FLOW_INSIGHTS = (id: string) => id === "compare-net" || id === "top-source";
const SPENDING_INSIGHTS = (id: string) => id === "top-category" || id === "credit";

function LoadingCard() {
  return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
}
function EmptyCard({ headline, sub }: { headline: string; sub: string }) {
  return (
    <div className="text-center py-8">
      <Waves size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
      <p className="text-sm text-[var(--text-muted)]">{headline}</p>
      <p className="text-xs text-[var(--text-faint)] mt-1">{sub}</p>
    </div>
  );
}

/** The quiet in-Surface heading (Block owns the section label; this labels a sub-panel). */
function SubHeading({ children }: { children: ReactNode }) {
  return <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{children}</p>;
}

export function CashFlowWorkspace({
  view = "cashFlow",
  transactions,
  transactionsMeta,
  txCtx,
  accounts,
  period,
  asOf,
  today,
  compareTo,
  onSelectPeriod,
  onResetPeriod,
  onOpenSpending,
  onEnvelopeChange,
  transactionsError = null,
  onRetryTransactions,
}: {
  /** Which page: Cash Flow (liquidity) or Spending (economic). Default Cash Flow. */
  view?:           FlowView;
  transactions?:   Transaction[] | null;
  /** TX-2A — coverage state for an honest "history incomplete" caveat when the
   *  shared read was capped (TX-2). null/complete ⇒ no note; folds are unaffected. */
  transactionsMeta?: TransactionsCoverage | null;
  txCtx?:          ConversionContext;
  accounts:        { id: string; type: string }[];
  period:          CashFlowPeriod;
  /** Canonical As-of — the ANCHOR for the selected period. The window's end travels
   *  with asOf via the canonical FLOW window, so Cash Flow is historical, not today-only. */
  asOf:            string;
  /** Today (YYYY-MM-DD) — bounds the heatmap's unit stepper. Absent ⇒ asOf. */
  today?:          string;
  /** Canonical compareTo (strictly-earlier) — anchors the then-vs-now comparison. */
  compareTo?:      string | null;
  /** Move the page's period to an explicit calendar unit (the heatmap's Month · Quarter · Year). */
  onSelectPeriod:  (period: CashFlowPeriod) => void;
  /** The heatmap's Reset — back to the rolling 1M default (clears the explicit unit). */
  onResetPeriod?:  () => void;
  /** Cash Flow only — open the Spending perspective (the category teaser). */
  onOpenSpending?: () => void;
  /** SD-6 gate — the workspace OWNS its completeness stamp (computed below from its
   *  own transactions + period) and emits the resulting trust envelope; the host
   *  merely relays it to the shell chip (mirrors Wealth/Investments/Liquidity). */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
  /** UI-006 — the shared transaction read FAILED (the sentence to show), or null. */
  transactionsError?: string | null;
  onRetryTransactions?: () => void;
}) {
  const perspective = VIEW_AXIS[view];
  const spendingView = view === "spending";

  // The canonical As-of clock — the ONE anchor for every period→range resolution in
  // this workspace (the contract fold, the stamp, the calendar grid, the insights
  // comparison, the hero delta).
  const asOfClock = useMemo(() => () => new Date(`${asOf}T00:00:00`), [asOf]);

  // THE composition boundary — one canonical projection of the selected window,
  // fanned out to every panel. Null while transactions load.
  const data = useMemo(
    () => (transactions ? buildCashFlowSpaceData({ transactions, accounts, period, moneyCtx: txCtx, now: asOfClock }) : null),
    [transactions, accounts, period, txCtx, asOfClock],
  );

  // Completeness stamp — the workspace owns the ONE computation and feeds it to BOTH
  // the Insights caveat and the shell chip envelope (emitted up), which therefore can
  // never disagree. Coverage is a property of the data, so the FULL history is stamped.
  const stamp = useMemo(
    () => (transactions
      ? cashFlowStamp({ transactions: transactions as unknown as LiquidityTx[], period, now: asOfClock })
      : null),
    [transactions, period, asOfClock],
  );
  // ONE trust envelope from the stamp — reported UP to the shell (onEnvelopeChange).
  // Spending reads the same transaction history, so it carries the same envelope.
  const fxUnconverted = data?.unconverted ?? false;
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: stamp, fxUnconverted }),
    [stamp, fxUnconverted],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  const liqCtx = useMemo(() => tierResolver(accounts), [accounts]);

  // Hero window delta vs the comparison window, over the shared projection via
  // compareCashFlow (the SAME then-vs-now authority the Insights use). Cash Flow
  // compares NET cash; Spending compares TOTAL SPENDING (out). The comparison window
  // is canonical compareTo when it is a DISTINCT prior baseline, else the sequential
  // previous-equivalent period; null when neither is honestly derivable. Never invented.
  const change = useMemo<CashFlowHeroChange | null>(() => {
    if (!transactions || !data || data.rows.length === 0) return null;
    const clock = asOfClock;
    const isRelative = period !== "ALL" && !isExplicitPeriod(period);
    const primaryWindow = isRelative
      ? resolveFinancialWindow({ preset: period as TimePreset, asOf, compareTo: null })
      : null;
    const primaryStart = primaryWindow?.flow.fromInclusiveISO ?? null;
    const compareToClock =
      compareTo && primaryStart && compareTo < primaryStart
        ? () => new Date(`${compareTo}T00:00:00`)
        : null;
    const then = compareToClock ? period : previousEquivalentPeriod(period, clock());
    if (!then) return null;
    const cmp = compareCashFlow({
      transactions: transactions as LiquidityTx[],
      liqCtx,
      then,
      now: period,
      perspective,
      clock,
      thenClock: compareToClock ?? undefined,
      moneyCtx: txCtx,
    });
    const abs = spendingView ? cmp.delta.totals.out : cmp.delta.totals.net;
    const from = spendingView ? cmp.then.totals.out : cmp.then.totals.net;
    const pct = from !== 0 ? (abs / Math.abs(from)) * 100 : null;
    const cmpWindow = compareToClock && isRelative
      ? resolveFinancialWindow({ preset: period as TimePreset, asOf: compareTo!, compareTo: null })
      : null;
    const fromLabel = cmpWindow
      ? `${formatDate(cmpWindow.flow.fromInclusiveISO)} – ${formatDate(cmpWindow.flow.toInclusiveISO)}`
      : periodLabel(then);
    return { abs, pct, fromLabel };
  }, [transactions, data, period, compareTo, perspective, spendingView, liqCtx, txCtx, asOfClock, asOf]);

  // Where the window sits, in words: an explicit unit states its own span; a
  // relative window its anchor.
  const windowLabel = period === "ALL"
    ? "all history"
    : isExplicitPeriod(period) && data
      ? `${formatDate(data.range.start)} – ${formatDate(data.range.end)}`
      : `as of ${formatDate(asOf)}`;

  // REVIEW-3 B-5 — the display-currency AUTHORITY is the fallback, never a
  // build-time USD literal (display-money.ts).
  const displayCurrency = useAggregateCurrency(txCtx);
  const fmt = useCallback((v: number) => formatAggregateMoney(v, txCtx), [txCtx]);

  // The Cash Flow reconciliation lines (context projection + card charges).
  const isLiabilityRow = useCallback(
    (r: Transaction) => {
      const t = r as LiquidityTx;
      return liqCtx.tierOf(t.financialAccountId ?? t.accountId ?? null) === "liability";
    },
    [liqCtx],
  );
  const movements = useMemo(
    () => (data ? movementLines({
      context: data.context,
      charged: data.summary.creditCardSpending,
      chargedRows: data.rows.filter((r) => isCostFlow(r.flowType) && isLiabilityRow(r)),
    }) : []),
    [data, isLiabilityRow],
  );
  const hasMovements = movements.length > 0 || (data?.debtPayments.length ?? 0) > 0;
  const hasCashIn = (data?.cashInByReason.length ?? 0) > 0;

  // Publish the RENDERED section anchors to the sidebar (cleared on unmount).
  const publishSections = useSpaceSectionsPublisher();
  useEffect(() => {
    const list = spendingView
      ? SPENDING_SECTIONS
      : CASHFLOW_SECTIONS.filter((s) =>
          (s.anchor !== "cashflow-movements" || hasMovements) && (s.anchor !== "cashflow-income" || hasCashIn));
    publishSections(list);
    return () => publishSections([]);
  }, [publishSections, spendingView, hasMovements, hasCashIn]);

  // Spending tier drill-downs — the same predicates the former economic tile used.
  const [tierSlice, setTierSlice] = useTransactionSlice(periodKey(period));

  // ── Spending by Category — contract `outflowByCategory`, drilled over `rows`. ──
  function renderSpendingLedger(): ReactNode {
    if (data == null) return <LoadingCard />;
    if (data.rows.length === 0) {
      return <EmptyCard headline="No money moved in this period" sub="Spending by category appears once you have purchases." />;
    }
    return (
      <CashFlowCategoryLedger
        invalidationKey={periodKey(period)}
        items={data.outflowByCategory}
        // CF-RECON-1 — THE window's spending total (economicSpend(summary)), plus the
        // refunds that no listed category could absorb, so the lines reconcile to it.
        total={data.spending.net}
        adjustment={{ label: "Net of refunds with no matching purchase in this period", value: data.spending.refundsUnapplied }}
        ctx={txCtx}
        totalLabel="Total spending"
        browserTitle="Spending categories"
        browserEyebrow="Spending"
        noun="categories"
        detailEyebrow="Spending category"
        shareLabel="Share of spending"
        sliceSubtitle="Spending in this category"
        emptyHeadline="No spending in this period"
        emptySubline="Spending by category appears once you have purchases."
        sliceFor={(item) => byId(data.rows, item.transactionIds)}
      />
    );
  }

  // ── Where cash came from — the liquidity axis's canonical cash-in slices. ──
  function renderCashIn(): ReactNode {
    if (data == null) return <LoadingCard />;
    // ONE canonical classification pass over the windowed rows; the slice below
    // reads identities from it rather than re-classifying per item.
    const cashInIds = liquidityIdsByReason(data.rows as LiquidityTx[], liqCtx, "CASH_IN");
    return (
      <CashFlowCategoryLedger
        invalidationKey={periodKey(period)}
        items={data.cashInByReason.map((l) => ({
          id: l.reason, label: l.label, value: l.amount,
          transactionIds: cashInIds.get(l.reason) ?? [],
        }))}
        total={data.summary.cashIn}
        ctx={txCtx}
        totalLabel="Total cash in"
        browserTitle="Cash in by source"
        browserEyebrow="Cash in"
        noun="sources"
        detailEyebrow="Cash in source"
        shareLabel="Share of cash in"
        sliceSubtitle="Cash in from this source"
        emptyHeadline="No cash arrived in this period"
        emptySubline="Cash in by source appears once cash arrives."
        sliceFor={(item) => byId(data.rows, item.transactionIds)}
      />
    );
  }

  const what = spendingView ? "spending" : "cash flow activity";
  // UI-006 — the read failed and nothing is loaded: say so instead of loading forever.
  if (transactionsError && transactions == null) {
    return (
      <div className="min-w-0">
        <SpaceReadFailure what={what} message={transactionsError} onRetry={onRetryTransactions} />
      </div>
    );
  }

  const failure = transactionsError && (
    <SpaceReadFailure variant="inline" what={what} message={transactionsError} onRetry={onRetryTransactions} />
  );
  const heatmap = (page: FlowView) => (
    <>
      {/* TX-2A — honest completeness caveat when the shared read was capped. */}
      <TransactionCoverageNote coverage={transactionsMeta} variant="history" className="mb-3" />
      <CashFlowHistoryWidget
        transactions={transactions}
        period={period}
        now={asOfClock}
        asOf={asOf}
        today={today ?? asOf}
        ctx={txCtx}
        accounts={accounts}
        page={page}
        onSelectPeriod={onSelectPeriod as (p: ExplicitCashFlowPeriod) => void}
        onResetPeriod={onResetPeriod}
        windowRows={data?.rows}
        daily={data?.daily}
      />
    </>
  );

  if (spendingView) {
    const tier = data ? economicSpendByTier(data.summary) : null;
    const rows = data?.rows ?? [];
    return (
      <div className="space-y-8 sm:space-y-10 min-w-0 max-lg:max-sm:space-y-6" data-flow-view="spending">
        {failure}
        {/* ① Summary — Total spending, then the compact credit / direct split. */}
        <section id="spending-summary" className="scroll-mt-20">
          <SpendingHero total={data?.spending.net} currency={displayCurrency} period={period} windowLabel={windowLabel} change={change} />
          {data && tier && rows.length > 0 && (
            <div className="mt-5 max-lg:mt-4">
              <SpendingTierBreakdown
                tier={tier}
                total={data.spending.net}
                fmt={fmt}
                onOpenCard={() => setTierSlice({ title: "Credit-card spending", subtitle: "Spending & refunds on credit this period", total: tier.creditCard, totalLabel: "Net",
                  rows: rows.filter((r) => (isCostFlow(r.flowType) || isRefund(r.flowType)) && isLiabilityRow(r)) })}
                onOpenDirect={() => setTierSlice({ title: "Direct & other spending", subtitle: "Spending & refunds this period", total: tier.direct, totalLabel: "Net",
                  rows: rows.filter((r) => (isCostFlow(r.flowType) || isRefund(r.flowType)) && !isLiabilityRow(r)) })}
                onOpenRefunds={() => setTierSlice({ title: "Refunds beyond charges", subtitle: "Refunds larger than the charges on the same accounts this period", total: tier.refundsUnapplied, totalLabel: "Total",
                  rows: rows.filter((r) => isRefund(r.flowType)) })}
              />
              <TransactionSliceDrawer slice={tierSlice} ctx={txCtx} onClose={() => setTierSlice(null)} />
            </div>
          )}
        </section>

        {/* ② Where it went — the distribution donut, the category ledger directly beneath. */}
        <Block id="spending-distribution" label="Where it went" action={<span className="text-[11px] text-[var(--text-faint)]">By category, net of refunds</span>}>
          {data && rows.length > 0
            ? <SpendingDistribution model={spendingDonutModel(data.outflowByCategory, data.spending)} fmt={fmt} ledger={renderSpendingLedger()} />
            : <Surface className="p-4 min-w-0">{renderSpendingLedger()}</Surface>}
        </Block>

        {/* ③ Spending activity — the heatmap, spending by day. */}
        <Block id="spending-activity" label="Spending activity" action={<span className="text-[11px] text-[var(--text-faint)]">Daily spending · click a day to inspect</span>}>
          {heatmap("spending")}
        </Block>

        {/* ④ Observations — the spending-relevant deterministic insights. No AI. */}
        <Block id="spending-insights" label="Observations">
          <Surface className="p-4 min-w-0">
            <CashFlowInsightsCard
              transactions={transactions}
              accounts={accounts}
              period={period}
              now={asOfClock}
              compareTo={compareTo}
              perspective="economic"
              txCtx={txCtx}
              stamp={stamp}
              include={SPENDING_INSIGHTS}
              emptyText="No notable spending patterns to call out for this period yet."
            />
          </Surface>
        </Block>
      </div>
    );
  }

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0 max-lg:max-sm:space-y-6" data-flow-view="cashFlow">
      {failure}
      {/* ① Summary — Net cash flow, then the Cash In / Cash Out summaries. */}
      <section id="cashflow-summary" className="scroll-mt-20">
        <CashFlowHero
          facts={data?.summary}
          currency={displayCurrency}
          period={period}
          windowLabel={windowLabel}
          change={change}
        />
        <div className="mt-5 max-lg:mt-4">
          <CashFlowSummaryWidget
            transactions={transactions}
            period={period}
            ctx={txCtx}
            accounts={accounts}
            windowRows={data?.rows}
            facts={data?.summary}
          />
        </div>
        {onOpenSpending && data && data.spending.net > 0 && (
          <button
            type="button"
            onClick={onOpenSpending}
            className="mt-3 inline-flex min-h-10 items-center px-1 text-xs font-semibold text-[var(--meridian-400)] lg:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] rounded"
            data-spending-teaser
          >
            Spending by category, incl. card purchases → Spending
          </button>
        )}
      </section>

      {/* ② Activity — the heatmap (daily cash movement), fed the contract's rows + daily facts. */}
      <Block
        id="cashflow-activity"
        label="Activity"
        action={<span className="text-[11px] text-[var(--text-faint)]">Daily net · click a day to inspect</span>}
      >
        {heatmap("cashFlow")}
      </Block>

      {/* ③ Transfers & movements — what moved that is NOT in Cash In / Cash Out (and the
           debt payments that ARE, by creditor). Absent when nothing moved. */}
      {data && hasMovements && (
        <Block id="cashflow-movements" label="Transfers & movements">
          <Surface className="p-4 min-w-0">
            <CashFlowMovements lines={movements} ctx={txCtx} invalidationKey={periodKey(period)}>
              {data.debtPayments.length > 0 && (
                <div className={movements.length > 0 ? "border-t border-[var(--border-hairline)] pt-3" : ""}>
                  <SubHeading>Debt payments · counted in Cash Out</SubHeading>
                  <DebtPaymentsWidget
                    transactions={transactions}
                    period={period}
                    ctx={txCtx}
                    accounts={accounts}
                    windowRows={data.rows}
                  />
                </div>
              )}
            </CashFlowMovements>
          </Surface>
        </Block>
      )}

      {/* ④ Where cash came from — only when cash arrived (no empty card). */}
      {data && hasCashIn && (
        <Block id="cashflow-income" label="Where cash came from">
          <Surface className="p-4 min-w-0">
            {renderCashIn()}
          </Surface>
        </Block>
      )}

      {/* ⑤ What changed — deterministic then-vs-now observations (compareCashFlow),
           fed the completeness `stamp`. No AI. */}
      <Block id="cashflow-insights" label="What changed">
        <Surface className="p-4 min-w-0">
          <CashFlowInsightsCard
            transactions={transactions}
            accounts={accounts}
            period={period}
            now={asOfClock}
            compareTo={compareTo}
            perspective="liquidity"
            txCtx={txCtx}
            stamp={stamp}
            include={CASH_FLOW_INSIGHTS}
            emptyText="No notable cash-flow movements to call out for this period yet."
          />
        </Surface>
      </Block>
    </div>
  );
}

/**
 * Rows for a contribution, BY IDENTITY.
 *
 * The drill-down reads the ids the authority recorded while computing the total,
 * so a slice cannot include a row its own total excluded — which is exactly what
 * a re-derived predicate did: the grouping functions skip a row whose amount
 * cannot be converted (V25-FINAL-1) and the React filter did not.
 *
 * This is a lookup, not a classification. React decides nothing here.
 */
function byId<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const want = new Set(ids);
  return rows.filter((r) => want.has(r.id));
}
