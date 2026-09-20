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

export function payoffHorizonLabel(plan: PayoffPlan): string {
  switch (plan.status) {
    // An estimate does not claim a schedule's precision: "About …" whenever any
    // part of the balance was carried without a known rate (plan.basis).
    case "paid_off":
      return plan.basis.interest === "INTEREST_AWARE" ? plan.elapsed.label : `About ${plan.elapsed.label}`;
    case "non_amortizing": return "Payment doesn't cover interest";
    case "beyond_horizon": return `Over ${Math.round(MAX_PAYOFF_PAYMENTS / 12)} years`;
    case "nothing_owed":   return "Nothing owed";
    case "invalid_input":  return "Enter a payment";
  }
}
