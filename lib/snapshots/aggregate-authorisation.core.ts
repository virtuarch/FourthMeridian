/**
 * lib/snapshots/aggregate-authorisation.core.ts
 *
 * V27-A — MAY THIS AGGREGATE BE ASSERTED?
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * Components carry authorisation; aggregates did not. `cryptoValuationStatus`
 * authorises `crypto` alone, while `netWorth`, `totalAssets`, `total` and
 * `netLiquid` are arithmetically composed FROM it and carry nothing of their
 * own. Measured by the V26-S4 probe: 378 rows whose crypto may not be asserted
 * while their aggregates assert freely.
 *
 * One existing helper — `isAssetSideContaminated` — already encoded a special
 * case of this ("crypto is unassertable, therefore the asset side is too"). It
 * is correct and stays; this module is the general rule it was a preview of.
 *
 * ── The rule, stated once ────────────────────────────────────────────────────
 *   An aggregate may be asserted only when EVERY component it is composed from
 *   is itself assertable.
 *
 * and, when that fails, which of the four outcomes applies depends on ONE thing:
 * whether the aggregate is a RECORDING or a COMPUTATION.
 *
 *   OBSERVED aggregate  (isEstimated === false)
 *     The number was recorded directly and stands on its own authority. What we
 *     lose is the ability to EXPLAIN all of it, not the number itself. So:
 *     explained = Σ assertable components, remainder = the rest.
 *     → PARTIALLY_ATTRIBUTED
 *
 *   COMPUTED aggregate  (isEstimated === true)
 *     The number was produced BY those components. If one of them may not be
 *     asserted then neither may the sum that contains it — the unassertability
 *     propagates through the arithmetic. There is no remainder to state, because
 *     there is no independent total to subtract from.
 *     → UNAVAILABLE
 *
 * Never the other way round. A computed total that disagrees with its parts is
 * stale or contradictory, never "partially attributed" — that would dress a
 * stale number as evidence.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * It does not decide whether a COMPONENT is assertable — that is the component
 * authorities' job (`resolveCryptoValuationState` today) and duplicating any of
 * it here would be a second authorisation model. It receives their verdicts.
 */

import {
  classifyReconciliation, round2, toleranceFor,
  type ReconciliationState,
} from "@/lib/perspective-engine/reconciliation.core";

export type { ReconciliationState };

/**
 * The stored components an aggregate can be composed from.
 *
 * `realAssets` is REAL and is deliberately in this list even though
 * `SpaceSnapshot` has no column for it: `computeSnapshotFields` folds it into
 * `totalAssets` and `netWorth` without storing it separately, so it exists in
 * every such aggregate and can only be recovered by subtraction. Pretending it
 * is absent would make `totalAssets` look contradictory on any Space that holds
 * property or a vehicle.
 */
export const SNAPSHOT_COMPONENTS = [
  "stocks", "crypto", "cash", "savings", "debt", "realAssets",
] as const;
export type SnapshotComponent = (typeof SNAPSHOT_COMPONENTS)[number];

/** The aggregates a consumer may want to assert. */
export const SNAPSHOT_AGGREGATES = [
  "total", "totalAssets", "netWorth", "netLiquid", "cashOnHand",
] as const;
export type SnapshotAggregate = (typeof SNAPSHOT_AGGREGATES)[number];

/**
 * WHICH COMPONENTS EACH AGGREGATE IS COMPOSED FROM.
 *
 * Transcribed from `computeSnapshotFields` (lib/snapshots/backfill-core.ts) —
 * the ONE place the arithmetic lives — and pinned by a test against that source,
 * so the two cannot drift apart silently:
 *
 *   total       = stocks + crypto
 *   totalAssets = total + cash + savings + realAssets
 *   netWorth    = totalAssets − debt
 *   netLiquid   = cash + savings − debt
 *   cashOnHand  = max(cash, 0)
 */
export const AGGREGATE_COMPOSITION: Record<SnapshotAggregate, readonly SnapshotComponent[]> = {
  total:       ["stocks", "crypto"],
  totalAssets: ["stocks", "crypto", "cash", "savings", "realAssets"],
  netWorth:    ["stocks", "crypto", "cash", "savings", "realAssets", "debt"],
  netLiquid:   ["cash", "savings", "debt"],
  cashOnHand:  ["cash"],
};

/** Machine-readable refusal reasons. Coded, never free text. */
export const AGGREGATE_REFUSAL_REASONS = [
  "AGGREGATE_COMPONENT_UNASSERTABLE",
  "AGGREGATE_IDENTITY_VIOLATED",
  "AGGREGATE_STALE",
] as const;
export type AggregateRefusalReason = (typeof AGGREGATE_REFUSAL_REASONS)[number];

export interface AggregateAuthorisationInput {
  /** The row's stored values. `realAssets` is recovered by the caller-free rule below. */
  values: Readonly<Record<SnapshotAggregate | "stocks" | "crypto" | "cash" | "savings" | "debt", number>>;
  /**
   * Per-component assertability, as the COMPONENT authorities decided it. A
   * component absent from this map is assertable: silence here means "no
   * authority has anything to say", which for `cash`/`savings`/`debt`/`stocks`
   * is the truth today — only crypto currently carries authorisation.
   */
  componentAssertable: Readonly<Partial<Record<SnapshotComponent, boolean>>>;
  /** False ⇒ the row's totals are RECORDED observations, not computations. */
  isEstimated: boolean;
}

export interface AggregateAuthorisation {
  aggregate: SnapshotAggregate;
  state: ReconciliationState;
  /** True for EXACT and PARTIALLY_ATTRIBUTED — the aggregate may be shown. */
  assertable: boolean;
  /** Σ of the assertable components, or null when nothing could be summed. */
  explained: number | null;
  /**
   * `observed total − explained`, and ONLY under PARTIALLY_ATTRIBUTED. It is not
   * cash, not a gain and not a missing component — it is a subtraction, and the
   * consumer must say so.
   */
  remainder: number | null;
  /** Components this aggregate contains that may not be asserted. */
  unassertableComponents: SnapshotComponent[];
  refusalReason: AggregateRefusalReason | null;
}

export type AggregateAuthorisationMap = Record<SnapshotAggregate, AggregateAuthorisation>;

/**
 * IDENTITIES THAT MUST HOLD BETWEEN STORED COLUMNS.
 *
 * Only relationships where BOTH sides are stored are checkable. Verified across
 * all 1,686 live rows before being encoded here — each holds on every one.
 *
 * `cashOnHand` is deliberately NOT checked. Its formula has drifted: the schema
 * comment describes `max(cash − expense_buffer, 0)` while both writers compute
 * `max(cash, 0)`, and 483 seeded rows hold a third value entirely. Encoding an
 * identity it does not satisfy would manufacture 483 contradictions out of a
 * naming disagreement, so it is authorised by its component and left
 * arithmetically unasserted.
 */
function identityViolations(v: AggregateAuthorisationInput["values"]): string[] {
  const out: string[] = [];
  const tol = 0.01;
  if (Math.abs(v.total - (v.stocks + v.crypto)) > tol) {
    out.push(`total ${round2(v.total)} != stocks + crypto ${round2(v.stocks + v.crypto)}`);
  }
  if (Math.abs(v.netWorth - (v.totalAssets - v.debt)) > tol) {
    out.push(`netWorth ${round2(v.netWorth)} != totalAssets − debt ${round2(v.totalAssets - v.debt)}`);
  }
  if (Math.abs(v.netLiquid - (v.cash + v.savings - v.debt)) > tol) {
    out.push(`netLiquid ${round2(v.netLiquid)} != cash + savings − debt ${round2(v.cash + v.savings - v.debt)}`);
  }
  // `totalAssets` carries the UNSTORED realAssets component, so it is bounded
  // rather than equated: the residual IS realAssets and cannot be negative.
  const realAssets = v.totalAssets - (v.stocks + v.crypto + v.cash + v.savings);
  if (realAssets < -tol) {
    out.push(`totalAssets ${round2(v.totalAssets)} is below its stored components by ${round2(-realAssets)}`);
  }
  return out;
}

/** The unstored real-asset component, recovered by subtraction. Never negative. */
export function derivedRealAssets(v: AggregateAuthorisationInput["values"]): number {
  return Math.max(0, round2(v.totalAssets - (v.stocks + v.crypto + v.cash + v.savings)));
}

/** The signed contribution one component makes to one aggregate. */
function contribution(
  aggregate: SnapshotAggregate,
  component: SnapshotComponent,
  v: AggregateAuthorisationInput["values"],
): number {
  if (component === "realAssets") return derivedRealAssets(v);
  // Liabilities SUBTRACT from netWorth and netLiquid; they are not a negative
  // asset, they are the other side of the sheet.
  const magnitude = v[component];
  const subtracts = component === "debt";
  return subtracts ? -magnitude : magnitude;
}

/**
 * Authorise every aggregate on one row.
 *
 * Total and deterministic; never throws. Identical inputs give an identical map.
 */
export function authoriseAggregates(
  input: AggregateAuthorisationInput,
): AggregateAuthorisationMap {
  const { values, componentAssertable, isEstimated } = input;
  const totalIsObserved = isEstimated === false;
  const violations = identityViolations(values);

  const out = {} as AggregateAuthorisationMap;
  for (const aggregate of SNAPSHOT_AGGREGATES) {
    const components = AGGREGATE_COMPOSITION[aggregate];
    const unassertable = components.filter((c) => componentAssertable[c] === false);

    // An identity failure is a property of the ROW's arithmetic, so it
    // invalidates every aggregate that identity touches. Reported before any
    // friendlier outcome — a contradiction is never softened into a remainder.
    if (violations.length > 0) {
      out[aggregate] = {
        aggregate, state: "CONTRADICTORY", assertable: false,
        explained: null, remainder: null,
        unassertableComponents: unassertable,
        refusalReason: "AGGREGATE_IDENTITY_VIOLATED",
      };
      continue;
    }

    const total = values[aggregate];

    if (unassertable.length === 0) {
      // Every component stands, so the aggregate stands. Nothing is subtracted
      // from it and there is nothing to attribute.
      out[aggregate] = {
        aggregate, state: "EXACT", assertable: true,
        explained: round2(total), remainder: null,
        unassertableComponents: [], refusalReason: null,
      };
      continue;
    }

    // ── At least one component may not be asserted ───────────────────────────
    const explained = round2(
      components
        .filter((c) => componentAssertable[c] !== false)
        .reduce((n, c) => n + contribution(aggregate, c, values), 0),
    );

    const { state, remainder } = classifyReconciliation({
      total,
      explained,
      // The discriminator: a RECORDED total survives an unexplainable part; a
      // COMPUTED one does not, because the part is inside it.
      totalIsObserved,
      componentCount: components.length,
    });

    out[aggregate] = {
      aggregate,
      state: totalIsObserved ? state : "UNAVAILABLE",
      assertable: totalIsObserved && state === "PARTIALLY_ATTRIBUTED"
        ? true
        : totalIsObserved && state === "EXACT",
      explained,
      remainder: totalIsObserved ? remainder : null,
      unassertableComponents: unassertable,
      refusalReason: "AGGREGATE_COMPONENT_UNASSERTABLE",
    };
  }
  return out;
}

/** Convenience: is this one aggregate assertable? */
export function isAggregateAssertable(
  map: AggregateAuthorisationMap, aggregate: SnapshotAggregate,
): boolean {
  return map[aggregate].assertable;
}

export { toleranceFor };
