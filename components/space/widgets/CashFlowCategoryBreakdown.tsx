"use client";

/**
 * components/space/widgets/CashFlowCategoryBreakdown.tsx
 *
 * "Where outflows go" for the Cash Flow Perspective (UX-PER-3 refinement) — a
 * calmer, denser alternative to a plain ranked bar list. Two coordinated parts:
 *
 *   1. Allocation strip — one 100%-of-spend stacked bar, each category a colored
 *      segment sized to its share. Instant composition read.
 *   2. Category cards  — a compact two-column grid (name · value · share), each
 *      with its color and a share sliver, largest first. Scannable, object-like,
 *      and shorter than N full-width bars for 3–12 categories.
 *
 * SAME data + math as before: `outflowByCategory` (FlowType-aware, refunds net
 * their category, descending). Presentation only — no new calculation.
 */

import { useState } from "react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { CashFlowContribution } from "@/lib/transactions/cash-flow";
import type { Transaction } from "@/types";
import { TransactionSliceDrawer, type TransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";

// Matches BreakdownWidget's DEFAULT_PALETTE so spend colors stay consistent
// with the rest of the product; cycles for >8 categories.
const PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316", "#84cc16",
];

interface Props {
  items: CashFlowContribution[];   // descending, value > 0 (from outflowByCategory / incomeBySource)
  ctx?:  ConversionContext;
  /** Header total label — defaults to spending. Income by Source passes its own. */
  totalLabel?:    string;
  emptyHeadline?: string;
  emptySubline?:  string;
  /** Drill-down: resolve the transactions behind one item (category / source).
   *  When provided, cards + strip segments open a TransactionSliceDrawer. */
  sliceFor?:      (item: CashFlowContribution) => Transaction[];
  sliceSubtitle?: string;
}

export function CashFlowCategoryBreakdown({
  items,
  ctx,
  totalLabel    = "Total spending",
  emptyHeadline = "No spending in this period",
  emptySubline  = "Spending by category appears once you have outflows.",
  sliceFor,
  sliceSubtitle,
}: Props) {
  const [slice, setSlice] = useState<TransactionSlice | null>(null);
  const openSlice = sliceFor
    ? (item: CashFlowContribution) => setSlice({ title: item.label, subtitle: sliceSubtitle, rows: sliceFor(item) })
    : undefined;
  const fmt = ctx
    ? (v: number) => formatCurrency(v, ctx.target)
    : (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);

  const total = items.reduce((s, c) => s + c.value, 0);
  if (items.length === 0 || total <= 0) {
    return (
      <div className="text-center py-5 space-y-1">
        <p className="text-sm text-[var(--text-secondary)]">{emptyHeadline}</p>
        <p className="text-xs text-[var(--text-faint)]">{emptySubline}</p>
      </div>
    );
  }

  const colored = items.map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length], pct: (c.value / total) * 100 }));

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">{totalLabel}</span>
        <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">{fmt(total)}</span>
      </div>

      {/* 1. Allocation strip — full-width composition at a glance. Segments are
             clickable when drill-down is enabled. */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-inset)" }}>
        {colored.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-label={`${c.label}: ${fmt(c.value)}`}
            title={`${c.label} · ${fmt(c.value)} · ${c.pct.toFixed(1)}%`}
            onPointerDown={openSlice ? (e) => e.stopPropagation() : undefined}
            onClick={openSlice ? () => openSlice(c) : undefined}
            disabled={!openSlice}
            className={openSlice ? "cursor-pointer transition-opacity hover:opacity-80" : "cursor-default"}
            style={{ width: `${c.pct}%`, backgroundColor: c.color, border: "none", padding: 0 }}
          />
        ))}
      </div>

      {/* 2. Category cards — dense, ranked, name · value · share. Cards open the
             slice drawer when drill-down is enabled. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {colored.map((c) => {
          const inner = (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                <span className="text-xs font-medium truncate text-[var(--text-primary)]">{c.label}</span>
                <span className="ml-auto text-[10px] tabular-nums text-[var(--text-faint)] shrink-0">{c.pct.toFixed(1)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 rounded-full overflow-hidden" style={{ background: "var(--surface-base, rgba(255,255,255,0.04))" }}>
                  <div className="h-full rounded-full" style={{ width: `${Math.max(3, c.pct)}%`, backgroundColor: c.color }} />
                </div>
                <span className="text-xs font-semibold tabular-nums text-[var(--text-primary)] shrink-0">{fmt(c.value)}</span>
              </div>
            </>
          );
          const cardStyle = { background: "var(--surface-inset)", borderColor: "var(--border-subtle, rgba(255,255,255,0.06))" };
          return openSlice ? (
            <button
              key={c.id}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => openSlice(c)}
              className="text-left rounded-xl p-2.5 flex flex-col gap-1.5 border transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
              style={cardStyle}
            >
              {inner}
            </button>
          ) : (
            <div key={c.id} className="rounded-xl p-2.5 flex flex-col gap-1.5 border" style={cardStyle}>
              {inner}
            </div>
          );
        })}
      </div>

      {slice && <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />}
    </div>
  );
}
