"use client";

/**
 * components/space/widgets/cashflow/CashFlowCategoryDetail.tsx
 *
 * The per-category (or per-source) DETAIL body, shown inside the ledger's RightPanel
 * (the Atlas panel primitive — "tell me more about what I selected"). The Cash Flow
 * analogue of HoldingDetail / DebtAccountDetail: it leads with the slice's OWN facts
 * and composes the EXISTING transaction drill for deeper exploration.
 *
 * HONESTY: every figure is the ledger's own already-converted contribution + the
 * caller's slice rows — nothing is re-derived here, so the panel and the row can never
 * disagree. No merchant insight, no AI, no forecast, no fabricated trend: per-category
 * history is not carried by the Cash Flow contract, so it is OMITTED (the note says so).
 * "Related transactions" reuse the existing TransactionSliceDrawer, not a new surface.
 */

import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { formatCurrency } from "@/lib/format";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { ChevronRight } from "lucide-react";

export function CashFlowCategoryDetail({
  label,
  value,
  total,
  color,
  rows,
  ctx,
  valueLabel,
  shareLabel,
  onOpenTransactions,
}: {
  label:  string;
  value:  number;
  /** The slice's parent total, for the share read (Σ of all items in the ledger). */
  total:  number;
  color:  string;
  /** The transactions behind this slice (from the caller's sliceFor). */
  rows:   Transaction[];
  ctx?:   ConversionContext;
  /** e.g. "this period" — the honest window suffix under the headline value. */
  valueLabel: string;
  /** e.g. "Share of spending" / "Share of cash in". */
  shareLabel: string;
  /** Opens the EXISTING TransactionSliceDrawer for these rows (the caller owns it). */
  onOpenTransactions: () => void;
}) {
  const fmt = (v: number) => (ctx ? formatCurrency(v, ctx.target) : formatCurrency(v, DEFAULT_DISPLAY_CURRENCY));
  const pct = total > 0 ? (value / total) * 100 : 0;
  const count = rows.length;

  return (
    <div className="min-w-0">
      {/* Headline value. */}
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 flex items-center gap-2 text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        {fmt(value)}
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{valueLabel}</p>

      {/* Share of the parent total — a real ratio over figures already on screen. */}
      <div className="mt-5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[var(--text-faint)]">{shareLabel}</span>
          <span className="font-semibold tabular-nums text-[var(--text-secondary)]">{pct.toFixed(1)}%</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-inset)]">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: color }} />
        </div>
      </div>

      {/* Related transactions — composes the EXISTING drill (TransactionSliceDrawer),
          never a new list. Full-width tap target. */}
      <button
        type="button"
        onClick={onOpenTransactions}
        disabled={count === 0}
        className="mt-5 flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-3 py-2.5 text-left transition-colors enabled:hover:bg-[var(--surface-hover)] disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
      >
        <span className="text-sm text-[var(--text-secondary)]">
          {count === 0 ? "No transactions in this slice" : `View ${count} transaction${count === 1 ? "" : "s"}`}
        </span>
        {count > 0 && <ChevronRight size={16} className="shrink-0 text-[var(--text-faint)]" aria-hidden />}
      </button>

      {/* Honest scope note — what this panel does NOT show, said plainly. */}
      <p className="mt-5 text-[11px] leading-snug text-[var(--text-faint)]">
        Figures reflect this period&rsquo;s posted transactions. Per-category history over time isn&rsquo;t
        tracked — the Activity calendar above shows daily movement across all categories.
      </p>
    </div>
  );
}
