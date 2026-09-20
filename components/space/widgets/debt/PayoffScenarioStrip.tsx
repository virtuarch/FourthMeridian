"use client";

/**
 * components/space/widgets/debt/PayoffScenarioStrip.tsx
 *
 * The "pay a little more" strip rendered BY the interactive planner, beneath its
 * result, over the planner's own {total, aprPct, payment}. Three presets —
 * +50 / +100 / +250 a month over the payment the user chose — each with its
 * precise payoff horizon and the interest saved against that chosen payment,
 * computed by buildPayoffScenarios over the same `planPayoff` engine.
 *
 * Unknown APR / nothing owed ⇒ buildPayoffScenarios returns [] and the strip
 * renders nothing (the planner already says why there is no timeline).
 */

import { formatCurrency } from "@/lib/currency";
import { buildPayoffScenarios, type PayoffScenarioInput } from "./payoff-scenarios";
import { payoffHorizonLabel } from "./payoff-copy";

export function PayoffScenarioStrip({
  input,
  currency,
}: {
  input: PayoffScenarioInput;
  /** The planner's display currency — the strip never resolves its own. */
  currency: string;
}) {
  const fmtMoney = (v: number) => formatCurrency(v, currency);
  const rows = buildPayoffScenarios(input, { fmtMoney });
  if (rows.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-hairline)] space-y-1.5">
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Pay a little more</p>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-[var(--text-secondary)] truncate">{r.label}</span>
          <span className="flex items-center gap-2 shrink-0 text-[11px] tabular-nums">
            <span className="text-[var(--text-muted)]">{payoffHorizonLabel(r.plan)}</span>
            {r.interestSavedVsChosen != null && r.interestSavedVsChosen > 0 && (
              <span className="font-medium text-[var(--accent-positive)]">
                saves {fmtMoney(r.interestSavedVsChosen)}
              </span>
            )}
          </span>
        </div>
      ))}
      <p className="text-[10px] text-[var(--text-faint)] pt-0.5">Interest saved vs the payment you chose.</p>
    </div>
  );
}
