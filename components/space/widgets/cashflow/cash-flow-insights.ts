/**
 * components/space/widgets/cashflow/cash-flow-insights.ts
 *
 * S4 — the deterministic bullet-builder behind the Cash Flow "Key Insights"
 * panel. Pure, DB-free, injected-clock (unit-testable under tsx). It is the
 * first sanctioned consumer of the landed-but-orphaned cash-flow-compare.ts
 * (cashFlowStamp / compareCashFlow), exactly as that module's header anticipated.
 *
 * NO AI, NO new classification, NO new time model. Every bullet is sourced from
 * already-canonical helpers:
 *   (a) compareCashFlow then-vs-now net delta — ONLY when a "then" period is
 *       honestly derivable (previousEquivalentPeriod), never fabricated;
 *   (b) top spending category / top income source from the existing breakdowns;
 *   (c) credit usage (DayFacts.creditCardSpending);
 *   (d) unresolved-transfer presence from groupCashFlowContext;
 *   (e) a single completeness caveat from cashFlowStamp when the tier is incomplete.
 *
 * The card renders ≤5 bullets; when nothing noteworthy is derivable it says so
 * plainly. The compare bullet references (never restates) the Summary net — it is
 * one prose delta, not a second KPI.
 */

import {
  filterByPeriod,
  outflowByCategory,
  incomeBySource,
  periodLabel,
  periodRange,
  isExplicitPeriod,
  type CashFlowPeriod,
} from "@/lib/transactions/cash-flow";
import {
  aggregateDayFacts,
  type CashFlowPerspective,
} from "@/lib/transactions/cash-flow-projection";
import { tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { groupLiquidityByReason } from "@/lib/transactions/liquidity-breakdown";
import { groupCashFlowContext } from "@/lib/transactions/cash-flow-context";
import { compareCashFlow, type CashFlowStamp } from "@/lib/transactions/cash-flow-compare";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatCurrency, formatDate } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import type { Transaction } from "@/types";

export type InsightTone = "neutral" | "positive" | "warning";

export interface CashFlowInsight {
  id:   string;
  text: string;
  tone: InsightTone;
}

/**
 * The previous FULL calendar period equivalent to `period`, for honest then-vs-now
 * comparison. Explicit month/quarter/year step back one (with year/quarter
 * rollover); to-date windows (MTD/QTD/YTD) map to the previous full calendar
 * period of the same grain. WTD, rolling (PAST_*) and ALL have no honest
 * calendar equivalent → null (the compare bullet is then omitted, never faked).
 */
export function previousEquivalentPeriod(period: CashFlowPeriod, now: Date): CashFlowPeriod | null {
  if (isExplicitPeriod(period)) {
    switch (period.kind) {
      case "month":
        return period.month > 1
          ? { kind: "month", year: period.year, month: period.month - 1 }
          : { kind: "month", year: period.year - 1, month: 12 };
      case "quarter":
        return period.quarter > 1
          ? { kind: "quarter", year: period.year, quarter: period.quarter - 1 }
          : { kind: "quarter", year: period.year - 1, quarter: 4 };
      case "year":
        return { kind: "year", year: period.year - 1 };
    }
  }
  switch (period) {
    case "MTD": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      d.setMonth(d.getMonth() - 1);
      return { kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 };
    }
    case "QTD": {
      const q = Math.floor(now.getMonth() / 3) + 1; // 1..4 (current quarter)
      return q > 1
        ? { kind: "quarter", year: now.getFullYear(), quarter: q - 1 }
        : { kind: "quarter", year: now.getFullYear() - 1, quarter: 4 };
    }
    case "YTD":
      return { kind: "year", year: now.getFullYear() - 1 };
    default:
      // WTD, PAST_WEEK/MONTH/QUARTER/6_MONTHS/YEAR, ALL — no calendar equivalent.
      return null;
  }
}

/**
 * Build the deterministic Key Insights bullets for a period. `now` is injected so
 * relative periods resolve against a fixed clock (byte-identical output for
 * identical inputs). Returns a single "nothing notable" bullet when empty.
 */
export function buildCashFlowInsights(args: {
  transactions: Transaction[] | null | undefined;
  accounts:     { id: string; type: string }[];
  period:       CashFlowPeriod;
  perspective:  CashFlowPerspective;
  now:          () => Date;
  /** Canonical compareTo anchor (YYYY-MM-DD, strictly earlier than asOf). When
   *  present, the then-vs-now comparison uses the SAME period at this anchor
   *  (period@asOf vs period@compareTo) instead of the sequential previous period. */
  compareTo?:   string | null;
  moneyCtx?:    ConversionContext;
  stamp?:       CashFlowStamp | null;
}): CashFlowInsight[] {
  const { transactions, accounts, period, perspective, now, compareTo, moneyCtx, stamp } = args;
  if (transactions == null) return [];

  const clock = now;
  const rows = filterByPeriod(transactions, period, clock()) as LiquidityTx[];
  // Canonical compareTo ⇒ compare the SAME period at the compareTo anchor — but ONLY
  // when compareTo is a DISTINCT prior baseline (strictly before the primary window's
  // start). For a plain preset, canonical compareTo IS the period's own start (a
  // point-in-time baseline, meaningless as a Cash Flow range comparison), so it falls
  // through to the sequential previous-period insight below.
  // Only RELATIVE periods re-anchor by the clock (explicit month/quarter/year drills
  // are absolute — periodRange ignores the anchor — so compareTo can't shift them;
  // those keep the sequential previous-period comparison).
  const primaryStart = (period === "ALL" || isExplicitPeriod(period)) ? null : periodRange(period, clock()).start;
  const compareToClock =
    compareTo && primaryStart && compareTo < primaryStart
      ? () => new Date(`${compareTo}T00:00:00`)
      : null;
  const liqCtx = tierResolver(accounts);
  const facts = aggregateDayFacts(rows, liqCtx, moneyCtx);
  const fmt = (v: number) => formatCurrency(v, moneyCtx?.target ?? DEFAULT_DISPLAY_CURRENCY);

  const insights: CashFlowInsight[] = [];
  const hasActivity = rows.length > 0;

  // (a) Then-vs-now net delta — only when a previous-equivalent period exists AND
  //     the current period has activity (a flat comparison of two empty windows is
  //     noise, not an insight; an empty period degrades to the "none" bullet below).
  // The comparison window: canonical compareTo (SAME period at the compareTo anchor)
  // when set, else the sequential previous-equivalent period (the existing insight).
  const then = hasActivity
    ? (compareToClock ? period : previousEquivalentPeriod(period, clock()))
    : null;
  if (then) {
    const cmp = compareCashFlow({
      transactions: transactions as LiquidityTx[],
      liqCtx,
      then,
      now: period,
      perspective,
      clock,
      thenClock: compareToClock ?? undefined,
      moneyCtx,
    });
    const dNet = cmp.delta.totals.net;
    const cmpRange = compareToClock ? periodRange(period, compareToClock()) : null;
    const prevLabel = cmpRange
      ? `${formatDate(cmpRange.start)} – ${formatDate(cmpRange.end)}`
      : periodLabel(then);
    // P2-1B — the compare net is perspective-aware: in LIQUIDITY mode the delta
    // is Cash In − Cash Out ("Net cash"); in ECONOMIC mode it is income − clamped
    // spending, which is NOT cash ("Income after spending"). Arithmetic unchanged.
    const netNoun = perspective === "liquidity" ? "Net cash" : "Income after spending";
    if (Math.abs(dNet) >= 1) {
      insights.push({
        id:   "compare-net",
        text: `${netNoun} is ${dNet > 0 ? "up" : "down"} ${fmt(Math.abs(dNet))} vs ${prevLabel} (${fmt(cmp.then.totals.net)} → ${fmt(cmp.now.totals.net)}).`,
        tone: dNet > 0 ? "positive" : "warning",
      });
    } else {
      insights.push({ id: "compare-net", text: `${netNoun} is about flat vs ${prevLabel}.`, tone: "neutral" });
    }
  }

  // (b) Top spending category.
  const cats = outflowByCategory(rows, moneyCtx);
  if (cats.length > 0 && cats[0].value > 0) {
    insights.push({ id: "top-category", text: `${cats[0].label} is your largest spending category at ${fmt(cats[0].value)}.`, tone: "neutral" });
  }

  // (b) Top income / cash-in source (perspective-aware, mirroring Income by Source).
  let topSource: { label: string; value: number } | null = null;
  if (perspective === "liquidity") {
    // Pure projection over the `facts` already folded above (no second fold).
    const cashIn = groupLiquidityByReason(facts).cashIn;
    if (cashIn.length > 0) topSource = { label: cashIn[0].label, value: cashIn[0].amount };
  } else {
    const src = incomeBySource(rows, moneyCtx);
    if (src.length > 0) topSource = { label: src[0].label, value: src[0].value };
  }
  if (topSource && topSource.value > 0) {
    const noun = perspective === "liquidity" ? "cash in" : "income";
    insights.push({ id: "top-source", text: `${topSource.label} is your largest source of ${noun} at ${fmt(topSource.value)}.`, tone: "neutral" });
  }

  // (c) Credit usage — a TWO-FACT statement over facts already in `facts`
  //     (P2-1B). `creditCardSpending` is this period's cost flows charged to a
  //     liability tier; `byReason.DEBT_PAYMENT` is this period's cash-out toward
  //     liabilities — the SAME DayFacts, same window, same FX. The two are shown
  //     side by side and NEVER subtracted: a period's debt payments can settle
  //     balances from earlier periods, so they do not "pay off" this period's
  //     charges and imply no unpaid balance (a balance is a Debt-domain stock
  //     fact, not a Cash-Flow flow fact). When no debt payments are visible
  //     (common — payments from unconnected accounts have no liquid leg), degrade
  //     to the timing-only sentence rather than announcing "$0 of payments".
  if (facts.creditCardSpending > 0) {
    const debtPaid = facts.byReason.DEBT_PAYMENT ?? 0;
    const text = debtPaid > 0
      ? `${fmt(facts.creditCardSpending)} of spending went on credit this period, and ${fmt(debtPaid)} of cash went to debt payments. Payments can cover balances from earlier periods, so the two won't necessarily match.`
      : `${fmt(facts.creditCardSpending)} of spending was charged to credit this period — it counts as spending now; the cash leaves when you pay the balance.`;
    insights.push({ id: "credit", text, tone: "neutral" });
  }

  // (d) Unresolved transfers — a review flag, never subtracted from the totals.
  const context = groupCashFlowContext(rows, liqCtx, moneyCtx);
  const unresolved = context.movedNotSpent.find((r) => r.key === "unresolved-transfers");
  if (unresolved && unresolved.amount > 0) {
    insights.push({ id: "unresolved", text: `${fmt(unresolved.amount)} moved through transfers we couldn't fully resolve — reviewing them keeps this period accurate.`, tone: "warning" });
  }

  // (e) Completeness caveat — one status sentence, only when the tier is incomplete.
  //     Points to the honest boundary; the shell chip owns the full evidence.
  const caveat: CashFlowInsight | null = stamp && stamp.completeness.tier === "incomplete"
    ? { id: "completeness", text: stamp.completeness.reason, tone: "warning" }
    : null;

  // Cap at 5 bullets; keep the caveat as the final line when present.
  const capped = insights.slice(0, caveat ? 4 : 5);
  if (caveat) capped.push(caveat);

  if (capped.length === 0) {
    return [{ id: "none", text: "No notable cash-flow movements to call out for this period yet.", tone: "neutral" }];
  }
  return capped;
}
