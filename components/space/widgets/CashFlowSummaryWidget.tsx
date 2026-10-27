"use client";

/**
 * components/space/widgets/CashFlowSummaryWidget.tsx
 *
 * Cash Flow's Cash In / Cash Out summaries — the LIQUIDITY axis (spendable cash)
 * from the shared DayFacts projection (aggregateDayFacts — the SOLE fold), each
 * expandable into its reason breakdown (Earned income, Spending, Debt payments,
 * Money invested, …) straight from the liquidity engine's per-reason output
 * (groupLiquidityByReason) — no recomputation here. Every line drills into its
 * exact rows (the shared slice drawer).
 *
 * v2.7 FINAL PERSPECTIVE UX PASS (owner) — this widget is now ONLY the two
 * tiles. The Cash Flow ⇄ Spending toggle is gone (Spending is its own
 * perspective, with its own hero and breakdown), and the movement context
 * (charged on credit, unresolved / internal transfers, needs classification)
 * moved to its own section further down the page (CashFlowMovements), after
 * the Activity heatmap.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatAggregateMoney } from "@/components/space/widgets/display-money";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import {
  filterByPeriod,
  asOfAnchor,
  type CashFlowPeriod, periodKey } from "@/lib/transactions/cash-flow";
import {
  classifyLiquidity,
  tierResolver,
  type LiquidityTx,
  type LiquidityEffect,
} from "@/lib/transactions/liquidity";
import { groupLiquidityByReason } from "@/lib/transactions/liquidity-breakdown";
import { aggregateDayFacts, type DayFacts } from "@/lib/transactions/cash-flow-projection";
import { TransactionSliceDrawer, useTransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";

function fmt(v: number, ctx?: ConversionContext): string {
  // REVIEW-3 B-5 — no context ⇒ no currency claim (display-money.ts).
  return formatAggregateMoney(v, ctx);
}

interface TierAccount { id: string; type: string }

/** A breakdown line — widened from LiquiditySliceLine so the same tile renders
 *  economic lines too (reason is just a stable key/handler discriminator here). */
type TileLine = { reason: string; label: string; amount: number };

interface Props {
  transactions: Transaction[] | null | undefined;
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  accounts:     TierAccount[];
  /** SD-6C — pre-computed slices from CashFlowSpaceData (the workspace composition
   *  boundary). When supplied the widget consumes them instead of re-windowing +
   *  re-folding from raw rows — byte-identical (same authority, same window). */
  windowRows?:          Transaction[];
  /** The SELECTED as-of date (YYYY-MM-DD) — the anchor for the fallback window. */
  asOf?:                string;
  facts?:               DayFacts;
}

/** The Cash Out tile's note — exported so a test can pin the exact copy. */
export const CASH_OUT_HINT = "Card purchases count here when you pay the card.";

/** One expandable side (Cash In or Cash Out) with its reason breakdown. Each
 *  reason line drills into its exact transactions when `onOpenLine` is provided. */
function AxisTile({
  label, total, accent, lines, ctx, sign, onOpenLine, hint,
}: {
  label:  string;
  total:  number;
  accent: "green" | "red";
  lines:  TileLine[];
  ctx?:   ConversionContext;
  sign:   "+" | "−";
  onOpenLine?: (line: TileLine) => void;
  /** A one-line, visually subordinate note under the figure. */
  hint?:  string;
}) {
  const [open, setOpen] = useState(false);
  const color = accent === "green" ? "var(--accent-positive)" : "var(--accent-negative)";
  const canExpand = lines.length > 0;

  return (
    <div className="rounded-xl p-3" style={{ background: "var(--surface-inset)" }}>
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => setOpen((v) => !v)}
        onPointerDown={(e) => e.stopPropagation()}
        className={`w-full flex items-center justify-between gap-2 min-w-0 max-sm:flex-col max-sm:items-start max-sm:gap-0.5 ${canExpand ? "cursor-pointer" : "cursor-default"}`}
      >
        {/* CF-5 — responsive number discipline: the label may truncate (it never
            carries meaning past its first word) so the figure keeps its full digits;
            the figure shrinks a step on narrow widths and never wraps or overflows.
            v2.7 — below sm the label stacks ABOVE the figure, so at phone widths
            neither is cut ("C…" / "Cas…" at 390px before). Desktop is unchanged. */}
        <span className="flex items-center gap-1 text-xs min-w-0" style={{ color: "var(--text-muted)" }}>
          {canExpand && (open
            ? <ChevronDown size={12} className="shrink-0 text-[var(--text-faint)]" />
            : <ChevronRight size={12} className="shrink-0 text-[var(--text-faint)]" />)}
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-base sm:text-lg font-semibold tabular-nums" style={{ color }} title={`${sign}${fmt(total, ctx)}`}>{sign}{fmt(total, ctx)}</span>
      </button>
      {hint && <p data-tile-hint className="mt-1 text-[10px] leading-snug text-[var(--text-faint)]">{hint}</p>}

      {open && canExpand && (
        <div className="mt-2 space-y-1 border-t border-[var(--border-hairline)] pt-2">
          {lines.map((l) => (
            onOpenLine ? (
              <button
                key={l.reason}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onOpenLine(l)}
                className="w-full flex items-center justify-between text-[11px] rounded -mx-1 px-1 py-0.5 hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
              >
                <span className="text-[var(--text-secondary)]">{l.label}</span>
                <span className="tabular-nums text-[var(--text-primary)]">{fmt(l.amount, ctx)}</span>
              </button>
            ) : (
              <div key={l.reason} className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--text-secondary)]">{l.label}</span>
                <span className="tabular-nums text-[var(--text-primary)]">{fmt(l.amount, ctx)}</span>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

export function CashFlowSummaryWidget({ transactions, period, ctx, accounts, windowRows, asOf, facts: factsProp }: Props) {
  // Closes on a TimelineLens move — the window the slice described is gone.
  const [slice, setSlice] = useTransactionSlice(periodKey(period));

  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
  }
  const rows = (windowRows ?? filterByPeriod(transactions, period, asOfAnchor(asOf))) as LiquidityTx[];
  if (rows.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-[var(--text-muted)]">No cash moved in this period</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Cash in and out appear as transactions accumulate.</p>
      </div>
    );
  }

  const liqCtx = tierResolver(accounts);
  // The shared DayFacts projection is the SOLE fold; when the workspace supplies
  // the CashFlowSpaceData slice, `facts` IS its canonical `summary`.
  const facts = factsProp ?? aggregateDayFacts(rows, liqCtx, ctx);
  // Reason breakdown (effect-split) — a PURE PROJECTION over the same `facts`
  // (no second fold); its per-side totals equal facts.cashIn/out by construction.
  const breakdown = groupLiquidityByReason(facts);

  // Drill-down for a Cash In / Cash Out breakdown line — its exact contributing rows
  // (matched by effect + reason), opened in the shared slice drawer. Reuses the same
  // classifier the totals use, so the slice reconciles with the line amount.
  const openReasonSlice = (effect: LiquidityEffect, line: TileLine) =>
    setSlice({
      title: line.label,
      subtitle: effect === "CASH_IN" ? "Cash in this period" : "Cash out this period",
      // Explicit reconciling total — many liquidity reasons (Debt payments, From
      // investments, Money invested, Payment apps) are TRANSFER/DEBT rows, neither
      // income nor spending, so the drawer would otherwise show only a count.
      total: line.amount, totalLabel: "Total",
      rows: rows.filter((r) => {
        const c = classifyLiquidity(r, liqCtx);
        return c.effect === effect && c.reason === line.reason;
      }),
    });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <AxisTile label="Cash In"  total={facts.cashIn}  accent="green" sign="+" lines={breakdown.cashIn}  ctx={ctx} onOpenLine={(l) => openReasonSlice("CASH_IN", l)} />
        {/* CF-TIER-NET — Cash Out is a CASH measure, not spending: a card purchase
            moves no cash until the card is paid, so it enters here as a debt
            payment, possibly in another period. One line says the timing; it
            claims no matching between payments and purchases. */}
        <AxisTile label="Cash Out" total={facts.cashOut} accent="red"   sign="−" lines={breakdown.cashOut} ctx={ctx} onOpenLine={(l) => openReasonSlice("CASH_OUT", l)}
          hint={CASH_OUT_HINT} />
      </div>

      <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />
    </div>
  );
}
