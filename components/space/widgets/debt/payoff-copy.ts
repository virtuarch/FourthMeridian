/**
 * components/space/widgets/debt/payoff-copy.ts
 *
 * The ONE wording of a payoff plan's horizon, shared by the planner and the
 * "pay a little more" strip so a status can never read two ways in one panel.
 *
 * Presentation only: every figure and every status comes from `planPayoff`
 * (lib/debt/payoff.ts). This module formats; it computes nothing.
 */

import { MAX_PAYOFF_PAYMENTS, type PayoffPlan } from "@/lib/debt/payoff";

export function payoffHorizonLabel(plan: PayoffPlan): string {
  switch (plan.status) {
    case "paid_off":       return plan.elapsed.label;
    case "unknown_apr":    return "APR needed";
    case "non_amortizing": return "Payment doesn't cover interest";
    case "beyond_horizon": return `Over ${Math.round(MAX_PAYOFF_PAYMENTS / 12)} years`;
    case "nothing_owed":   return "Nothing owed";
    case "invalid_input":  return "Enter a payment";
  }
}
