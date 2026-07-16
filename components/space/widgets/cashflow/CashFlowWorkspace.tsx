"use client";

/**
 * components/space/widgets/cashflow/CashFlowWorkspace.tsx  (SD-6C)
 *
 * The Cash Flow Workspace — the SpaceShell → CashFlowWorkspace boundary. It
 * replaces the former stateless CashFlowPerspective composition with a real
 * workspace that:
 *
 *   1. CONSUMES the canonical composition contract — it builds `CashFlowSpaceData`
 *      ONCE (buildCashFlowSpaceData, "composes, computes none") and feeds the SAME
 *      windowed projection into every panel: summary, history (calendar/cards),
 *      spending by category, income, debt payments, context, and trust. No panel
 *      re-windows or re-folds from raw transactions — the contract is the source.
 *   2. OWNS the workspace-local semantic-slice state — the perspective toggle
 *      (Cash Flow ⇄ Spending) and the measure filter — RELOCATED here from the
 *      host. Calendar/Cards mode, the All-Time year cursor, and every day/bucket
 *      drill live inside the child widgets (part of this workspace boundary).
 *
 * Canonical TIME stays host-owned: `period` (derived from the SD-0B shell preset
 * + the explicit-drill bridge) and `onSelectPeriod` come in as props; this
 * workspace never owns a second date authority. `stamp` is the host-computed
 * completeness stamp (also the shell chip's source), passed straight to Insights
 * so the caveat and the chip can never disagree.
 *
 * Layout is byte-identical to the prior CashFlowPerspective grid (the 12-column
 * pattern, the same spans, mobile source order Summary → History → Spending →
 * Debt → Income → Insights); only the panel DATA SOURCE changed (contract slices
 * instead of per-widget re-projection). The calendar and every in-widget control
 * (perspective/measure chips, Calendar/Cards toggle, M/Q/Y selects, drill-downs)
 * are untouched — the heatmap-usability invariant.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Waves } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { periodLabel, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { incomeSourceLabel } from "@/lib/transactions/cash-flow";
import type { CashFlowPerspective as CashFlowPerspectiveMode } from "@/lib/transactions/cash-flow-projection";
import { cashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import { buildCashFlowSpaceData } from "@/lib/transactions/cash-flow-space-data";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { DEFAULT_FILTER_ID } from "@/components/space/widgets/CashFlowFilterControls";
import { CashFlowSummaryWidget } from "@/components/space/widgets/CashFlowSummaryWidget";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";
import { DebtPaymentsWidget } from "@/components/space/widgets/DebtPaymentsWidget";
import { CashFlowInsightsCard } from "./CashFlowInsightsCard";

// The card language is exactly the SectionCard solid-lede treatment — GlassPanel
// depth="thin" elevation="e2" radius="lg" p-4 with a text-sm font-semibold header.
// `h-full min-w-0` lets items-stretch balance rows without fixed heights. This is
// NOT a new card system — it reproduces the existing one so the panels read
// identically to the prior CashFlowPerspective.
function Panel({ title, subdued, children }: { title: string; subdued?: boolean; children: ReactNode }) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 h-full min-w-0">
      <p className={`text-sm font-semibold px-1 mb-2 ${subdued ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
        {title}
      </p>
      {children}
    </GlassPanel>
  );
}

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

export function CashFlowWorkspace({
  transactions,
  txCtx,
  accounts,
  period,
  onSelectPeriod,
  onEnvelopeChange,
}: {
  transactions?:   Transaction[] | null;
  txCtx?:          ConversionContext;
  accounts:        { id: string; type: string }[];
  period:          CashFlowPeriod;
  onSelectPeriod:  (period: CashFlowPeriod) => void;
  /** SD-6 gate — the workspace now OWNS its completeness stamp (computed below from
   *  its own transactions + period) and emits the resulting trust envelope; the host
   *  merely relays it to the shell chip (mirrors Wealth/Investments/Liquidity). */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}) {
  // Workspace-local semantic slice — the perspective toggle + measure filter,
  // relocated here from the host. The Summary / History widgets host the selector
  // controls and drive this state through `changePerspective`.
  const [perspective, setPerspective] = useState<CashFlowPerspectiveMode>("liquidity");
  const [filterId, setFilterId] = useState<string>(DEFAULT_FILTER_ID);
  const changePerspective = (p: CashFlowPerspectiveMode, id: string) => {
    setPerspective(p);
    setFilterId(id);
  };

  // THE composition boundary — one canonical projection of the selected window,
  // fanned out to every panel. Null while transactions load (widgets show their own
  // loading state via the null-transactions guard).
  const data = useMemo(
    () => (transactions ? buildCashFlowSpaceData({ transactions, accounts, period, moneyCtx: txCtx }) : null),
    [transactions, accounts, period, txCtx],
  );

  // Completeness stamp — RELOCATED here from the host (SD-6 gate): the workspace has
  // everything the stamp needs (its own transactions + the canonical period), so it
  // owns the ONE computation and feeds it to BOTH the Insights caveat (below) and the
  // shell chip envelope (emitted up), which therefore can never disagree. Coverage is
  // a property of the data, so the FULL history is stamped, not a period slice. Null
  // while transactions load ⇒ the caveat is omitted and the chip shows static text.
  const stamp = useMemo(
    () => (transactions
      ? cashFlowStamp({ transactions: transactions as unknown as LiquidityTx[], period, now: () => new Date() })
      : null),
    [transactions, period],
  );
  useEffect(() => {
    onEnvelopeChange(resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", cashFlowStamp: stamp }));
  }, [stamp, onEnvelopeChange]);

  // Liquidity context for the income-panel drill filters (a pure selection over the
  // contract's already-windowed rows — never a re-window or re-classification fold).
  const liqCtx = useMemo(() => tierResolver(accounts), [accounts]);

  // ── Spending by Category — contract `outflowByCategory`, drilled over `rows`. ──
  function renderSpending(): ReactNode {
    if (data == null) return <LoadingCard />;
    if (data.rows.length === 0) {
      return <EmptyCard headline="No money moved in this period" sub="Spending by category appears once you have outflows." />;
    }
    return (
      <CashFlowCategoryBreakdown
        items={data.outflowByCategory}
        ctx={txCtx}
        cardGridClassName="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-2"
        sliceSubtitle="Spending in this category"
        sliceFor={(item) => data.rows.filter((t) => t.category === item.id && (isCostFlow(t.flowType) || isRefund(t.flowType)))}
      />
    );
  }

  // ── Income by Source — perspective-aware, from the contract's canonical slices
  //    (cashInByReason on the liquidity axis, incomeBySource on the economic axis).
  //    Reproduces renderIncomeBySource exactly; the only computation is the pure
  //    drill filter over the contract's windowed rows. ──
  function renderIncome(): ReactNode {
    if (data == null) return <LoadingCard />;
    if (perspective === "liquidity") {
      if (data.rows.length === 0) return <EmptyCard headline="No money moved in this period" sub="Cash in by source appears once cash arrives." />;
      return (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-[var(--text-secondary)]">Cash in by source</p>
          <CashFlowCategoryBreakdown
            items={data.cashInByReason.map((l) => ({ id: l.reason, label: l.label, value: l.amount }))}
            ctx={txCtx}
            totalLabel="Total cash in"
            emptyHeadline="No cash arrived in this period"
            emptySubline="Cash in by source appears once cash arrives."
            sliceSubtitle="Cash in from this source"
            sliceFor={(item) => (data.rows as LiquidityTx[]).filter((t) => {
              const c = classifyLiquidity(t, liqCtx);
              return c.effect === "CASH_IN" && c.reason === item.id;
            })}
          />
        </div>
      );
    }
    if (data.rows.length === 0) return <EmptyCard headline="No money moved in this period" sub="Income by source appears once you have inflows." />;
    return (
      <div className="space-y-2">
        <p className="text-[11px] font-semibold text-[var(--text-secondary)]">Income by source</p>
        <CashFlowCategoryBreakdown
          items={data.incomeBySource}
          ctx={txCtx}
          totalLabel="Total income"
          emptyHeadline="No income in this period"
          emptySubline="Income by source appears once you have inflows."
          sliceSubtitle="Income from this source"
          sliceFor={(item) => data.rows.filter((t) => isIncome(t.flowType) && incomeSourceLabel(t) === item.id)}
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
      {/* ① Cash Flow Summary — header names the active period. Fed the contract's
           `summary` facts + `context` + windowed `rows`. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4">
        <Panel title={`Cash Flow Summary · ${periodLabel(period)}`}>
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
          />
        </Panel>
      </div>

      {/* ② Cash Flow History — the calendar + its whole control cluster live inside,
           byte-identical. Fed the contract's windowed `rows`, `daily` (calendar) and
           `buckets` (cards). */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-5">
        <Panel title="Cash Flow History">
          <CashFlowHistoryWidget
            transactions={transactions}
            period={period}
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
        </Panel>
      </div>

      {/* ③ Right column — Spending by Category over its de-emphasized liquidity twin,
           Debt Payments. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-3 flex flex-col gap-4">
        <Panel title="Spending by Category">
          {renderSpending()}
        </Panel>
        <Panel title="Debt Payments" subdued>
          <DebtPaymentsWidget
            transactions={transactions}
            period={period}
            ctx={txCtx}
            accounts={accounts}
            windowRows={data?.rows}
          />
        </Panel>
      </div>

      {/* ④ Income by Source — perspective-aware (cash-in by reason / income by source). */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-7">
        <Panel title="Income by Source">
          {renderIncome()}
        </Panel>
      </div>

      {/* ⑤ Key Insights — deterministic then-vs-now observations (compareCashFlow),
           a separate two-window comparison the single-window contract does not own;
           fed the host completeness `stamp`. */}
      <div className="min-w-0 lg:col-span-12 xl:col-span-5">
        <Panel title="Key Insights">
          <CashFlowInsightsCard
            transactions={transactions}
            accounts={accounts}
            period={period}
            perspective={perspective}
            txCtx={txCtx}
            stamp={stamp}
          />
        </Panel>
      </div>
    </div>
  );
}
