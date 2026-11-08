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
 * ── Allocation: REQUIRED FIRST, THEN ONE TARGET AT A TIME (Mortgage F4) ──────
 * Owner decision 2026-11-08: the budget is no longer split pro rata across every
 * debt (a $300k mortgage absorbed ~98% of it and a 25% card was carried for
 * years). Each month, in this order:
 *
 *   1. REQUIRED — every debt receives its required payment (`requiredPayment`:
 *      a card's minimum, a loan's scheduled installment), capped at what it owes.
 *   2. SURPLUS — what is left of the budget goes to ONE target at a time, in the
 *      strategy's order; when a target is cleared the rest flows to the next in
 *      the same settlement, and from then on its required payment is surplus
 *      too (the rollover):
 *        avalanche (default)  highest KNOWN rate first; unknown rate LAST
 *        snowball             smallest starting balance first
 *
 * Surplus targets are REVOLVING debts (cards, lines of credit, HELOCs — the
 * lib/debt/liability-kind.ts authority) and debts with no kind evidence.
 * INSTALLMENT loans (mortgage, auto, student, personal) amortise on schedule and
 * receive only their scheduled payment unless the caller opts in
 * (`includeInstallmentExtra`), and even then only when they can be projected.
 *
 * A budget below the sum of the KNOWN required payments is a `shortfall` —
 * named, with the amounts — never a silent pro-rata of too little money.
 *
 * ── The payment is a BUDGET ─────────────────────────────────────────────────
 * `payment` is the most the user can put toward the debts each month. A
 * liability never receives more than extinguishes it. When every debt still
 * open is a surplus target and the evenly-accruing budget covers all of them
 * inside a month, they are cleared on the FIRST DAY `d` it does:
 *
 *     smallest d in 1..D with  P × d/D  ≥  Σ (balanceᵢ + interestᵢ(d))
 *
 * and the schedule STOPS. If the FIRST payment does it, the result reports how
 * much of the budget no debt needed (`unusedPaymentCapacity`). An installment
 * loan that is not a surplus target is never paid early this way.
 *
 * ── Unknown data: NEVER assumed (owner 2026-11-08) ───────────────────────────
 *   • Unknown RATE on a revolving debt: still a surplus target (after every
 *     known rate under avalanche); its balance is projected on PRINCIPAL ONLY,
 *     labelled (`rateStatus: "RATE_UNKNOWN"`, `projection:
 *     "PRINCIPAL_ONLY_ESTIMATE"`) and LEFT OUT of the interest total. No rate is
 *     written or implied for it — there is no 0% assumption.
 *   • Unknown REQUIRED payment on a revolving debt: no minimum is invented;
 *     nothing is reserved for it and `coverage` names the field.
 *   • An INSTALLMENT loan is projected only with a known rate AND a known
 *     amortising payment. Otherwise its payoff date is UNKNOWN (`payoffISO:
 *     null` + `unknownReasons`), it is out of every total, and its known gross
 *     payment is still RESERVED from the budget each month.
 *   • MORTGAGE: the scheduled payment may include escrow (unsplit, owner F6), so
 *     the gross payment is never treated as principal + interest. A mortgage is
 *     projected only from `principalInterestPayment`; without it the payoff is
 *     unknown ("MORTGAGE_PAYMENT_SPLIT_UNKNOWN").
 * `coverage` lists every owing debt with an unknown field; `assumptions` states
 * the rules that applied, in words a surface or the model can repeat.
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
import type { TermCoverageStatus } from "@/lib/debt/aggregates";
import { liabilityKind, type LiabilityKind, type LiabilityKindInput } from "@/lib/debt/liability-kind";
import { isMortgage } from "@/lib/debt/rate-label";
import { addMonths } from "@/lib/perspectives/time-range";

/** The planner's initial payment. An initial value only — never re-applied over a user's choice. */
export const DEFAULT_PAYOFF_PAYMENT = 50;

/** The one cadence this engine and the Payoff Strategy UI share. */
export const PAYOFF_CADENCE = "monthly" as const;

/** 100 years of monthly payments. Past this the honest answer is "not in any useful horizon". */
export const MAX_PAYOFF_PAYMENTS = 1200;

/** F4 — where the surplus goes first. */
export const PAYOFF_STRATEGIES = ["avalanche", "snowball"] as const;
export type PayoffStrategy = typeof PAYOFF_STRATEGIES[number];
/** F4 — highest known rate first. */
export const DEFAULT_PAYOFF_STRATEGY: PayoffStrategy = "avalanche";

export function isPayoffStrategy(v: unknown): v is PayoffStrategy {
  return typeof v === "string" && (PAYOFF_STRATEGIES as readonly string[]).includes(v);
}

/** Why one liability received money at one settlement (recorded on every allocation). */
export type PayoffAllocationReason =
  /** Its required payment only (minimum / scheduled installment). */
  | "REQUIRED_PAYMENT"
  /** Its required payment plus surplus: it is (or became, by rollover) the strategy's current target. */
  | "SURPLUS_TARGET"
  /** The closing settlement: each liability receives exactly what extinguishes it. */
  | "FINAL_SETTLEMENT";

export interface PayoffLiabilityInput {
  id:      string;
  label?:  string;
  /** Signed balance; normalised through `amountOwed` (a credit owes nothing). */
  balance: number;
  /** Percent per year (19.99). `0` is a rate. `null` = UNKNOWN — never read as 0. */
  aprPct:  number | null;
  /**
   * F4 — the REQUIRED monthly payment: a card's minimum, a loan's scheduled
   * installment (for a mortgage, possibly including escrow — see
   * `principalInterestPayment`). `null`/absent = UNKNOWN — never invented.
   */
  requiredPayment?: number | null;
  /**
   * F4 — a mortgage's principal + interest portion of its scheduled payment
   * (escrow excluded), when known. A mortgage is projected ONLY from this.
   */
  principalInterestPayment?: number | null;
  /** F4 — kind evidence, classified by lib/debt/liability-kind.ts. Absent ⇒ "unknown" (a surplus target, like revolving credit). */
  kind?: LiabilityKindInput;
}

export interface PayoffOptions {
  /** Default "avalanche". */
  strategy?: PayoffStrategy;
  /** Let projectable installment loans receive surplus too. Default false: they amortise on schedule. */
  includeInstallmentExtra?: boolean;
}

export type PayoffInput =
  & PayoffOptions
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

/** One liability's interest evidence. UNKNOWN is "not modelled" — never 0%. */
export type LiabilityInterestBasis = "KNOWN_APR" | "NOT_MODELLED_UNKNOWN_APR";

/** F3 — the label a surface renders for one liability's projection. */
export type LiabilityRateStatus = "KNOWN" | "RATE_UNKNOWN";

/** F3 — which liabilities a plan's `totalInterest` covers. */
export type PayoffInterestTotalScope = "ALL_DEBTS" | "KNOWN_RATE_ONLY";

/** F4 — how one liability's payoff was (or was not) projected. */
export type LiabilityProjection =
  /** Known rate and known amortising payment (or a surplus target with a known rate). */
  | "PROJECTED"
  /** A revolving debt with no rate on file: principal only, interest not modelled. */
  | "PRINCIPAL_ONLY_ESTIMATE"
  /** Not projected — its payoff date is unknown (`unknownReasons`). */
  | "UNKNOWN";

/** F4 — why an installment loan's payoff date is unknown. */
export type PayoffUnknownReason = "RATE_UNKNOWN" | "REQUIRED_PAYMENT_UNKNOWN" | "MORTGAGE_PAYMENT_SPLIT_UNKNOWN";

/** F4 — a term the plan needed and did not have. */
export type PayoffUnknownField = "rate" | "requiredPayment" | "principalInterestSplit";

/**
 * F4 — what the plan knew. COMPLETE ⇔ every owing debt has every term the plan
 * uses; PARTIAL / NONE name the debts and the fields that were unknown.
 */
export interface PayoffCoverage {
  status:      TermCoverageStatus;
  owingCount:  number;
  /** Owing debts with every term on file. */
  knownCount:  number;
  unknown:     { id: string; label: string; fields: PayoffUnknownField[] }[];
  /** Installment loans that could not be projected: no payoff date, out of every total. */
  unprojected: { id: string; label: string; reasons: PayoffUnknownReason[]; reservedMonthly: number }[];
}

/** F4 — a rule the plan applied, stated so a surface or the model can repeat it. */
export type PayoffAssumptionCode =
  | "REQUIRED_FIRST"
  | "SURPLUS_AVALANCHE"
  | "SURPLUS_SNOWBALL"
  | "INSTALLMENT_SCHEDULED_ONLY"
  | "INSTALLMENT_EXTRA_INCLUDED"
  | "UNKNOWN_RATE_PRINCIPAL_ONLY"
  | "UNKNOWN_RATE_ORDERED_LAST"
  | "UNKNOWN_REQUIRED_NOT_RESERVED"
  | "INSTALLMENT_UNPROJECTED_RESERVED"
  | "MORTGAGE_ESCROW_NOT_PRINCIPAL"
  | "UNKNOWN_KIND_AS_REVOLVING";
export interface PayoffAssumption { code: PayoffAssumptionCode; text: string }

/**
 * The evidence a schedule stands on. Carried by every status that classified
 * the debts, so a consumer never infers "was this an estimate?" from copy or a 0.
 */
export interface PayoffBasis {
  interest: PayoffInterestBasis;
  /** Owed with a rate on file. */
  knownAprBalance: number;
  /** Owed with NO rate on file. */
  unknownAprBalance: number;
  /** Ids of the owing liabilities with no rate on file. */
  unknownAprLiabilityIds: string[];
  /** F3 — owing liabilities with no rate on file (= unknownAprLiabilityIds.length). */
  unknownAprCount: number;
  /** F3 — owing liabilities. */
  owingCount: number;
  /**
   * DESCRIPTIVE ONLY — the opening owed-weighted mean of the KNOWN rates. Never
   * an input to the schedule. Null when no liability has a rate.
   */
  avgKnownAprPct: number | null;
}

/** What one liability received at one settlement. */
export interface PayoffAllocation {
  id:           string;
  /** Interest accrued on THIS liability since the previous settlement. */
  interest:     number;
  /** What this liability received (= toRequired + toExtra = toInterest + toPrincipal). */
  paid:         number;
  /** F4 — the part that was its required payment. */
  toRequired:   number;
  /** F4 — the part that was surplus (it was the target). */
  toExtra:      number;
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
  /** F4 — set aside for payments that reduce no projected balance (unprojected loans, escrow). */
  reserved:    number;
  /** F4 — budget no debt could take (no surplus target was open). */
  unallocated: number;
  allocations: PayoffAllocation[];
}

/** One liability's own schedule, summarised. */
export interface LiabilityPayoff {
  id:                string;
  label:             string;
  startingPrincipal: number;
  /** null = UNKNOWN. */
  aprPct:            number | null;
  /** F4 — lib/debt/liability-kind.ts. */
  kind:              LiabilityKind;
  isMortgage:        boolean;
  /** F4 — the required payment on file; null = unknown. */
  requiredPayment:   number | null;
  /** F4 — eligible for surplus. */
  surplusTarget:     boolean;
  /** F4 — 1-based position in the strategy's target order; null when not a target. */
  order:             number | null;
  interestBasis:     LiabilityInterestBasis;
  /** F3 — "RATE_UNKNOWN" ⇔ no rate on file: render "rate unknown", never "0% / $0 interest". */
  rateStatus:        LiabilityRateStatus;
  projection:        LiabilityProjection;
  /** F4 — empty unless `projection` is "UNKNOWN". */
  unknownReasons:    PayoffUnknownReason[];
  principalPaid:     number;
  /** Modelled interest (0 when not modelled — `rateStatus` / `projection` say so). */
  interestPaid:      number;
  /** `principalPaid + interestPaid`. */
  totalPaid:         number;
  /** 0 on a paid-off schedule; the starting balance for an unprojected loan. */
  remainingBalance:  number;
  /** Settlements in which this liability received money. */
  paymentCount:      number;
  /** null ⇔ `projection` "UNKNOWN": the payoff date is not known. */
  payoffISO:         string | null;
  /** True when the schedule's FIRST settlement extinguished it. */
  paidOffWithFirstPayment: boolean;
}

/** Fields every plan that classified the debts carries. */
interface Classified {
  basis:      PayoffBasis;
  coverage:   PayoffCoverage;
  strategy:   PayoffStrategy;
  includeInstallmentExtra: boolean;
  assumptions: PayoffAssumption[];
}

export interface PaidOffPlan extends Classified {
  status:   "paid_off";
  cadence:  typeof PAYOFF_CADENCE;
  allocation: "REQUIRED_THEN_TARGETED";
  /** F4 — the surplus targets' ids, in the order they receive surplus. */
  targetOrder: string[];
  startISO: string;
  /** When the LAST PROJECTED liability is cleared. */
  payoffISO: string;
  /** F4 — `payoffISO` when every owing debt was projected; null when any payoff date is unknown. */
  debtFreeISO: string | null;
  /** Settlements BEFORE the final one. */
  fullPayments: number;
  /** The last settlement's total to the projected debts, to the cent. */
  finalPayment: number;
  /** True when the last settlement is smaller than the budget available to the debts. */
  finalPaymentIsPartial: boolean;
  /** Days into its month the final settlement falls (the month's length on an exact boundary). */
  finalPaymentDay: number;
  /** `fullPayments + 1`. `1` ⇔ the first settlement extinguishes every projected liability. */
  paymentCount: number;
  /** The monthly budget this schedule was run with (the input `payment`). */
  paymentBudget: number;
  /** F4 — Σ known required payments at the start (what the budget must at least cover). */
  requiredMonthly: number;
  /** F4 — set aside each month for unprojected loans (their known gross payment). */
  reservedMonthly: number;
  /** Budget no debt needed when ONE settlement clears everything projected, else 0. */
  unusedPaymentCapacity: number;
  /** F4 — the first settlement at which some budget had no surplus target (only scheduled loans left). */
  idleSurplus: { fromISO: string; amount: number } | null;
  elapsed:       PayoffElapsed;
  /** Σ PROJECTED liabilities' startingPrincipal. */
  principal:     number;
  /** Σ interestPaid over KNOWN-rate projected liabilities. */
  totalInterest: number;
  /** F3 — "KNOWN_RATE_ONLY" whenever any owing debt has no rate on file or was not projected. */
  interestTotalScope: PayoffInterestTotalScope;
  /** Σ PROJECTED liabilities' totalPaid. */
  totalPaid:     number;
  /** Every OWING liability (projected or not), in input order. */
  liabilities:   LiabilityPayoff[];
  /** Every settlement, in order. */
  payments:      PayoffPayment[];
}

export type PayoffPlan =
  | PaidOffPlan
  | { status: "nothing_owed" }
  /** Payment ≤ 0, or a non-finite / negative input. */
  | { status: "invalid_input" }
  /** F4 — the budget is below the KNOWN required payments: no schedule, the gap named. */
  | (Classified & { status: "shortfall"; payment: number; requiredTotal: number; shortfall: number;
      required: { id: string; label: string; amount: number }[] })
  /** F4 — no owing debt could be projected (e.g. only a mortgage whose rate or split is unknown). */
  | (Classified & { status: "not_projectable"; liabilities: LiabilityPayoff[] })
  /** A full year of payments did not reduce the total owed. */
  | (Classified & { status: "non_amortizing"; payment: number; firstPeriodInterest: number })
  /** Amortizes, but not within `MAX_PAYOFF_PAYMENTS`. */
  | (Classified & { status: "beyond_horizon"; maxPayments: number });

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

interface Debt {
  idx: number; id: string; label: string; aprPct: number | null;
  kind: LiabilityKind; mortgage: boolean;
  requiredPayment: number | null;
  startingPrincipal: number;
  projection: LiabilityProjection; unknownReasons: PayoffUnknownReason[];
  /** Paid toward the balance each month before surplus (0 when unknown on a revolving debt). */
  required: number;
  /** Cash set aside each month that reduces no projected balance (escrow; an unprojected loan's payment). */
  reserve: number;
  surplusTarget: boolean; order: number | null;
  /** principalLeft + unpaidInterest = the modelled balance. */
  principalLeft: number; unpaidInterest: number;
  principalPaid: number; interestPaid: number;
  paymentCount: number; payoffISO: string | null; firstSettlementCleared: boolean;
}
const balanceOf = (s: Debt) => round2(s.principalLeft + s.unpaidInterest);
const validTerm = (n: number | null | undefined) => n == null || (Number.isFinite(n) && n >= 0);

const ASSUMPTION_TEXT: Record<PayoffAssumptionCode, string> = {
  REQUIRED_FIRST:                   "Every debt receives its required payment first (its minimum or scheduled installment).",
  SURPLUS_AVALANCHE:                "The rest of the budget goes to one debt at a time, highest known rate first (avalanche); when one is paid off, its payment rolls to the next.",
  SURPLUS_SNOWBALL:                 "The rest of the budget goes to one debt at a time, smallest balance first (snowball); when one is paid off, its payment rolls to the next.",
  INSTALLMENT_SCHEDULED_ONLY:       "Installment loans (mortgage, auto, student, personal) receive only their scheduled payment; extra goes to revolving debt.",
  INSTALLMENT_EXTRA_INCLUDED:       "Installment loans with known terms are included as targets for extra payments.",
  UNKNOWN_RATE_PRINCIPAL_ONLY:      "Debts with no rate on file are projected on principal only and left out of the interest total; no rate is assumed for them.",
  UNKNOWN_RATE_ORDERED_LAST:        "Debts with no rate on file are paid down after every debt with a known rate.",
  UNKNOWN_REQUIRED_NOT_RESERVED:    "Debts with no minimum payment on file have no minimum set aside; none is assumed.",
  INSTALLMENT_UNPROJECTED_RESERVED: "Loans missing a rate or payment terms have no projected payoff date; their known payment is still set aside from the budget each month.",
  MORTGAGE_ESCROW_NOT_PRINCIPAL:    "A mortgage payment may include escrow, so it is not counted as principal and interest unless that split is on file.",
  UNKNOWN_KIND_AS_REVOLVING:        "Debts whose type is not known are treated like revolving credit (eligible for extra payments).",
};

/** The payoff schedule for a set of liabilities and one monthly payment budget. */
export function planPayoff(input: PayoffInput): PayoffPlan {
  const { payment, startISO } = input;
  const strategy: PayoffStrategy = input.strategy ?? DEFAULT_PAYOFF_STRATEGY;
  const includeInstallmentExtra = input.includeInstallmentExtra === true;
  if (!Number.isFinite(payment) || !(payment > 0)) return { status: "invalid_input" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO) || Number.isNaN(utc(startISO))) return { status: "invalid_input" };
  if (!isPayoffStrategy(strategy)) return { status: "invalid_input" };

  const raw: readonly PayoffLiabilityInput[] =
    "liabilities" in input ? input.liabilities : [{ id: "liability", balance: input.balance, aprPct: input.aprPct }];
  for (const l of raw) {
    if (!Number.isFinite(l.balance)) return { status: "invalid_input" };
    if (l.aprPct !== null && (!Number.isFinite(l.aprPct) || l.aprPct < 0)) return { status: "invalid_input" };
    if (!validTerm(l.requiredPayment) || !validTerm(l.principalInterestPayment)) return { status: "invalid_input" };
  }

  // ── Classify every OWING liability (a credit or a settled card takes no part).
  const debts: Debt[] = raw
    .map((l, idx) => ({ l, idx, owed: round2(amountOwed(l.balance)) }))
    .filter((x) => x.owed > 0)
    .map(({ l, idx, owed }): Debt => {
      const kind = l.kind ? liabilityKind(l.kind) : "unknown";
      const mortgage = kind === "installment" && !!l.kind && isMortgage(l.kind);
      const requiredPayment = l.requiredPayment ?? null;
      const pi = l.principalInterestPayment ?? null;
      const unknownReasons: PayoffUnknownReason[] = [];
      let projection: LiabilityProjection;
      let required = 0;
      let reserve = 0;
      if (kind === "installment") {
        // The payment that AMORTISES the balance: P&I for a mortgage (the gross
        // may carry escrow), the scheduled installment for any other loan.
        const amortising = mortgage ? pi : requiredPayment;
        if (l.aprPct === null) unknownReasons.push("RATE_UNKNOWN");
        if (requiredPayment === null && (!mortgage || pi === null)) unknownReasons.push("REQUIRED_PAYMENT_UNKNOWN");
        if (mortgage && pi === null && requiredPayment !== null) unknownReasons.push("MORTGAGE_PAYMENT_SPLIT_UNKNOWN");
        if (unknownReasons.length === 0 && !(amortising !== null && amortising > 0)) unknownReasons.push("REQUIRED_PAYMENT_UNKNOWN");
        const gross = requiredPayment ?? pi ?? 0;
        if (unknownReasons.length > 0) {
          projection = "UNKNOWN";
          reserve = gross;                                   // known cash still leaves the budget
        } else {
          projection = "PROJECTED";
          required = amortising as number;
          reserve = Math.max(0, round2(gross - required));   // escrow: cash, not principal
        }
      } else {
        projection = l.aprPct === null ? "PRINCIPAL_ONLY_ESTIMATE" : "PROJECTED";
        required = requiredPayment ?? 0;                     // unknown minimum: none invented
      }
      return {
        idx, id: l.id, label: l.label ?? l.id, aprPct: l.aprPct, kind, mortgage, requiredPayment,
        startingPrincipal: owed, projection, unknownReasons, required, reserve,
        surplusTarget: projection !== "UNKNOWN" && (kind !== "installment" || includeInstallmentExtra),
        order: null,
        principalLeft: owed, unpaidInterest: 0, principalPaid: 0, interestPaid: 0,
        paymentCount: 0, payoffISO: null, firstSettlementCleared: false,
      };
    });
  if (debts.length === 0) return { status: "nothing_owed" };

  // ── The strategy's target order (fixed at the start; ties → smaller balance, then input order).
  const aprKey = (s: Debt) => (s.aprPct === null ? -1 : s.aprPct);
  const targets = debts.filter((s) => s.surplusTarget).sort((a, b) =>
    strategy === "avalanche"
      ? (aprKey(b) - aprKey(a)) || (a.startingPrincipal - b.startingPrincipal) || (a.idx - b.idx)
      : (a.startingPrincipal - b.startingPrincipal) || (aprKey(b) - aprKey(a)) || (a.idx - b.idx));
  targets.forEach((s, i) => { s.order = i + 1; });

  // ── Basis (rates), coverage (every term), assumptions (every rule that applied).
  const known   = debts.filter((s) => s.aprPct !== null);
  const unknown = debts.filter((s) => s.aprPct === null);
  const knownAprBalance   = round2(known.reduce((t, s) => t + s.startingPrincipal, 0));
  const unknownAprBalance = round2(unknown.reduce((t, s) => t + s.startingPrincipal, 0));
  const basis: PayoffBasis = {
    interest: unknown.length === 0 ? "INTEREST_AWARE" : known.length === 0 ? "PRINCIPAL_ONLY" : "PARTIAL_INTEREST",
    knownAprBalance, unknownAprBalance,
    unknownAprLiabilityIds: unknown.map((s) => s.id),
    unknownAprCount: unknown.length,
    owingCount: debts.length,
    avgKnownAprPct: knownAprBalance > 0
      ? known.reduce((t, s) => t + (s.aprPct as number) * s.startingPrincipal, 0) / knownAprBalance
      : null,
  };
  const unknownTerms = debts.map((s) => {
    const fields: PayoffUnknownField[] = [];
    if (s.aprPct === null) fields.push("rate");
    if (s.unknownReasons.includes("REQUIRED_PAYMENT_UNKNOWN") || (s.kind !== "installment" && s.requiredPayment === null)) fields.push("requiredPayment");
    if (s.unknownReasons.includes("MORTGAGE_PAYMENT_SPLIT_UNKNOWN")) fields.push("principalInterestSplit");
    return { id: s.id, label: s.label, fields };
  }).filter((u) => u.fields.length > 0);
  const unprojected = debts.filter((s) => s.projection === "UNKNOWN");
  const coverage: PayoffCoverage = {
    status: unknownTerms.length === 0 ? "COMPLETE" : unknownTerms.length === debts.length ? "NONE" : "PARTIAL",
    owingCount: debts.length,
    knownCount: debts.length - unknownTerms.length,
    unknown: unknownTerms,
    unprojected: unprojected.map((s) => ({ id: s.id, label: s.label, reasons: [...s.unknownReasons], reservedMonthly: s.reserve })),
  };
  const codes: PayoffAssumptionCode[] = ["REQUIRED_FIRST", strategy === "avalanche" ? "SURPLUS_AVALANCHE" : "SURPLUS_SNOWBALL"];
  if (debts.some((s) => s.kind === "installment")) codes.push(includeInstallmentExtra ? "INSTALLMENT_EXTRA_INCLUDED" : "INSTALLMENT_SCHEDULED_ONLY");
  if (debts.some((s) => s.projection === "PRINCIPAL_ONLY_ESTIMATE")) codes.push("UNKNOWN_RATE_PRINCIPAL_ONLY");
  if (strategy === "avalanche" && targets.some((s) => s.aprPct === null) && targets.some((s) => s.aprPct !== null)) codes.push("UNKNOWN_RATE_ORDERED_LAST");
  if (debts.some((s) => s.kind !== "installment" && s.requiredPayment === null) && debts.length > 1) codes.push("UNKNOWN_REQUIRED_NOT_RESERVED");
  if (unprojected.length > 0) codes.push("INSTALLMENT_UNPROJECTED_RESERVED");
  if (debts.some((s) => s.mortgage)) codes.push("MORTGAGE_ESCROW_NOT_PRINCIPAL");
  if (debts.some((s) => s.kind === "unknown") && debts.some((s) => s.kind !== "unknown")) codes.push("UNKNOWN_KIND_AS_REVOLVING");
  const classified: Classified = {
    basis, coverage, strategy, includeInstallmentExtra,
    assumptions: codes.map((code) => ({ code, text: ASSUMPTION_TEXT[code] })),
  };

  const summaries = (): LiabilityPayoff[] => debts.map((s) => ({
    id: s.id, label: s.label, startingPrincipal: s.startingPrincipal, aprPct: s.aprPct,
    kind: s.kind, isMortgage: s.mortgage, requiredPayment: s.requiredPayment,
    surplusTarget: s.surplusTarget, order: s.order,
    interestBasis: s.aprPct === null ? "NOT_MODELLED_UNKNOWN_APR" : "KNOWN_APR",
    rateStatus: s.aprPct === null ? "RATE_UNKNOWN" : "KNOWN",
    projection: s.projection, unknownReasons: [...s.unknownReasons],
    principalPaid: s.principalPaid, interestPaid: s.interestPaid,
    totalPaid: round2(s.principalPaid + s.interestPaid),
    remainingBalance: balanceOf(s), paymentCount: s.paymentCount,
    payoffISO: s.payoffISO, paidOffWithFirstPayment: s.firstSettlementCleared,
  }));

  // ── Shortfall: the budget must cover every KNOWN required payment.
  const requiredRows = debts
    .map((s) => ({ id: s.id, label: s.label,
      amount: round2(s.projection === "UNKNOWN" ? s.reserve : Math.min(s.required, s.startingPrincipal) + s.reserve) }))
    .filter((r) => r.amount > 0);
  const requiredTotal = round2(requiredRows.reduce((t, r) => t + r.amount, 0));
  if (payment + 1e-9 < requiredTotal) {
    return { ...classified, status: "shortfall", payment, requiredTotal, shortfall: round2(requiredTotal - payment), required: requiredRows };
  }

  const projected = debts.filter((s) => s.projection !== "UNKNOWN");
  if (projected.length === 0) return { ...classified, status: "not_projectable", liabilities: summaries() };

  const unprojectedReserve = round2(unprojected.reduce((t, s) => t + s.reserve, 0));

  /** THIS liability's interest over `days`, at ITS rate. Unknown ⇒ not modelled. */
  const interestOf = (s: Debt, days: number) => (s.aprPct === null ? 0 : accruedInterest(balanceOf(s), s.aprPct, days));
  const open = () => projected.filter((s) => s.payoffISO === null);
  const totalOwed = () => round2(open().reduce((t, s) => t + balanceOf(s), 0));

  /** Accrue `interest`, then apply the payment: accrued-unpaid interest first, then principal. */
  function settle(s: Debt, interest: number, toRequired: number, toExtra: number, dateISO: string, first: boolean, reason: PayoffAllocationReason): PayoffAllocation {
    const paid = round2(toRequired + toExtra);
    s.unpaidInterest = round2(s.unpaidInterest + interest);
    const toInterest  = round2(Math.min(paid, s.unpaidInterest));
    const toPrincipal = round2(Math.min(paid - toInterest, s.principalLeft));
    s.unpaidInterest = round2(s.unpaidInterest - toInterest);
    s.principalLeft  = round2(s.principalLeft - toPrincipal);
    s.interestPaid   = round2(s.interestPaid + toInterest);
    s.principalPaid  = round2(s.principalPaid + toPrincipal);
    if (paid > 0) s.paymentCount++;
    if (balanceOf(s) <= 0) { s.payoffISO = dateISO; s.firstSettlementCleared = first; }
    return { id: s.id, interest, paid: round2(toInterest + toPrincipal), toRequired, toExtra, toInterest, toPrincipal, balanceAfter: balanceOf(s), reason };
  }

  const payments: PayoffPayment[] = [];
  let firstPeriodInterest = 0;
  let yearAgoOwed = totalOwed();
  let prev = startISO;
  let idleSurplus: PaidOffPlan["idleSurplus"] = null;

  const finish = (k: number, payoffISO: string, d: number, D: number, finalPayment: number, available: number): PaidOffPlan => {
    const liabilities = summaries();
    const proj = liabilities.filter((l) => l.projection !== "UNKNOWN");
    const onBoundary = d === D;
    return {
      ...classified,
      status: "paid_off",
      cadence: PAYOFF_CADENCE,
      allocation: "REQUIRED_THEN_TARGETED",
      targetOrder: targets.map((s) => s.id),
      startISO,
      payoffISO,
      debtFreeISO: unprojected.length === 0 ? payoffISO : null,
      fullPayments: k,
      finalPayment,
      finalPaymentIsPartial: finalPayment < available - 0.005,
      finalPaymentDay: d,
      paymentCount: k + 1,
      paymentBudget: payment,
      requiredMonthly: requiredTotal,
      reservedMonthly: unprojectedReserve,
      unusedPaymentCapacity: k === 0 ? Math.max(0, round2(available - finalPayment)) : 0,
      idleSurplus,
      elapsed: elapsedOf(startISO, payoffISO, onBoundary ? k + 1 : k, onBoundary ? 0 : d),
      principal:     round2(proj.reduce((t, l) => t + l.startingPrincipal, 0)),
      totalInterest: round2(proj.filter((l) => l.rateStatus === "KNOWN").reduce((t, l) => t + l.interestPaid, 0)),
      interestTotalScope: unknown.length > 0 || unprojected.length > 0 ? "KNOWN_RATE_ONLY" : "ALL_DEBTS",
      totalPaid:     round2(proj.reduce((t, l) => t + l.totalPaid, 0)),
      liabilities,
      payments,
    };
  };

  for (let k = 0; k < MAX_PAYOFF_PAYMENTS; k++) {
    // Anniversaries are taken from the ANCHOR, not the previous date, so a
    // Jan-31 start does not drift to the 28th for the rest of the schedule.
    const next = addMonths(startISO, k + 1);
    const D = daysBetween(prev, next);
    const live = open();
    // Cash that reduces no projected balance: unprojected loans' payments, live escrow.
    const reserved = round2(unprojectedReserve + live.reduce((t, s) => t + s.reserve, 0));
    const available = round2(payment - reserved);

    // Can the accruing budget clear EVERYTHING still open inside this month?
    // Only when every open debt may take surplus — a scheduled loan is never paid early.
    if (live.every((s) => s.surplusTarget)) {
      for (let d = 1; available + 1e-9 >= totalOwed() && d <= D; d++) {
        const interests = live.map((s) => interestOf(s, d));
        const dues = live.map((s, i) => round2(balanceOf(s) + interests[i]));
        const due = round2(dues.reduce((t, x) => t + x, 0));
        if (available * (d / D) + 1e-9 < due) continue;

        const payoffISO = addDays(prev, d);
        const allocations = live.map((s, i) => {
          const req = round2(Math.min(s.required, dues[i]));
          return settle(s, interests[i], req, round2(dues[i] - req), payoffISO, k === 0, "FINAL_SETTLEMENT");
        });
        payments.push({ dateISO: payoffISO, days: d, paid: due, reserved, unallocated: 0, allocations });
        return finish(k, payoffISO, d, D, due, available);
      }
    }

    // A full month: every debt accrues at ITS rate, receives its required
    // payment, then the surplus goes to the targets in order (rolling over).
    const interests = live.map((s) => interestOf(s, D));
    const dues = live.map((s, i) => round2(balanceOf(s) + interests[i]));
    const req  = live.map((s, i) => round2(Math.min(s.required, dues[i])));
    let surplus = Math.max(0, round2(available - req.reduce((t, x) => t + x, 0)));
    const extra = live.map(() => 0);
    for (const t of targets) {
      if (surplus <= 0) break;
      const i = live.indexOf(t);
      if (i < 0) continue;
      const give = round2(Math.min(surplus, dues[i] - req[i]));
      if (give <= 0) continue;
      extra[i] = give;
      surplus = round2(surplus - give);
    }
    const allocations = live.map((s, i) =>
      settle(s, interests[i], req[i], extra[i], next, k === 0, extra[i] > 0 ? "SURPLUS_TARGET" : "REQUIRED_PAYMENT"));
    const paid = round2(allocations.reduce((t, a) => t + a.paid, 0));
    payments.push({ dateISO: next, days: D, paid, reserved, unallocated: surplus, allocations });
    if (k === 0) firstPeriodInterest = round2(interests.reduce((t, x) => t + x, 0));
    if (surplus > 0.005 && open().length > 0 && idleSurplus === null) idleSurplus = { fromISO: next, amount: surplus };
    prev = next;

    // A scheduled loan's last instalment (or a target) can clear the last open debt.
    if (open().length === 0) return finish(k, next, D, D, paid, available);

    // Every month length has been seen once a year has passed. If twelve
    // payments left the total no lower, no number of them will.
    if ((k + 1) % 12 === 0) {
      const owed = totalOwed();
      if (owed >= yearAgoOwed) return { ...classified, status: "non_amortizing", payment, firstPeriodInterest };
      yearAgoOwed = owed;
    }
  }

  return { ...classified, status: "beyond_horizon", maxPayments: MAX_PAYOFF_PAYMENTS };
}
