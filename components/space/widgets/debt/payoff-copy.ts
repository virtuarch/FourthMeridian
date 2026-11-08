/**
 * components/space/widgets/debt/payoff-copy.ts
 *
 * The ONE wording of a payoff plan — its horizon, its headline, and the notices
 * that qualify it — so a status can never read two ways in one panel.
 *
 * Presentation only: every figure and every status comes from `planPayoff`
 * (lib/debt/payoff.ts). This module formats; it computes nothing.
 */

import { MAX_PAYOFF_PAYMENTS, type PayoffBasis, type PayoffPlan, type PayoffStrategy, type PayoffUnknownReason, type PayoffUnknownField } from "@/lib/debt/payoff";
import { formatOwedShare } from "@/lib/debt/aggregates";

/** The basis of a plan that ran a schedule, or null for one that never did. */
export function payoffBasisOf(plan: PayoffPlan): PayoffBasis | null {
  return "basis" in plan ? plan.basis : null;
}

/**
 * The qualification an estimate must carry, or null for an interest-aware plan.
 * `headline` is the badge; `detail` says what was and was not counted.
 */
export function payoffEstimateNotice(
  plan: PayoffPlan,
  /** Mortgage F3 — "APR" only when every debt in the plan is revolving credit
   *  (lib/debt/rate-label.ts blendedRateLabel); otherwise the neutral "rate". */
  rateWord: "APR" | "rate" = "APR",
): { headline: string; detail: string } | null {
  const basis = payoffBasisOf(plan);
  if (!basis || basis.interest === "INTEREST_AWARE") return null;
  return basis.interest === "PRINCIPAL_ONLY"
    ? { headline: "Estimated without interest", detail: `No ${rateWord} is on file, so this counts payments against the balance only.` }
    : { headline: "Estimated without some interest", detail: `Interest is counted only on the debts with ${rateWord === "APR" ? "an APR" : "a rate"} on file.` };
}

/**
 * Mortgage F3 (S2 ruling, item 3) — the payoff never assumes 0% SILENTLY: the
 * rate-unknown note, stating how many debts AND what SHARE of the balance the
 * known rates cover (S2), from the engine's own counts and balances. Null when
 * every owing debt has a rate on file.
 */
export function payoffUnknownRateNote(plan: PayoffPlan): string | null {
  const basis = payoffBasisOf(plan);
  if (!basis || basis.unknownAprCount === 0) return null;
  const { unknownAprCount: u, owingCount: n, knownAprBalance: k, unknownAprBalance: x } = basis;
  const share = k + x > 0 ? k / (k + x) : 0;
  return `Rate known for ${n - u} of ${n} debt${n === 1 ? "" : "s"} (${formatOwedShare(share)} of what you owe) — `
    + `no rate is assumed for the others, and they are left out of the interest total.`;
}

/** The one call to action — it points at the Interest cost widget, never at a second APR input. */
export const ADD_APR_PROMPT = "Add APR for a more accurate payoff estimate";

/** True when the engine's FIRST payment extinguishes the debt (its `paymentCount`). */
export function isSinglePaymentPayoff(plan: PayoffPlan): boolean {
  return plan.status === "paid_off" && plan.paymentCount === 1;
}

/**
 * The planner's two-line headline. A debt cleared by its first payment reads
 * "Paid off with / One payment" — a duration of "2 weeks, 5 days" answers a
 * question nobody asked. The payment DATE is still shown beside it by the
 * planner.
 */
export function payoffHeadline(plan: PayoffPlan): { caption: string; label: string } {
  if (isSinglePaymentPayoff(plan)) return { caption: "Paid off with", label: "One payment" };
  // F4 — a plan with an unprojected loan never claims a debt-free date.
  if (plan.status === "paid_off" && plan.debtFreeISO === null) return { caption: "Projected debts paid off in", label: payoffHorizonLabel(plan) };
  return { caption: "Debt-free in", label: payoffHorizonLabel(plan) };
}

// ── Mortgage F4 — the strategy, the unknowns, the shortfall ──────────────────

/** The strategy's name as a user reads it. */
export const PAYOFF_STRATEGY_LABEL: Record<PayoffStrategy, string> = {
  avalanche: "Highest rate first",
  snowball:  "Smallest balance first",
};

/** One line saying how the budget is allocated (null when no plan classified the debts). */
export function payoffStrategyLine(plan: PayoffPlan): string | null {
  if (!("strategy" in plan)) return null;
  const order = plan.strategy === "avalanche" ? "the highest known rate first" : "the smallest balance first";
  const loans = plan.includeInstallmentExtra
    ? " Installment loans with known terms can receive extra too."
    : " Installment loans (mortgage, auto, student) get only their scheduled payment.";
  return `Each debt gets its required payment first; the rest goes to one debt at a time, ${order}, and rolls to the next when it is paid off.${loans}`;
}

const REASON_WORDS: Record<PayoffUnknownReason, string> = {
  RATE_UNKNOWN:                   "rate unknown",
  REQUIRED_PAYMENT_UNKNOWN:       "scheduled payment unknown",
  MORTGAGE_PAYMENT_SPLIT_UNKNOWN: "principal and interest split of the payment unknown (it may include escrow)",
};
const FIELD_WORDS: Record<PayoffUnknownField, string> = {
  rate:                   "rate",
  requiredPayment:        "required payment",
  principalInterestSplit: "principal/interest split",
};

/** "Mortgage: payoff date unknown — rate unknown; …" per unprojected loan. */
export function payoffUnprojectedLines(plan: PayoffPlan): string[] {
  if (!("coverage" in plan)) return [];
  return plan.coverage.unprojected.map((u) => `${u.label}: payoff date unknown — ${u.reasons.map((r) => REASON_WORDS[r]).join("; ")}.`);
}

/** "Not on file: Card A (required payment), Mortgage (rate, principal/interest split)." Null when complete. */
export function payoffCoverageNote(plan: PayoffPlan): string | null {
  if (!("coverage" in plan) || plan.coverage.unknown.length === 0) return null;
  return `Not on file: ${plan.coverage.unknown.map((u) => `${u.label} (${u.fields.map((f) => FIELD_WORDS[f]).join(", ")})`).join("; ")}.`;
}

/** The shortfall, stated with the engine's figures. Null unless the plan is a shortfall. */
export function payoffShortfallLine(plan: PayoffPlan, fmtMoney: (n: number) => string): string | null {
  if (plan.status !== "shortfall") return null;
  return `${fmtMoney(plan.payment)} a month is ${fmtMoney(plan.shortfall)} short of the ${fmtMoney(plan.requiredTotal)} in required payments, `
    + `so no payoff plan is shown. Required: ${plan.required.map((r) => `${r.label} ${fmtMoney(r.amount)}`).join(", ")}.`;
}

/**
 * The notice for a budget larger than the debt needs — INFORMATION, not an
 * error: the user may enter any amount; the debt simply requires less.
 *
 * Every figure is the engine's (`totalPaid`, `unusedPaymentCapacity`); this
 * formats them. Under an incomplete interest basis the requirement is an
 * estimate, so it is worded as one — never as a creditor's payoff quote.
 * Null when nothing is spare (including an exact payment).
 */
export function payoffOverBudgetNotice(
  plan: PayoffPlan,
  fmtMoney: (n: number) => string,
): { headline: string; required: string; unused: string } | null {
  if (plan.status !== "paid_off" || !(plan.unusedPaymentCapacity >= 0.01)) return null;
  const estimate = plan.basis.interest !== "INTEREST_AWARE";
  return estimate
    ? {
        headline: "Your payment amount is likely more than this debt needs.",
        required: `Based on the interest currently known, about ${fmtMoney(plan.totalPaid)} would be needed.`,
        unused:   `About ${fmtMoney(plan.unusedPaymentCapacity)} of this payment would not be needed.`,
      }
    : {
        headline: "Your payment amount is more than this debt needs.",
        required: `Payoff amount: ${fmtMoney(plan.totalPaid)}.`,
        unused:   `${fmtMoney(plan.unusedPaymentCapacity)} of this payment would not be needed.`,
      };
}

export function payoffHorizonLabel(plan: PayoffPlan): string {
  switch (plan.status) {
    // An estimate does not claim a schedule's precision: "About …" whenever any
    // part of the balance was carried without a known rate (plan.basis).
    case "paid_off":
      if (plan.paymentCount === 1) return "One payment";
      return plan.basis.interest === "INTEREST_AWARE" ? plan.elapsed.label : `About ${plan.elapsed.label}`;
    case "non_amortizing": return "Payment doesn't cover interest";
    case "shortfall":      return "Below required payments";
    case "not_projectable": return "Payoff date unknown";
    case "beyond_horizon": return `Over ${Math.round(MAX_PAYOFF_PAYMENTS / 12)} years`;
    case "nothing_owed":   return "Nothing owed";
    case "invalid_input":  return "Enter a payment";
  }
}
