/**
 * lib/history/net-worth-node.ts
 *
 * V27-B — THE canonical Net Worth historical-point authority.
 *
 * ── What it composes, and what it refuses to re-derive ───────────────────────
 * One question: "what made up Net Worth on this date?" — answered ONLY from
 * things already decided elsewhere:
 *
 *   getRecentSnapshots        the ONE snapshot read boundary. Supplies the
 *                             stored totals AND Slice A's aggregateAuthorisation,
 *                             already resolved. This module never re-derives
 *                             assertability.
 *   computeSnapshotFields     the ONE place the aggregate arithmetic lives; the
 *                             bucket partition here is transcribed from it and
 *                             pinned by test.
 *   reconciliation.core       the ONE reconciliation vocabulary.
 *
 * It prices nothing, owns nothing, replays nothing and authorises nothing.
 *
 * ── The three things that must never be conflated ────────────────────────────
 * V27-B3 is explicit about this and it is the subtlest part of the module:
 *
 *   REAL-ASSETS RESIDUAL   a canonical bucket. `computeSnapshotFields` folds
 *                          real assets into totalAssets and netWorth without
 *                          storing a column, so the value is recovered by
 *                          subtraction. It is PART OF THE COMPUTATION — a real
 *                          component whose internal composition we simply do not
 *                          hold. It is never an account and never a holding.
 *
 *   UNATTRIBUTED OBSERVED  `recorded total − explained children`, and only when
 *   REMAINDER              the total was RECORDED. It is a subtraction, not an
 *                          asset. A computed total may never have one.
 *
 *   CONTRADICTION          the evidence disagrees with itself. Refused outright,
 *                          never softened into either of the above.
 *
 * They live in three different fields with three different labels, deliberately.
 */

import type { Snapshot } from "@/types";
import {
  classifyReconciliation, round2, type ReconciliationState,
} from "@/lib/perspective-engine/reconciliation.core";
import {
  derivedRealAssets, type AggregateAuthorisationMap,
} from "@/lib/snapshots/aggregate-authorisation.core";
import {
  explainedFromComponents, extendBreadcrumb,
  type BucketKind, type HistoricalBucketNode, type HistoricalCrumb,
  type HistoricalLensNode, type HistoricalNode, type ValueBasis,
} from "./historical-node.core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/**
 * THE NET-WORTH PARTITION, transcribed from `computeSnapshotFields`:
 *
 *   totalAssets = stocks + crypto + cash + savings + realAssets
 *   netWorth    = totalAssets − debt
 *
 * Order is the display order. `subtracts` is the side of the sheet.
 */
const BUCKETS: readonly {
  kind: BucketKind; label: string; subtracts: boolean;
  /** Which Snapshot field carries it; null ⇒ derived by subtraction. */
  field: keyof Snapshot | null;
}[] = [
  { kind: "investments", label: "Investments", subtracts: false, field: "totalInvestments" },
  { kind: "crypto",      label: "Crypto",      subtracts: false, field: "totalCrypto" },
  { kind: "cash",        label: "Cash",        subtracts: false, field: "totalCash" },
  { kind: "savings",     label: "Savings",     subtracts: false, field: "totalSavings" },
  { kind: "real-assets", label: "Real assets", subtracts: false, field: null },
  { kind: "debt",        label: "Debt",        subtracts: true,  field: "totalDebt" },
];

/** Which aggregate-authorisation component gates each bucket. */
const BUCKET_COMPONENT: Record<BucketKind, "stocks" | "crypto" | "cash" | "savings" | "debt" | "realAssets"> = {
  investments: "stocks", crypto: "crypto", cash: "cash",
  savings: "savings", "real-assets": "realAssets", debt: "debt",
};

/** A bucket with no material value is not a component of anything. */
const MATERIALITY = 0.005;

export interface NetWorthNodeArgs {
  /** The row for the selected date, from the canonical read boundary. */
  snapshot: Snapshot & { aggregateAuthorisation?: AggregateAuthorisationMap };
  dateISO: string;
  fromISO: string;
  toISO:   string;
  currency: string;
}

/**
 * Build the Net Worth root node for one date.
 *
 * PURE over an already-read snapshot: the caller supplies the row (so a window
 * of dates costs one read, not N), and every authorisation on it was resolved at
 * the read boundary. Deterministic; never throws.
 */
export function buildNetWorthNode(args: NetWorthNodeArgs): HistoricalLensNode {
  const { snapshot: s, dateISO, fromISO, toISO, currency } = args;
  const auth = s.aggregateAuthorisation;
  const basis: ValueBasis = s.isEstimated === false ? "observed" : "reconstructed";
  const tier: CompletenessTier = (s.completenessTier as CompletenessTier | undefined) ?? "unknown";

  const rootCrumb: HistoricalCrumb = { id: "net-worth", label: "Net worth", nodeType: "lens" };

  // The residual is canonical arithmetic, not a guess: it is exactly what
  // `computeSnapshotFields` folded in and did not store.
  const realAssets = derivedRealAssets({
    stocks: s.totalInvestments, crypto: s.totalCrypto, cash: s.totalCash,
    savings: s.totalSavings, debt: s.totalDebt,
    total: s.totalInvestments + s.totalCrypto,
    totalAssets: s.totalAssets, netWorth: s.netWorth,
    netLiquid: s.netLiquid ?? 0, cashOnHand: s.cashOnHand,
  });

  const components: HistoricalNode[] = [];
  for (const b of BUCKETS) {
    const value = b.field === null ? realAssets : (s[b.field] as number);
    if (!Number.isFinite(value) || Math.abs(value) < MATERIALITY) continue;

    // Assertability comes from Slice A, per component. Absent authorisation
    // (a DTO built before Slice A) leaves the bucket assertable — the same
    // backward-compatible posture the read boundary takes.
    const componentKey = BUCKET_COMPONENT[b.kind];
    const componentAssertable = auth
      ? !auth.netWorth.unassertableComponents.includes(componentKey)
      : true;

    components.push({
      nodeType: "bucket",
      id: `bucket:${b.kind}`,
      label: b.label,
      bucketKind: b.kind,
      subtracts: b.subtracts,
      dateISO, fromISO, toISO, currency,
      displayedValue: componentAssertable ? round2(value) : null,
      // A bucket's own children arrive in Slice C; it explains nothing yet.
      explainedValue: null,
      unattributedObservedAmount: null,
      reconciliation: componentAssertable ? "EXACT" : "UNAVAILABLE",
      assertable: componentAssertable,
      unavailableReason: componentAssertable ? null : "AGGREGATE_COMPONENT_UNASSERTABLE",
      provenance: {
        basis, tier,
        supportedFromISO: null, supportedToISO: null,
        note: b.kind === "investments"
          // DISAMBIGUATION. Under Net Worth, Investments and Crypto are SIBLING
          // components of `computeSnapshotFields`' partition, so this bucket is
          // securities only. The Investments LENS is the `total` aggregate
          // (securities + crypto) and is a larger number. Same word, two scopes
          // — saying which one this is costs a sentence and prevents a reader
          // concluding one of them is wrong.
          ? "Securities only. Crypto is a separate component of net worth."
          : b.kind === "real-assets"
          // The one bucket whose honesty depends on saying what it is NOT.
          ? "Part of the recorded asset total that is not investments, crypto, cash or savings. Fourth Meridian does not hold its per-account composition."
          : null,
      },
      breadcrumb: extendBreadcrumb([rootCrumb], { id: `bucket:${b.kind}`, label: b.label, nodeType: "bucket" }),
      components: [],
      // Real assets can never be drilled: there is nothing beneath a residual.
      drilldown: b.kind === "real-assets"
        ? { available: false, reason: "REAL_ASSETS_HAVE_NO_STORED_COMPOSITION" }
        : { available: componentAssertable, reason: componentAssertable ? null : "AGGREGATE_COMPONENT_UNASSERTABLE" },
      historicalCount: 0,
      valuedCount: 0,
    } satisfies HistoricalBucketNode);
  }

  const rootAuth = auth?.netWorth;
  const displayedValue = rootAuth && !rootAuth.assertable ? null : round2(s.netWorth);
  const explainedValue = round2(explainedFromComponents(components));

  const explainedAssets = round2(
    components.filter((c) => c.nodeType === "bucket" && !c.subtracts && c.assertable && c.displayedValue != null)
      .reduce((n, c) => n + (c.displayedValue ?? 0), 0),
  );
  const explainedLiabilities = round2(
    components.filter((c) => c.nodeType === "bucket" && c.subtracts && c.assertable && c.displayedValue != null)
      .reduce((n, c) => n + (c.displayedValue ?? 0), 0),
  );

  // ── Reconciliation ────────────────────────────────────────────────────────
  //
  // Slice A already decided whether the AGGREGATE may be asserted. This decides
  // whether its CHILDREN explain it. The two are different questions and the
  // first dominates: an aggregate nothing may assert cannot be explained by
  // anything, however well the children happen to sum.
  let reconciliation: ReconciliationState;
  let unattributed: number | null = null;
  let unavailableReason: string | null = null;

  if (rootAuth && rootAuth.state === "CONTRADICTORY") {
    reconciliation = "CONTRADICTORY";
    unavailableReason = rootAuth.refusalReason;
  } else if (rootAuth && !rootAuth.assertable) {
    reconciliation = "UNAVAILABLE";
    unavailableReason = rootAuth.refusalReason;
  } else if (components.length === 0) {
    reconciliation = "UNAVAILABLE";
    unavailableReason = "NO_COMPONENTS";
  } else {
    const r = classifyReconciliation({
      total: s.netWorth,
      explained: explainedValue,
      // THE discriminator. A recorded total survives an unexplained part; a
      // computed one does not, because the part is inside it.
      totalIsObserved: basis === "observed",
      componentCount: components.length,
    });
    reconciliation = r.state;
    unattributed = r.remainder;
    if (r.state === "UNAVAILABLE") unavailableReason = "AGGREGATE_STALE";
    if (r.state === "CONTRADICTORY") unavailableReason = "AGGREGATE_IDENTITY_VIOLATED";
  }

  const assertable = reconciliation === "EXACT" || reconciliation === "PARTIALLY_ATTRIBUTED";

  return {
    nodeType: "lens",
    lens: "net-worth",
    id: "net-worth",
    label: "Net worth",
    dateISO, fromISO, toISO, currency,
    displayedValue: assertable ? displayedValue : null,
    explainedValue: components.length > 0 ? explainedValue : null,
    unattributedObservedAmount: unattributed,
    reconciliation,
    assertable,
    unavailableReason,
    provenance: {
      basis, tier,
      supportedFromISO: null, supportedToISO: null,
      note: null,
    },
    breadcrumb: [rootCrumb],
    // Components are ALWAYS carried, even when the root refuses.
    //
    // Suppressing them here would have made `historicalCount` describe a set the
    // DTO no longer contained, and — worse — would have thrown away the only
    // evidence that explains the refusal: on the 378 contaminated rows it is the
    // crypto bucket, and a reader deserves to see WHICH component failed. The
    // refusal is expressed by `assertable` / `reconciliation`, and honouring it
    // is the consumer's contract (a CONTRADICTORY or UNAVAILABLE node must not
    // render an apparently valid composition), not a reason to withhold
    // diagnostics from the transport.
    components,
    drilldown: { available: assertable && components.length > 0, reason: assertable ? null : unavailableReason },
    historicalCount: components.length,
    valuedCount: components.filter((c) => c.displayedValue != null).length,
    explainedAssets: components.length > 0 ? explainedAssets : null,
    explainedLiabilities: components.length > 0 ? explainedLiabilities : null,
  };
}
