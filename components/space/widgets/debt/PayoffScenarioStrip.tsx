"use client";

/**
 * components/space/widgets/debt/PayoffScenarioStrip.tsx
 *
 * S4 — the extra-payment scenario strip that sits BENEATH the interactive
 * planner inside the same Payoff panel (plan §2, §3.3). Three honest presets —
 * minimums / +$100/mo / +$250/mo — each with its payoff horizon and interest
 * saved vs minimums, computed by buildPayoffScenarios over the SAME aggregate
 * ({total, monthlyRate, minPayment}) the planner derives (plan risk §5). The
 * planner IS the interactive extra-payment control; this strip is the at-a-glance
 * comparison the mockup's scenario bars imply — no avalanche/snowball engine.
 *
 * No minimums / nothing owed ⇒ buildPayoffScenarios returns [] and the strip
 * renders nothing (the planner's own disclaimers already cover it).
 */

import { formatCurrency } from "@/lib/currency";
import { useAggregateCurrency } from "@/components/space/widgets/display-money";
import type { ConversionContext } from "@/lib/money/types";
import { buildPayoffScenarios, type PayoffScenarioInput } from "./payoff-scenarios";

function horizonLabel(months: number | null): string {
  if (months == null) return "Won't cover interest";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${months} mo`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}m`;
}

export function PayoffScenarioStrip({
  input,
  ctx,
}: {
  input: PayoffScenarioInput;
  ctx?: ConversionContext;
}) {
  // REVIEW-3 B-5 — the display-currency AUTHORITY is the fallback, never a
  // build-time USD literal (display-money.ts). The formatter is INJECTED into
  // buildPayoffScenarios, which no longer owns a "$" default of its own.
  const aggregateCurrency = useAggregateCurrency(ctx);
  const fmtMoney = (v: number) => formatCurrency(v, aggregateCurrency);
  const rows = buildPayoffScenarios(input, { fmtMoney });
  if (rows.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-hairline)] space-y-1.5">
      <p className="text-[10px] uppercase tracking-widest text-[var(--text-faint)]">Pay a little more</p>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-[var(--text-secondary)] truncate">{r.label}</span>
          <span className="flex items-center gap-2 shrink-0 text-[11px] tabular-nums">
            <span className="text-[var(--text-muted)]">{horizonLabel(r.months)}</span>
            {r.interestSavedVsMin != null && r.interestSavedVsMin > 0 && (
              <span className="font-medium text-[var(--accent-positive)]">
                saves {fmtMoney(r.interestSavedVsMin)}
              </span>
            )}
          </span>
        </div>
      ))}
      <p className="text-[10px] text-[var(--text-faint)] pt-0.5">Interest saved vs paying minimums only.</p>
    </div>
  );
}
