"use client";

/**
 * components/space/widgets/wealth/WealthChangeLedger.tsx
 *
 * Surface ③ of the Wealth Perspective — "Where did the change come from?" One
 * row per composition component that actually moved (the read model's
 * epsilon-filtered, |Δ|-sorted drivers), colored by whether the move was good
 * (liabilities DOWN is good), closing with a hairline-separated Net Change total
 * that equals deltas.netWorth. Exactly ONE forward-phrased attribution note — the
 * rows stay generic {id,label,delta} so historical valuation (A9) can swap the
 * source (market growth vs. contributions) without a redesign; we NEVER label a
 * row Market Growth / Contributions / Income / Spending / Fees today. Honest
 * states: no comparison ⇒ the add-a-date prompt; a flat period ⇒ the flat note.
 * Presentation only — every number comes from the WealthResult.
 */

import type { WealthResult, WealthDriver } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable, formatSigned } from "./wealth-ui";

/**
 * The single forward-phrased attribution note (A9 slot contract). Deliberately
 * free of the reserved source labels — asserting that in the colocated test locks
 * the honesty rule.
 */
export const ATTRIBUTION_NOTE =
  "Attribution by market growth vs. contributions arrives with historical valuation.";

/** A move is "good" when net worth rose from it — liabilities are good going DOWN. */
export function driverGood(d: WealthDriver): boolean {
  return d.id === "liabilities" ? d.delta < 0 : d.delta > 0;
}

export function WealthChangeLedger({
  result,
  currency,
}: {
  result:   WealthResult;
  currency: string;
}) {
  const { deltas, drivers, compareState } = result;
  const compareLabel =
    compareState?.found && compareState.date ? formatWealthDate(compareState.date) : undefined;

  if (!deltas) {
    return (
      <WealthCard title="Where did the change come from?">
        <WealthUnavailable message="Add a Compare To date above to break down how your wealth changed." />
      </WealthCard>
    );
  }

  const rows = drivers ?? [];

  return (
    <WealthCard
      title="Where did the change come from?"
      subtitle={compareLabel ? `Since ${compareLabel}` : undefined}
    >
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--text-faint)] py-1.5">
          Net worth was essentially flat over this period.
        </p>
      ) : (
        <div>
          <div className="divide-y" style={{ borderColor: "var(--border-hairline)" }}>
            {rows.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-xs text-[var(--text-secondary)] truncate">{d.label}</span>
                <span
                  className="text-xs font-semibold tabular-nums shrink-0"
                  style={{ color: driverGood(d) ? "var(--accent-positive)" : "var(--accent-negative)" }}
                >
                  {formatSigned(d.delta, currency)}
                </span>
              </div>
            ))}
          </div>
          {/* Net Change — the authoritative total (hairline-separated). */}
          <div
            className="flex items-center justify-between gap-3 pt-2 mt-1 border-t"
            style={{ borderColor: "var(--border-hairline-strong)" }}
          >
            <span className="text-xs font-semibold text-[var(--text-primary)]">Net Change</span>
            <span
              className="text-sm font-semibold tabular-nums shrink-0"
              style={{ color: deltas.netWorth.abs >= 0 ? "var(--accent-positive)" : "var(--accent-negative)" }}
            >
              {formatSigned(deltas.netWorth.abs, currency)}
            </span>
          </div>
        </div>
      )}
      <p className="mt-3 text-[11px] text-[var(--text-faint)] leading-relaxed">{ATTRIBUTION_NOTE}</p>
    </WealthCard>
  );
}
