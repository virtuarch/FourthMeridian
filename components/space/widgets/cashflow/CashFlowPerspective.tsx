"use client";

/**
 * components/space/widgets/cashflow/CashFlowPerspective.tsx
 *
 * The Cash Flow Perspective workspace — a multi-panel composition of the SAME
 * five mounted Cash Flow widgets that the generic SectionCard stack rendered
 * before, relocated into a 2D grid. Mirrors the landed WealthPerspective grid
 * pattern (grid-cols-1 lg:grid-cols-12, mobile stacks in source order, every
 * column min-w-0); it is NOT a new layout abstraction — no registry, no schema,
 * no grid engine.
 *
 * This component owns NO state: time stays host-owned (period / onSelectPeriod
 * come in as props, exactly as the SectionCard path passed them). Data contracts
 * stay single-sourced — the panels reuse the adapter render functions from
 * cash-flow-adapters.tsx. The one exception is the Spending panel, which calls
 * CashFlowCategoryBreakdown directly (via the same pure helpers the adapter uses)
 * so it can pass the narrow-column card grid; behavior is otherwise identical.
 *
 * Layout (plan §3.3) — desktop is a 12-column grid; mobile/tablet stacks in
 * source order Summary → History → Spending → Debt → Income:
 *   xl (≥1280): ① Summary 4 · ② History 5 · ③ Spending+Debt 3   (row 1)
 *               ④ Income 12                                       (row 2, until S4 Insights)
 *   lg (1024):  ① Summary 5 · ② History 7                        (row 1)
 *               ③ Spending+Debt 6 · ④ Income 6                    (row 2)
 *
 * The calendar and every in-widget control (perspective/measure chips,
 * Calendar/Cards toggle, M/Q/Y selects, the Summary toggle, all drill-downs)
 * stay INSIDE their widgets, untouched — the calendar-usability invariant.
 */

import type { ReactNode } from "react";
import { Waves } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import {
  filterByPeriod,
  outflowByCategory,
  periodLabel,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { isCostFlow, isRefund } from "@/lib/transactions/flow-predicates";
import type { CashFlowPerspective as CashFlowPerspectiveMode } from "@/lib/transactions/cash-flow-projection";
import { CashFlowCategoryBreakdown } from "@/components/space/widgets/CashFlowCategoryBreakdown";
import {
  renderCashFlowSummary,
  renderCashFlowHistory,
  renderIncomeBySource,
  renderDebtPayments,
} from "@/components/space/widgets/cash-flow-adapters";

// The card language is exactly the SectionCard solid-lede treatment
// (SpaceDashboard.tsx:1792–1795): GlassPanel depth="thin" elevation="e2"
// radius="lg" p-4 with a text-sm font-semibold header line. `h-full min-w-0`
// lets items-stretch balance rows without fixed heights. This is NOT a new card
// system — it reproduces the existing one so the panels read identically.
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

export function CashFlowPerspective({
  transactions,
  txCtx,
  accounts,
  period,
  onSelectPeriod,
  perspective,
  filterId,
  onPerspectiveChange,
}: {
  transactions?:        Transaction[] | null;
  txCtx?:               ConversionContext;
  accounts:             { id: string; type: string }[];
  period:               CashFlowPeriod;
  onSelectPeriod:       (period: CashFlowPeriod) => void;
  perspective?:         CashFlowPerspectiveMode;
  filterId?:            string;
  onPerspectiveChange?: (perspective: CashFlowPerspectiveMode, filterId: string) => void;
}) {
  // Spending by Category — identical data + drill-down to renderCashFlowByCategory,
  // rendered directly so the narrow right-rail column gets single-column cards at
  // xl (sm:grid-cols-2 xl:grid-cols-1) while staying two-column when wide. The
  // loading / whole-period-empty sentinels mirror the adapter exactly.
  function renderSpending(): ReactNode {
    if (transactions == null) {
      return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
    }
    const rows = filterByPeriod(transactions, period);
    if (rows.length === 0) {
      return (
        <div className="text-center py-8">
          <Waves size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-muted)]">No money moved in this period</p>
          <p className="text-xs text-[var(--text-faint)] mt-1">Spending by category appears once you have outflows.</p>
        </div>
      );
    }
    return (
      <CashFlowCategoryBreakdown
        items={outflowByCategory(rows, txCtx)}
        ctx={txCtx}
        cardGridClassName="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-2"
        sliceSubtitle="Spending in this category"
        sliceFor={(item) => rows.filter((t) => t.category === item.id && (isCostFlow(t.flowType) || isRefund(t.flowType)))}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
      {/* ① Cash Flow Summary — header names the active period, from the same
           authoritative `period` every panel consumes. */}
      <div className="min-w-0 lg:col-span-5 xl:col-span-4">
        <Panel title={`Cash Flow Summary · ${periodLabel(period)}`}>
          {renderCashFlowSummary(transactions, period, txCtx, accounts, perspective, onPerspectiveChange)}
        </Panel>
      </div>

      {/* ② Cash Flow History — the visually dominant panel; the calendar and its
           whole control cluster live inside, byte-identical. */}
      <div className="min-w-0 lg:col-span-7 xl:col-span-5">
        <Panel title="Cash Flow History">
          {renderCashFlowHistory(transactions, period, txCtx, onSelectPeriod, accounts, perspective, filterId, onPerspectiveChange)}
        </Panel>
      </div>

      {/* ③ Right column — Spending by Category over its de-emphasized liquidity
           twin, Debt Payments. A flex stack (not a grid row-span) so panel
           heights stay content-defined. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-3 flex flex-col gap-4">
        <Panel title="Spending by Category">
          {renderSpending()}
        </Panel>
        <Panel title="Debt Payments" subdued>
          {renderDebtPayments(transactions, period, txCtx, accounts)}
        </Panel>
      </div>

      {/* ④ Income by Source — perspective-aware (cash-in by reason / income by
           source). Spans the remaining row width until S4 adds Key Insights. */}
      <div className="min-w-0 lg:col-span-6 xl:col-span-12">
        <Panel title="Income by Source">
          {renderIncomeBySource(transactions, period, txCtx, accounts, perspective)}
        </Panel>
      </div>
    </div>
  );
}
