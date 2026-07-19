"use client";

/**
 * components/space/widgets/cashflow/CashFlowWorkspace.tsx  (SD-6C · editorial convergence)
 *
 * The Cash Flow Workspace — the SpaceShell → CashFlowWorkspace boundary. It
 * consumes the canonical composition contract and fans ONE windowed projection
 * (buildCashFlowSpaceData, "composes, computes none") into every panel. That
 * contract, the canonical As-of clock, the workspace-owned semantic-slice state
 * (perspective + measure filter), the trust stamp/envelope, and every drill-down
 * are UNCHANGED from the SD-6C extraction.
 *
 * What changed here is PRESENTATION ONLY — the former 12-column GlassPanel grid is
 * rebuilt in the Net Worth / prototype EDITORIAL idiom (the Debt & Investments
 * redesigns): a stacked, generously-spaced read surface rather than a KPI card
 * grid, with sidebar section anchors published like the other workspaces.
 *
 *   ① Summary   CashFlowHero (Net lede + trust + delta + perspective toggle) over
 *               the headless CashFlowSummaryWidget breakdown (Cash In/Out tiles,
 *               credit-card context, moved-not-spent / needs-classification).
 *   ② Activity  The Cash Flow History widget (Calendar heatmap + Cards) — the
 *               operational centerpiece, given a full-width Activity Block. Its
 *               control cluster (mode toggle, Month/Quarter/Year, All-Time nav)
 *               is UNTOUCHED.
 *   ③ Spending  Spending by Category + its liquidity twin, Debt Payments.
 *   ④ Income    Income by Source (perspective-aware).
 *   ⑤ What changed  Deterministic Key Insights (no AI).
 *
 * The calendar, the contract, DayFacts, the aggregation authorities, and the
 * canonical time behaviour are all untouched — the heatmap-usability invariant.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Waves } from "lucide-react";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import {
  periodLabel,
  periodRange,
  isExplicitPeriod,
  incomeSourceLabel,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { formatDate } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import type { CashFlowPerspective as CashFlowPerspectiveMode } from "@/lib/transactions/cash-flow-projection";
import { cashFlowStamp, compareCashFlow } from "@/lib/transactions/cash-flow-compare";
import { buildCashFlowSpaceData } from "@/lib/transactions/cash-flow-space-data";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { useSpaceSectionsPublisher, type SpaceChromeSection } from "@/lib/space/space-chrome-context";
import { Surface, Block } from "@/components/atlas/Surface";
import { TransactionCoverageNote } from "@/components/space/trust/TransactionCoverageNote";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import { DEFAULT_FILTER_ID } from "@/components/space/widgets/CashFlowFilterControls";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { DebtPaymentsWidget } from "@/components/space/widgets/DebtPaymentsWidget";
import { CashFlowInsightsCard } from "./CashFlowInsightsCard";
import { CashFlowCategoryLedger } from "./CashFlowCategoryLedger";
import { CashFlowHero, type CashFlowHeroChange } from "./CashFlowHero";
import { previousEquivalentPeriod } from "./cash-flow-insights";

/** The Cash Flow workspace's section anchors — the sidebar's "what's inside". */
const CASHFLOW_SECTIONS: SpaceChromeSection[] = [
  { label: "Summary",      anchor: "cashflow-summary" },
  { label: "Activity",     anchor: "cashflow-activity" },
  { label: "Spending",     anchor: "cashflow-spending" },
  { label: "Income",       anchor: "cashflow-income" },
  { label: "What changed", anchor: "cashflow-insights" },
];

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
  transactions,
  transactionsMeta,
  txCtx,
  accounts,
  period,
  asOf,
  compareTo,
  onSelectPeriod,
  onEnvelopeChange,
}: {
  transactions?:   Transaction[] | null;
  /** TX-2A — coverage state for an honest "history incomplete" caveat when the
   *  shared read was capped (TX-2). null/complete ⇒ no note; folds are unaffected. */
  transactionsMeta?: TransactionsCoverage | null;
  txCtx?:          ConversionContext;
  accounts:        { id: string; type: string }[];
  period:          CashFlowPeriod;
  /** Canonical As-of — the ANCHOR for the selected period. The window's end travels
   *  with asOf (periodRange(period, asOf)), so Cash Flow is historical, not today-only. */
  asOf:            string;
  /** Canonical compareTo (strictly-earlier) — anchors the then-vs-now comparison. */
  compareTo?:      string | null;
  onSelectPeriod:  (period: CashFlowPeriod) => void;
  /** SD-6 gate — the workspace OWNS its completeness stamp (computed below from its
   *  own transactions + period) and emits the resulting trust envelope; the host
   *  merely relays it to the shell chip (mirrors Wealth/Investments/Liquidity). */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  // Workspace-local semantic slice — the perspective toggle + measure filter,
  // relocated here from the host. The Hero / History widgets host the selector
  // controls and drive this state through `changePerspective`.
  const [perspective, setPerspective] = useState<CashFlowPerspectiveMode>("liquidity");
  const [filterId, setFilterId] = useState<string>(DEFAULT_FILTER_ID);
  const changePerspective = (p: CashFlowPerspectiveMode, id: string) => {
    setPerspective(p);
    setFilterId(id);
  };

  // The canonical As-of clock — the ONE anchor for every period→range resolution in
  // this workspace (the contract fold, the stamp, the calendar grid, the insights
  // comparison, the hero delta). Replacing the former implicit `new Date()` (today)
  // makes the whole Cash Flow window travel with asOf: periodRange(period, asOf).
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
  // ONE trust envelope from the stamp — shared by the shell (onEnvelopeChange) and the
  // hero's TrustIndicator, so the two can never disagree.
  const envelope = useMemo(
    () => resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: stamp }),
    [stamp],
  );
  useEffect(() => { onEnvelopeChange(envelope); }, [envelope, onEnvelopeChange]);

  // Liquidity context for the income-panel drill filters + the hero delta (a pure
  // selection / comparison over already-windowed rows — never a re-window or fold).
  const liqCtx = useMemo(() => tierResolver(accounts), [accounts]);

  // Hero window delta — the perspective net change vs the comparison window, computed
  // over the shared projection via compareCashFlow (the SAME then-vs-now authority the
  // Insights "compare-net" bullet uses, so the two reconcile). The comparison window is
  // canonical compareTo (SAME period at the compareTo anchor) when it is a DISTINCT prior
  // baseline, else the sequential previous-equivalent period; null when neither is
  // honestly derivable (e.g. WTD / rolling / All Time with no compareTo). Never invented.
  const change = useMemo<CashFlowHeroChange | null>(() => {
    if (!transactions || !data || data.rows.length === 0) return null;
    const clock = asOfClock;
    const primaryStart = (period === "ALL" || isExplicitPeriod(period)) ? null : periodRange(period, clock()).start;
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
    const abs = cmp.delta.totals.net;
    const fromNet = cmp.then.totals.net;
    const pct = fromNet !== 0 ? (abs / Math.abs(fromNet)) * 100 : null;
    const cmpRange = compareToClock ? periodRange(period, compareToClock()) : null;
    const fromLabel = cmpRange
      ? `${formatDate(cmpRange.start)} – ${formatDate(cmpRange.end)}`
      : periodLabel(then);
    return { abs, pct, fromLabel };
  }, [transactions, data, period, compareTo, perspective, liqCtx, txCtx, asOfClock]);

  const displayCurrency = txCtx?.target ?? DEFAULT_DISPLAY_CURRENCY;

  // Publish section anchors to the sidebar (cleared on unmount).
  const publishSections = useSpaceSectionsPublisher();
  useEffect(() => {
    publishSections(CASHFLOW_SECTIONS);
    return () => publishSections([]);
  }, [publishSections]);

  // ── Spending by Category — contract `outflowByCategory`, drilled over `rows`.
  //    CF-4: exploration via the Preview → LeftPanel → RightPanel ledger. ──
  function renderSpending(): ReactNode {
    if (data == null) return <LoadingCard />;
    if (data.rows.length === 0) {
      return <EmptyCard headline="No money moved in this period" sub="Spending by category appears once you have outflows." />;
    }
    return (
      <CashFlowCategoryLedger
        items={data.outflowByCategory}
        ctx={txCtx}
        totalLabel="Total spending"
        browserTitle="Spending categories"
        browserEyebrow="Spending"
        noun="categories"
        detailEyebrow="Spending category"
        shareLabel="Share of spending"
        sliceSubtitle="Spending in this category"
        emptyHeadline="No spending in this period"
        emptySubline="Spending by category appears once you have outflows."
        sliceFor={(item) => data.rows.filter((t) => t.category === item.id && (isCostFlow(t.flowType) || isRefund(t.flowType)))}
      />
    );
  }

  // ── Income by Source — perspective-aware, from the contract's canonical slices
  //    (cashInByReason on the liquidity axis, incomeBySource on the economic axis).
  //    CF-4: same exploration ledger as Spending (consistency). ──
  function renderIncome(): ReactNode {
    if (data == null) return <LoadingCard />;
    if (perspective === "liquidity") {
      if (data.rows.length === 0) return <EmptyCard headline="No money moved in this period" sub="Cash in by source appears once cash arrives." />;
      return (
        <CashFlowCategoryLedger
          items={data.cashInByReason.map((l) => ({ id: l.reason, label: l.label, value: l.amount }))}
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
          sliceFor={(item) => (data.rows as LiquidityTx[]).filter((t) => {
            const c = classifyLiquidity(t, liqCtx);
            return c.effect === "CASH_IN" && c.reason === item.id;
          })}
        />
      );
    }
    if (data.rows.length === 0) return <EmptyCard headline="No money moved in this period" sub="Income by source appears once you have inflows." />;
    return (
      <CashFlowCategoryLedger
        items={data.incomeBySource}
        ctx={txCtx}
        totalLabel="Total income"
        browserTitle="Income sources"
        browserEyebrow="Income"
        noun="sources"
        detailEyebrow="Income source"
        shareLabel="Share of income"
        sliceSubtitle="Income from this source"
        emptyHeadline="No income in this period"
        emptySubline="Income by source appears once you have inflows."
        sliceFor={(item) => data.rows.filter((t) => isIncome(t.flowType) && incomeSourceLabel(t) === item.id)}
      />
    );
  }

  return (
    <div className="space-y-8 sm:space-y-10 min-w-0">
      {/* ① Summary — the editorial lede (Net + trust + delta + perspective toggle)
           over the headless breakdown body (Cash In/Out tiles + movement context). */}
      <section id="cashflow-summary" className="scroll-mt-20">
        <CashFlowHero
          facts={data?.summary}
          perspective={perspective}
          filterId={filterId}
          onPerspectiveChange={changePerspective}
          currency={displayCurrency}
          period={period}
          asOf={asOf}
          change={change}
          envelope={envelope}
        />
        <div className="mt-5">
          <CashFlowSummaryWidget
            transactions={transactions}
            period={period}
            ctx={txCtx}
            accounts={accounts}
            perspective={perspective}
            onPerspectiveChange={changePerspective}
            windowRows={data?.rows}
            facts={data?.summary}
            context={data?.context}
            hideHeadline
          />
        </div>
      </section>

      {/* ② Activity — the Cash Flow History widget (Calendar heatmap + Cards), the
           operational centerpiece. Its whole control cluster lives inside, untouched;
           the Block supplies only the editorial header. Fed the contract's windowed
           `rows`, `daily` (calendar) and `buckets` (cards). */}
      <Block
        id="cashflow-activity"
        label="Activity"
        action={<span className="text-[11px] text-[var(--text-faint)]">Daily net · click a day to inspect</span>}
      >
        {/* TX-2A — honest completeness caveat for the HISTORICAL view when the
            shared transaction read was capped (TX-2). Renders nothing when the
            population is complete; never blocks the charts or alters the fold. */}
        <TransactionCoverageNote coverage={transactionsMeta} variant="history" className="mb-3" />
        <CashFlowHistoryWidget
          transactions={transactions}
          period={period}
          now={asOfClock}
          ctx={txCtx}
          accounts={accounts}
          onSelectPeriod={onSelectPeriod}
          perspective={perspective}
          filterId={filterId}
          onPerspectiveChange={changePerspective}
          windowRows={data?.rows}
          daily={data?.daily}
          buckets={data?.buckets}
        />
      </Block>

      {/* ③ Spending — Spending by Category over its de-emphasized liquidity twin,
           Debt Payments. (CF-4 will fold the category list into a "View all →" panel;
           for now the full-width Block + multi-column grid keeps it bounded.) */}
      <Block
        id="cashflow-spending"
        label="Spending"
        action={<span className="text-[11px] text-[var(--text-faint)]">Bar shows share of spend</span>}
      >
        <div className="grid gap-4 lg:grid-cols-2 items-start min-w-0">
          <Surface className="p-4 min-w-0">
            {renderSpending()}
          </Surface>
          <Surface className="p-4 min-w-0" tone="sunken">
            <SubHeading>Debt payments</SubHeading>
            <DebtPaymentsWidget
              transactions={transactions}
              period={period}
              ctx={txCtx}
              accounts={accounts}
              windowRows={data?.rows}
            />
          </Surface>
        </div>
      </Block>

      {/* ④ Income by Source — perspective-aware (cash-in by reason / income by source). */}
      <Block id="cashflow-income" label="Income by source">
        <Surface className="p-4 min-w-0">
          {renderIncome()}
        </Surface>
      </Block>

      {/* ⑤ What changed — deterministic then-vs-now observations (compareCashFlow),
           a separate two-window comparison the single-window contract does not own;
           fed the completeness `stamp`. No AI. */}
      <Block id="cashflow-insights" label="What changed">
        <Surface className="p-4 min-w-0">
          <CashFlowInsightsCard
            transactions={transactions}
            accounts={accounts}
            period={period}
            now={asOfClock}
            compareTo={compareTo}
            perspective={perspective}
            txCtx={txCtx}
            stamp={stamp}
          />
        </Surface>
      </Block>
    </div>
  );
}
