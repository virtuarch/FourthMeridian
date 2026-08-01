/**
 * lib/snapshots/snapshot-completeness.core.ts
 *
 * V26-INVESTMENTS-HISTORY — THE ONE canonical interpretation of a stored
 * snapshot's confidence. Pure: no Prisma, no DB, no clock.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A `SpaceSnapshot` row now carries two overlapping honesty signals:
 *
 *   isEstimated      a boolean, written since D2.x, defined by
 *                    regenerate-history.core.ts as `tier !== "observed"`
 *   completenessTier the canonical tier itself, written from V26 onward,
 *                    null on every row written before it (and on every row no
 *                    A8 valuation produced)
 *
 * Two fields describing one property is exactly how a codebase acquires two
 * sources of truth. Consumers MUST NOT combine them themselves — they call
 * this, and only this. The read authority (lib/data/snapshots.ts) resolves it
 * once at the boundary so no downstream surface ever sees the raw pair.
 *
 * ── The frozen-row invariant ────────────────────────────────────────────────
 * An `isEstimated=false` row is an OBSERVATION of what balances said that day.
 * regenerate-history.core.ts's frozen guard never rewrites one, so such a row
 * will carry `completenessTier: null` forever — no migration can fix it and no
 * regeneration will.
 *
 * That costs nothing, because the flag already determines the answer:
 *
 *     isEstimated = (tier !== "observed")        [the FLIP rule]
 *   ⇒ isEstimated === false  ⇒  tier === "observed"
 *
 * So the one class of row that can never be enriched is the one class that
 * needs no column. This inference is sound ONLY while the FLIP rule holds; if
 * that derivation ever changes, this function is where it breaks and must be
 * revisited.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * `reason`, `conflict`, `byComponent`, and per-instrument exclusion lists are
 * NOT persisted and are not reconstructed here. Those belong to the runtime
 * `Completeness` envelope (the ratified anti-`FinancialState` ruling,
 * lib/perspective-engine/types.ts) and are available on demand from the
 * point-in-time valuation path. This module answers only what a stored row can
 * honestly say about itself.
 */

import { isCompletenessTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/** Where a resolved tier came from — an audit of the answer, not a second answer. */
export type SnapshotCompletenessBasis =
  /** Read from the row's own `completenessTier` column. */
  | "recorded"
  /** Inferred from `isEstimated === false` via the FLIP rule (frozen observation). */
  | "inferred-observed"
  /** An estimated row written before this column existed: not observed, but which
   *  of derived/estimated/incomplete/unknown it was is genuinely unrecoverable. */
  | "legacy-unrecorded";

/** The stored fields this interpretation reads. Structural — no Prisma import. */
export interface SnapshotCompletenessRow {
  isEstimated?:                boolean | null;
  completenessTier?:           string | null;
  contributingComponentCount?: number | null;
  totalComponentCount?:        number | null;
}

export interface SnapshotCompleteness {
  /** The tier to use. Always a canonical member — never null, never invented. */
  tier:  CompletenessTier;
  basis: SnapshotCompletenessBasis;
  /** True only when `tier` is a recorded fact rather than an inference. */
  recorded: boolean;
  /**
   * Holdings that contributed to this row's investment figure, and how many
   * were considered. Null when not recorded — NEVER coerced to 0, which would
   * assert "nothing contributed" about a row that simply predates the column.
   */
  contributingComponentCount: number | null;
  totalComponentCount:        number | null;
}

/**
 * Resolve one stored row's confidence.
 *
 * Precedence, in order:
 *   1. a recorded, canonical `completenessTier`            → "recorded"
 *   2. `isEstimated === false` (the frozen-row invariant)  → "inferred-observed"
 *   3. otherwise                                           → "legacy-unrecorded"
 *
 * Case 3 returns `unknown` rather than guessing a middle tier. The row IS a
 * reconstruction (that much the flag proves) but its quality was never written
 * down, and `unknown` is this codebase's word for "we cannot say" — the same
 * conservative direction valuation takes for a missing price. `basis` lets a
 * consumer tell that apart from a row genuinely measured as `unknown`, so a
 * pessimistic default never has to become a pessimistic claim.
 *
 * A non-canonical string in the column is treated as absent, not trusted and
 * not thrown on: this is a read path over historical rows and must stay total.
 */
export function resolveSnapshotCompleteness(row: SnapshotCompletenessRow): SnapshotCompleteness {
  const counts = {
    contributingComponentCount: row.contributingComponentCount ?? null,
    totalComponentCount:        row.totalComponentCount ?? null,
  };

  if (isCompletenessTier(row.completenessTier)) {
    return { tier: row.completenessTier, basis: "recorded", recorded: true, ...counts };
  }
  if (row.isEstimated === false) {
    return { tier: "observed", basis: "inferred-observed", recorded: false, ...counts };
  }
  return { tier: "unknown", basis: "legacy-unrecorded", recorded: false, ...counts };
}

/**
 * How much a stored row may be trusted, reduced to the three states a surface
 * can actually render differently. The ONE classifier — a consumer never reads
 * a tier, a count, or a threshold of its own.
 *
 *   observed       measured; draw it as fact
 *   reconstructed  a labelled estimate; draw it as an estimate
 *   unreliable     the row exists but most of it could not be valued; draw it
 *                  as something LESS than an estimate
 */
export type SnapshotConfidence = "observed" | "reconstructed" | "unreliable";

/**
 * Classify a resolved completeness for presentation.
 *
 * Order matters, and rule 2 is the load-bearing one:
 *
 *   1. tier "observed"                 → observed
 *   2. NOT recorded                    → reconstructed
 *   3. tier "incomplete" | "unknown"   → unreliable
 *   4. tier "derived" | "estimated"    → reconstructed
 *
 * Rule 2 exists because `legacy-unrecorded` resolves to tier `unknown` — a
 * deliberately conservative default for "we never wrote it down". Classifying
 * on the tier alone would therefore mark EVERY row written before the
 * completeness column as low-confidence, which is a claim about data quality
 * that nobody measured. A row is only called unreliable when a regeneration
 * actually recorded that it was; until then, every historical row keeps exactly
 * the treatment it has today.
 *
 * The split at rule 3 is the canonical COMPLETENESS_TIERS ordering (observed <
 * derived < estimated < incomplete < unknown), not a new threshold: `derived`
 * and `estimated` are legitimate estimates, `incomplete` and `unknown` are the
 * two tiers that mean "we could not say". No coverage ratio is invented here —
 * the counts travel separately as disclosure, never as a rule.
 */
export function snapshotConfidence(c: SnapshotCompleteness): SnapshotConfidence {
  if (c.tier === "observed") return "observed";
  if (!c.recorded) return "reconstructed";
  return c.tier === "incomplete" || c.tier === "unknown" ? "unreliable" : "reconstructed";
}

/**
 * The `isEstimated` a resolved tier implies — the FLIP rule, in one place.
 *
 * Provided so a future consumer can drop the stored boolean entirely rather
 * than keep asking both questions. NOT used to rewrite stored rows in this
 * slice: `isEstimated` remains authoritative on disk, and this is the bridge
 * that keeps the two from ever disagreeing in a reader's hands.
 */
export function isEstimatedFromTier(tier: CompletenessTier): boolean {
  return tier !== "observed";
}
