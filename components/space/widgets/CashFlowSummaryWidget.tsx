"use client";

/**
 * components/space/widgets/CashFlowSummaryWidget.tsx
 *
 * Cash Flow Perspective headline — now the LIQUIDITY axis (spendable cash),
 * which is the primary user-facing model. Shows Cash In / Cash Out / Net Cash
 * from deriveCashFlowAxes(), each expandable into its reason breakdown (Earned
 * income, Asset liquidation, Debt proceeds, Spending, Debt payments, Asset
 * deployment, …) taken straight from the liquidity engine's per-reason output —
 * no recomputation here.
 *
 * The economic axis (earned income vs real cost) is NOT deleted: it's preserved
 * behind a quiet "Economic view" disclosure, and remains the basis of AI facts
 * and every other economic widget. This widget only changes which axis is
 * primary.
 *
 * Runtime note: the client transaction DTO does not yet carry
 * counterpartyAccountId (a separate, privacy-gated plumbing slice), so transfers
 * whose other side is unknown surface honestly as "Unresolved movement" rather
 * than being mislabeled. Income / spending / investment classify fully today.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";
import {
  filterByPeriod,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import {
  deriveCashFlowAxes,
  tierResolver,
  type LiquidityTx,
} from "@/lib/transactions/liquidity";
import {
  groupLiquidityByReason,
  type LiquiditySliceLine,
} from "@/lib/transactions/liquidity-breakdown";

function fmt(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
}

interface TierAccount { id: string; type: string }

interface Props {
  transactions: Transaction[] | null | undefined;
  period:       CashFlowPeriod;
  ctx?:         ConversionContext;
  accounts:     TierAccount[];
}

/** One expandable side (Cash In or Cash Out) with its reason breakdown. */
function AxisTile({
  label, total, accent, lines, ctx, sign,
}: {
  label:  string;
  total:  number;
  accent: "green" | "red";
  lines:  LiquiditySliceLine[];
  ctx?:   ConversionContext;
  sign:   "+" | "−";
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
        className={`w-full flex items-center justify-between gap-2 ${canExpand ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {canExpand && (open
            ? <ChevronDown size={12} className="text-[var(--text-faint)]" />
            : <ChevronRight size={12} className="text-[var(--text-faint)]" />)}
          {label}
        </span>
        <span className="text-lg font-semibold tabular-nums" style={{ color }}>{sign}{fmt(total, ctx)}</span>
      </button>

      {open && canExpand && (
        <div className="mt-2 space-y-1 border-t border-[var(--border-hairline)] pt-2">
          {lines.map((l) => (
            <div key={l.reason} className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--text-secondary)]">{l.label}</span>
              <span className="tabular-nums text-[var(--text-primary)]">{fmt(l.amount, ctx)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A single muted context line (not part of Cash In/Out totals). */
function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">{value}</span>
    </div>
  );
}

export function CashFlowSummaryWidget({ transactions, period, ctx, accounts }: Props) {
  const [showEconomic, setShowEconomic] = useState(false);

  if (transactions == null) {
    return <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading activity…</p>;
  }
  const rows = filterByPeriod(transactions, period) as LiquidityTx[];
  if (rows.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-[var(--text-muted)]">No cash moved in this period</p>
        <p className="text-xs text-[var(--text-faint)] mt-1">Cash in and out appear as transactions accumulate.</p>
      </div>
    );
  }

  const liqCtx = tierResolver(accounts);
  // Cash In / Cash Out / Net Cash come from deriveCashFlowAxes (liquidity axis).
  const axes = deriveCashFlowAxes(rows, liqCtx, ctx);
  // Reason breakdown (effect-split) — its per-side totals equal axes.cashIn/out.
  const breakdown = groupLiquidityByReason(rows, liqCtx, ctx);

  const net = axes.netCash;
  const eco = axes.economic;

  return (
    <div className="space-y-3">
      {/* Primary: Net Cash (liquidity) */}
      <div>
        <p className="text-3xl font-bold" style={{ color: net >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}>
          {net >= 0 ? "+" : "−"}{fmt(Math.abs(net), ctx)}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>net cash this period</p>
      </div>

      {/* Cash In / Cash Out — expandable into reason breakdown */}
      <div className="grid grid-cols-2 gap-3">
        <AxisTile label="Cash In"  total={axes.cashIn}  accent="green" sign="+" lines={breakdown.cashIn}  ctx={ctx} />
        <AxisTile label="Cash Out" total={axes.cashOut} accent="red"   sign="−" lines={breakdown.cashOut} ctx={ctx} />
      </div>

      {/* Context — NOT part of Cash Out. Shown so the composition reconciles:
          credit-card purchases (cash leaves later as Debt payments), liquidity-
          neutral internal transfers, and movement we can't yet resolve. */}
      {(breakdown.creditCardPurchases > 0 || breakdown.internalTransfers > 0 || breakdown.unresolved > 0) && (
        <div className="rounded-xl px-3 py-2 space-y-1.5" style={{ background: "var(--surface-inset)", border: "1px dashed var(--border-hairline)" }}>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">For context · not in Cash Out</p>
          {breakdown.creditCardPurchases > 0 && (
            <ContextRow label="Credit card purchases" value={fmt(breakdown.creditCardPurchases, ctx)} />
          )}
          {breakdown.internalTransfers > 0 && (
            <ContextRow label="Internal transfers (neutral)" value={fmt(breakdown.internalTransfers, ctx)} />
          )}
          {breakdown.unresolved > 0 && (
            <ContextRow label="Unresolved movement" value={fmt(breakdown.unresolved, ctx)} />
          )}
          {breakdown.creditCardPurchases > 0 && (
            <p className="text-[10px] text-[var(--text-faint)] pt-0.5">
              Credit-card purchases are shown for context; cash leaves when the card is paid (see Debt payments).
            </p>
          )}
        </div>
      )}

      {/* Economic axis preserved — quiet disclosure (earned income vs real cost). */}
      <div className="pt-1 border-t border-[var(--border-hairline)]">
        <button
          type="button"
          onClick={() => setShowEconomic((v) => !v)}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex items-center gap-1 text-[11px] text-[var(--text-faint)] hover:text-[var(--text-muted)] transition-colors"
        >
          {showEconomic ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Economic view
        </button>
        {showEconomic && (
          <div className="mt-1.5 space-y-1 text-[11px]">
            <p className="text-[var(--text-faint)]">Earned income and real costs — net worth effect, not spendable cash.</p>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Earned income</span>
              <span className="tabular-nums text-[var(--accent-positive)]">+{fmt(eco.income, ctx)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Spending</span>
              <span className="tabular-nums text-[var(--accent-negative)]">−{fmt(eco.spend, ctx)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)]">Economic net</span>
              <span className="tabular-nums" style={{ color: eco.net >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}>
                {eco.net >= 0 ? "+" : "−"}{fmt(Math.abs(eco.net), ctx)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
