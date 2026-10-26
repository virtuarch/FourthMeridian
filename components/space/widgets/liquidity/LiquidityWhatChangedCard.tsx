"use client";

/**
 * components/space/widgets/liquidity/LiquidityWhatChangedCard.tsx
 *
 * S4 — the Liquidity "What Changed" panel body: the top cash-in / cash-out
 * liquidity drivers for the shell-bridged period, with a "View all activity in
 * Cash Flow →" doorway. Pure over its props; the build is memoized. It shows
 * liquidity-axis reasons and points to Cash Flow for detail — it NEVER grows
 * drill-down drawers or filters (that is Cash Flow's workspace, by doctrine).
 *
 * v2.7 R4 — COMPACT (<1024px) only: the same rows, largest |amount| first, the
 * top 3 shown and the rest behind "Show all N" (a compact-only list; the desktop
 * grid is max-lg:hidden, so at ≥1024px the card renders exactly as before).
 */

import { useId, useMemo, useState } from "react";
import { ArrowRight, Waves } from "lucide-react";
import { formatAggregateMoney } from "@/components/space/widgets/display-money";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { periodKey, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { buildWhatChangedRows, type WhatChangedRow } from "./liquidity-what-changed";
import { CompactDisclosureButton } from "@/components/space/compact/CompactDisclosure";

/** v2.7 R4 — how many drivers the compact card shows before "Show all". */
export const COMPACT_DRIVER_COUNT = 3;

/** The compact order: the SAME rows, largest absolute amount first (stable). A sort, never a new figure. */
export function compactDriverOrder(rows: readonly WhatChangedRow[]): WhatChangedRow[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => Math.abs(b.r.amount) - Math.abs(a.r.amount) || a.i - b.i).map((x) => x.r);
}

function fmtSigned(amount: number, ctx?: ConversionContext): string {
  // REVIEW-3 B-5 — no context ⇒ no currency claim (display-money.ts).
  const abs = formatAggregateMoney(Math.abs(amount), ctx);
  return `${amount >= 0 ? "+" : "−"}${abs}`;
}

export function LiquidityWhatChangedCard({
  transactions,
  accounts,
  period,
  ctx,
  asOf,
  onOpenCashFlow,
}: {
  transactions?:  Transaction[] | null;
  accounts:       { id: string; type: string }[];
  period:         CashFlowPeriod;
  ctx?:           ConversionContext;
  /** The shell's selected as-of date — the window anchor. Required: without it
   *  this card windowed against today and disagreed with the Liquidity chart
   *  beside it on any historical date. */
  asOf:           string;
  onOpenCashFlow?: () => void;
}) {
  const periodId = periodKey(period);
  const result = useMemo(
    () => buildWhatChangedRows({ transactions, accounts, period, ctx, asOf }),
    // period is reconstructed from periodId (a stable primitive).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, accounts, periodId, ctx, asOf],
  );
  const [showAll, setShowAll] = useState(false);
  const listId = `compact-drivers-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  if (result.state === "loading") {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
  }
  if (result.state === "empty") {
    return (
      <div className="text-center py-8">
        <Waves size={22} className="text-[var(--text-faint)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No cash moved in this period</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Top cash-in and cash-out drivers appear once cash moves.</p>
      </div>
    );
  }

  const renderRow = (r: WhatChangedRow, className = "flex items-center justify-between gap-2") => {
    const color = r.direction === "in" ? "var(--flow-in, #22c55e)" : "var(--flow-out, #ef4444)";
    return (
      <div key={r.id} className={className}>
        <span className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm text-[var(--text-secondary)] truncate">{r.label}</span>
        </span>
        <span className="text-sm font-medium tabular-nums shrink-0" style={{ color }}>{fmtSigned(r.amount, ctx)}</span>
      </div>
    );
  };
  const compactRows = compactDriverOrder(result.rows);
  const extra = compactRows.length - COMPACT_DRIVER_COUNT;

  return (
    <div className="space-y-3">
      {/* v2.7 R4 — compact-only list (before the desktop grid, so the grid's
          place among its siblings is unchanged at ≥1024px). */}
      <div className="lg:hidden" data-compact-drivers>
        <div id={listId} className="space-y-1.5">
          {compactRows.map((r, i) => renderRow(r, i < COMPACT_DRIVER_COUNT || showAll ? "flex items-center justify-between gap-2" : "hidden"))}
        </div>
        {extra > 0 && (
          <div className="-ml-2 mt-1">
            <CompactDisclosureButton open={showAll} onToggle={() => setShowAll((v) => !v)} controls={listId} label={`Show all ${compactRows.length}`} openLabel="Show top 3" />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-lg:hidden">
        {result.rows.map((r) => renderRow(r))}
      </div>

      {onOpenCashFlow && (
        <button
          type="button"
          onClick={onOpenCashFlow}
          className="flex items-center gap-1 text-xs font-medium text-[var(--meridian-400)] hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)] rounded"
        >
          View all activity in Cash Flow <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}
