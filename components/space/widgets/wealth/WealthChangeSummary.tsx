"use client";

/**
 * components/space/widgets/wealth/WealthChangeSummary.tsx
 *
 * The single "What changed?" surface — a consolidation of the former
 * how-wealthy / drivers / story cards into one stronger Then-vs-Now card
 * (fewer, denser cards; no redundant net-worth restatement — the KPI strip
 * already leads with it). Deterministic and template-driven: every number is a
 * real snapshot component delta. Finer attribution (contributions vs. market
 * growth) is stated as unavailable, never estimated.
 */

import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import type { WealthResult, WealthDriver } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable, DeltaBadge, formatSigned } from "./wealth-ui";

const ATTRIBUTION_NOTE =
  "Detailed attribution (contributions vs. market growth) isn't available for this period yet.";

function driverGood(d: WealthDriver): boolean {
  return d.id === "liabilities" ? d.delta < 0 : d.delta > 0;
}

export function WealthChangeSummary({
  result,
  currency,
}: {
  result:   WealthResult;
  currency: string;
}) {
  const { deltas, drivers, story, compareState } = result;
  const compareLabel = compareState?.date ? formatWealthDate(compareState.date) : undefined;

  if (!deltas) {
    return (
      <WealthCard title="What changed?">
        <WealthUnavailable message="Add a Compare To date above to see how your wealth changed." />
      </WealthCard>
    );
  }

  return (
    <WealthCard
      title="What changed?"
      subtitle={compareLabel ? `Then vs Now · since ${compareLabel}` : undefined}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        {/* Left — the headline change + the plain-language story. */}
        <div className="space-y-2 min-w-0">
          <DeltaBadge
            abs={deltas.netWorth.abs}
            pct={deltas.netWorth.pct}
            currency={currency}
            goodDirection="up"
            className="!text-sm"
          />
          {story && (
            <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{story}</p>
          )}
          <p className="text-[11px] text-[var(--text-faint)] leading-relaxed">{ATTRIBUTION_NOTE}</p>
        </div>

        {/* Right — the biggest supported drivers (real component deltas). */}
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-[var(--text-faint)] mb-1">Biggest movers</p>
          {drivers && drivers.length > 0 ? (
            <div className="divide-y" style={{ borderColor: "var(--border-hairline)" }}>
              {drivers.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 py-1.5">
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
          ) : (
            <p className="text-xs text-[var(--text-faint)] py-1.5">Net worth was essentially flat.</p>
          )}
        </div>
      </div>
    </WealthCard>
  );
}
