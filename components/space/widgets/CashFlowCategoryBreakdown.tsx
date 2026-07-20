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
import { ChevronDown, ChevronUp } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { CashFlowContribution } from "@/lib/transactions/cash-flow";
import type { Transaction } from "@/types";
import { TransactionSliceDrawer, type TransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";
import { CHART_PALETTE } from "@/lib/charts/chart-palette";

// The one shared categorical palette. This was a hand-kept third copy of the
// same eight hues ("matches BreakdownWidget's DEFAULT_PALETTE") — a comment is
// not a constraint, so it could drift silently. Imported now instead.
const PALETTE = CHART_PALETTE;

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
  /** Phase 2 — how many cards show on narrow/mobile widths before "Show more".
   *  Wide (≥sm) always shows all; this only truncates the stacked mobile grid. */
  mobileTopN?:    number;
  /** Presentation-only override for the category-card grid classes. Defaults to
   *  the two-column grid; the Cash Flow Perspective passes a narrow-column
   *  variant (single column at xl) for the right-rail Spending panel. No data,
   *  ordering, or drill-down change. */
  cardGridClassName?: string;
}

export function CashFlowCategoryBreakdown({
  items,
  ctx,
  totalLabel    = "Total spending",
  emptyHeadline = "No spending in this period",
  emptySubline  = "Spending by category appears once you have outflows.",
  sliceFor,
  sliceSubtitle,
  mobileTopN = 4,
  cardGridClassName = "grid grid-cols-1 sm:grid-cols-2 gap-2",
}: Props) {
  const [slice, setSlice] = useState<TransactionSlice | null>(null);
  // Phase 2 — narrow/mobile truncation. Collapsed by default; wide screens (≥sm)
  // ignore this entirely (CSS below always shows every card at ≥sm). Ordering,
  // totals and drill-down are untouched — this only hides overflow cards on
  // mobile until "Show more". No recomputation / reclassification.
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const openSlice = sliceFor
    ? (item: CashFlowContribution) => setSlice({
        title: item.label, subtitle: sliceSubtitle, rows: sliceFor(item),
        // The clicked value, so the drawer visibly reconciles even for slices
        // whose rows are neither income nor spending (debt payments, cash-in
        // reasons) — the drawer shows it only when the flow totals are both 0.
        total: item.value, totalLabel: "Total",
      })
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
             slice drawer when drill-down is enabled. Beyond mobileTopN, cards are
             hidden on mobile (until "Show more") but ALWAYS shown at ≥sm. */}
      <div className={cardGridClassName}>
        {colored.map((c, idx) => {
          const overflow = idx >= mobileTopN;
          // Overflow cards: hidden on mobile when collapsed; every card is shown
          // at ≥sm regardless. `flex` restores the card's own flex layout at ≥sm.
          const visibility = overflow && !mobileExpanded ? "hidden sm:flex" : "flex";
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
              className={`text-left rounded-xl p-2.5 ${visibility} flex-col gap-1.5 border transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]`}
              style={cardStyle}
            >
              {inner}
            </button>
          ) : (
            <div key={c.id} className={`rounded-xl p-2.5 ${visibility} flex-col gap-1.5 border`} style={cardStyle}>
              {inner}
            </div>
          );
        })}
      </div>

      {/* Phase 2 — Show more / less, mobile-only (hidden at ≥sm where every card
          is already visible). Only when there are overflow categories. Full-width
          tap target ≥44px; toggles the mobile list, never opens a drawer. */}
      {colored.length > mobileTopN && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMobileExpanded((v) => !v)}
          className="sm:hidden w-full flex items-center justify-center gap-1 min-h-[44px] rounded-xl text-xs font-semibold text-[var(--meridian-400)] border transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
          style={{ borderColor: "var(--border-subtle, rgba(255,255,255,0.06))" }}
          aria-expanded={mobileExpanded}
        >
          {mobileExpanded
            ? <>Show less <ChevronUp size={14} /></>
            : <>Show {colored.length - mobileTopN} more <ChevronDown size={14} /></>}
        </button>
      )}

      {slice && <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />}
    </div>
  );
}
