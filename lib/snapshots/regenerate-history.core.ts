/**
 * lib/snapshots/regenerate-history.core.ts
 *
 * A9 — PURE wealth-regeneration decision core. No DB, no clock, no network: the
 * per-day rules that turn a flat-held historical snapshot into an A8-valued one,
 * so it fixture-tests without `prisma generate`. The binding
 * (regenerate-history.ts) gathers the inputs (walk-back balances + A8 valuation)
 * and applies these decisions.
 *
 * The gap this closes: lib/snapshots/backfill.ts walks cash and revolving cards
 * back from transactions but HOLDS INVESTMENTS FLAT at today's value on every
 * historical row (backfill.ts §"everything else keeps its current balance").
 * A9 replaces that flat investment component with the canonical A8 historical
 * valuation (getInvestmentValueAsOf → valuedSubtotal), keeping the cash/card
 * walk-backs and the crypto/real-asset components exactly as backfill computed
 * them, and recomputing the derived aggregates through the SAME
 * computeSnapshotFields the live "today" row uses (formula parity).
 *
 * Honesty rules (all enforced here, none in the binding):
 *  - FROZEN rows: an isEstimated=false row is an observation of what balances
 *    said that day — NEVER touched (guard + byte-identity test). This is the
 *    load-bearing safety rule.
 *  - NO FABRICATION: when A8 has no position evidence reaching the day yet flat
 *    investments exist, the day is left as backfill wrote it (a labeled
 *    estimate) rather than zeroed — unknown is preferable to a fabricated value.
 *  - FLIP: a regenerated row flips isEstimated→false ONLY when every component
 *    is observed (cash + investment). Historical A8 valuation is derived/
 *    estimated, so historical rows stay isEstimated=true → a derived date is
 *    NEVER presented as observed.
 *  - MONOTONE: regeneration never turns an observed (frozen) row estimated and
 *    never removes coverage — completeness never decreases.
 *  - Deterministic: identical inputs ⇒ identical output (idempotent upserts).
 *  - No interpolation: this module decides values from evidence, never invents
 *    a date's data from its neighbours.
 */

import { computeSnapshotFields, type ClassifyTotals, type SnapshotFields } from "./backfill-core";
import { worstTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/** Sub-dollar noise floor — a flat investment at/below this is "nothing to reconstruct". */
export const WEALTH_REGEN_EPSILON = 0.5;

/** What the binding resolves for one day before applying the regeneration rules. */
export interface DayRegenInput {
  date: string; // YYYY-MM-DD
  /** Existing SpaceSnapshot state for the day: its isEstimated flag, or null if no row. */
  existingIsEstimated: boolean | null;
  /**
   * Base classified totals with cash/card WALKED BACK and everything else
   * (investments, crypto, real, loans) flat-held — i.e. exactly what backfill
   * produces for the day. `totalInvestments` is the flat value A9 replaces.
   */
  base: ClassifyTotals;
  /** A8 historical investment valuation (valuedSubtotal), reporting currency. */
  investmentValue: number;
  /** A8 completeness tier for the day's investment valuation. */
  investmentTier: CompletenessTier;
  /** True when A8 had at least one position with evidence reaching the day. */
  hasInvestmentEvidence: boolean;
  /** Trust tier of the walked-back cash/card component (typically "derived"). */
  cashCardTier: CompletenessTier;
}

export type RegenAction = "write" | "skip-frozen" | "skip-unsupported";

/** The per-day decision + the row to upsert when action === "write". */
export interface DayRegenResult {
  date: string;
  action: RegenAction;
  /** The regenerated snapshot fields, or null when skipped. */
  fields: SnapshotFields | null;
  /** The isEstimated flag to persist (meaningful only when action === "write"). */
  isEstimated: boolean;
  /** Overall completeness tier of the regenerated row (worst of cash/card + investment). */
  tier: CompletenessTier;
  reason: string;
}

/**
 * Apply the A9 regeneration rules to one day. Pure and total — never throws.
 */
export function regenerateDay(input: DayRegenInput): DayRegenResult {
  const { date, existingIsEstimated, base } = input;

  // FROZEN: an observed row is never touched (the safety invariant).
  if (existingIsEstimated === false) {
    return { date, action: "skip-frozen", fields: null, isEstimated: false, tier: "observed", reason: "Observed row is frozen." };
  }

  const flatInvestments = base.totalInvestments;

  // NO FABRICATION: flat investments we cannot A8-value are left as-is, never
  // zeroed or fabricated — the day keeps backfill's labeled estimate.
  if (!input.hasInvestmentEvidence && flatInvestments > WEALTH_REGEN_EPSILON) {
    return {
      date, action: "skip-unsupported", fields: null, isEstimated: true, tier: "incomplete",
      reason: "No historical position evidence for this date; flat estimate preserved (not fabricated).",
    };
  }

  // Override the flat investment component with the A8 valuation (when evidence
  // exists); otherwise there is nothing to value (flat ≈ 0) and the day is a
  // cash-only reconstruction.
  const investments = input.hasInvestmentEvidence ? input.investmentValue : flatInvestments;
  const totals: ClassifyTotals = { ...base, totalInvestments: investments };
  const fields = computeSnapshotFields(totals);

  const investmentTier: CompletenessTier = input.hasInvestmentEvidence ? input.investmentTier : "derived";
  const tier = worstTier([input.cashCardTier, investmentTier]);
  // FLIP: observed only when every component is observed; otherwise the row is a
  // reconstruction and stays estimated (a derived date is never "observed").
  const isEstimated = tier !== "observed";

  return {
    date, action: "write", fields, isEstimated, tier,
    reason: input.hasInvestmentEvidence
      ? `Investments valued at the A8 historical portfolio value (${tier}).`
      : `Cash-only reconstruction for this date (${tier}).`,
  };
}

/**
 * Apply the rules across a window. Deterministic: identical inputs ⇒ identical
 * results, so repeated regeneration upserts identical rows (idempotent).
 */
export function regenerateWindow(inputs: readonly DayRegenInput[]): DayRegenResult[] {
  return inputs.map(regenerateDay);
}

/** The rows a run would write (action === "write"), in input order. */
export function writableRows(results: readonly DayRegenResult[]): DayRegenResult[] {
  return results.filter((r) => r.action === "write");
}
