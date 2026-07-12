"use client";

/**
 * components/space/widgets/liquidity/LiquidityWhatChangedCard.tsx
 *
 * S4 — the Liquidity "What Changed" panel body: the top cash-in / cash-out
 * liquidity drivers for the shell-bridged period, with a "View all activity in
 * Cash Flow →" doorway. Pure over its props; the build is memoized. It shows
 * liquidity-axis reasons and points to Cash Flow for detail — it NEVER grows
 * drill-down drawers or filters (that is Cash Flow's workspace, by doctrine).
 */

import { useMemo } from "react";
import { ArrowRight, Waves } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import { periodKey, type CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { buildWhatChangedRows } from "./liquidity-what-changed";

function fmtSigned(amount: number, ctx?: ConversionContext): string {
  const abs = ctx
    ? formatCurrency(Math.abs(amount), ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(Math.abs(amount));
  return `${amount >= 0 ? "+" : "−"}${abs}`;
}

export function LiquidityWhatChangedCard({
  transactions,
  accounts,
  period,
  ctx,
  onOpenCashFlow,
}: {
  transactions?:  Transaction[] | null;
  accounts:       { id: string; type: string }[];
  period:         CashFlowPeriod;
  ctx?:           ConversionContext;
  onOpenCashFlow?: () => void;
}) {
  const periodId = periodKey(period);
  const result = useMemo(
    () => buildWhatChangedRows({ transactions, accounts, period, ctx }),
    // period is reconstructed from periodId (a stable primitive).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, accounts, periodId, ctx],
  );

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

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        {result.rows.map((r) => {
          const color = r.direction === "in" ? "var(--flow-in, #22c55e)" : "var(--flow-out, #ef4444)";
          return (
            <div key={r.id} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 min-w-0">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-sm text-[var(--text-secondary)] truncate">{r.label}</span>
              </span>
              <span className="text-sm font-medium tabular-nums shrink-0" style={{ color }}>{fmtSigned(r.amount, ctx)}</span>
            </div>
          );
        })}
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
