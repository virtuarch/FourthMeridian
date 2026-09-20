/**
 * lib/debt/payoff.ts
 *
 * THE payoff-timing authority for the Debt experience: "putting this much a
 * month toward these debts, when is each one gone, what did it cost, and what is
 * the last payment?"
 *
 * Pure: no React, no DB, no clock (the start date is injected), no FX, no
 * currency.
 *
 * ── PER LIABILITY — there is no blended balance ─────────────────────────────
 * Every liability keeps its OWN balance, its OWN APR evidence, its OWN accrued
 * interest, its OWN payments and its OWN payoff date. A payment that takes one
 * card from 1,174 to 674 lowers THAT card's next interest, and no other card's
 * rate is ever averaged into it.
 *
 * This replaces the aggregate model (one balance at an owed-weighted APR). A
 * blended rate is only right while the mix of balances is constant, and the mix
 * is not constant: the higher-rate debt accrues faster, so a blend under-counts
 * interest a little more every month. An average APR may still be DESCRIBED on a
 * surface (`basis.avgKnownAprPct`); it is never an input to a schedule.
 *
 * ── Cadence ─────────────────────────────────────────────────────────────────
 * ONE cadence: MONTHLY. `payment` is money per calendar month, settled on each
 * monthly anniversary of `startISO` (clamped to the month's length, the same
 * rule as `lib/perspectives/time-range.addMonths`).
 *
 * ── Interest (the L1 liability semantics, restated — not a second convention) ─
 * Simple interest over ACTUAL days on a 365-day year, accrued PER LIABILITY at
 * each settlement on that liability's outstanding modelled balance, and added
 * to it BEFORE the payment, to the cent:
 *
 *     interest = round2(balance × apr/100 × days/365)
 *
 * — the line `lib/ai/conversation/scenario-ledger.ts` settles a modelled
 * liability with. (That ledger is a SEPARATE engine — stated minimums, dated
 * movements, a `target` waterfall — sharing this formula and nothing else. It
 * is deliberately not coupled to this one.)
 *
 * Within a liability a payment retires accrued-and-unpaid INTEREST first, then
 * principal, so `principalPaid + interestPaid = totalPaid` holds per liability
 * and in aggregate, and a paid-off liability has paid exactly its starting
 * principal plus every cent of interest modelled on it.
 *
 * ── Allocation: PRO RATA BY BALANCE ─────────────────────────────────────────
 * The planner offers no ordering strategy (no avalanche / snowball control), so
 * this engine does not smuggle one in. Each monthly payment is split across the
 * liabilities in proportion to what each owes AT THAT SETTLEMENT (after its own
 * interest), to the cent by largest remainder. It is the allocation the old
 * aggregate balance already implied — now applied to real per-liability
 * balances — and it prefers no debt over another. Every allocation is recorded
 * with its reason, so a schedule can say who got what, and why.
 *
 * ── The payment is a BUDGET ─────────────────────────────────────────────────
 * `payment` is the most the user can put toward the debts each month. A
 * liability never receives more than extinguishes it. When what is left across
 * ALL liabilities (each with the interest it has accrued by then) is less than a
 * full payment, it is cleared on the FIRST DAY `d` of that month on which the
 * evenly-accruing budget covers it:
 *
 *     smallest d in 1..D with  P × d/D  ≥  Σ (balanceᵢ + interestᵢ(d))
 *
 * each liability receives exactly its own `balanceᵢ + interestᵢ(d)`, and the
 * schedule STOPS: no negative balance, no interest on money never owed, nothing
 * in `totalPaid` a creditor did not receive. If the FIRST payment does it, the
 * result reports how much of the budget no debt needed
 * (`unusedPaymentCapacity`). The comparison is against the MODELLED REQUIREMENT
 * (balance + interest to the payment day), not today's principal. A later,
 * smaller last payment is a final partial payment, not spare capacity.
 *
 * ── Unknown APR: an ESTIMATE, never a rate ──────────────────────────────────
 * A liability with no APR on file accrues nothing, as an explicitly labelled
 * ESTIMATION ASSUMPTION on THAT liability (`interestBasis:
 * "ASSUMED_ZERO_UNKNOWN_APR"`, `aprPct: null`). It never borrows another
 * liability's rate — there is no shared rate to borrow. The schedule's `basis`:
 *
 *     INTEREST_AWARE    every liability that owes has a rate on file (0% included)
 *     PARTIAL_INTEREST  some do, some do not
 *     PRINCIPAL_ONLY    none does
 *
 * UNKNOWN IS NOT 0%: a known 0% is `KNOWN_APR` with `aprPct: 0`. Nothing here
 * writes, returns, or implies a rate for an account.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * Not an issuer payoff quote. The model has no evidence of grace-period
 * eligibility, statement-cycle balance method, cash-advance terms or residual
 * interest, and infers none: paying before a statement closes is not assumed to
 * cancel interest. "Estimated interest: $0" is a statement about this model.
 *
 * ── What it refuses ─────────────────────────────────────────────────────────
 * Payments that do not reduce the total owed over a full year, and a schedule
 * longer than `MAX_PAYOFF_PAYMENTS`, each come back as a named status with no
 * timeline.
 */

import { amountOwed } from "@/lib/debt/balance-semantics";
import { addMonths } from "@/lib/perspectives/time-range";

/** The planner's initial payment. An initial value only — never re-applied over a user's choice. */
export const DEFAULT_PAYOFF_PAYMENT = 50;

/** The one cadence this engine and the Payoff Strategy UI share. */
export const PAYOFF_CADENCE = "monthly" as const;

/** 100 years of monthly payments. Past this the honest answer is "not in any useful horizon". */
export const MAX_PAYOFF_PAYMENTS = 1200;

/** The one allocation rule (see the header). Recorded on every allocation. */
export type PayoffAllocationReason =
  /** A full monthly payment, split in proportion to each liability's balance at that settlement. */
  | "PRO_RATA_BY_BALANCE"
  /** The closing settlement: each liability receives exactly what extinguishes it. */
  | "FINAL_SETTLEMENT";

export interface PayoffLiabilityInput {
  id:      string;
  label?:  string;
  /** Signed balance; normalised through `amountOwed` (a credit owes nothing). */
  balance: number;
  /** Percent per year (19.99). `0` is a rate. `null` = UNKNOWN — never read as 0. */
  aprPct:  number | null;
}

export type PayoffInput =
  & {
    /** Money per month — a BUDGET; never more is paid than is owed. */
    payment: number;
    /** YYYY-MM-DD the schedule starts from (injected — this module owns no clock). */
    startISO: string;
  }
  & (
    | { liabilities: readonly PayoffLiabilityInput[] }
    /** Shorthand for exactly ONE liability. */
    | { balance: number; aprPct: number | null }
  );

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

/** One liability's interest evidence. */
export type LiabilityInterestBasis = "KNOWN_APR" | "ASSUMED_ZERO_UNKNOWN_APR";

/**
 * The evidence a schedule stands on. Carried by every status that ran one, so a
 * consumer never infers "was this an estimate?" from copy or from a 0.
 */
export interface PayoffBasis {
  interest: PayoffInterestBasis;
  /** Owed with a rate on file (interest accrues on these liabilities). */
  knownAprBalance: number;
  /** Owed with NO rate on file (carried at the assumption below). */
  unknownAprBalance: number;
  /** Ids of the owing liabilities with no APR on file. */
  unknownAprLiabilityIds: string[];
  /**
   * What an unknown-APR liability was computed at, and that it is an ASSUMPTION.
   * Null when nothing was unknown. Never the account's APR — that stays unknown.
   */
  unknownAprAssumption: { aprPct: 0; provenance: "ESTIMATION_ASSUMPTION" } | null;
  /**
   * DESCRIPTIVE ONLY — the opening owed-weighted mean of the KNOWN APRs, for a
   * surface that wants to show one. It is never an input to the schedule: every
   * liability accrues at its own rate. Null when no liability has a rate.
   */
  avgKnownAprPct: number | null;
}

/** What one liability received at one settlement. */
export interface PayoffAllocation {
  id:           string;
  /** Interest accrued on THIS liability since the previous settlement. */
  interest:     number;
  /** What this liability received. */
  paid:         number;
  toInterest:   number;
  toPrincipal:  number;
  /** Its modelled balance afterwards. Never negative. */
  balanceAfter: number;
  reason:       PayoffAllocationReason;
}

/** One settlement: the date, and who received what. */
export interface PayoffPayment {
  dateISO:     string;
  /** Actual days since the previous settlement (the accrual period). */
  days:        number;
  /** Σ allocations' `paid` — never more than the budget, never more than is owed. */
  paid:        number;
  allocations: PayoffAllocation[];
}

/** One liability's own schedule, summarised. */
export interface LiabilityPayoff {
  id:                string;
  label:             string;
  startingPrincipal: number;
  /** null = UNKNOWN. */
  aprPct:            number | null;
  interestBasis:     LiabilityInterestBasis;
  principalPaid:     number;
  /** Modelled interest accrued on — and paid by — this liability. 0 under the unknown-APR assumption. */
  interestPaid:      number;
  /** `principalPaid + interestPaid`. */
  totalPaid:         number;
  /** 0 on a paid-off schedule. Never negative. */
  remainingBalance:  number;
  /** Settlements in which this liability received money. */
  paymentCount:      number;
  payoffISO:         string;
  /** True when the schedule's FIRST settlement extinguished it. */
  paidOffWithFirstPayment: boolean;
}

export interface PaidOffPlan {
  status:   "paid_off";
  basis:    PayoffBasis;
  cadence:  typeof PAYOFF_CADENCE;
  allocation: "PRO_RATA_BY_BALANCE";
  startISO: string;
  /** The date of the final settlement — when the LAST liability is cleared. */
  payoffISO: string;
  /** Settlements of exactly `payment`, made on monthly anniversaries, BEFORE the final one. */
  fullPayments: number;
  /** The last settlement's total, to the cent. Equals `payment` on an exact boundary. */
  finalPayment: number;
  /** True when the last settlement is smaller than a full one. */
  finalPaymentIsPartial: boolean;
  /** Days into its month the final settlement falls (the month's length on an exact boundary). */
  finalPaymentDay: number;
  /** `fullPayments + 1`. `1` ⇔ the first settlement extinguishes every liability. */
  paymentCount: number;
  /** The monthly budget this schedule was run with (the input `payment`). */
  paymentBudget: number;
  /**
   * Budget no debt needed: `paymentBudget − totalPaid` when ONE settlement clears
   * everything, else 0. Never part of `totalPaid`. 0 on an exact payment.
   */
  unusedPaymentCapacity: number;
  elapsed:       PayoffElapsed;
  /** Σ liabilities' startingPrincipal (= Σ principalPaid on a paid-off schedule). */
  principal:     number;
  /** Σ liabilities' interestPaid. */
  totalInterest: number;
  /** Σ liabilities' totalPaid = principal + totalInterest. */
  totalPaid:     number;
  /** Every liability's own summary. The aggregates above are sums of these. */
  liabilities:   LiabilityPayoff[];
  /** Every settlement, in order, with per-liability allocations and reasons. */
  payments:      PayoffPayment[];
}

export type PayoffPlan =
  | PaidOffPlan
  | { status: "nothing_owed" }
  /** Payment ≤ 0, or a non-finite / negative input. */
  | { status: "invalid_input" }
  /** A full year of payments did not reduce the total owed: interest meets or exceeds the payment. */
  | { status: "non_amortizing"; basis: PayoffBasis; payment: number; firstPeriodInterest: number }
  /** Amortizes, but not within `MAX_PAYOFF_PAYMENTS`. */
  | { status: "beyond_horizon"; basis: PayoffBasis; maxPayments: number };

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);
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

/**
 * Split `payment` across balances in proportion to each, to the cent, by largest
 * remainder (ties → input order). Requires `payment < Σ balances`, which makes
 * every share strictly less than its balance.
 */
export function allocateProRata(payment: number, balances: readonly number[]): number[] {
  const total = balances.reduce((s, b) => s + cents(b), 0);
  const pay = cents(payment);
  if (total <= 0 || pay <= 0) return balances.map(() => 0);
  const exact = balances.map((b) => (pay * cents(b)) / total);
  const shares = exact.map(Math.floor);
  let left = pay - shares.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let n = 0; left > 0 && n < order.length; n++, left--) shares[order[n].i] += 1;
  return shares.map((c) => c / 100);
}

interface State {
  id: string; label: string; aprPct: number | null;
  startingPrincipal: number;
  /** principalLeft + unpaidInterest = the modelled balance. */
  principalLeft: number; unpaidInterest: number;
  principalPaid: number; interestPaid: number;
  paymentCount: number; payoffISO: string | null; firstSettlementCleared: boolean;
}
const balanceOf = (s: State) => round2(s.principalLeft + s.unpaidInterest);

/** The payoff schedule for a set of liabilities and one monthly payment budget. */
export function planPayoff(input: PayoffInput): PayoffPlan {
  const { payment, startISO } = input;
  if (!Number.isFinite(payment) || !(payment > 0)) return { status: "invalid_input" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO) || Number.isNaN(utc(startISO))) return { status: "invalid_input" };

  const raw: readonly PayoffLiabilityInput[] =
    "liabilities" in input ? input.liabilities : [{ id: "liability", balance: input.balance, aprPct: input.aprPct }];
  for (const l of raw) {
    if (!Number.isFinite(l.balance)) return { status: "invalid_input" };
    if (l.aprPct !== null && (!Number.isFinite(l.aprPct) || l.aprPct < 0)) return { status: "invalid_input" };
  }

  // Only liabilities that OWE take part. A settled card or an issuer credit
  // contributes nothing and can never net against another liability.
  const states: State[] = raw
    .map((l) => ({ l, owed: round2(amountOwed(l.balance)) }))
    .filter((x) => x.owed > 0)
    .map(({ l, owed }) => ({
      id: l.id, label: l.label ?? l.id, aprPct: l.aprPct,
      startingPrincipal: owed, principalLeft: owed, unpaidInterest: 0,
      principalPaid: 0, interestPaid: 0, paymentCount: 0, payoffISO: null, firstSettlementCleared: false,
    }));
  if (states.length === 0) return { status: "nothing_owed" };

  const known   = states.filter((s) => s.aprPct !== null);
  const unknown = states.filter((s) => s.aprPct === null);
  const knownAprBalance   = round2(known.reduce((t, s) => t + s.startingPrincipal, 0));
  const unknownAprBalance = round2(unknown.reduce((t, s) => t + s.startingPrincipal, 0));
  const basis: PayoffBasis = {
    interest: unknown.length === 0 ? "INTEREST_AWARE" : known.length === 0 ? "PRINCIPAL_ONLY" : "PARTIAL_INTEREST",
    knownAprBalance,
    unknownAprBalance,
    unknownAprLiabilityIds: unknown.map((s) => s.id),
    unknownAprAssumption: unknown.length > 0 ? { aprPct: 0, provenance: "ESTIMATION_ASSUMPTION" } : null,
    avgKnownAprPct: knownAprBalance > 0
      ? known.reduce((t, s) => t + (s.aprPct as number) * s.startingPrincipal, 0) / knownAprBalance
      : null,
  };

  /** THIS liability's interest over `days`, at ITS rate. Unknown ⇒ the assumption: none. */
  const interestOf = (s: State, days: number) => (s.aprPct === null ? 0 : accruedInterest(balanceOf(s), s.aprPct, days));
  const open = () => states.filter((s) => s.payoffISO === null);
  const totalOwed = () => round2(open().reduce((t, s) => t + balanceOf(s), 0));

  /** Accrue `interest`, then apply `paid`: accrued-unpaid interest first, then principal. */
  function settle(s: State, interest: number, paid: number, dateISO: string, first: boolean, reason: PayoffAllocationReason): PayoffAllocation {
    s.unpaidInterest = round2(s.unpaidInterest + interest);
    const toInterest  = round2(Math.min(paid, s.unpaidInterest));
    const toPrincipal = round2(Math.min(paid - toInterest, s.principalLeft));
    s.unpaidInterest = round2(s.unpaidInterest - toInterest);
    s.principalLeft  = round2(s.principalLeft - toPrincipal);
    s.interestPaid   = round2(s.interestPaid + toInterest);
    s.principalPaid  = round2(s.principalPaid + toPrincipal);
    if (paid > 0) s.paymentCount++;
    if (balanceOf(s) <= 0) { s.payoffISO = dateISO; s.firstSettlementCleared = first; }
    return { id: s.id, interest, paid: round2(toInterest + toPrincipal), toInterest, toPrincipal, balanceAfter: balanceOf(s), reason };
  }

  const payments: PayoffPayment[] = [];
  let firstPeriodInterest = 0;
  let yearAgoOwed = totalOwed();
  let prev = startISO;

  for (let k = 0; k < MAX_PAYOFF_PAYMENTS; k++) {
    // Anniversaries are taken from the ANCHOR, not the previous date, so a
    // Jan-31 start does not drift to the 28th for the rest of the schedule.
    const next = addMonths(startISO, k + 1);
    const D = daysBetween(prev, next);
    const live = open();

    // Can the accruing budget clear EVERYTHING that is left inside this month?
    // (A budget that tops out below what is owed cannot, whatever the day.)
    for (let d = 1; payment + 1e-9 >= totalOwed() && d <= D; d++) {
      const interests = live.map((s) => interestOf(s, d));
      const dues = live.map((s, i) => round2(balanceOf(s) + interests[i]));
      const due = round2(dues.reduce((t, x) => t + x, 0));
      if (payment * (d / D) + 1e-9 < due) continue;

      const payoffISO = addDays(prev, d);
      const allocations = live.map((s, i) => settle(s, interests[i], dues[i], payoffISO, k === 0, "FINAL_SETTLEMENT"));
      payments.push({ dateISO: payoffISO, days: d, paid: due, allocations });

      const liabilities: LiabilityPayoff[] = states.map((s) => ({
        id: s.id, label: s.label, startingPrincipal: s.startingPrincipal, aprPct: s.aprPct,
        interestBasis: s.aprPct === null ? "ASSUMED_ZERO_UNKNOWN_APR" : "KNOWN_APR",
        principalPaid: s.principalPaid, interestPaid: s.interestPaid,
        totalPaid: round2(s.principalPaid + s.interestPaid),
        remainingBalance: balanceOf(s), paymentCount: s.paymentCount,
        payoffISO: s.payoffISO as string, paidOffWithFirstPayment: s.firstSettlementCleared,
      }));
      const onBoundary = d === D;
      return {
        status: "paid_off",
        basis,
        cadence: PAYOFF_CADENCE,
        allocation: "PRO_RATA_BY_BALANCE",
        startISO,
        payoffISO,
        fullPayments: k,
        finalPayment: due,
        finalPaymentIsPartial: due < payment - 0.005,
        finalPaymentDay: d,
        paymentCount: k + 1,
        paymentBudget: payment,
        // Only a schedule that never needed a full payment has capacity to spare.
        unusedPaymentCapacity: k === 0 ? Math.max(0, round2(payment - due)) : 0,
        elapsed: elapsedOf(startISO, payoffISO, onBoundary ? k + 1 : k, onBoundary ? 0 : d),
        // Aggregates are SUMS of the liability schedules — nothing is computed twice.
        principal:     round2(liabilities.reduce((t, l) => t + l.startingPrincipal, 0)),
        totalInterest: round2(liabilities.reduce((t, l) => t + l.interestPaid, 0)),
        totalPaid:     round2(liabilities.reduce((t, l) => t + l.totalPaid, 0)),
        liabilities,
        payments,
      };
    }

    // A full month: every liability accrues at ITS rate on ITS balance, then the
    // payment is split pro rata over the post-interest balances.
    const interests = live.map((s) => interestOf(s, D));
    const balances = live.map((s, i) => round2(balanceOf(s) + interests[i]));
    const shares = allocateProRata(payment, balances);
    const allocations = live.map((s, i) => settle(s, interests[i], shares[i], next, k === 0, "PRO_RATA_BY_BALANCE"));
    payments.push({ dateISO: next, days: D, paid: round2(allocations.reduce((t, a) => t + a.paid, 0)), allocations });
    if (k === 0) firstPeriodInterest = round2(interests.reduce((t, x) => t + x, 0));
    prev = next;

    // Every month length has been seen once a year has passed. If twelve
    // payments left the total no lower, no number of them will.
    if ((k + 1) % 12 === 0) {
      const owed = totalOwed();
      if (owed >= yearAgoOwed) return { status: "non_amortizing", basis, payment, firstPeriodInterest };
      yearAgoOwed = owed;
    }
  }

  return { status: "beyond_horizon", basis, maxPayments: MAX_PAYOFF_PAYMENTS };
}
