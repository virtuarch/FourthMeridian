/**
 * lib/forecast/observed-spending.ts
 *
 * PROJECTION-1 — WHAT SPENDING HAS ACTUALLY BEEN, OVER A NAMED WINDOW.
 *
 * ── This is NOT FORECAST-6, and the difference is the whole point ───────────
 * F6 asks "what does this user's ordinary spending LOOK LIKE NOW" and answers
 * UNKNOWN for this user, on evidence: calendar months range 6.1x, 28-day windows
 * 8.3x, 7-day windows 15.1x. No level repeats, so no level is "normal". That
 * verdict is untouched here and must never be restated as a rate.
 *
 * This module asks a strictly weaker question with a strictly weaker answer:
 * over the last N complete months, what did spending AVERAGE? That is a
 * description of a window, true by construction, and it licenses nothing about
 * the future on its own — a projection built from it carries
 * `OBSERVED_CONTINUATION`, which is the assumption the user can reject.
 *
 * ⚠️ THE WINDOW IS PART OF THE ANSWER, because on real data it IS the answer.
 * Measured on the live Space: 2 complete months give $4,156.68/mo, 3 give
 * $8,349.66, 13 give $6,567.02. A rate quoted without its window is not a
 * weaker claim than a forecast — it is an unfalsifiable one.
 *
 * ⚠️ AND THE WINDOW IS FIXED, NOT CHOSEN. `WINDOW_MONTHS` is a constant and the
 * selection is always "the most recent complete months, up to that many". There
 * is deliberately no path that compares candidate windows — picking the one with
 * the tightest dispersion, or the friendliest number, would make the disclosure
 * a decoration on a decision already taken.
 *
 * ── Why it reads the canonical breakdown rather than the ledger ─────────────
 * `monthlyBreakdown` + `reliableMonths` is the population the assessment and the
 * prompt already share, and KD-10 records that a competing spending figure was
 * removed once before. A second, wider read would reintroduce exactly that. So
 * this takes the same complete months everything else uses — which also means
 * DEBT_PAYMENT is already excluded, verified against the ledger: Jul+Aug 2026
 * `expenseTotal` averages $4,156.68, and SPENDING+FEE over those months is
 * $2,290.03 + $6,023.33, the same figure to the cent.
 */

import { AssumptionOrigin, type AssumptionOriginKind } from './policy';

/**
 * The canonical projection lookback.
 *
 * Three complete calendar months: long enough to span more than one pay cycle
 * and one billing cycle, short enough to describe the current regime rather than
 * an average of regimes. Fewer are used when fewer exist, and the count is always
 * disclosed; more are never used, so a longer history cannot quietly smooth an
 * unstable recent period into a comfortable number.
 */
export const WINDOW_MONTHS = 3;

/** One complete month, as the shared breakdown already holds it. */
export interface CompleteMonth {
  /** `YYYY-MM`. */
  month: string;
  /**
   * The month's ECONOMIC spend, in the reporting currency: gross charges less the
   * refunds dated in that month, floored at 0 (NET-BASELINE-1). The caller supplies
   * it already netted through the canonical clamp — this module averages, and
   * decides nothing about what counts as spending or as a refund.
   */
  expenseTotal: number;
}

/** `2026-07` → `July 2026`, so a reply cannot paraphrase the window loosely. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const idx = Number(m) - 1;
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

export interface ObservedSpendingRate {
  assertable: true;
  /** The mean of `values`, full precision. Rounded only at the display edge. */
  monthlyRate: number;
  /** Equivalent daily accrual, for a horizon that is not a whole month. */
  dailyRate: number;
  /** The months averaged, oldest first — the window, stated. */
  months: string[];
  values: number[];
  monthCount: number;
  /**
   * max/min across the window. NOT a confidence interval and not a forecast
   * band: a plain statement of how much the averaged months differed from each
   * other, so a mid-point drawn from $14,060.81 and $2,290.03 cannot be read as
   * a settled level. Null when a single month was averaged.
   */
  dispersionRatio: number | null;
  low: number;
  high: number;
  origin: AssumptionOriginKind;
}

export interface UnavailableSpendingRate {
  assertable: false;
  reason: string;
}

export type ObservedSpendingResult = ObservedSpendingRate | UnavailableSpendingRate;

/** Days in an average month — the same constant the engine accrues by. */
const DAYS_PER_MONTH = 365 / 12;

/**
 * Average the most recent complete months, and say which ones.
 *
 * PURE. No clock, no DB. `months` must already be the reliable set, oldest
 * first, exactly as `reliableMonths` returns it.
 */
export function deriveObservedSpendingRate(
  months: readonly CompleteMonth[],
  windowMonths: number = WINDOW_MONTHS,
): ObservedSpendingResult {
  const usable = months.filter((m) => Number.isFinite(m.expenseTotal) && m.expenseTotal >= 0);
  if (usable.length === 0) {
    return {
      assertable: false,
      reason: 'no complete calendar month of spending is available to average',
    };
  }
  // ⚠️ ALWAYS THE MOST RECENT. Never the most stable, never the longest run that
  // happens to look level.
  const window = usable.slice(-Math.max(1, windowMonths));
  const values = window.map((m) => m.expenseTotal);
  const monthlyRate = values.reduce((t, v) => t + v, 0) / values.length;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return {
    assertable: true,
    monthlyRate,
    dailyRate: monthlyRate / DAYS_PER_MONTH,
    months: window.map((m) => m.month),
    values,
    monthCount: values.length,
    dispersionRatio: values.length > 1 && low > 0 ? high / low : null,
    low,
    high,
    origin: AssumptionOrigin.OBSERVED_CONTINUATION,
  };
}

// ── S1 — category rates over the SAME months ─────────────────────────────────

/** A month's category lines as the canonical ledger emits them. */
export interface BreakdownMonthCategories {
  month: string;
  byCategory?: readonly { category: string; total: number; netTotal?: number }[];
}

/** One category line's rate. Shape-compatible with `spending-change.ts`'s CategoryRate. */
export interface CategorySpendingRate {
  category: string;
  /** The mean of `values`, full precision. */
  monthly: number;
  /** Exactly the months the total rate averaged, oldest first. */
  months: string[];
  /** The line's NET (charges less its own credits, floored at 0) in each of them. */
  values: number[];
}

/**
 * The rate of each category line over EXACTLY the months the total rate averaged.
 *
 * ⚠️ THE SAME MONTHS, OR IT IS NOT A DECOMPOSITION. A category averaged over a
 * different window than the total is two measurements pretending to be one, and a
 * cut applied to it would move the total by an amount measured somewhere else.
 * `windowMonths` is the observed rate's own `months`.
 *
 * ⚠️ A LINE ABSENT FROM A MONTH COUNTS AS NOTHING SPENT THAT MONTH, for the mean
 * only: the ledger omits a line with no rows, and averaging over the months where
 * it happened to appear would overstate it. The months are named beside the values.
 *
 * Each value is the ledger line's own net (`netTotal ?? total`), so a refund lowers
 * the category it was filed against, as it does everywhere else.
 */
export function deriveCategorySpendingRates(
  months: readonly BreakdownMonthCategories[], windowMonths: readonly string[],
): CategorySpendingRate[] {
  if (windowMonths.length === 0) return [];
  const inWindow = windowMonths.map((ym) => months.find((m) => m.month === ym));
  const names = new Set<string>();
  for (const m of inWindow) for (const c of m?.byCategory ?? []) names.add(c.category);
  return [...names].sort().map((category) => {
    const values = inWindow.map((m) => {
      const line = m?.byCategory?.find((c) => c.category === category);
      return line ? (line.netTotal ?? line.total) : 0;
    });
    return { category, monthly: values.reduce((t, v) => t + v, 0) / values.length,
      months: [...windowMonths], values };
  });
}

// ── S1-N1 — interest the scenario ledger accrues itself ─────────────────────

/** A month as the canonical breakdown holds it — only the fields this reads. */
export interface BreakdownMonthForRate {
  month: string;
  /** GROSS cost-flow charges. */
  expenseTotal: number;
  refundTotal: number;
  /** Interest charged this month, by the account it posted to (charges ⊆ expenseTotal). */
  interestByAccount?: Record<string, { charges: number; credits: number }>;
}

/** What was left out of the spending rate, month by month, and why. */
export interface ModelledInterestExclusion {
  /** The liabilities whose historical interest was left out. */
  accounts: string[];
  /** Per month: interest charged on those accounts, net of reversals. Full precision. */
  months: { month: string; excluded: number }[];
  meaning: string;
}

/**
 * The months with the interest of ledger-modelled liabilities taken out of GROSS
 * and REFUNDS — before the canonical clamp, which the caller still applies.
 *
 * ⚠️ WHY (S1-N1). The spending rate averages every cost flow, and INTEREST is one:
 * interest charged on a card's carried balance is in `expenseTotal`. A scenario
 * whose ledger ALSO accrues interest on that card (L1: a known rate, ACT/365, on
 * the balance carried into each month-end) would charge that interest twice — once
 * as a repeat of history inside ordinary spending, once as the balance's own
 * accrual. Only one of them is a model of the future.
 *
 * ⚠️ ONLY WHAT CAN BE ATTRIBUTED, ONLY TO WHAT IS MODELLED. A charge is taken out
 * when it posted to an account in `modelledAccounts` — the liabilities the ledger
 * accrues at a known rate. Interest with no account, or on a liability the ledger
 * does not accrue (no rate known), is untouched and stays in the rate: nothing
 * else models it, so removing it would make it vanish rather than count once.
 *
 * PURE. Months are returned in the input order with every other field intact.
 */
export function withoutModelledInterest<M extends BreakdownMonthForRate>(
  months: readonly M[], modelledAccounts: readonly string[],
): { months: M[]; excluded: ModelledInterestExclusion | null } {
  const ids = new Set(modelledAccounts);
  if (ids.size === 0) return { months: [...months], excluded: null };
  const perMonth: { month: string; excluded: number }[] = [];
  const touched = new Set<string>();
  const out = months.map((m) => {
    let charges = 0, credits = 0;
    for (const [id, v] of Object.entries(m.interestByAccount ?? {})) {
      if (!ids.has(id)) continue;
      charges += v.charges; credits += v.credits;
      touched.add(id);
    }
    if (charges === 0 && credits === 0) return m;
    perMonth.push({ month: m.month, excluded: charges - credits });
    return { ...m, expenseTotal: m.expenseTotal - charges, refundTotal: m.refundTotal - credits };
  });
  if (touched.size === 0) return { months: out, excluded: null };
  return {
    months: out,
    excluded: {
      accounts: [...touched].sort(),
      months: perMonth,
      meaning: 'Interest charged on these liabilities in the averaged months is NOT in the spending '
        + 'rate, because this scenario\'s ledger accrues their future interest itself from each '
        + 'balance and rate. Counted once, as the ledger\'s interest.',
    },
  };
}

// ⚠️ `describeObservedSpending` DELETED (V26-REASONING Slice 0). A prose
// renderer with no caller but its own test. `deriveObservedSpendingRate` and its
// completeness reasons are the authority and are unchanged.
