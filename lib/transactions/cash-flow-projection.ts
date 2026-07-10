/**
 * lib/transactions/cash-flow-projection.ts
 *
 * CF-3 — the ONE shared projection Summary, History, and Calendar consume for BOTH
 * honest Cash Flow perspectives. It adds NO classifier: every fact below is read
 * from the two existing canonical authorities —
 *   • LIQUIDITY axis  → classifyLiquidity (lib/transactions/liquidity.ts)
 *   • ECONOMIC axis   → flow-predicates    (lib/transactions/flow-predicates.ts)
 * — computed exactly ONCE per row, then folded into a per-day / per-total
 * `DayFacts`. Widgets select measures out of `DayFacts`; they never re-classify.
 *
 * Why two perspectives (see the liquidity-axis doctrine, "Did the data earn this?"):
 *   LIQUIDITY  answers "did spendable cash move?" — a credit-card purchase is
 *              liquidity-NEUTRAL at purchase time (the cash leaves later, as a
 *              Debt payment), so it is NOT Cash Out.
 *   ECONOMIC   answers "what did I actually spend?" — the SAME credit-card purchase
 *              IS spending (cost flow), counted the day it happened.
 * A credit-card-heavy user must be able to see BOTH: their spendable-cash reality
 * (LIQUIDITY) and their true daily spending (ECONOMIC). Neither is forced onto the
 * other axis, and a card purchase + its later debt payment are never counted as
 * spending twice (the purchase is ECONOMIC spend; the payment is a LIQUIDITY
 * Debt payment — different axes, no overlap).
 *
 * Pure, importable (no DB/React/next), unit-testable under tsx. Currency: per-row
 * conversion at the row's own date via the caller's ConversionContext; absent ⇒
 * raw amounts (same rule as every other Cash Flow helper).
 */

import {
  classifyLiquidity,
  type LiquidityTx,
  type LiquidityContext,
  type LiquidityReason,
  type LiquidityEffect,
} from "@/lib/transactions/liquidity";
import { isCostFlow, isRefund, isIncome } from "@/lib/transactions/flow-predicates";
import {
  granularityFor, bucketKey, bucketLabel,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import type { TransferDisposition } from "@/lib/transactions/transfer-evidence";

// ─── Perspective ────────────────────────────────────────────────────────────────

export type CashFlowPerspective = "liquidity" | "economic";

// ─── Per-day / per-total facts (both axes, computed once) ────────────────────────

/**
 * Everything Summary / History / Calendar need for one day (or one aggregate),
 * from the two canonical classifiers. Overlap is DOCUMENTED, never accidental:
 *   • cashIn/cashOut    — LIQUIDITY spendable movement (classifyLiquidity effect).
 *   • income/spendGross — ECONOMIC value (flow-predicates). spendGross overlaps
 *                         cashOut only in its REAL_COST (direct-cash) portion; on
 *                         a credit-card purchase spendGross rises while cashOut
 *                         does NOT — that is the whole point.
 *   • creditCardSpending — the liability-tier subset of spendGross (⊂ economic
 *                          spend, ∉ cashOut). "What you bought on credit."
 *   • cashWithdrawals   — physical-cash form change (CASH_MOVEMENT, out). Owned
 *                          money, NOT spending and NOT liquidity Cash Out — its
 *                          own honest line (Part 5).
 */
export interface DayFacts {
  // Liquidity axis
  cashIn:   number;
  cashOut:  number;
  byReason: Partial<Record<LiquidityReason, number>>;
  // Economic axis
  income:     number;   // Σ|amount| INCOME
  spendGross: number;   // Σ|amount| cost flows (SPENDING+FEE+INTEREST), pre-refund
  refunds:    number;   // Σ|amount| REFUND
  // Cross-cutting subsets
  creditCardSpending: number;  // cost flow charged to a liability account (⊂ spendGross)
  directSpending:     number;  // cost flow charged to a NON-liability account (⊂ spendGross)
  cashWithdrawals:    number;  // physical-cash withdrawals (⊄ cashOut, ⊄ spend)
}

function emptyFacts(): DayFacts {
  return { cashIn: 0, cashOut: 0, byReason: {}, income: 0, spendGross: 0, refunds: 0, creditCardSpending: 0, directSpending: 0, cashWithdrawals: 0 };
}

function rowMagnitude(t: LiquidityTx, ctx?: ConversionContext): number {
  const amt = ctx
    ? convertMoney({ amount: t.amount, currency: t.currency ?? null }, t.date, ctx).amount
    : t.amount;
  return Math.abs(amt);
}

/** Fold one row into an accumulator, reading BOTH canonical axes exactly once. */
function foldDayFacts(acc: DayFacts, t: LiquidityTx, liqCtx: LiquidityContext, moneyCtx?: ConversionContext): void {
  const amt = rowMagnitude(t, moneyCtx);
  const ft = t.flowType ?? null;

  // ── Liquidity axis (spendable-cash effect) ──
  const c = classifyLiquidity(t, liqCtx);
  if (c.effect === "CASH_IN")  { acc.cashIn += amt;  acc.byReason[c.reason] = (acc.byReason[c.reason] ?? 0) + amt; }
  else if (c.effect === "CASH_OUT") { acc.cashOut += amt; acc.byReason[c.reason] = (acc.byReason[c.reason] ?? 0) + amt; }

  // ── Economic axis (real value, tier-independent — includes card purchases) ──
  if (isCostFlow(ft)) {
    acc.spendGross += amt;
    if (liqCtx.tierOf(t.financialAccountId ?? t.accountId ?? null) === "liability") acc.creditCardSpending += amt;
    else acc.directSpending += amt;
  } else if (isRefund(ft)) {
    acc.refunds += amt;
  } else if (isIncome(ft)) {
    acc.income += amt;
  }

  // ── Physical cash (form change, Part 5) — CASH_MOVEMENT disposition, out ──
  const disposition = (t as { transferDisposition?: TransferDisposition | null }).transferDisposition ?? null;
  if (disposition === "CASH_MOVEMENT" && t.amount < 0) acc.cashWithdrawals += amt;
}

// ─── Aggregate + daily + bucketed projections ────────────────────────────────────

/** One aggregate `DayFacts` over all rows (Summary). */
export function aggregateDayFacts(transactions: LiquidityTx[], liqCtx: LiquidityContext, moneyCtx?: ConversionContext): DayFacts {
  const acc = emptyFacts();
  for (const t of transactions) foldDayFacts(acc, t, liqCtx, moneyCtx);
  return acc;
}

/** Per-calendar-day `DayFacts`, keyed by YYYY-MM-DD (Calendar). Every day with
 *  ANY activity on either axis is present (unlike dailyLiquidity, which drops
 *  liquidity-neutral days) — the economic perspective needs card-only days too. */
export function projectDailyFacts(transactions: LiquidityTx[], liqCtx: LiquidityContext, moneyCtx?: ConversionContext): Map<string, DayFacts> {
  const out = new Map<string, DayFacts>();
  for (const t of transactions) {
    const f = out.get(t.date) ?? emptyFacts();
    foldDayFacts(f, t, liqCtx, moneyCtx);
    out.set(t.date, f);
  }
  return out;
}

export interface FactsBucket extends DayFacts { key: string; label: string }

/** Per-time-bucket `DayFacts` for the period (History), same key scheme as the
 *  economic/liquidity bucketers so it reconciles with them. */
export function bucketDayFacts(
  transactions: LiquidityTx[],
  liqCtx: LiquidityContext,
  period: CashFlowPeriod,
  moneyCtx?: ConversionContext,
): FactsBucket[] {
  const g = granularityFor(period);
  const acc = new Map<string, DayFacts>();
  for (const t of transactions) {
    const key = bucketKey(t.date, g);
    const f = acc.get(key) ?? emptyFacts();
    foldDayFacts(f, t, liqCtx, moneyCtx);
    acc.set(key, f);
  }
  return [...acc.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({ key, label: bucketLabel(key, g), ...v }));
}

// ─── Perspective totals (what a widget headline shows) ───────────────────────────

export interface PerspectiveTotals {
  in:   number;   // inflow magnitude for the perspective
  out:  number;   // outflow magnitude for the perspective
  net:  number;   // in − out
}

/** Economic spend, refunds netted then clamped ≥ 0 (same doctrine as aggregateCashFlow). */
export function economicSpend(f: DayFacts): number {
  return Math.max(0, f.spendGross - f.refunds);
}

/** Collapse a `DayFacts` to the selected perspective's in/out/net.
 *   LIQUIDITY: Cash In / Cash Out / Net Cash.
 *   ECONOMIC:  Income / Spending (clamped) / Economic net. */
export function perspectiveTotals(f: DayFacts, perspective: CashFlowPerspective): PerspectiveTotals {
  if (perspective === "economic") {
    const out = economicSpend(f);
    return { in: f.income, out, net: f.income - out };
  }
  return { in: f.cashIn, out: f.cashOut, net: f.cashIn - f.cashOut };
}

// ─── Calendar measures (Part 1 filter) ───────────────────────────────────────────
//
// Each measure reads ONE value out of DayFacts — no new classification. `direction`
// says which side of net it lands on; `perspective` which axis owns it. Overlap is
// tracked with `subsetOf`: the UI must never SUM a measure with a measure it is a
// subset of (that is the only way to double-count here). Within a single
// perspective's non-subset measures there is NO overlap — the liquidity reasons
// partition Cash In/Out, and cash withdrawals are disjoint from both — so any
// combined selection of those sums honestly.

export type CalendarMeasureId =
  | "cashIn" | "cashOut"
  | "income" | "allSpending" | "creditCardSpending" | "directDebitSpending"
  | "debtPayments" | "moneyInvested" | "fromInvestments"
  | "fromPaymentApps" | "paymentsThroughApps"
  | "cashWithdrawals";

export interface CalendarMeasure {
  id:          CalendarMeasureId;
  label:       string;
  direction:   "in" | "out";
  perspective: CashFlowPerspective;
  /** When set, this measure is a strict subset of the named one — never sum both. */
  subsetOf?:   CalendarMeasureId;
  /** Aggregate value for a day (drives the heat-map). */
  value:       (f: DayFacts) => number;
  /**
   * Per-ROW membership — true when this row CONTRIBUTES to the measure. It reads
   * the SAME canonical facts as `value` (classifyLiquidity effect/reason for the
   * liquidity axis; flow-predicates + tier for the economic axis), so the rows
   * the drill-down surfaces are exactly the rows the heat-map counted — no
   * independent classification, and the drawer reconciles with the cell (CF-3B).
   */
  rowMatches:  (t: LiquidityTx, liqCtx: LiquidityContext) => boolean;
}

const reason = (f: DayFacts, ...ks: LiquidityReason[]) => ks.reduce((s, k) => s + (f.byReason[k] ?? 0), 0);
const tierOfRow = (t: LiquidityTx, ctx: LiquidityContext) => ctx.tierOf(t.financialAccountId ?? t.accountId ?? null);
const effectIs = (t: LiquidityTx, ctx: LiquidityContext, e: LiquidityEffect) => classifyLiquidity(t, ctx).effect === e;
const reasonIs = (t: LiquidityTx, ctx: LiquidityContext, e: LiquidityEffect, ...rs: LiquidityReason[]) => {
  const c = classifyLiquidity(t, ctx);
  return c.effect === e && rs.includes(c.reason);
};
const dispositionIs = (t: LiquidityTx, d: TransferDisposition) =>
  ((t as { transferDisposition?: TransferDisposition | null }).transferDisposition ?? null) === d;

export const CALENDAR_MEASURES: Record<CalendarMeasureId, CalendarMeasure> = {
  // Liquidity axis — a partition of Cash In / Cash Out by reason (safe to combine).
  cashIn:              { id: "cashIn",              label: "Cash in",              direction: "in",  perspective: "liquidity", value: (f) => f.cashIn,  rowMatches: (t, c) => effectIs(t, c, "CASH_IN") },
  cashOut:             { id: "cashOut",             label: "Cash out",             direction: "out", perspective: "liquidity", value: (f) => f.cashOut, rowMatches: (t, c) => effectIs(t, c, "CASH_OUT") },
  fromInvestments:     { id: "fromInvestments",     label: "From investments",     direction: "in",  perspective: "liquidity", subsetOf: "cashIn",  value: (f) => reason(f, "ASSET_LIQUIDATION", "INVESTMENT_INFLOW"), rowMatches: (t, c) => reasonIs(t, c, "CASH_IN", "ASSET_LIQUIDATION", "INVESTMENT_INFLOW") },
  fromPaymentApps:     { id: "fromPaymentApps",     label: "From payment apps",    direction: "in",  perspective: "liquidity", subsetOf: "cashIn",  value: (f) => reason(f, "PAYMENT_APP_INFLOW"),                    rowMatches: (t, c) => reasonIs(t, c, "CASH_IN", "PAYMENT_APP_INFLOW") },
  debtPayments:        { id: "debtPayments",        label: "Debt payments",        direction: "out", perspective: "liquidity", subsetOf: "cashOut", value: (f) => reason(f, "DEBT_PAYMENT"),                          rowMatches: (t, c) => reasonIs(t, c, "CASH_OUT", "DEBT_PAYMENT") },
  moneyInvested:       { id: "moneyInvested",       label: "Money invested",       direction: "out", perspective: "liquidity", subsetOf: "cashOut", value: (f) => reason(f, "ASSET_DEPLOYMENT", "INVESTMENT_OUTFLOW"), rowMatches: (t, c) => reasonIs(t, c, "CASH_OUT", "ASSET_DEPLOYMENT", "INVESTMENT_OUTFLOW") },
  paymentsThroughApps: { id: "paymentsThroughApps", label: "Payments through apps", direction: "out", perspective: "liquidity", subsetOf: "cashOut", value: (f) => reason(f, "PAYMENT_APP_OUTFLOW"),                  rowMatches: (t, c) => reasonIs(t, c, "CASH_OUT", "PAYMENT_APP_OUTFLOW") },
  // Economic axis — real value, includes credit-card purchases.
  income:              { id: "income",              label: "Income",               direction: "in",  perspective: "economic",  value: (f) => f.income,      rowMatches: (t) => isIncome(t.flowType ?? null) },
  // All spending includes REFUNDs (they net the total) — same doctrine as Spending
  // by Category, so the drawer's clamped spend reconciles.
  allSpending:         { id: "allSpending",         label: "All spending",         direction: "out", perspective: "economic",  value: economicSpend,        rowMatches: (t) => isCostFlow(t.flowType ?? null) || isRefund(t.flowType ?? null) },
  creditCardSpending:  { id: "creditCardSpending",  label: "Credit-card spending", direction: "out", perspective: "economic",  subsetOf: "allSpending", value: (f) => f.creditCardSpending, rowMatches: (t, c) => isCostFlow(t.flowType ?? null) && tierOfRow(t, c) === "liability" },
  directDebitSpending: { id: "directDebitSpending", label: "Direct/debit spending", direction: "out", perspective: "economic", subsetOf: "allSpending", value: (f) => f.directSpending,     rowMatches: (t, c) => isCostFlow(t.flowType ?? null) && tierOfRow(t, c) !== "liability" },
  // Physical cash — its own honest line, subset of neither axis (Part 5).
  cashWithdrawals:     { id: "cashWithdrawals",     label: "Cash withdrawals",     direction: "out", perspective: "liquidity", value: (f) => f.cashWithdrawals, rowMatches: (t) => dispositionIs(t, "CASH_MOVEMENT") && t.amount < 0 },
};

/** The default measure set for a perspective (a clean, non-overlapping in/out pair). */
export function defaultMeasures(perspective: CashFlowPerspective): CalendarMeasureId[] {
  return perspective === "economic" ? ["income", "allSpending"] : ["cashIn", "cashOut"];
}

/** Net of a selected measure set over one day's facts: Σ(in) − Σ(out). Callers are
 *  responsible for not selecting a measure together with its `subsetOf` parent
 *  (the UI enforces this); given that, the sum never double-counts. */
export function netOfMeasures(f: DayFacts, ids: CalendarMeasureId[]): PerspectiveTotals {
  let inSum = 0, outSum = 0;
  for (const id of ids) {
    const m = CALENDAR_MEASURES[id];
    const v = m.value(f);
    if (m.direction === "in") inSum += v; else outSum += v;
  }
  return { in: inSum, out: outSum, net: inSum - outSum };
}

/**
 * CF-3B — the EXACT rows behind a selected measure set, for the Calendar/History
 * day & bucket drill-down. A row is included iff it contributes to at least one
 * selected measure (measure.rowMatches). This is the drill-down's single source
 * of truth: it consumes the SAME per-row classification the heat-map totals do,
 * so the drawer shows precisely the transactions the cell counted — a
 * "Credit-card spending" day opens only card purchases, never the debt payments
 * that share the day. Order is preserved. No independent classification.
 */
export function rowsForMeasures<T extends LiquidityTx>(
  rows: T[],
  ids: CalendarMeasureId[],
  liqCtx: LiquidityContext,
): T[] {
  const measures = ids.map((id) => CALENDAR_MEASURES[id]);
  return rows.filter((r) => measures.some((m) => m.rowMatches(r, liqCtx)));
}
