/**
 * components/space/widgets/debt/payoff-scenarios.ts
 *
 * Pure "pay a little more" presets for the Payoff Strategy panel. Each row is
 * the SAME `planPayoff` schedule the interactive planner runs (lib/debt/payoff.ts),
 * over the SAME inputs the planner holds — {total, aprPct, payment} — so the
 * strip can never disagree with the planner above it.
 *
 * The baseline is the payment THE USER CHOSE, not a minimum payment: this
 * experience no longer reads minimums. Three presets — +50, +100, +250 a month
 * over the chosen payment — each with its precise payoff horizon and the
 * interest it saves against the chosen payment.
 *
 * No avalanche/snowball sequencing: one aggregate balance at the blended rate,
 * exactly the planner's model.
 *
 * Unknown APR does not remove the rows: each is the engine's ESTIMATE, carrying
 * the same `plan.basis` the planner's own result carries, so the strip qualifies
 * itself from structure. "Interest saved" is null when NO interest was modelled
 * (PRINCIPAL_ONLY) — there is nothing to have saved — and under PARTIAL_INTEREST
 * it is the saving on the known-APR part only, which `basis` lets the strip say.
 *
 * Pure and deterministic: the start date and the money formatter are injected.
 */

import { planPayoff, type PayoffPlan } from "@/lib/debt/payoff";

export interface PayoffScenarioInput {
  /** Aggregate converted amount owed (the planner's `total`). */
  total: number;
  /** Blended APR percent over the part of `total` with a rate on file; null = none of it. */
  aprPct: number | null;
  /** The part of `total` with NO APR on file (the planner's `unknownAprBalance`). */
  unknownAprBalance?: number;
  /** The monthly payment the user has chosen in the planner. */
  payment: number;
  /** YYYY-MM-DD the schedules start from. */
  startISO: string;
}

export interface PayoffScenarioRow {
  id: `plus-${number}`;
  /** Display label, e.g. "+$100/mo" (money via the injected formatter). */
  label: string;
  /** Extra monthly payment above the chosen payment. */
  extra: number;
  /** Total monthly payment for this scenario (payment + extra). */
  payment: number;
  /** The engine's plan for this payment — the row's single source of truth. */
  plan: PayoffPlan;
  /** Interest saved vs the chosen payment; null when either side has no schedule. */
  interestSavedVsChosen: number | null;
}

export const PAYOFF_SCENARIO_EXTRAS = [50, 100, 250] as const;

export function buildPayoffScenarios(
  input: PayoffScenarioInput,
  opts?: { fmtMoney?: (n: number) => string },
): PayoffScenarioRow[] {
  const { total, aprPct, unknownAprBalance, payment, startISO } = input;
  if (!(total > 0) || !(payment > 0)) return [];

  // REVIEW-3 B-5 — this pure helper owns NO currency. Without an injected
  // formatter the label states the magnitude with no currency claim.
  const fmt = opts?.fmtMoney ?? ((n: number) => `${Math.round(n)}`);

  const base = planPayoff({ balance: total, aprPct, unknownAprBalance, payment, startISO });
  // No interest modelled at all ⇒ no "saved" figure to report (not a saving of 0).
  const baseInterest =
    base.status === "paid_off" && base.basis.interest !== "PRINCIPAL_ONLY" ? base.totalInterest : null;

  return PAYOFF_SCENARIO_EXTRAS.map((extra): PayoffScenarioRow => {
    const plan = planPayoff({ balance: total, aprPct, unknownAprBalance, payment: payment + extra, startISO });
    return {
      id: `plus-${extra}`,
      label: `+${fmt(extra)}/mo`,
      extra,
      payment: payment + extra,
      plan,
      interestSavedVsChosen:
        baseInterest == null || plan.status !== "paid_off"
          ? null
          : Math.max(0, Math.round((baseInterest - plan.totalInterest) * 100) / 100),
    };
  });
}
