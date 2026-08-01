"use client";

/**
 * components/space/widgets/investments/InvestmentsHero.tsx
 *
 * Surface ① of the Investments Workspace — the editorial lede, in the Net Worth /
 * prototype idiom (bare, no card): an eyebrow + trust chip, the portfolio-value
 * headline, its period change, and how much of the portfolio that number covers.
 *
 * HONESTY (the whole point of this screen — mirrors the prototype thesis):
 *  - The headline is `portfolio.valuedSubtotal` — a SUBTOTAL over VALUED positions
 *    only, never presented as whole. The valued/total line states the coverage up
 *    front, so a partial number is met as partial.
 *  - The change is the A10 reconciliation's `totalChange` — a VALUE DELTA over the
 *    period (it includes contributions by construction), so it is labelled "vs
 *    {date}", never "gain": Investments carries no cost basis for a period, and a
 *    value change is not a return. (Per-holding cost basis, where Plaid supplies it,
 *    lives in the holding detail — not restated here.)
 *
 * Presentation only — every figure comes from the InvestmentsSpaceData contract.
 */

import { formatCurrency } from "@/lib/format";
import type { InvestmentsPortfolio, InvestmentsReconciliation } from "@/lib/investments/investments-time-machine-core";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { Figure } from "@/components/atlas/Surface";
import { TrustIndicator } from "@/components/space/trust/TrustIndicator";
import { DeltaBadge } from "@/components/space/widgets/wealth/wealth-ui";
import { heroComparison, type PeriodAttribution } from "@/lib/investments/period-attribution.core";

export function InvestmentsHero({
  portfolio,
  reconciliation,
  reportingCurrency,
  figureLabel,
  asOf,
  envelope,
  attribution,
}: {
  portfolio:         InvestmentsPortfolio;
  reconciliation:    InvestmentsReconciliation | null;
  reportingCurrency: string;
  /** Trust-derived honest label ("Portfolio value" | "Valued holdings"). */
  figureLabel:       string;
  asOf:              string;
  /** The workspace's canonical trust envelope — drives the confidence chip. */
  envelope:          PerspectiveEnvelope;
  /** Canonical period verdict — the ONE rule the hero and the card both obey. */
  attribution?:      PeriodAttribution | null;
}) {
  const ccy = reportingCurrency;
  const totalPositions = portfolio.valuedCount + portfolio.unvaluedCount;
  // V26-INVESTMENTS-HISTORY-FIX — the change and the percentage are GATED by the
  // same verdict the period card reads. Previously this divided totalChange by
  // openingValue with no reference to whether either endpoint was defensible,
  // which is how a reconstructed $516.43 opening became "3857.0%".
  const gate = attribution ? heroComparison(attribution) : null;
  const change = gate ? (gate.showChange ? gate.changeAmount : null) : (reconciliation?.totalChange ?? null);
  const opening = gate ? attribution!.openingValue : (reconciliation?.openingValue ?? null);
  const pct = gate
    ? (gate.showPercentage ? gate.percentage : null)
    : (change != null && opening != null && opening !== 0 ? (change / opening) * 100 : null);
  const suppressedReason = gate?.suppressedReason ?? null;

  return (
    // Bare hero — no card, no border. The most important figure doesn't need a
    // container to be found (the read surfaces are the rows below).
    <section>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{figureLabel}</p>
        <TrustIndicator variant="compact" envelope={envelope} />
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <Figure value={formatCurrency(portfolio.valuedSubtotal, ccy)} size="hero" className="sm:text-5xl leading-none" />
        {change != null ? (
          <DeltaBadge
            abs={change}
            pct={pct}
            currency={ccy}
            goodDirection="up"
            compareLabel={reconciliation?.from}
            className="!text-xs"
          />
        ) : suppressedReason ? (
          <span className="text-[11px] text-[var(--text-muted)]">Period change unavailable — {suppressedReason}</span>
        ) : (
          <span className="text-[11px] text-[var(--text-muted)]">Add a Compare To date above to see the change.</span>
        )}
      </div>

      <p className="mt-2.5 text-sm text-[var(--text-secondary)]">
        {portfolio.unvaluedCount > 0 ? (
          <>
            <span className="tabular-nums">{portfolio.valuedCount}</span> of{" "}
            <span className="tabular-nums">{totalPositions}</span> positions valued
            <span className="text-[var(--text-muted)]"> · as of {asOf}</span>
          </>
        ) : (
          <>as of {asOf}</>
        )}
      </p>
    </section>
  );
}
