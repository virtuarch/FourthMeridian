"use client";

/**
 * components/space/widgets/wealth/WealthHero.tsx
 *
 * Surface ① of the Wealth Perspective — the ONE place the page's subject is
 * stated as a number (single-instance doctrine): the headline, its change vs
 * Compare To, an inline confidence chip (Observed / Reconstructed / No history —
 * tone straight from the read model's completeness), then a quiet secondary
 * stat line (NOT cards, NO sparklines):
 *
 *   Total  (netWorth)  → Assets · Liabilities · Liquid NW
 *   Assets (any slice) → Cash · Investments
 *
 * OVERVIEW-CONSOLIDATION — Liquid Net Worth is no longer a page; it survives
 * here as the derived stat it always was (netLiquid, read off the same
 * snapshot). Cash and Investments are the two disjoint dimensions of Total
 * Assets (cash + invested ≤ totalAssets; the remainder is real-world assets).
 * Honest states: an As Of before coverage shows "No history for this date"
 * (never zeros-as-facts); a missing comparison shows values without deltas.
 * Presentation only — every number comes from the WealthResult.
 */

import type { ReactNode } from "react";
import { formatCurrency } from "@/lib/currency";
import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import { formatWealthDate } from "@/lib/wealth/wealth-time-machine";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import type { WealthMetricKey } from "@/lib/wealth/wealth-mode";
import { WealthUnavailable, DeltaBadge } from "./wealth-ui";

/** Hero eyebrow label per metric — mirrors the chart's metric switcher so the
 *  headline reads as whatever series the user selected in Balance history. */
const METRIC_LABEL: Record<WealthMetricKey, string> = {
  netWorth:         "Net worth",
  totalAssets:      "Total assets",
  totalLiabilities: "Total liabilities",
  liquidNetWorth:   "Liquid net worth",
  cash:             "Cash",
  invested:         "Investments & crypto",
};

/** The secondary stat line per headline — each row is a real WealthMetrics key. */
const SECONDARY: Record<WealthMetricKey, { key: WealthMetricKey; label: string; goodDirection: "up" | "down" }[]> = {
  netWorth: [
    { key: "totalAssets",      label: "Assets",      goodDirection: "up" },
    { key: "totalLiabilities", label: "Liabilities", goodDirection: "down" },
    { key: "liquidNetWorth",   label: "Liquid NW",   goodDirection: "up" },
  ],
  // "Investments & crypto" — the invested series is stocks + crypto (the two
  // disjoint snapshot buckets the Investments lens always plotted), while the
  // composition card below names "Investments" and "Crypto" as separate classes.
  // The stat says which it is so the two never read as one figure disagreeing.
  totalAssets: [
    { key: "cash",     label: "Cash",                 goodDirection: "up" },
    { key: "invested", label: "Investments & crypto", goodDirection: "up" },
  ],
  cash: [
    { key: "totalAssets", label: "Total assets",         goodDirection: "up" },
    { key: "invested",    label: "Investments & crypto", goodDirection: "up" },
  ],
  invested: [
    { key: "totalAssets", label: "Total assets", goodDirection: "up" },
    { key: "cash",        label: "Cash",         goodDirection: "up" },
  ],
  totalLiabilities: [],
  liquidNetWorth: [],
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
  /** The page's resolved series — the hero reflects the SAME metric the chart
   *  plots, so Total / Assets / a slice change the headline too. */
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

      {/* Secondary stats — the subject's dimensions, each a real WealthMetrics
          key off the same as-of snapshot (label · value · signed change). */}
      {SECONDARY[metric].length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[var(--text-muted)]">
          {SECONDARY[metric].map((row) => {
            const d = deltas?.[row.key];
            const good = d ? (row.goodDirection === "up" ? d.abs >= 0 : d.abs <= 0) : true;
            return (
              <Stat key={row.key} label={row.label}>
                {formatCurrency(asOfState[row.key], currency)}
                {d && Math.abs(d.abs) >= 0.5 && (
                  <span className="ml-1.5" style={{ color: good ? "var(--accent-positive)" : "var(--accent-negative)" }}>
                    {d.abs >= 0 ? "+" : "−"}{formatCurrency(Math.abs(d.abs), currency)}
                  </span>
                )}
              </Stat>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{label}</span>
      <span className="text-[var(--text-secondary)]">{children}</span>
    </span>
  );
}
