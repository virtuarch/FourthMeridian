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
 * Mortgage F3 (S2 ruling, item 2) — how much of the OWING debt a term covers.
 *
 * The coverage model is the debt-side twin of "partial, never $0, never omit"
 * (and of the scenario ledger's InterestBasis COMPLETE | PARTIAL | NONE |
 * NOT_APPLICABLE): a blended rate or a minimum-payment sum built from SOME of
 * the debts is PARTIAL and says so — how many debts and what share of the owed
 * balance lack the term. An unknown term is never averaged in and never summed
 * as 0 without this disclosure travelling with the figure.
 *
 *   COMPLETE        every owing debt has the term on file
 *   PARTIAL         some do, some do not — the figure covers the known ones only
 *   NONE            no owing debt has it — there is no figure (weightedApr null)
 *   NOT_APPLICABLE  nothing is owed — the question does not arise
 */
export type TermCoverageStatus = "COMPLETE" | "PARTIAL" | "NONE" | "NOT_APPLICABLE";

export interface TermCoverage {
  status:       TermCoverageStatus;
  /** Owing debts with the term on file. */
  knownCount:   number;
  /** Owing debts WITHOUT the term on file. */
  unknownCount: number;
  /** knownCount + unknownCount — the owing debts. */
  owingCount:   number;
  /** Σ owed over the debts without the term. */
  unknownOwed:  number;
  /** unknownOwed / totalOwed (0..1); 0 when nothing is owed. */
  unknownOwedShare: number;
  /** 1 − unknownOwedShare when something is owed; 0 when nothing is. The share
   *  of what is owed that the figure actually describes. */
  knownOwedShare: number;
  /**
   * True when the figure may be SHOWN as the aggregate: COMPLETE, or PARTIAL with
   * the known debts covering at least MIN_KNOWN_OWED_SHARE of what is owed.
   * Below that a surface shows "not enough rate information" in place of the
   * number (the number + its coverage stay in the drill-down). F3 / S2.
   */
  sufficient:   boolean;
  /** "rate known for 1 of 2 debts (2% of what you owe)" — null unless PARTIAL or NONE. */
  note:         string | null;
}

/** F3 / S2 — below this share of the owed balance, a PARTIAL aggregate is not shown as the figure. */
export const MIN_KNOWN_OWED_SHARE = 0.5;

/** "2%", never "0%" for a real non-zero share nor "100%" for a partial one. */
export function formatOwedShare(share: number): string {
  if (share <= 0) return "0%";
  if (share >= 1) return "100%";
  if (share < 0.005) return "<1%";
  if (share > 0.995) return ">99%";
  return `${Math.round(share * 100)}%`;
}

function coverageOf(known: number, unknown: number, unknownOwed: number, totalOwed: number, noun: string): TermCoverage {
  const owing = known + unknown;
  const status: TermCoverageStatus =
    owing === 0 ? "NOT_APPLICABLE" : unknown === 0 ? "COMPLETE" : known === 0 ? "NONE" : "PARTIAL";
  const unknownOwedShare = totalOwed > 0 ? unknownOwed / totalOwed : 0;
  const knownOwedShare = totalOwed > 0 ? 1 - unknownOwedShare : 0;
  const note = status === "PARTIAL" || status === "NONE"
    ? `${noun} known for ${known} of ${owing} debt${owing === 1 ? "" : "s"} (${formatOwedShare(knownOwedShare)} of what you owe)`
    : null;
  return {
    status, knownCount: known, unknownCount: unknown, owingCount: owing,
    unknownOwed, unknownOwedShare, knownOwedShare,
    sufficient: status === "COMPLETE" || (status === "PARTIAL" && knownOwedShare >= MIN_KNOWN_OWED_SHARE),
    note,
  };
}

/**
 * The coverage as the AI tool contract carries it — beside EVERY AI-visible
 * weighted rate (F3 / S2). Shares rounded to 3dp; `scope` says which debts the
 * rate describes, so a PARTIAL figure is never read as the blend of all debt.
 */
export interface AiRateCoverage {
  status:           TermCoverageStatus;
  ratedCount:       number;
  unratedCount:     number;
  unknownOwedShare: number;
  /** "ALL_OWED_DEBT" only when COMPLETE; otherwise the rate (if any) covers the rated debts only. */
  scope:            "ALL_OWED_DEBT" | "RATED_DEBTS_ONLY" | "NO_RATE";
  /** How to read the rate, in words the model can quote. */
  meaning:          string;
}

export function aiRateCoverage(c: TermCoverage): AiRateCoverage {
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const scope = c.status === "COMPLETE" ? "ALL_OWED_DEBT" : c.status === "PARTIAL" ? "RATED_DEBTS_ONLY" : "NO_RATE";
  const meaning =
    c.status === "COMPLETE" ? "weighted rate across all debt that is owed"
    : c.status === "PARTIAL"
      ? `rate across the debts with a known rate only, ${formatOwedShare(c.knownOwedShare)} of what you owe — NOT the rate of all debt; ${c.unknownCount} debt(s) have no rate on file`
    : c.status === "NONE" ? "unknown — no owing debt has a rate on file"
    : "not applicable — nothing is owed";
  return { status: c.status, ratedCount: c.knownCount, unratedCount: c.unknownCount, unknownOwedShare: r3(c.unknownOwedShare), scope, meaning };
}

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
   *  row owes anything. Unrounded — the surface decides precision. Unknown rates
   *  are never averaged in; when any owing row lacks one, `rateCoverage` is
   *  PARTIAL and the surface must say so (F3). */
  weightedApr:          number | null;
  /** `weightedApr / 100 / 12`, or 0 when no rate is known. The payoff
   *  simulator's input: a 0 rate means "project without interest", which is the
   *  honest projection when nothing is known, not a claim that the rate is 0. */
  monthlyRate:          number;
  /** Σ minimum payment over rows that OWE and HAVE one. A missing minimum is not
   *  in the sum — `minimumCoverage` says PARTIAL (F3), so it is never a silent 0. */
  minimumPayment:       number;
  /** Σ owed over the rows that carried a rate — the APR denominator. */
  ratedOwed:            number;
  /** Rows with a known APR that owe something (the APR population). */
  ratedCount:           number;
  /** Rows that owe something with NO APR on file — excluded from the rate. */
  unratedCount:         number;
  /** Rows that owe something with NO minimum payment on file. */
  missingMinimumCount:  number;
  /** F3 — coverage of `weightedApr`: PARTIAL when any owing row has no rate. */
  rateCoverage:         TermCoverage;
  /** F3 — coverage of `minimumPayment`: PARTIAL when any owing row has no
   *  minimum. A PARTIAL sum is the KNOWN minimums only — never "the unknown is 0". */
  minimumCoverage:      TermCoverage;
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
  let unratedOwed         = 0;
  let missingMinimumOwed  = 0;

  for (const row of rows) {
    const owed = amountOwed(row.balance);
    totalOwed += owed;

    // A row that owes nothing carries no rate weight and no obligation. Its
    // `owed` is 0, so the arithmetic below would be a no-op anyway; the explicit
    // check exists so the COUNTS describe the accounts a reader would count.
    if (owed <= 0) continue;

    if (row.apr === null) {
      unratedCount++;
      unratedOwed += owed;
    } else {
      ratedCount++;
      rateWeighted += row.apr * owed;
      ratedOwed    += owed;
    }

    if (row.minimumPayment === null) {
      missingMinimumCount++;
      missingMinimumOwed += owed;
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
    rateCoverage:    coverageOf(ratedCount, unratedCount, unratedOwed, totalOwed, "rate"),
    minimumCoverage: coverageOf(ratedCount + unratedCount - missingMinimumCount, missingMinimumCount, missingMinimumOwed, totalOwed, "minimum payment"),
  };
}
