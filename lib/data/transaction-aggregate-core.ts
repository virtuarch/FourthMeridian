/**
 * lib/data/transaction-aggregate-core.ts  (TX-3.1b)
 *
 * The PURE fold behind the Transaction Explorer's aggregate authority — no `db`, no
 * FX archive, no server-only import, so the conversion math is unit-testable against
 * a hand-built ConversionContext.
 *
 * WHY THIS EXISTS (review finding M7):
 *   A keyset page cannot produce a total. The explorer's KPI figures are computed
 *   over the WHOLE filtered set, so they need their own authority — but a naive
 *   server `SUM(amount)` would be wrong in exactly the way that removed amount
 *   sorting (M1): the product's figure is `Math.abs(FX-converted amount)`, while SQL
 *   sums the SIGNED NATIVE column.
 *
 * THE EXACTNESS ARGUMENT (why grouping by date+currency reproduces the client):
 *   Conversion is a per-(currency, date) positive scalar multiplication, so within
 *   one (currency, date) group it is linear and sign-preserving:
 *       Σ |convert(aᵢ, d, c)|  =  convert(Σ |aᵢ|, d, c)          [rate > 0]
 *   and within a group split by SIGN, Σ|aᵢ| is recoverable from the signed sum:
 *       positives → Σ|aᵢ| =  Σaᵢ
 *       negatives → Σ|aᵢ| = -Σaᵢ      i.e. |Σaᵢ| in both cases.
 *   So grouping by (flowType, currency, date) with a sign split and converting each
 *   group at ITS OWN date yields a figure identical to converting every row
 *   individually — which is what the client does today. No row-level scan needed,
 *   no persisted reporting column, no FX persistence.
 *
 *   The sign split is load-bearing: without it a group's signed sum would net
 *   inflows against outflows and `Math.abs` of the net is NOT the sum of magnitudes.
 */

import { convertMoney } from "@/lib/money/convert";
import type { ConversionContext } from "@/lib/money/types";
import { UNCLASSIFIED_FLOW_KEY } from "@/lib/transactions/flow-predicates";

/**
 * One `groupBy([flowType, currency, date])` row with its SIGNED sum. Both the
 * positive-only and negative-only passes produce this shape.
 */
export interface AggregateGroup {
  flowType: string | null;
  currency: string | null;
  /** YYYY-MM-DD — the group's own date, so conversion uses that day's rate. */
  date: string;
  /** The signed `_sum.amount` for this group (may be null when Prisma sums nothing). */
  sum: number | null;
}

export interface TransactionAggregate {
  /** Exact row count for the filtered set (currency-free, always trustworthy). */
  count: number;
  /**
   * Converted MAGNITUDE per flow type, keyed by FlowType (or UNCLASSIFIED_FLOW_KEY),
   * expressed in `currency`. Matches the client's `sumByFlowType(…, Math.abs(…))`.
   */
  totalsByFlowType: Record<string, number>;
  /** The reporting currency the totals are expressed in. */
  currency: string;
  /**
   * True when ANY contributing group was converted with an estimated rate — a rate
   * miss, or a row with no recorded currency (Phase 0 null-residue). Presentation
   * must degrade honestly rather than present an estimate as exact.
   */
  estimated: boolean;
}

/**
 * Fold grouped signed sums into converted per-flow-type magnitudes.
 *
 * `groups` must be the UNION of the positive-only and negative-only groupBy passes;
 * each group's magnitude is `|sum|` (exact per the argument above), converted at the
 * group's own date into the context target.
 */
export function foldAggregateGroups(
  groups: readonly AggregateGroup[],
  count: number,
  ctx: ConversionContext,
): TransactionAggregate {
  const totalsByFlowType: Record<string, number> = {};
  let estimated = false;

  for (const g of groups) {
    if (g.sum == null || g.sum === 0) continue;
    const converted = convertMoney({ amount: Math.abs(g.sum), currency: g.currency }, g.date, ctx);
    if (converted.estimated) estimated = true;
    const key = g.flowType ?? UNCLASSIFIED_FLOW_KEY;
    totalsByFlowType[key] = (totalsByFlowType[key] ?? 0) + converted.amount;
  }

  return { count, totalsByFlowType, currency: ctx.target, estimated };
}

/**
 * The distinct (currency, date) pairs a set of groups will convert — exactly the
 * prefetch the conversion-context factory needs, and nothing more.
 */
export function conversionKeysFor(groups: readonly AggregateGroup[]): {
  currencies: (string | null)[];
  dates: string[];
} {
  const currencies = new Set<string | null>();
  const dates = new Set<string>();
  for (const g of groups) {
    if (g.sum == null || g.sum === 0) continue;
    currencies.add(g.currency);
    dates.add(g.date);
  }
  return { currencies: [...currencies], dates: [...dates] };
}
