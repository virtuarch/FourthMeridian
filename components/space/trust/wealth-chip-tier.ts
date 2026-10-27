/**
 * components/space/trust/wealth-chip-tier.ts  (v2.7 final UX pass — owner-authorized §6)
 *
 * The PRESENTATION-ONLY confidence tier for the Net Worth / Assets hero chip.
 *
 * WealthResult.completeness (computeWealthTimeMachine) derives its tier from the
 * snapshot's boolean `isEstimated` only, so a reconstructed row whose resolved
 * tier is `estimated` / `incomplete` reads "Reconstructed", and an observed row
 * the live writer RECORDED as `incomplete` (an FX-unconverted account excluded)
 * reads clean. The Snapshot DTO already carries the canonical resolved tier
 * (`completenessTier`, resolved ONCE at the read boundary by
 * lib/snapshots/snapshot-completeness.core.ts). This maps THAT to the chip.
 *
 * Isolation (the owner's constraint): nothing here feeds WealthResult, the AI,
 * or the Daily Brief. WealthResult.completeness is untouched; the chip receives
 * this tier through an ADDITIVE optional input consumed only by wealthEnvelope.
 * Chart series / dashing still read `isEstimated` and are unchanged.
 *
 *   not found            ⇒ incomplete (no snapshot on/before the date)
 *   completenessTier set ⇒ that tier (observed ⇒ silent chip; derived ⇒
 *                          Reconstructed; estimated ⇒ Estimated; incomplete ⇒
 *                          Incomplete; unknown ⇒ Unavailable)
 *   absent               ⇒ the legacy rule: isEstimated ⇒ derived, else observed
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { Snapshot } from "@/types";

/**
 * The row's resolved tier is the WORST of every component the day composed
 * (cash/card walk-back, investment + crypto valuation, real assets, FX —
 * regenerate-history.core.ts / regenerate.ts). It therefore speaks for the
 * WHOLE-ROW aggregates only: Net worth and Total assets. A slice (Cash,
 * Investments, Liquid NW, Liabilities) would inherit a component it does not
 * contain (constant-quantity crypto "estimated" on a Cash figure), so slices
 * keep the legacy isEstimated rule.
 */
export const ROW_TIER_METRICS: ReadonlySet<string> = new Set(["netWorth", "totalAssets"]);

export function wealthChipTier(args: {
  found:             boolean;
  isEstimated:       boolean;
  completenessTier?: CompletenessTier | null;
  /** The displayed wealth metric; absent ⇒ treated as a whole-row aggregate. */
  metric?:           string;
}): CompletenessTier {
  if (!args.found) return "incomplete";
  const rowTier = args.metric === undefined || ROW_TIER_METRICS.has(args.metric) ? args.completenessTier : undefined;
  return rowTier ?? (args.isEstimated ? "derived" : "observed");
}

/**
 * The resolved tier of the snapshot the as-of figure was read from (the row whose
 * date equals `asOfState.date`). Undefined when the row carries none.
 */
export function asOfSnapshotTier(snapshots: readonly Snapshot[] | null | undefined, date: string | null): CompletenessTier | undefined {
  if (!date || !snapshots) return undefined;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].date === date) return snapshots[i].completenessTier ?? undefined;
  }
  return undefined;
}
