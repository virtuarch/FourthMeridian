/**
 * lib/perspective-engine/completeness.ts
 *
 * A5-S1 — the single shared trust vocabulary and its propagation helpers.
 *
 * `CompletenessTier` (lib/perspective-engine/types.ts) is THE platform trust
 * vocabulary; this module is its canonical runtime surface:
 *   - COMPLETENESS_TIERS  — the frozen, ordered tier list (best → worst).
 *   - isCompletenessTier  — the membership guard A4's DERIVED writer asserts
 *                            with before writing PositionObservation.completeness
 *                            (A4 imports it — it cannot mint a value off-list).
 *   - worstTier           — reduce contributing tiers to the least trustworthy.
 *   - propagateCompleteness — worst tier + conflict-OR, in one call.
 *
 * Every consumer (the networth lens, the Liquidity/Debt as-of bindings, A4's
 * reconstruction summary) uses these helpers rather than re-deriving the
 * ordering or the OR — a single source of truth for how trust degrades.
 *
 * Pure: imports only the type from ./types, so nothing here trips the engine's
 * import-graph guards (no Prisma, no LLM, no request coupling).
 */

import type { CompletenessTier } from "./types";

/**
 * The canonical tiers, ordered from most to least trustworthy. The array index
 * IS the trust rank (0 = most trustworthy), so worstTier() is a max over
 * indices. Frozen so a consumer can neither reorder nor extend it in place —
 * the only way to add a tier is to edit the `CompletenessTier` union and this
 * list together, deliberately.
 */
export const COMPLETENESS_TIERS: readonly CompletenessTier[] = Object.freeze([
  "observed",
  "derived",
  "estimated",
  "incomplete",
  "unknown",
]);

/**
 * Membership guard for the canonical vocabulary. A4's writer calls this before
 * persisting `PositionObservation.completeness` and refuses any non-member
 * value at write time, so no stream can smuggle a fifth trust vocabulary into
 * the reserved String column.
 */
export function isCompletenessTier(value: unknown): value is CompletenessTier {
  return (
    typeof value === "string" &&
    (COMPLETENESS_TIERS as readonly string[]).includes(value)
  );
}

/**
 * Reduce contributing tiers to the least-trustworthy (highest-ranked) one.
 * An empty contributor set cannot be characterised, so it fails closed to
 * "unknown" (the method itself could not be determined).
 */
export function worstTier(tiers: readonly CompletenessTier[]): CompletenessTier {
  let seen = false;
  let worstRank = 0;
  for (const tier of tiers) {
    seen = true;
    const rank = COMPLETENESS_TIERS.indexOf(tier);
    if (rank > worstRank) worstRank = rank;
  }
  return seen ? COMPLETENESS_TIERS[worstRank] : "unknown";
}

/**
 * Combine per-component trust into a single tier + conflict flag: the worst
 * tier among the parts (worstTier) and the OR of their conflict flags. This is
 * the one propagation rule from the investigation §5 ("worst-tier at every
 * level; conflict ORs upward") — callers layer it (field → account →
 * perspective) rather than re-implementing the reduction.
 */
export function propagateCompleteness(
  parts: ReadonlyArray<{ tier: CompletenessTier; conflict?: boolean }>,
): { tier: CompletenessTier; conflict: boolean } {
  return {
    tier: worstTier(parts.map((p) => p.tier)),
    conflict: parts.some((p) => p.conflict === true),
  };
}
