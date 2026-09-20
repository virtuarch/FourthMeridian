/**
 * components/space/widgets/debt/payoff-copy.ts
 *
 * The ONE wording of a payoff plan's horizon, shared by the planner and the
 * "pay a little more" strip so a status can never read two ways in one panel.
 *
 * Presentation only: every figure and every status comes from `planPayoff`
 * (lib/debt/payoff.ts). This module formats; it computes nothing.
 */

import { MAX_PAYOFF_PAYMENTS, type PayoffBasis, type PayoffPlan } from "@/lib/debt/payoff";

/** The basis of a plan that ran a schedule, or null for one that never did. */
export function payoffBasisOf(plan: PayoffPlan): PayoffBasis | null {
  return "basis" in plan ? plan.basis : null;
}

/**
 * The qualification an estimate must carry, or null for an interest-aware plan.
 * `headline` is the badge; `detail` says what was and was not counted.
 */
export function payoffEstimateNotice(plan: PayoffPlan): { headline: string; detail: string } | null {
  const basis = payoffBasisOf(plan);
  if (!basis || basis.interest === "INTEREST_AWARE") return null;
  return basis.interest === "PRINCIPAL_ONLY"
    ? { headline: "Estimated without interest", detail: "No APR is on file, so this counts payments against the balance only." }
    : { headline: "Estimated without some interest", detail: "Interest is counted only on the debts with an APR on file." };
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
 * planner, and the elapsed time stays in the detail line.
 */
export function payoffHeadline(plan: PayoffPlan): { caption: string; label: string } {
  return isSinglePaymentPayoff(plan)
    ? { caption: "Paid off with", label: "One payment" }
    : { caption: "Debt-free in", label: payoffHorizonLabel(plan) };
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
    case "beyond_horizon": return `Over ${Math.round(MAX_PAYOFF_PAYMENTS / 12)} years`;
    case "nothing_owed":   return "Nothing owed";
    case "invalid_input":  return "Enter a payment";
  }
}
