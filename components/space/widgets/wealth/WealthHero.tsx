"use client";

/**
 * components/space/widgets/wealth/WealthHero.tsx
 *
 * Surface ① of the Wealth Perspective — the ONE place net worth is stated as a
 * number (single-instance doctrine): the headline, its change vs Compare To, an
 * inline confidence chip (Observed / Reconstructed / No history — tone straight
 * from the read model's completeness), then three secondary rows — Total Assets ·
 * Total Liabilities · Liquid Net Worth — as label · value · delta lines (NOT
 * cards, NO sparklines). The Liquid Net Worth row carries a "→ Liquidity"
 * affordance that switches the active lens while the shell's time context stays
 * fixed (P1). Honest states: an As Of before coverage shows "No history for this
 * date" (never zeros-as-facts); a missing comparison shows values without deltas.
 * Presentation only — every number comes from the WealthResult.
 */

import { ArrowUpRight } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import { WealthCard, WealthUnavailable, DeltaBadge } from "./wealth-ui";

type SecondaryKey = "totalAssets" | "totalLiabilities" | "liquidNetWorth";

const SECONDARY: { key: SecondaryKey; label: string; good: "up" | "down" }[] = [
  { key: "totalAssets",      label: "Total Assets",      good: "up" },
  { key: "totalLiabilities", label: "Total Liabilities", good: "down" },
  { key: "liquidNetWorth",   label: "Liquid Net Worth",  good: "up" },
];

function toneColor(tone: "neutral" | "positive" | "warning"): string {
  return tone === "positive"
    ? "var(--accent-positive)"
    : tone === "warning"
      ? "var(--accent-warning)"
      : "var(--text-secondary)";
}

export function WealthHero({
  result,
  currency,
  onSwitchLens,
}: {
  result:        WealthResult;
  currency:      string;
  /** Switch the active perspective (shell time context stays fixed — P1). */
  onSwitchLens?: (lensId: string) => void;
}) {
  const { asOfState, deltas, compareState, completeness } = result;
  const compareLabel =
    compareState?.found && compareState.date ? formatWealthDate(compareState.date) : undefined;
  const asOfLabel = asOfState.date ? `As of ${formatWealthDate(asOfState.date)}` : undefined;

  const confidenceChip = (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border"
      style={{
        color: toneColor(completeness.tone),
        borderColor: "var(--border-hairline)",
        background: "var(--surface-inset)",
      }}
      title="Data confidence for this date"
    >
      {completeness.label}
    </span>
  );

  if (!asOfState.found) {
    return (
      <WealthCard title="Net worth" subtitle={asOfLabel} right={confidenceChip}>
        <WealthUnavailable message="No history for this date. Pick a later As Of, or connect accounts to build history." />
      </WealthCard>
    );
  }

  return (
    <WealthCard title="Net worth" subtitle={asOfLabel} right={confidenceChip}>
      {/* The single net-worth headline. */}
      <div className="space-y-1">
        <div className="text-3xl sm:text-4xl font-semibold tabular-nums text-[var(--text-primary)] leading-none">
          {formatCurrency(asOfState.netWorth, currency)}
        </div>
        {deltas ? (
          <DeltaBadge
            abs={deltas.netWorth.abs}
            pct={deltas.netWorth.pct}
            currency={currency}
            goodDirection="up"
            compareLabel={compareLabel}
            className="!text-xs"
          />
        ) : (
          <span className="text-[11px] text-[var(--text-faint)]">
            Add a Compare To date above to see the change.
          </span>
        )}
      </div>

      {/* Secondary rows — label (+ Liquidity link) left, value over delta right.
          Stacking the value/delta keeps every row legible even in the hero's
          narrow 4-column desktop slot (no truncated labels, no overlap). */}
      <div className="mt-4 divide-y" style={{ borderColor: "var(--border-hairline)" }}>
        {SECONDARY.map(({ key, label, good }) => {
          const value = asOfState[key];
          const d = deltas ? deltas[key] : null;
          const isLiquid = key === "liquidNetWorth";
          return (
            <div key={key} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-[var(--text-secondary)] truncate">{label}</div>
                {isLiquid && onSwitchLens && (
                  <button
                    type="button"
                    onClick={() => onSwitchLens("liquidity")}
                    className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-[var(--accent-info)] hover:underline"
                    title="Open the Liquidity perspective (keeps this date)"
                  >
                    Liquidity <ArrowUpRight size={11} aria-hidden />
                  </button>
                )}
              </div>
              <div className="flex flex-col items-end shrink-0">
                <span className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatCurrency(value, currency)}
                </span>
                {d && <DeltaBadge abs={d.abs} pct={d.pct} currency={currency} goodDirection={good} />}
              </div>
            </div>
          );
        })}
      </div>
    </WealthCard>
  );
}
