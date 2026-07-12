/**
 * components/space/widgets/debt/payoff-scenarios.ts
 *
 * S4 — pure preset payoff scenarios for the Debt Perspective (plan §2, §3.2).
 * Reuses the SAME exported `simulatePayoff` the interactive planner runs
 * (DebtPayoffSection.tsx:80) over the SAME aggregate inputs the planner derives
 * ({total, monthlyRate, minPayment}) — computed once by the composition and
 * passed to both, so the strip can never disagree with the planner inside one
 * panel (plan risk §5, "Scenario-strip math drift").
 *
 * Three honest presets — minimums-only, +$100/mo, +$250/mo — each with its
 * payoff horizon, payoff date, projected interest, and interest saved vs the
 * minimums baseline. No amortization engine, no avalanche/snowball sequencing
 * (refused, §1.2): one aggregate balance at the blended rate, exactly the
 * planner's model.
 *
 * Pure and deterministic: the clock and the money formatter are injected, so no
 * `new Date()` / currency assumptions leak into the math (tests pin both).
 */

import { simulatePayoff } from "@/components/space/sections/DebtPayoffSection";
import { formatMonthYear } from "@/lib/format";

export interface PayoffScenarioInput {
  /** Aggregate converted debt balance (the planner's `total`). */
  total: number;
  /** Blended monthly rate: weightedApr/100/12; 0 when no rates are known. */
  monthlyRate: number;
  /** Aggregate converted minimum payment (the planner's `minPayment`). */
  minPayment: number;
}

export interface PayoffScenarioRow {
  id: "min" | `plus-${number}`;
  /** Display label, e.g. "Minimums" / "+$100/mo" (money via the injected formatter). */
  label: string;
  /** Extra monthly payment above the minimum (0 for the baseline). */
  extra: number;
  /** Total monthly payment for this scenario (minPayment + extra). */
  payment: number;
  /** Months to payoff, or null when the payment cannot cover interest (honest row). */
  months: number | null;
  /** Estimated payoff month/year, or null when not payable. */
  payoffDate: string | null;
  /** Projected total interest, or null with no known rate / not payable. */
  totalInterest: number | null;
  /** Interest saved vs the minimums baseline; null on the baseline row / when unknowable. */
  interestSavedVsMin: number | null;
}

/** The mockup's three presets (plan §2): minimums, +$100/mo, +$250/mo. */
const EXTRAS = [0, 100, 250] as const;

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000; // the planner's month approximation

export function buildPayoffScenarios(
  input: PayoffScenarioInput,
  opts?: { now?: () => Date; fmtMoney?: (n: number) => string },
): PayoffScenarioRow[] {
  const { total, monthlyRate, minPayment } = input;
  // No minimums / nothing owed ⇒ no honest baseline; the strip is absent and the
  // planner's own disclaimers already cover it (plan §3.2).
  if (!(minPayment > 0) || !(total > 0)) return [];

  const now = opts?.now ?? (() => new Date());
  const fmt = opts?.fmtMoney ?? ((n: number) => `$${Math.round(n)}`);
  const hasRate = monthlyRate > 0;

  // The minimums-only baseline every "interest saved" figure is measured against.
  const base = simulatePayoff(total, monthlyRate, minPayment);
  const baseInterest = base && hasRate ? base.totalInterest : null;

  return EXTRAS.map((extra): PayoffScenarioRow => {
    const payment = minPayment + extra;
    const r = simulatePayoff(total, monthlyRate, payment);
    const months = r?.months ?? null;
    const totalInterest = r && hasRate ? r.totalInterest : null;
    const payoffDate = months != null
      ? formatMonthYear(new Date(now().getTime() + months * MS_PER_MONTH).toISOString())
      : null;
    const interestSavedVsMin =
      extra === 0 || baseInterest == null || totalInterest == null
        ? null
        : Math.max(0, baseInterest - totalInterest);
    return {
      id: extra === 0 ? "min" : `plus-${extra}`,
      label: extra === 0 ? "Minimums" : `+${fmt(extra)}/mo`,
      extra,
      payment,
      months,
      payoffDate,
      totalInterest,
      interestSavedVsMin,
    };
  });
}
