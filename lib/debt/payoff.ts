/**
 * lib/debt/payoff.ts
 *
 * THE payoff-timing authority for the Debt experience: "paying this much a
 * month, when is this balance gone, and what is the last payment?"
 *
 * Pure: no React, no DB, no clock (the start date is injected), no FX, no
 * currency. It replaces the month-granular `simulatePayoff` that lived inside
 * `DebtPayoffSection.tsx` and answered "3 months" for a schedule whose last
 * payment is a fraction of a full one.
 *
 * ── Inputs ──────────────────────────────────────────────────────────────────
 * balance (and how much of it has a known rate) + APR + chosen payment. NOTHING
 * ELSE. A minimum payment is not an input: the payment the user chose is the
 * payment.
 *
 * ── Cadence ─────────────────────────────────────────────────────────────────
 * ONE cadence: MONTHLY. `payment` is money per calendar month, paid on each
 * monthly anniversary of `startISO` (clamped to the month's length, the same
 * rule as `lib/perspectives/time-range.addMonths`).
 *
 * ── Interest (the L1 liability semantics, restated — not a second convention) ─
 * Simple interest over ACTUAL days on a 365-day year, accrued at each
 * settlement and added to the balance BEFORE the payment, rounded to the cent:
 *
 *     interest = round2(balance × apr/100 × days/365)
 *
 * which is the line `lib/ai/conversation/scenario-ledger.ts` settles a modelled
 * liability with. An explicit 0 is a rate.
 *
 * ── Unknown APR: an ESTIMATE, never a rate ──────────────────────────────────
 * A missing APR does not block the schedule. The part of the balance whose rate
 * is unknown is carried at ZERO interest as an explicitly labelled ESTIMATION
 * ASSUMPTION, and the result says so STRUCTURALLY, in `basis`:
 *
 *     INTEREST_AWARE    every dollar owed has a rate on file (0% included)
 *     PARTIAL_INTEREST  some of the balance has a rate, some does not
 *     PRINCIPAL_ONLY    none of it has a rate — payments against principal only
 *
 * UNKNOWN IS NOT 0%. A known 0% card is INTEREST_AWARE with `aprPct: 0`; an
 * unknown one is PRINCIPAL_ONLY with `aprPct: null` and an
 * `unknownAprAssumption`. The two may print the same date; they never carry the
 * same basis. Nothing here writes, returns, or implies a rate for the account —
 * the assumption lives on the RESULT, and only there.
 *
 * MIXED balances. `aprPct` is the blended rate over the KNOWN part only, and it
 * is applied to the known part only:
 *
 *     interest = round2(balance × knownShare × apr/100 × days/365)
 *
 * where `knownShare = known / (known + unknown)` is fixed for the schedule —
 * the payment retires the two parts pro-rata, which is the SAME assumption the
 * single blended balance has always made about the accounts inside it (a
 * blended rate is only constant if the mix is). The unknown part therefore
 * accrues exactly 0 and NEVER inherits the known accounts' rate; the old planner
 * applied the rated subset's blend to the whole balance, which is the defect
 * this replaces.
 *
 * ── The final partial payment ───────────────────────────────────────────────
 * A payment of P a month is a budget that accrues evenly across the month. When
 * what is left (plus the interest it has accrued by then) is less than a full
 * payment, it is cleared on the FIRST DAY `d` of that month on which the accrued
 * budget covers it:
 *
 *     smallest d in 1..D with  P × d/D  ≥  balance + round2(balance × apr/100 × d/365)
 *
 * and the final payment is that right-hand side, to the cent. So $1,174 at $500
 * a month is not "3 months": it is two full payments and a smaller third one,
 * some days into the third month. When the remainder is exactly one full
 * payment, `d = D` and the schedule ends on the month boundary with a full
 * final payment.
 *
 * ── What it refuses ─────────────────────────────────────────────────────────
 * A payment that does not reduce the balance over a full year, and a schedule
 * longer than `MAX_PAYOFF_PAYMENTS`, each come back as a named status with no
 * timeline. An estimate is qualified; it is never dressed up as precise.
 */

import { amountOwed } from "@/lib/debt/balance-semantics";
import { addMonths } from "@/lib/perspectives/time-range";

/** The planner's initial payment. An initial value only — never re-applied over a user's choice. */
export const DEFAULT_PAYOFF_PAYMENT = 50;

/** The one cadence this engine and the Payoff Strategy UI share. */
export const PAYOFF_CADENCE = "monthly" as const;

/** 100 years of monthly payments. Past this the honest answer is "not in any useful horizon". */
export const MAX_PAYOFF_PAYMENTS = 1200;

export interface PayoffInput {
  /** Signed balance; normalised through `amountOwed` (a credit owes nothing). */
  balance:  number;
  /**
   * Percent per year (19.99), blended over the part of `balance` whose rate IS
   * known. `0` is a rate. `null` = no part of the balance has a known rate.
   */
  aprPct:   number | null;
  /**
   * The part of `balance` whose APR is UNKNOWN (same currency, ≥ 0). It accrues
   * no interest — an estimation assumption reported in `basis`, not a rate.
   * Omitted ⇒ all of it when `aprPct` is null, none of it otherwise.
   */
  unknownAprBalance?: number;
  /** Money per month. */
  payment:  number;
  /** YYYY-MM-DD the schedule starts from (injected — this module owns no clock). */
  startISO: string;
}

export interface PayoffElapsed {
  years:       number;
  /** Whole months beyond `years` (0–11). */
  months:      number;
  /** Whole weeks beyond the last whole month (0–4). */
  weeks:       number;
  /** Days beyond the last whole week (0–6). */
  days:        number;
  /** `years × 12 + months`. */
  totalMonths: number;
  /** Actual calendar days from `startISO` to the payoff date. */
  totalDays:   number;
  /** "2 months, 1 week, 3 days" — only the non-zero parts. */
  label:       string;
}

/** How much of the schedule's interest is evidenced by a rate on file. */
export type PayoffInterestBasis = "INTEREST_AWARE" | "PARTIAL_INTEREST" | "PRINCIPAL_ONLY";

/**
 * The evidence a schedule stands on. Carried by every status that ran one, so a
 * consumer never infers "was this an estimate?" from copy or from a 0.
 */
export interface PayoffBasis {
  interest: PayoffInterestBasis;
  /** Blended APR over the KNOWN part; null when none of the balance has a rate. */
  aprPct: number | null;
  /** Owed with a rate on file (interest accrues on this part). */
  knownAprBalance: number;
  /** Owed with NO rate on file (carried at the assumption below). */
  unknownAprBalance: number;
  /**
   * What the unknown part was computed at, and that it is an ASSUMPTION. Null
   * when nothing was unknown. This is never the account's APR — that stays
   * unknown in the data; only this estimate used a zero.
   */
  unknownAprAssumption: { aprPct: 0; provenance: "ESTIMATION_ASSUMPTION" } | null;
}

export interface PaidOffPlan {
  status:   "paid_off";
  basis:    PayoffBasis;
  cadence:  typeof PAYOFF_CADENCE;
  startISO: string;
  /** The date of the final payment. */
  payoffISO: string;
  /** Payments of exactly `payment`, made on monthly anniversaries, BEFORE the final one. */
  fullPayments: number;
  /** The last payment, to the cent. Equals `payment` on an exact boundary. */
  finalPayment: number;
  /** True when the last payment is smaller than a full one. */
  finalPaymentIsPartial: boolean;
  /** Days into its month the final payment falls (equals the month's length on an exact boundary). */
  finalPaymentDay: number;
  /** `fullPayments + 1`. */
  paymentCount: number;
  elapsed:       PayoffElapsed;
  principal:     number;
  totalInterest: number;
  totalPaid:     number;
}

export type PayoffPlan =
  | PaidOffPlan
  | { status: "nothing_owed" }
  /** Payment ≤ 0, a non-finite / negative input, or a known part with no rate. */
  | { status: "invalid_input" }
  /** A full year of payments did not reduce the balance: interest meets or exceeds the payment. */
  | { status: "non_amortizing"; basis: PayoffBasis; payment: number; firstPeriodInterest: number }
  /** Amortizes, but not within `MAX_PAYOFF_PAYMENTS`. */
  | { status: "beyond_horizon"; basis: PayoffBasis; maxPayments: number };

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY_MS);
const addDays = (iso: string, n: number) => new Date(utc(iso) + n * DAY_MS).toISOString().slice(0, 10);

/** Interest a balance accrues over `days` actual days, to the cent (ACT/365, simple). */
export function accruedInterest(balance: number, aprPct: number, days: number): number {
  return round2(balance * (aprPct / 100) * (days / 365));
}

const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function elapsedOf(startISO: string, payoffISO: string, wholeMonths: number, extraDays: number): PayoffElapsed {
  const years  = Math.floor(wholeMonths / 12);
  const months = wholeMonths % 12;
  const weeks  = Math.floor(extraDays / 7);
  const days   = extraDays % 7;
  const label = [
    years  > 0 ? part(years, "year")   : "",
    months > 0 ? part(months, "month") : "",
    weeks  > 0 ? part(weeks, "week")   : "",
    days   > 0 ? part(days, "day")     : "",
  ].filter(Boolean).join(", ");
  return { years, months, weeks, days, totalMonths: wholeMonths, totalDays: daysBetween(startISO, payoffISO), label };
}

/** The payoff schedule for one balance at one rate and one monthly payment. */
export function planPayoff(input: PayoffInput): PayoffPlan {
  const { aprPct, payment, startISO } = input;
  if (!Number.isFinite(input.balance) || !Number.isFinite(payment) || !(payment > 0)) return { status: "invalid_input" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO) || Number.isNaN(utc(startISO))) return { status: "invalid_input" };

  const principal = round2(amountOwed(input.balance));
  if (!(principal > 0)) return { status: "nothing_owed" };

  if (aprPct !== null && (!Number.isFinite(aprPct) || aprPct < 0)) return { status: "invalid_input" };
  const rawUnknown = input.unknownAprBalance ?? (aprPct === null ? principal : 0);
  if (!Number.isFinite(rawUnknown) || rawUnknown < 0) return { status: "invalid_input" };
  const unknownAprBalance = Math.min(round2(rawUnknown), principal);
  const knownAprBalance   = round2(principal - unknownAprBalance);
  // A part of the balance is claimed as KNOWN but no rate came with it.
  if (knownAprBalance > 0 && aprPct === null) return { status: "invalid_input" };

  const basis: PayoffBasis = {
    interest: unknownAprBalance <= 0 ? "INTEREST_AWARE" : knownAprBalance <= 0 ? "PRINCIPAL_ONLY" : "PARTIAL_INTEREST",
    aprPct: knownAprBalance > 0 ? aprPct : null,
    knownAprBalance,
    unknownAprBalance,
    unknownAprAssumption: unknownAprBalance > 0 ? { aprPct: 0, provenance: "ESTIMATION_ASSUMPTION" } : null,
  };
  // Interest accrues on the KNOWN share only, at the known part's own rate. The
  // unknown share accrues exactly 0 — it never borrows the known accounts' APR.
  const knownShare = knownAprBalance / principal;
  const rate = basis.aprPct ?? 0;
  const interestOn = (bal: number, days: number) => accruedInterest(bal * knownShare, rate, days);

  let balance = principal;
  let totalInterest = 0;
  let totalPaid = 0;
  let firstPeriodInterest = 0;
  let yearAgoBalance = principal;
  let prev = startISO;

  for (let k = 0; k < MAX_PAYOFF_PAYMENTS; k++) {
    // Anniversaries are taken from the ANCHOR, not the previous date, so a
    // Jan-31 start does not drift to the 28th for the rest of the schedule.
    const next = addMonths(startISO, k + 1);
    const D = daysBetween(prev, next);

    // Can the accruing budget clear what is left inside this month? (A budget
    // that tops out below the balance cannot, whatever the day — skip the scan.)
    for (let d = 1; payment + 1e-9 >= balance && d <= D; d++) {
      const interest = interestOn(balance, d);
      const due = round2(balance + interest);
      if (payment * (d / D) + 1e-9 >= due) {
        const payoffISO = addDays(prev, d);
        const onBoundary = d === D;
        return {
          status: "paid_off",
          basis,
          cadence: PAYOFF_CADENCE,
          startISO,
          payoffISO,
          fullPayments: k,
          finalPayment: due,
          finalPaymentIsPartial: due < payment - 0.005,
          finalPaymentDay: d,
          paymentCount: k + 1,
          elapsed: elapsedOf(startISO, payoffISO, onBoundary ? k + 1 : k, onBoundary ? 0 : d),
          principal,
          totalInterest: round2(totalInterest + interest),
          totalPaid: round2(totalPaid + due),
        };
      }
    }

    // A full month: accrue, then pay.
    const interest = interestOn(balance, D);
    if (k === 0) firstPeriodInterest = interest;
    balance = round2(balance + interest - payment);
    totalInterest += interest;
    totalPaid += payment;
    prev = next;

    // Every month length has been seen once a year has passed. If twelve
    // payments left the balance no lower, no number of them will.
    if ((k + 1) % 12 === 0) {
      if (balance >= yearAgoBalance) return { status: "non_amortizing", basis, payment, firstPeriodInterest };
      yearAgoBalance = balance;
    }
  }

  return { status: "beyond_horizon", basis, maxPayments: MAX_PAYOFF_PAYMENTS };
}
