/**
 * lib/debt/aggregates.ts   (v2.6-DEBT-1)
 *
 * THE single answer to the three questions every debt surface asks about a SET
 * of liabilities:
 *
 *   "how much is owed?"              → totalOwed
 *   "at what blended rate?"          → weightedApr / monthlyRate
 *   "what is due each month?"        → minimumPayment
 *
 * Pure: no DB, no React, no clock, no FX. It operates on rows the caller has
 * ALREADY converted into one currency and ALREADY filtered for visibility —
 * because those two are the caller's context, and the population rule is not.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 *
 * v2.6-REVIEW-2 §4.2 found five implementations of the weighted average APR.
 * Re-measuring on HEAD found a SIXTH (`SectionCard.tsx:149`), and it was the one
 * that disagreed. Roadmap item 1 (Semantic Authority Convergence) exits on "no
 * displayed percentage or derived metric is computed at more than one site; each
 * has a named owner and an enrolment guard". The weighted APR is a displayed
 * percentage — it is rendered six times in `DebtPayoffSection` alone and
 * serialized into the AI prompt — and it had neither an owner nor a guard.
 *
 * ── The rule, and why this one ──────────────────────────────────────────────
 *
 * MEMBERSHIP of the total is STRUCTURAL: every row the caller passes counts,
 * and contributes `owed`. A settled card contributes 0; an issuer credit
 * contributes 0. Never a negative — an issuer credit is spendable only at that
 * issuer, so it can never discharge another account's obligation (V25-SIDE-1).
 *
 * APR WEIGHTING is over rows with a KNOWN rate, weighted by `owed`. Three
 * consequences worth stating, because implementations disagreed on all three:
 *
 *   - A rate of exactly 0 is KNOWN, not missing. A 0% promotional balance
 *     genuinely lowers a blended rate, and excluding it overstates the rate the
 *     borrower actually pays. `metrics.ts` and `engine.ts` filtered `apr > 0`
 *     and so reported a higher blended rate than the money supports.
 *   - A row that owes nothing needs no separate filter. Its weight IS its
 *     `owed`, which is 0, so it contributes nothing to either side of the ratio.
 *     This is why the lens (no owes-filter) and the planner (owes-filter) were
 *     always the same function written twice.
 *   - An UNRATED row is EXCLUDED FROM BOTH SIDES — never folded in as a 0.
 *     `SectionCard.tsx:149` divided a rate-weighted numerator by the total over
 *     ALL debt, so one unrated account dragged the blended rate toward zero and
 *     the collapsed payoff summary told the user they would be debt-free sooner
 *     than they will be. That is the defect this module removes.
 *
 * ⚠️ NO ROUNDING. `metrics.ts` rounded to 2dp and `engine.ts` did not, from the
 * same population — one number, two values. Rounding is a PRESENTATION choice
 * and belongs at the surface that prints it (they all already call `.toFixed(2)`).
 *
 * MINIMUM PAYMENT sums only rows that OWE: nothing is due on a settled card or
 * one carrying an issuer credit, and a missing minimum on such a row is not a
 * gap worth reporting. A missing minimum on a row that DOES owe contributes 0
 * and is counted in `missingMinimumCount`, so a surface can disclose the sum is
 * partial rather than silently understating what is due.
 *
 * ⚠️ This module does NOT estimate a missing minimum payment. `lib/data/accounts.ts`
 * estimates (for /dashboard/credit) and `lib/space/mount-composition.ts` does
 * not (for the Space workspace) — a live divergence recorded in v2.6-REVIEW-2
 * §4.3 and deliberately NOT resolved here, because which surfaces may show an
 * estimated obligation is a product decision, not a derivable fact. Whatever the
 * caller passes in is what gets summed.
 */

import { amountOwed } from "@/lib/debt/balance-semantics";

/**
 * One liability, already converted into the caller's currency and already
 * cleared for the caller's visibility tier.
 *
 * `owed` is passed RAW (signed) and normalised here through `amountOwed`, so a
 * caller cannot accidentally hand in a negative and net it against another row.
 */
export interface DebtAggregateRow {
  /** Signed balance in ONE currency. Normalised via `amountOwed`. */
  balance:         number;
  /** Effective APR as a percent (19.99 ⇒ 19.99%). Null when not on file. */
  apr:             number | null;
  /** Minimum payment in the same currency. Null when not on file. */
  minimumPayment:  number | null;
}

export interface DebtAggregate {
  /** Σ amount OWED across every row. Settled and credit rows contribute 0. */
  totalOwed:            number;
  /** Owed-weighted mean APR over rows with a KNOWN rate, or null when no rated
   *  row owes anything. Unrounded — the surface decides precision. */
  weightedApr:          number | null;
  /** `weightedApr / 100 / 12`, or 0 when no rate is known. The payoff
   *  simulator's input: a 0 rate means "project without interest", which is the
   *  honest projection when nothing is known, not a claim that the rate is 0. */
  monthlyRate:          number;
  /** Σ minimum payment over rows that OWE. Missing minimums contribute 0. */
  minimumPayment:       number;
  /** Σ owed over the rows that carried a rate — the APR denominator. */
  ratedOwed:            number;
  /** Rows with a known APR that owe something (the APR population). */
  ratedCount:           number;
  /** Rows that owe something with NO APR on file — excluded from the rate. */
  unratedCount:         number;
  /** Rows that owe something with NO minimum payment on file. */
  missingMinimumCount:  number;
}

/**
 * The debt aggregate for a set of liabilities. Deterministic, and total over its
 * input: an empty list yields zeros with a null rate, never a NaN.
 */
export function computeDebtAggregate(rows: readonly DebtAggregateRow[]): DebtAggregate {
  let totalOwed           = 0;
  let rateWeighted        = 0;
  let ratedOwed           = 0;
  let minimumPayment      = 0;
  let ratedCount          = 0;
  let unratedCount        = 0;
  let missingMinimumCount = 0;

  for (const row of rows) {
    const owed = amountOwed(row.balance);
    totalOwed += owed;

    // A row that owes nothing carries no rate weight and no obligation. Its
    // `owed` is 0, so the arithmetic below would be a no-op anyway; the explicit
    // check exists so the COUNTS describe the accounts a reader would count.
    if (owed <= 0) continue;

    if (row.apr === null) {
      unratedCount++;
    } else {
      ratedCount++;
      rateWeighted += row.apr * owed;
      ratedOwed    += owed;
    }

    if (row.minimumPayment === null) {
      missingMinimumCount++;
    } else {
      minimumPayment += row.minimumPayment;
    }
  }

  const weightedApr = ratedOwed > 0 ? rateWeighted / ratedOwed : null;

  return {
    totalOwed,
    weightedApr,
    monthlyRate: weightedApr !== null ? weightedApr / 100 / 12 : 0,
    minimumPayment,
    ratedOwed,
    ratedCount,
    unratedCount,
    missingMinimumCount,
  };
}
