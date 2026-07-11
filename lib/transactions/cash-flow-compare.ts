/**
 * lib/transactions/cash-flow-compare.ts
 *
 * P1 — Cash Flow Time Machine (lib phase). Two pure, deterministic capabilities
 * that let the Cash Flow Perspective answer historically and honestly:
 *
 *   1. cashFlowStamp()   — the completeness stamp for a period, using the A5-S1
 *                          shared trust vocabulary (Completeness). Cash Flow is
 *                          not a lens, but it emits the SAME envelope every
 *                          Perspective does, so the shell can render one honest
 *                          badge across all of them. Posted transactions are
 *                          `observed`; a period reaching before our earliest
 *                          history is `incomplete` (a gap, never a fabricated
 *                          whole).
 *   2. compareCashFlow() — "Then vs Now": deltas between two period selections
 *                          over the existing shared DayFacts projection and the
 *                          existing category breakdown, with the comparison's
 *                          completeness set to the WORST of the two sides (via
 *                          the S1 propagation helper — never re-derived here).
 *
 * This module adds NO classifier and NO new period/time state. It composes the
 * already-canonical Cash Flow helpers (cash-flow.ts period model, filterByPeriod,
 * availableHistoricalPeriods, outflowByCategory) and the shared projection
 * (cash-flow-projection.ts DayFacts, perspectiveTotals). The trust vocabulary
 * and its propagation come from lib/perspective-engine (imported, never edited —
 * "downstream Perspectives build [completeness] with the propagation helpers …,
 * never by hand", per LensResult.completeness in perspective-engine/types.ts).
 *
 * Pure and importable (no DB/React/next), unit-testable under tsx. The clock is
 * injected (relative periods resolve against it) so identical inputs yield
 * byte-identical output. Currency: per-row conversion at the row's own date via
 * the caller's ConversionContext; absent ⇒ raw amounts (same rule as every other
 * Cash Flow helper).
 */

import {
  periodRange,
  filterByPeriod,
  availableHistoricalPeriods,
  outflowByCategory,
  type CashFlowPeriod,
  type CashFlowContribution,
} from "@/lib/transactions/cash-flow";
import {
  aggregateDayFacts,
  perspectiveTotals,
  type DayFacts,
  type PerspectiveTotals,
  type CashFlowPerspective,
} from "@/lib/transactions/cash-flow-projection";
import type { LiquidityTx, LiquidityContext } from "@/lib/transactions/liquidity";
import { propagateCompleteness } from "@/lib/perspective-engine/completeness";
import type { Completeness } from "@/lib/perspective-engine/types";
import type { ConversionContext } from "@/lib/money/types";

// ─── Completeness stamp ──────────────────────────────────────────────────────

/**
 * The trust envelope for a Cash Flow answer over one period, plus the freshness
 * of the underlying data. `completeness` is the A5-S1 shared type — the exact
 * envelope the Liquidity/Debt/Wealth Perspectives carry — so a shared badge is
 * uniform across perspectives. `dataAsOf` is the newest posted transaction date
 * we hold (how current the feed is); null when there is no history at all.
 */
export interface CashFlowStamp {
  completeness: Completeness;
  dataAsOf: string | null;
}

/** Min / max transaction date over a set, ignoring undated rows. Deterministic
 *  string compare (ISO YYYY-MM-DD sorts chronologically). */
function coverageBounds(transactions: LiquidityTx[]): { earliest: string | null; latest: string | null } {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const t of transactions) {
    const d = t.date;
    if (!d || d.length < 7) continue;
    if (earliest === null || d < earliest) earliest = d;
    if (latest === null || d > latest) latest = d;
  }
  return { earliest, latest };
}

/**
 * Emit the completeness stamp for a period over the FULL visible history.
 *
 * Tier derivation (the coverage boundary, from the same transaction dates that
 * drive availableHistoricalPeriods):
 *   - no history at all                       → incomplete (nothing to answer)
 *   - the period reaches before earliest data → incomplete (a pre-coverage gap;
 *                                               the window's total cannot be whole)
 *   - otherwise                               → observed (posted transactions)
 *
 * "All Time" asks only for the data we have, so it never reads as pre-coverage.
 * Pass the FULL history (not a period-filtered slice): coverage is a property of
 * the data, not of the window. The clock is injected so relative periods (MTD,
 * PAST_MONTH, …) resolve deterministically.
 */
export function cashFlowStamp(args: {
  transactions: LiquidityTx[];
  period: CashFlowPeriod;
  now: () => Date;
}): CashFlowStamp {
  const { transactions, period, now } = args;
  const { earliest, latest } = coverageBounds(transactions);

  // availableHistoricalPeriods is the selectable-period surface; it and the
  // coverage bound below both derive from the same transaction dates, so the
  // stamp is consistent with what the selector can even offer. Referenced for
  // the selectable-year floor (documented dependency, no behavioural coupling).
  void availableHistoricalPeriods;

  if (earliest === null) {
    return {
      completeness: {
        tier: "incomplete",
        conflict: false,
        reason: "No cash-flow history available.",
      },
      dataAsOf: null,
    };
  }

  // "All Time" (sentinel range) asks for exactly the history we hold, so its
  // effective start is the earliest data — never a claim before coverage.
  const effectiveStart = period === "ALL" ? earliest : periodRange(period, now()).start;
  const predatesCoverage = effectiveStart < earliest;

  const completeness: Completeness = predatesCoverage
    ? {
        tier: "incomplete",
        conflict: false,
        reason: `Requested period reaches before cash-flow history begins on ${earliest}.`,
        coverageFrom: earliest,
      }
    : {
        tier: "observed",
        conflict: false,
        reason: "Computed from posted transactions within cash-flow history.",
        coverageFrom: earliest,
      };

  return { completeness, dataAsOf: latest };
}

// ─── Then vs Now ─────────────────────────────────────────────────────────────

/** One side of a Then-vs-Now comparison: the period, its totals for the chosen
 *  perspective, its full (both-axis) DayFacts, its outflow-by-category
 *  breakdown, and its completeness stamp. */
export interface CashFlowSide {
  period: CashFlowPeriod;
  totals: PerspectiveTotals;
  facts: DayFacts;
  outflowByCategory: CashFlowContribution[];
  stamp: CashFlowStamp;
}

/** Per-category movement between the two periods (now − then). Present for every
 *  category that had spend in EITHER period; the absent side contributes 0. */
export interface CashFlowCategoryDelta {
  id: string;
  label: string;
  then: number;
  now: number;
  delta: number;
}

/** The full Then-vs-Now result: both sides, the deltas, and the comparison's
 *  completeness (worst of the two side stamps, conflict ORing upward). */
export interface CashFlowComparison {
  perspective: CashFlowPerspective;
  then: CashFlowSide;
  now: CashFlowSide;
  delta: {
    totals: PerspectiveTotals;                 // now.totals − then.totals
    outflowByCategory: CashFlowCategoryDelta[];
  };
  completeness: Completeness;
}

/** Compute one side of the comparison from the full history + a period. */
function computeSide(
  transactions: LiquidityTx[],
  period: CashFlowPeriod,
  liqCtx: LiquidityContext,
  perspective: CashFlowPerspective,
  clock: () => Date,
  moneyCtx?: ConversionContext,
): CashFlowSide {
  const rows = filterByPeriod(transactions, period, clock());
  const facts = aggregateDayFacts(rows, liqCtx, moneyCtx);
  return {
    period,
    totals: perspectiveTotals(facts, perspective),
    facts,
    outflowByCategory: outflowByCategory(rows, moneyCtx),
    stamp: cashFlowStamp({ transactions, period, now: clock }),
  };
}

/** Union of two category breakdowns into now − then deltas, biggest mover first
 *  (tie-broken by id for byte-identical ordering). */
function diffCategories(
  thenCats: CashFlowContribution[],
  nowCats: CashFlowContribution[],
): CashFlowCategoryDelta[] {
  const thenBy = new Map(thenCats.map((c) => [c.id, c]));
  const nowBy = new Map(nowCats.map((c) => [c.id, c]));
  const ids = [...new Set([...thenBy.keys(), ...nowBy.keys()])];
  return ids
    .map((id) => {
      const t = thenBy.get(id)?.value ?? 0;
      const n = nowBy.get(id)?.value ?? 0;
      return { id, label: nowBy.get(id)?.label ?? thenBy.get(id)?.label ?? id, then: t, now: n, delta: n - t };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Combine two side stamps into the comparison's completeness: worst tier +
 *  conflict-OR via the S1 propagation helper (never re-derived), with a
 *  composed, name-free reason and the shared coverage floor. */
function combineCompleteness(then: Completeness, now: Completeness): Completeness {
  const { tier, conflict } = propagateCompleteness([then, now]);
  const coverageFrom = then.coverageFrom ?? now.coverageFrom;
  const reason =
    tier === "incomplete"
      ? coverageFrom
        ? `One or both periods reach before cash-flow history begins on ${coverageFrom}.`
        : "One or both periods have no cash-flow history to compare."
      : "Both periods computed from posted transactions within cash-flow history.";
  return coverageFrom
    ? { tier, conflict, reason, coverageFrom }
    : { tier, conflict, reason };
}

/**
 * "Then vs Now" — the deltas between two period selections, computed purely over
 * the shared projection (aggregateDayFacts → perspectiveTotals) and the existing
 * category breakdown. Each side is filtered from the SAME full history, so the
 * comparison is apples-to-apples; the result's completeness is the worst of the
 * two sides (a comparison is only as trustworthy as its weaker end).
 *
 * Deterministic: the injected clock resolves relative periods once; identical
 * inputs yield byte-identical output.
 */
export function compareCashFlow(args: {
  transactions: LiquidityTx[];
  liqCtx: LiquidityContext;
  then: CashFlowPeriod;
  now: CashFlowPeriod;
  perspective: CashFlowPerspective;
  clock: () => Date;
  moneyCtx?: ConversionContext;
}): CashFlowComparison {
  const { transactions, liqCtx, then, now, perspective, clock, moneyCtx } = args;
  const thenSide = computeSide(transactions, then, liqCtx, perspective, clock, moneyCtx);
  const nowSide = computeSide(transactions, now, liqCtx, perspective, clock, moneyCtx);

  return {
    perspective,
    then: thenSide,
    now: nowSide,
    delta: {
      totals: {
        in: nowSide.totals.in - thenSide.totals.in,
        out: nowSide.totals.out - thenSide.totals.out,
        net: nowSide.totals.net - thenSide.totals.net,
      },
      outflowByCategory: diffCategories(thenSide.outflowByCategory, nowSide.outflowByCategory),
    },
    completeness: combineCompleteness(thenSide.stamp.completeness, nowSide.stamp.completeness),
  };
}
