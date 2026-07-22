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

import { formatCurrency } from "@/lib/format";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import type { WealthMetricKey } from "./WealthTrendChart";
import { WealthUnavailable, DeltaBadge } from "./wealth-ui";

/** Hero eyebrow label per metric — mirrors the chart's metric switcher so the
 *  headline reads as whatever series the user selected in Balance history. */
const METRIC_LABEL: Record<WealthMetricKey, string> = {
  netWorth:         "Net worth",
  totalAssets:      "Total assets",
  totalLiabilities: "Total liabilities",
  liquidNetWorth:   "Liquid net worth",
};

export function WealthHero({
  result,
  currency,
  envelope,
  metric = "netWorth",
}: {
  result:   WealthResult;
  currency: string;
  /** The workspace's canonical trust envelope — drives the confidence chip. */
  envelope: PerspectiveEnvelope;
  /** The chart's selected series — the hero reflects the SAME metric so the
   *  headline changes to Assets / Liabilities / Liquid NW when the user does. */
  metric?:  WealthMetricKey;
}) {
  const { asOfState, deltas, compareState } = result;
  const compareLabel =
    compareState?.found && compareState.date ? formatWealthDate(compareState.date) : undefined;
  const asOfLabel = asOfState.date ? `As of ${formatWealthDate(asOfState.date)}` : undefined;

  // Rising liabilities are BAD; every other metric is good when it rises.
  const goodDirection: "up" | "down" = metric === "totalLiabilities" ? "down" : "up";

  // The confidence chip is now the shared trust primitive, reading the SAME
  // envelope the shell Completeness chip does — they can never disagree.
  const confidenceChip = <TrustIndicator variant="compact" envelope={envelope} />;

  // Eyebrow + confidence — the quiet label above the figure (prototype hero).
  const eyebrow = (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{METRIC_LABEL[metric]}</p>
      {confidenceChip}
    </div>
  );

  if (!asOfState.found) {
    return (
      <section>
        {eyebrow}
        <WealthUnavailable message="No history for this date. Pick a later As Of, or connect accounts to build history." />
      </section>
    );
  }

  return (
    // The hero — no card, no border. The most important figure doesn't need a
    // container to be found (prototype: solid surfaces are for the rows below).
    <section>
      {eyebrow}

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <Figure value={formatCurrency(asOfState[metric], currency)} size="hero" className="sm:text-5xl leading-none" />
        {deltas ? (
          <DeltaBadge
            abs={deltas[metric].abs}
            pct={deltas[metric].pct}
            currency={currency}
            goodDirection={goodDirection}
            compareLabel={compareLabel}
            className="!text-xs"
          />
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">Add a Compare To date above to see the change.</span>
        )}
      </div>
      {asOfLabel && <p className="mt-2.5 text-sm text-[var(--text-secondary)]">{asOfLabel}</p>}
    </section>
  );
}
