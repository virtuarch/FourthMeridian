"use client";

/**
 * components/space/widgets/CashFlowSummaryWidget.tsx
 *
 * Cash Flow Perspective headline — now the LIQUIDITY axis (spendable cash),
 * which is the primary user-facing model. Shows Cash In / Cash Out / Net Cash
 * from the shared DayFacts projection (aggregateDayFacts — the SOLE fold; P2-1
 * removed the former second deriveCashFlowAxes pass), each expandable into its
 * reason breakdown (Earned income, Asset liquidation, Debt proceeds, Spending,
 * Debt payments, Asset deployment, …) taken straight from the liquidity engine's
 * per-reason output (groupLiquidityByReason) — no recomputation here.
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
  classifyLiquidity,
  tierResolver,
  type LiquidityTx,
  type LiquidityEffect,
} from "@/lib/transactions/liquidity";
import { groupLiquidityByReason } from "@/lib/transactions/liquidity-breakdown";
import { groupCashFlowContext } from "@/lib/transactions/cash-flow-context";
import { aggregateDayFacts, economicSpend, type CashFlowPerspective } from "@/lib/transactions/cash-flow-projection";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import { CashFlowFilterControls, DEFAULT_FILTER_ID } from "@/components/space/widgets/CashFlowFilterControls";
import { TransactionSliceDrawer, type TransactionSlice } from "@/components/space/widgets/TransactionSliceDrawer";

function fmt(v: number, ctx?: ConversionContext): string {
  return ctx
    ? formatCurrency(v, ctx.target)
    : new Intl.NumberFormat("en-US", { style: "currency", currency: DEFAULT_DISPLAY_CURRENCY, maximumFractionDigits: 0 }).format(v);
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
  /** CF-3 — the workspace-shared perspective. When provided the widget is
   *  controlled (mirrors the History selector); otherwise it self-manages. */
  perspective?:         CashFlowPerspective;
  onPerspectiveChange?: (perspective: CashFlowPerspective, filterId: string) => void;
}

/** One expandable side (Cash In or Cash Out) with its reason breakdown. Each
 *  reason line drills into its exact transactions when `onOpenLine` is provided. */
function AxisTile({
  label, total, accent, lines, ctx, sign, onOpenLine,
}: {
  label:  string;
  total:  number;
  accent: "green" | "red";
  lines:  TileLine[];
  ctx?:   ConversionContext;
  sign:   "+" | "−";
  onOpenLine?: (line: TileLine) => void;
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

/** A drillable context line (not part of Cash In/Out totals). Opens the shared
 *  TransactionSliceDrawer with the exact rows behind it. */
function ContextRow({ label, value, onOpen }: { label: string; value: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onOpen}
      className="w-full flex items-center justify-between gap-2 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--meridian-400)]"
    >
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">{value}</span>
    </button>
  );
}

export function CashFlowSummaryWidget({ transactions, period, ctx, accounts, perspective: controlledPerspective, onPerspectiveChange }: Props) {
  // CF-3 — perspective toggle (Cash Flow ⇄ Spending). Controlled by the shared
  // workspace perspective when provided; otherwise self-managed for standalone use.
  const [localPerspective, setLocalPerspective] = useState<CashFlowPerspective>("liquidity");
  const perspective = controlledPerspective ?? localPerspective;
  const changePerspective = (p: CashFlowPerspective, id: string) =>
    onPerspectiveChange ? onPerspectiveChange(p, id) : setLocalPerspective(p);
  const [slice, setSlice] = useState<TransactionSlice | null>(null);

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
  // CF-3 / P2-1 — the shared DayFacts projection is the SOLE fold: ONE pass over
  // the rows yields BOTH axes (liquidity cashIn/cashOut + economic income/spend/
  // subsets). Cash In / Cash Out / Net Cash read straight off `facts` — no second
  // deriveCashFlowAxes pass (that was the removed production double-fold).
  const facts = aggregateDayFacts(rows, liqCtx, ctx);
  // Reason breakdown (effect-split) — a PURE PROJECTION over the same `facts`
  // (no second fold); its per-side totals equal facts.cashIn/out by construction.
  const breakdown = groupLiquidityByReason(facts);
  const econSpendTotal = economicSpend(facts);
  const econCard = Math.min(facts.creditCardSpending, econSpendTotal);
  const econOther = Math.max(0, econSpendTotal - econCard);
  const econNet = facts.income - econSpendTotal;
  // CF-1 — human context projection (presentation only; never feeds Cash In/Out/Net).
  const context = groupCashFlowContext(rows, liqCtx, ctx);
  // CF-1A — is any context bucket populated? Drives the populated rows vs the
  // discoverability empty state. Consumes the grouped output; computes nothing new.
  const hasContext = context.movedNotSpent.length > 0 || context.needsClassification.length > 0;

  const economic = perspective === "economic";
  const net = economic ? econNet : facts.cashIn - facts.cashOut;

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

  // Economic drill-downs — reconcile with Spending by Category / Income by Source
  // (same flow-predicates). Card spending = cost flows charged to a liability tier.
  const isLiabilityRow = (r: LiquidityTx) => liqCtx.tierOf(r.financialAccountId ?? r.accountId ?? null) === "liability";
  const openEconSlice = (line: TileLine) => {
    if (line.reason === "INCOME") {
      setSlice({ title: "Income", subtitle: "Earned income this period", rows: rows.filter((r) => isIncome(r.flowType)) });
    } else if (line.reason === "CARD_SPEND") {
      setSlice({ title: "Credit-card spending", subtitle: "Bought on credit this period", rows: rows.filter((r) => isCostFlow(r.flowType) && isLiabilityRow(r)) });
    } else {
      setSlice({ title: "Direct & other spending", subtitle: "Spending & refunds this period", rows: rows.filter((r) => (isCostFlow(r.flowType) || isRefund(r.flowType)) && !isLiabilityRow(r)) });
    }
  };

  const econInLines:  TileLine[] = [{ reason: "INCOME", label: "Income", amount: facts.income }].filter((l) => l.amount > 0);
  const econOutLines: TileLine[] = [
    { reason: "CARD_SPEND",   label: "Credit-card spending",   amount: econCard },
    { reason: "DIRECT_SPEND", label: "Direct & other spending", amount: econOther },
  ].filter((l) => l.amount > 0);

  return (
    <div className="space-y-3">
      {/* CF-3 — perspective toggle (the small reused control; no measure dropdown here). */}
      <div className="flex items-center justify-end">
        <CashFlowFilterControls perspective={perspective} filterId={DEFAULT_FILTER_ID} onChange={(p, id) => changePerspective(p, id)} compact />
      </div>

      {/* Primary: Net (perspective-dependent) */}
      <div>
        <p className="text-3xl font-bold" style={{ color: net >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}>
          {net >= 0 ? "+" : "−"}{fmt(Math.abs(net), ctx)}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
          {economic ? "net spending this period (incl. credit-card purchases)" : "net cash this period"}
        </p>
      </div>

      {economic ? (
        /* Economic: Income vs All spending — includes credit-card purchases. */
        <div className="grid grid-cols-2 gap-3">
          <AxisTile label="Income"   total={facts.income}    accent="green" sign="+" lines={econInLines}  ctx={ctx} onOpenLine={openEconSlice} />
          <AxisTile label="Spending" total={econSpendTotal}  accent="red"   sign="−" lines={econOutLines} ctx={ctx} onOpenLine={openEconSlice} />
        </div>
      ) : (
        /* Liquidity: Cash In / Cash Out — expandable into reason breakdown. */
        <div className="grid grid-cols-2 gap-3">
          <AxisTile label="Cash In"  total={facts.cashIn}  accent="green" sign="+" lines={breakdown.cashIn}  ctx={ctx} onOpenLine={(l) => openReasonSlice("CASH_IN", l)} />
          <AxisTile label="Cash Out" total={facts.cashOut} accent="red"   sign="−" lines={breakdown.cashOut} ctx={ctx} onOpenLine={(l) => openReasonSlice("CASH_OUT", l)} />
        </div>
      )}

      {/* Credit-card spending is honestly visible in BOTH perspectives: on the
          liquidity axis it is NOT Cash Out (the cash leaves later as a Debt
          payment), so it surfaces here as a context figure that drills into the
          card cost-flow rows — reconciles with Spending by Category. */}
      {!economic && facts.creditCardSpending > 0 && (
        <div className="pt-1 border-t border-[var(--border-hairline)]">
          <ContextRow
            label="Spent on credit (not yet paid as cash)"
            value={fmt(facts.creditCardSpending, ctx)}
            onOpen={() => setSlice({ title: "Credit-card spending", subtitle: "Bought on credit this period", rows: rows.filter((r) => isCostFlow(r.flowType) && isLiabilityRow(r)) })}
          />
        </div>
      )}

      {/* CF-1A — Cash Flow context projection, kept BELOW the Economic View so the
          populated rows and the empty state share one consistent location.
          Populated rows when movements exist; a small explanatory empty state
          (never fake $0 rows) otherwise. Consumes the existing grouped context —
          no projection logic is duplicated here, drill-down preserved. */}
      {hasContext ? (
        <div className="space-y-2">
          {context.movedNotSpent.length > 0 && (
            <div className="rounded-xl px-3 py-2 space-y-1.5" style={{ background: "var(--surface-inset)", border: "1px dashed var(--border-hairline)" }}>
              <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Moved, not spent</p>
              {context.movedNotSpent.map((r) => (
                <ContextRow
                  key={r.key}
                  label={r.label}
                  value={fmt(r.amount, ctx)}
                  onOpen={() => setSlice({ title: r.label, subtitle: "Money that moved, not spent", rows: r.rows, total: r.amount, totalLabel: "Total" })}
                />
              ))}
            </div>
          )}
          {context.needsClassification.length > 0 && (
            <div className="rounded-xl px-3 py-2 space-y-1.5" style={{ background: "var(--surface-inset)", border: "1px dashed var(--border-hairline)" }}>
              <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Needs classification</p>
              {context.needsClassification.map((r) => (
                <ContextRow
                  key={r.key}
                  label={r.label}
                  value={`${r.count} ${r.count === 1 ? "transaction" : "transactions"}`}
                  onOpen={() => setSlice({ title: r.label, subtitle: "We can see this moved, but not yet why", rows: r.rows })}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl px-3 py-2 space-y-1" style={{ background: "var(--surface-inset)", border: "1px dashed var(--border-hairline)" }}>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">Moved, not spent</p>
          <p className="text-xs text-[var(--text-secondary)]">
            No account transfers, cash movements, investment funding, or payment-app movements were found for this period.
          </p>
        </div>
      )}

      {slice && <TransactionSliceDrawer slice={slice} ctx={ctx} onClose={() => setSlice(null)} />}
    </div>
  );
}
