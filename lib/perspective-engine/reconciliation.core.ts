/**
 * lib/perspective-engine/reconciliation.core.ts
 *
 * V27-A — THE ONE RECONCILIATION VOCABULARY.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 * V26-S4 established four outcomes for "do these components explain this total?"
 * and proved them against 366 live dates. They were declared inside
 * `lib/investments/historical-point-detail.ts`, which is a database binding —
 * so the moment a SECOND thing needed to reconcile (aggregate authorisation,
 * V27 Slice A) the only options were to import a DB module from a pure one or
 * to restate the vocabulary.
 *
 * Restating it would have been the beginning of a second reconciliation model,
 * which is precisely what the V27 investigation's invariants forbid. So the
 * vocabulary moves here, beside the trust tiers it belongs with, and both
 * consumers import it. `historical-point-detail.ts` re-exports its own names so
 * nothing downstream changes.
 *
 * This module holds the VOCABULARY and the TOLERANCE RULE, and nothing else. It
 * knows about no lens, no aggregate, no instrument and no account.
 */

/**
 * How well a set of components explains the total they are supposed to compose.
 *
 *   EXACT                 the components account for the total within tolerance
 *   PARTIALLY_ATTRIBUTED  they fall SHORT of an OBSERVED total; the difference is
 *                         a stated remainder, never an invented component
 *   CONTRADICTORY         the evidence disagrees with itself — components exceed
 *                         the total, or an identity that must hold does not
 *   UNAVAILABLE           too little evidence to say anything useful, or a
 *                         COMPUTED total that no longer matches its own parts
 */
export const RECONCILIATION_STATES = [
  "EXACT",
  "PARTIALLY_ATTRIBUTED",
  "CONTRADICTORY",
  "UNAVAILABLE",
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

/** A breakdown may be rendered only in these two states. */
export function isRenderable(state: ReconciliationState): boolean {
  return state === "EXACT" || state === "PARTIALLY_ATTRIBUTED";
}

/**
 * Tolerance when comparing the engine AGAINST ITSELF — a computed total this
 * same composition produced. One cent: exactness is achievable there, so
 * anything larger is a real defect rather than rounding.
 */
export const COMPUTED_TOLERANCE = 0.01;

/**
 * Tolerance when comparing against an INDEPENDENT OBSERVATION — a total recorded
 * directly at the time, while the components are resolved now from dated
 * evidence.
 *
 * Two recordings of the same portfolio, made by different means at different
 * moments, differ by rounding at the currency and FX boundaries. Measured across
 * the live frozen rows in V26-S4: 0.00, 0.00, −0.02, 0.00, 0.00, −0.31, 0.00,
 * −0.05. Demanding one-cent agreement there would report six-hundredths of a
 * percent as a contradiction, which is not what a contradiction is.
 *
 * A dollar, or one basis point of the total — whichever is larger — so the floor
 * scales with the portfolio instead of tightening as it grows.
 */
export function observedTolerance(total: number): number {
  return Math.max(1.0, Math.abs(total) * 0.0001);
}

/**
 * The tolerance that applies to one comparison.
 *
 * `totalIsObserved` is the whole discriminator: a recorded total and a computed
 * total are being asked different questions, and giving them the same bar makes
 * one of the two answers wrong.
 */
export function toleranceFor(total: number, totalIsObserved: boolean): number {
  return totalIsObserved ? observedTolerance(total) : COMPUTED_TOLERANCE;
}

/** Reporting-currency rounding — the repository's canonical two-decimal policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify one reconciliation.
 *
 * ── The rule that must not be softened ───────────────────────────────────────
 * A REMAINDER IS ONLY AVAILABLE UNDER AN OBSERVATION. When the total was
 * COMPUTED from these very components, a shortfall does not mean "some of it is
 * unattributed" — it means the stored total no longer matches what the engine
 * now computes, i.e. it is stale. Presenting that as a remainder would dress a
 * stale number as evidence, which is the one failure mode this vocabulary exists
 * to prevent.
 *
 * Components EXCEEDING the total are always contradictory, observed or not: a
 * negative remainder is not a quantity anything can mean.
 *
 * Total and deterministic; never throws.
 */
export function classifyReconciliation(args: {
  /** The total being explained. */
  total: number;
  /** Σ of the components that may be asserted. */
  explained: number;
  /** True when `total` is a recorded observation rather than a computation. */
  totalIsObserved: boolean;
  /** How many components were available at all. Zero ⇒ nothing to say. */
  componentCount: number;
  /** Stated contradictions found by the caller (identity failures, duplicates…). */
  contradictions?: readonly string[];
}): { state: ReconciliationState; delta: number; remainder: number | null } {
  const delta = round2(args.total - args.explained);
  const tol = toleranceFor(args.total, args.totalIsObserved);

  if ((args.contradictions?.length ?? 0) > 0 || delta < -tol) {
    return { state: "CONTRADICTORY", delta, remainder: null };
  }
  if (Math.abs(delta) <= tol) {
    return { state: "EXACT", delta, remainder: null };
  }
  if (args.totalIsObserved && delta > 0 && args.componentCount > 0) {
    return { state: "PARTIALLY_ATTRIBUTED", delta, remainder: delta };
  }
  return { state: "UNAVAILABLE", delta, remainder: null };
}
