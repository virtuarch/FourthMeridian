/**
 * lib/balances/unobserved-totals.ts
 *
 * Mortgage F8 (S2 ruling) — a TOTAL that excludes an account of unknown balance
 * is PARTIAL, and says which WAY the truth lies.
 *
 * FIN-A2 / FM-AUDIT-022 already exclude such an account from every total
 * (`balanceObserved === false`, or an unpriced / never-observed wallet: a
 * structural 0 flagged `valuationUnknown`, counted in `unvaluedCount`). That is
 * right — we never invent its balance — but the exclusion was disclosed only on
 * the account row ("Balance unavailable"), so a household whose $300k mortgage
 * was never observed saw a clean net worth $300k too HIGH. This module is the
 * ONE place that turns the exclusions into a statement AT THE TOTAL:
 *
 *   excluded DEBT  → net worth / liquid net worth: "Excludes a debt of unknown
 *                    balance — the true total is lower"
 *                  → total debt: "… — the true amount owed is higher" (the debt
 *                    total itself understates; "lower" would be false there)
 *   excluded ASSET → "Excludes an account of unknown balance — the true total
 *                    may be higher" (net worth, total assets; liquid figures only
 *                    when the excluded account is checking / savings)
 *
 * Status reuses the F3 typed-coverage vocabulary (lib/debt/aggregates.ts
 * TermCoverageStatus): COMPLETE when nothing this total depends on was excluded,
 * PARTIAL otherwise. The excluded balance stays excluded — no number is invented
 * ("partial, never $0, never silently omitted").
 *
 * Pure: no DB, no server-only imports (client components import it).
 */

import type { TermCoverageStatus } from "@/lib/debt/aggregates";

/** Which total a coverage statement describes. */
export type ExclusionTotal =
  | "NET_WORTH"
  | "LIQUID_NET_WORTH"
  | "TOTAL_DEBT"
  | "TOTAL_ASSETS"
  /** Unrestricted cash (checking + savings) — the AI snapshot's `liquid`. */
  | "LIQUID_CASH";

/**
 * Which way the true figure lies relative to the one shown.
 *   TRUE_TOTAL_LOWER         an excluded debt was not subtracted
 *   TRUE_TOTAL_MAY_BE_HIGHER an excluded account (asset) was not added — it may hold nothing
 *   TRUE_TOTAL_HIGHER        an excluded debt is missing from a DEBT total
 */
export type ExclusionDirection = "TRUE_TOTAL_LOWER" | "TRUE_TOTAL_MAY_BE_HIGHER" | "TRUE_TOTAL_HIGHER";

/** How many accounts of each kind the totals classification excluded as unvalued. */
export interface ExcludedAccountCounts {
  /** type === "debt" rows (or members of a debt aggregate). */
  debt:   number;
  /** every non-debt row (or aggregate member). */
  asset:  number;
  /** the subset of `asset` that is checking / savings (feeds the liquid figures). */
  liquid: number;
}

export interface UnobservedTotalCoverage {
  total:              ExclusionTotal;
  /** F3 vocabulary, narrowed: an exclusion makes the total PARTIAL; none ⇒ COMPLETE. */
  status:             Extract<TermCoverageStatus, "COMPLETE" | "PARTIAL">;
  /** Excluded debts this total depends on. */
  excludedDebtCount:  number;
  /** Excluded assets this total depends on. */
  excludedAssetCount: number;
  /** One per kind of exclusion, debt first. Empty when COMPLETE. */
  directions:         ExclusionDirection[];
  /** The sentence per direction (same order), quotable as-is. Empty when COMPLETE. */
  notes:              string[];
}

const NONE: ExcludedAccountCounts = { debt: 0, asset: 0, liquid: 0 };

/** The one reader of the two FM-AUDIT-022 flags (mirrors account-classifier's unvaluedAccountCount). */
function excludedOf(a: { valuationUnknown?: boolean; unvaluedMemberCount?: number }): number {
  return (a.valuationUnknown === true ? 1 : 0) + (a.unvaluedMemberCount ?? 0);
}

/**
 * Count the excluded accounts by kind over the SAME rows a total was classified
 * from (rows carrying `valuationUnknown` / `unvaluedMemberCount`).
 */
export function excludedAccountCounts(
  accounts: ReadonlyArray<{ type: string; valuationUnknown?: boolean; unvaluedMemberCount?: number }>,
): ExcludedAccountCounts {
  const c = { ...NONE };
  for (const a of accounts) {
    const n = excludedOf(a);
    if (n === 0) continue;
    if (a.type === "debt") c.debt += n;
    else {
      c.asset += n;
      if (a.type === "checking" || a.type === "savings") c.liquid += n;
    }
  }
  return c;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** The debt-exclusion sentence for a NET figure (net worth / liquid net worth). */
export function excludedDebtNote(n: number): string {
  return `Excludes ${plural(n, "a debt", "debts")} of unknown balance — the true total is lower`;
}
/** The debt-exclusion sentence for a DEBT total. */
export function excludedDebtFromDebtTotalNote(n: number): string {
  return `Excludes ${plural(n, "a debt", "debts")} of unknown balance — the true amount owed is higher`;
}
/** The asset-exclusion sentence (net worth / assets / liquid). */
export function excludedAssetNote(n: number): string {
  return `Excludes ${plural(n, "an account", "accounts")} of unknown balance — the true total may be higher`;
}

/**
 * The coverage of ONE total. Which exclusions matter depends on the total:
 * an excluded house never makes the debt total partial; an excluded brokerage
 * account never makes liquid cash partial.
 */
export function unobservedTotalCoverage(
  total: ExclusionTotal,
  counts: ExcludedAccountCounts = NONE,
): UnobservedTotalCoverage {
  const debt = total === "TOTAL_ASSETS" || total === "LIQUID_CASH" ? 0 : counts.debt;
  const asset =
    total === "TOTAL_DEBT" ? 0
    : total === "LIQUID_NET_WORTH" || total === "LIQUID_CASH" ? counts.liquid
    : counts.asset;

  const directions: ExclusionDirection[] = [];
  const notes: string[] = [];
  if (debt > 0) {
    if (total === "TOTAL_DEBT") {
      directions.push("TRUE_TOTAL_HIGHER");
      notes.push(excludedDebtFromDebtTotalNote(debt));
    } else {
      directions.push("TRUE_TOTAL_LOWER");
      notes.push(excludedDebtNote(debt));
    }
  }
  if (asset > 0) {
    directions.push("TRUE_TOTAL_MAY_BE_HIGHER");
    notes.push(excludedAssetNote(asset));
  }
  return {
    total,
    status: directions.length > 0 ? "PARTIAL" : "COMPLETE",
    excludedDebtCount: debt,
    excludedAssetCount: asset,
    directions,
    notes,
  };
}

/** The short badge text for one direction — what a chip beside the total says. */
export function exclusionBadge(d: ExclusionDirection): string {
  switch (d) {
    case "TRUE_TOTAL_LOWER":         return "Partial — true total is lower";
    case "TRUE_TOTAL_HIGHER":        return "Partial — true amount owed is higher";
    case "TRUE_TOTAL_MAY_BE_HIGHER": return "Partial — true total may be higher";
  }
}

/**
 * The AI tool contract's projection: status + direction BESIDE each total.
 * Returns null when every total is COMPLETE, so a fully observed Space's payload
 * is unchanged.
 */
export interface AiTotalsCoverage {
  netWorth:         UnobservedTotalCoverage;
  totalAssets:      UnobservedTotalCoverage;
  totalLiabilities: UnobservedTotalCoverage;
  liquid:           UnobservedTotalCoverage;
  /** How to read the PARTIAL totals, in words the model can quote. */
  meaning:          string;
}

export function aiTotalsCoverage(counts: ExcludedAccountCounts): AiTotalsCoverage | null {
  const netWorth = unobservedTotalCoverage("NET_WORTH", counts);
  if (netWorth.status === "COMPLETE") return null; // every exclusion moves net worth
  return {
    netWorth,
    totalAssets:      unobservedTotalCoverage("TOTAL_ASSETS", counts),
    totalLiabilities: unobservedTotalCoverage("TOTAL_DEBT", counts),
    liquid:           unobservedTotalCoverage("LIQUID_CASH", counts),
    meaning:
      "A PARTIAL total leaves out an account whose balance is unknown (never observed or not yet valued) — it is NOT counted as 0. "
      + "State the total as partial with its direction: an excluded debt means the true net worth is LOWER (and the true debt higher); "
      + "an excluded asset means the true total MAY BE HIGHER. Never present a partial total as complete, and never estimate the missing balance.",
  };
}
