/**
 * lib/transactions/cash-flow-space-data.ts  (SD-4 contract priming — Cash Flow)
 *
 * THE canonical read contract for the Cash Flow workspace — the Cash Flow analogue
 * of lib/investments/space-data.ts. ONE pure composition over the canonical
 * transaction projection: a single selected WINDOW of transactions is folded ONCE
 * (through the existing cash-flow-projection / cash-flow authorities) and fanned
 * out to every panel the workspace renders — summary, history (buckets), calendar
 * (daily), category, income, cash-in-by-reason, debt payments, context, and the
 * trust stamp.
 *
 * DISCIPLINE (mirrors loadInvestmentsSpaceData): this builder ORCHESTRATES the
 * canonical authorities; it computes NONE of the cash-flow math itself. Every field
 * traces to an existing authority — aggregateDayFacts / projectDailyFacts /
 * bucketDayFacts / outflowByCategory / incomeBySource / groupLiquidityByReason /
 * groupDebtPaymentsByCreditor / groupCashFlowContext / cashFlowStamp — with the two
 * canonical classifiers (classifyLiquidity + flow-predicates) read exactly ONCE per
 * row inside the projection. It NEVER re-classifies a raw transaction (the
 * cash-flow-fold-authority invariant).
 *
 * PURE / CLIENT — no DB, no React, no next. The Cash Flow inputs are host-fetched
 * (the generic transactions read), so unlike loadInvestmentsSpaceData this is a
 * PURE PROJECTION contract, not a DB loader; its value is consolidating already-
 * canonical projections + trust, not hiding a database. Unit-testable under tsx.
 *
 * DATA vs CONTROL. This contract carries only DATA for one resolved window. The
 * workspace's CONTROL STATE stays OUTSIDE it: the perspective toggle (liquidity
 * "Cash Flow" / economic "Spending"), the measure filter, the Calendar/Cards view
 * mode, the All-Time year, the selected day, and every drill-down slice. Those
 * SELECT measures out of the perspective-agnostic DayFacts below (via
 * perspectiveTotals / netOfMeasures / rowsForMeasures in the widgets); they never
 * trigger a re-fold. The WINDOW (period) is the one time INPUT — Cash Flow reads
 * the SD-0B preset dimension, never the canonical asOf/compareTo.
 */

import type { Transaction } from "@/types";
import type { ConversionContext } from "@/lib/money/types";
import { convertMoney } from "@/lib/money/convert";
import {
  periodRange,
  filterByPeriod,
  availableHistoricalPeriods,
  dataBearingYears,
  type CashFlowPeriod,
  type CashFlowContribution,
  type AvailableHistoricalPeriods,
  outflowByCategory,
  incomeBySource,
} from "@/lib/transactions/cash-flow";
import {
  aggregateDayFacts,
  projectDailyFacts,
  bucketDayFacts,
  type DayFacts,
  type FactsBucket,
} from "@/lib/transactions/cash-flow-projection";
import { cashFlowStamp, type CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import { groupCashFlowContext, type CashFlowContext } from "@/lib/transactions/cash-flow-context";
import {
  classifyLiquidity,
  tierResolver,
  type LiquidityTx,
} from "@/lib/transactions/liquidity";
import { groupLiquidityByReason, type LiquiditySliceLine } from "@/lib/transactions/liquidity-breakdown";
import { groupDebtPaymentsByCreditor, type DebtPaymentGroup } from "@/lib/transactions/debt-payments";

/**
 * THE canonical Cash Flow workspace contract — the perspective-AGNOSTIC data for
 * ONE resolved window. Both honest axes are pre-folded ONCE (inside DayFacts); the
 * workspace applies the perspective/measure selection on top. Serialisable except
 * for `daily`, which is a Map keyed by ISO day (the calendar's natural shape).
 */
export interface CashFlowSpaceData {
  /** The resolved window (echoed so widgets need no second period source). */
  period: CashFlowPeriod;
  /** Inclusive ISO bounds of `period` (periodRange). */
  range: { start: string; end: string };
  /** Windowed rows — the drill-down source (already FX-agnostic; converted on read). */
  rows: Transaction[];

  // ── the ONE projection, at all three granularities (both axes each) ──
  /** aggregateDayFacts(window) → the Summary headline facts. */
  summary: DayFacts;
  /** projectDailyFacts(window) → per-ISO-day facts for the Calendar heatmap. */
  daily: Map<string, DayFacts>;
  /** bucketDayFacts(window, period) → History cards at the period's granularity. */
  buckets: FactsBucket[];

  // ── derived presentation slices (each straight from an authority) ──
  /** Spending by Category (economic outflow). */
  outflowByCategory: CashFlowContribution[];
  /** Income by Source (economic income). */
  incomeBySource: CashFlowContribution[];
  /** Cash In by reason (liquidity axis) — groupLiquidityByReason(summary).cashIn. */
  cashInByReason: LiquiditySliceLine[];
  /** Debt payments grouped by creditor — the canonical DEBT_PAYMENT liquidity rows. */
  debtPayments: DebtPaymentGroup[];
  /** Moved-not-spent / Needs-classification context sections. */
  context: CashFlowContext;

  // ── trust + selector option lists (computed over the FULL history) ──
  /** Completeness stamp — coverage is a property of the DATA, not the window, so it
   *  is computed over the full history, not the windowed slice. */
  stamp: CashFlowStamp;
  /** Selectable Month/Quarter/Year dropdowns (over full history). */
  available: AvailableHistoricalPeriods;
  /** Years that bear data — the All-Time calendar nav (over full history). */
  dataYears: number[];
}

/** Converted absolute magnitude of a row at its own date; absent ctx ⇒ raw abs. */
function magnitude(t: Transaction, ctx?: ConversionContext): number {
  const amt = ctx
    ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount
    : t.amount;
  return Math.abs(amt);
}

/**
 * Compose the canonical Cash Flow workspace contract for ONE window. PURE
 * ORCHESTRATION — it performs NO classification, fold, or currency math of its own:
 * it windows the rows once (filterByPeriod), builds the liquidity context once
 * (tierResolver), then hands them to the canonical projection + breakdown + stamp
 * authorities. `now` is the injected clock (relative periods + the stamp resolve
 * deterministically from it); `moneyCtx` threads per-row conversion into the
 * authorities exactly as the widgets do today.
 *
 * `transactions` is the FULL visible history: the window is derived here
 * (filterByPeriod) for the projections, while the stamp + selector lists read the
 * full history (coverage/selectability are properties of the data, not the window).
 */
export function buildCashFlowSpaceData(input: {
  transactions: Transaction[];
  accounts: { id: string; type: string }[];
  period: CashFlowPeriod;
  now?: () => Date;
  moneyCtx?: ConversionContext;
}): CashFlowSpaceData {
  const { transactions, accounts, period, moneyCtx } = input;
  const now = input.now ?? (() => new Date());
  const nowDate = now();

  const range = periodRange(period, nowDate);
  const windowed = filterByPeriod(transactions, period, nowDate);
  const liqCtx = tierResolver(accounts);
  // The canonical projection consumes LiquidityTx (Transaction + optional transfer
  // fields); a plain Transaction[] satisfies it — the exact cast the widgets use.
  const rows = windowed as LiquidityTx[];

  const summary = aggregateDayFacts(rows, liqCtx, moneyCtx);
  const breakdown = groupLiquidityByReason(summary);

  // Canonical DEBT_PAYMENT rows (classifyLiquidity CASH_OUT + DEBT_PAYMENT) — no new
  // classifier; the SAME predicate the Debt Payments widget uses, applied once here.
  const debtPaymentRows = rows.filter((t) => {
    const c = classifyLiquidity(t, liqCtx);
    return c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT";
  });

  return {
    period,
    range,
    rows: windowed,
    summary,
    daily: projectDailyFacts(rows, liqCtx, moneyCtx),
    buckets: bucketDayFacts(rows, liqCtx, period, moneyCtx),
    outflowByCategory: outflowByCategory(windowed, moneyCtx),
    incomeBySource: incomeBySource(windowed, moneyCtx),
    cashInByReason: breakdown.cashIn,
    debtPayments: groupDebtPaymentsByCreditor(debtPaymentRows, (t) => magnitude(t, moneyCtx)),
    context: groupCashFlowContext(rows, liqCtx, moneyCtx),
    stamp: cashFlowStamp({ transactions, period, now }),
    available: availableHistoricalPeriods(transactions),
    dataYears: dataBearingYears(transactions),
  };
}
