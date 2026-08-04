/**
 * lib/history/lens-root-node.ts
 *
 * THE canonical lens roots. Pure over one already-read snapshot.
 *
 * ── What a "root" is, and what it is not ─────────────────────────────────────
 * A root is a QUESTION, not a new calculation. Every root here selects an
 * existing canonical authority and re-frames it:
 *
 *   net-worth          `buildNetWorthNode` verbatim — the six-bucket partition
 *   assets             the five asset buckets, totalling the stored totalAssets
 *   liquid-net-worth   cash + savings − debt, totalling the stored netLiquid
 *   debt / investments the corresponding BUCKET, re-framed as its own root so
 *   crypto / cash      it can be entered directly instead of only beneath
 *   savings            Net Worth
 *
 * Nothing here prices, owns, replays or authorises. `buildNetWorthNode` is
 * called ONCE and everything else is a projection of its output, so a root can
 * never disagree with the tree it belongs to.
 *
 * ── Why there is no `liabilities` root ───────────────────────────────────────
 * There is no `totalLiabilities` aggregate. `debt` is a COMPONENT, and the
 * Wealth chart's "Liabilities" metric is `totalDebt` renamed in the view layer.
 * A `lens:liabilities` root would be a second name for `lens:debt` with the same
 * value, the same children and the same reconciliation — a duplicate concept.
 * The product may keep the LABEL; the identity resolves to debt.
 */

import type { Snapshot } from "@/types";
import {
  classifyReconciliation, round2, type ReconciliationState,
} from "@/lib/perspective-engine/reconciliation.core";
import type { AggregateAuthorisationMap, SnapshotAggregate } from "@/lib/snapshots/aggregate-authorisation.core";
import { buildNetWorthNode } from "./net-worth-node";
import {
  explainedFromComponents, LIQUIDITY_TIERS,
  type BucketKind, type HistoricalBucketNode, type HistoricalCrumb,
  type HistoricalLensNode, type HistoricalNode, type HistoricalTierNode,
  type LiquidityTier,
} from "./historical-node.core";

/** Every legitimate exploration root. `liabilities` is deliberately absent. */
export const LENS_ROOTS = [
  "net-worth", "assets", "liquid-net-worth",
  "investments", "crypto", "cash", "savings", "debt",
  "liquidity",
] as const;
export type LensRoot = (typeof LENS_ROOTS)[number];

/** Product labels may differ from identities. "Liabilities" IS debt. */
export const LENS_ROOT_ALIASES: Record<string, LensRoot> = {
  liabilities: "debt",
  networth: "net-worth",
  "liquid-nw": "liquid-net-worth",
  wealth: "net-worth",
};

export function normaliseLensRoot(raw: string | null | undefined): LensRoot | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if ((LENS_ROOTS as readonly string[]).includes(v)) return v as LensRoot;
  return LENS_ROOT_ALIASES[v] ?? null;
}

/** A root whose children are BUCKETS, totalling a stored aggregate column. */
const AGGREGATE_ROOTS: Record<string, {
  label: string;
  aggregate: SnapshotAggregate;
  /** Buckets that ADD, in display order. */
  adds: BucketKind[];
  /** Buckets that SUBTRACT. */
  subtracts: BucketKind[];
  total: (s: Snapshot) => number;
  formula: string;
}> = {
  assets: {
    label: "Assets",
    aggregate: "totalAssets",
    adds: ["investments", "crypto", "cash", "savings", "real-assets"],
    subtracts: [],
    total: (s) => s.totalAssets,
    formula: "Investments + Crypto + Cash + Savings + Real assets",
  },
  "liquid-net-worth": {
    label: "Liquid net worth",
    aggregate: "netLiquid",
    // The repository's ACTUAL formula: cash + savings − debt. Investments and
    // crypto are NOT liquid net worth, and a root that showed them (greyed out
    // or otherwise) would teach the reader that the total ought to include them.
    adds: ["cash", "savings"],
    subtracts: ["debt"],
    total: (s) => s.netLiquid ?? 0,
    formula: "Cash + Savings − Debt",
  },
};

/** A root that IS a bucket, entered directly rather than through Net Worth. */
const BUCKET_ROOTS: Record<string, BucketKind> = {
  investments: "investments",
  crypto: "crypto",
  cash: "cash",
  savings: "savings",
  debt: "debt",
};

export function isBucketRoot(lens: LensRoot): boolean {
  return lens in BUCKET_ROOTS;
}
export function bucketKindForRoot(lens: LensRoot): BucketKind | null {
  return BUCKET_ROOTS[lens] ?? null;
}
export function isAggregateRoot(lens: LensRoot): boolean {
  return lens in AGGREGATE_ROOTS;
}

/**
 * THE LIQUIDITY TIERS, transcribed from `lib/perspective-engine/lenses/
 * liquidity.core.ts` — the module that owns the vocabulary:
 *
 *   cashNow    = Σ balance (checking, savings)
 *   marketable = Σ balance (investment, crypto)   "could be raised by selling"
 *   illiquid   = Σ balance (other / manual / real assets)
 *   credit     = borrowing capacity — NEVER liquidity, NEVER in a sum
 *
 * There is NO liability subtraction anywhere in this lens. Liquidity asks "how
 * fast could I raise cash", not "what do I own net of debt" — that second
 * question is Liquid Net Worth, and conflating them would put debt inside a
 * total the doctrine says it never enters.
 */
const LIQUIDITY_TIER_SPEC: { tier: LiquidityTier; label: string; buckets: BucketKind[]; note: string }[] = [
  { tier: "cashNow",    label: "Cash now",    buckets: ["cash", "savings"],
    note: "Immediately available — checking and savings." },
  { tier: "marketable", label: "Marketable",  buckets: ["investments", "crypto"],
    note: "Could be raised by selling, before tax or penalty." },
  { tier: "illiquid",   label: "Illiquid",    buckets: ["real-assets"],
    note: "Not readily convertible." },
];

/**
 * The LIQUIDITY root: tiers, then the buckets inside each.
 *
 * The tier sum is the asset side only, which is why it totals `totalAssets` and
 * not `netWorth` — and why the reconciliation is stated against that column.
 */
export function buildLiquidityRootNode(args: Omit<LensRootArgs, "lens">): HistoricalLensNode {
  const { snapshot: s, dateISO, fromISO, toISO, currency } = args;
  const nw = buildNetWorthNode({ snapshot: s, dateISO, fromISO, toISO, currency });
  const rootCrumb: HistoricalCrumb = { id: "lens:liquidity", label: "Liquidity", nodeType: "lens" };

  const tiers: HistoricalTierNode[] = LIQUIDITY_TIER_SPEC.map((spec) => {
    const buckets = nw.components.filter(
      (c): c is HistoricalBucketNode => c.nodeType === "bucket" && spec.buckets.includes(c.bucketKind),
    ).map((c) => ({
      ...c,
      subtracts: false, // no tier subtracts; liquidity has no liability side
      breadcrumb: [rootCrumb, { id: `tier:${spec.tier}`, label: spec.label, nodeType: "tier" as const },
                   { id: c.id, label: c.label, nodeType: "bucket" as const }],
    }));
    const explained = round2(explainedFromComponents(buckets));
    const allAssertable = buckets.length > 0 && buckets.every((b) => b.assertable);
    return {
      nodeType: "tier" as const,
      tier: spec.tier,
      id: `tier:${spec.tier}`,
      label: spec.label,
      dateISO, fromISO, toISO, currency,
      // A tier IS the sum of its buckets — it has no stored column of its own,
      // so it is COMPUTED and may never carry an observed remainder.
      displayedValue: allAssertable ? explained : null,
      explainedValue: buckets.length > 0 ? explained : null,
      unattributedObservedAmount: null,
      reconciliation: allAssertable ? "EXACT" as const
        : buckets.length === 0 ? "UNAVAILABLE" as const : "UNAVAILABLE" as const,
      assertable: allAssertable,
      unavailableReason: allAssertable ? null
        : buckets.length === 0 ? "NO_COMPONENTS_IN_TIER" : "TIER_COMPONENT_UNASSERTABLE",
      provenance: { ...nw.provenance, note: spec.note },
      breadcrumb: [rootCrumb, { id: `tier:${spec.tier}`, label: spec.label, nodeType: "tier" as const }],
      components: buckets as HistoricalNode[],
      drilldown: { available: allAssertable && buckets.length > 0, reason: allAssertable ? null : "TIER_COMPONENT_UNASSERTABLE" },
      historicalCount: buckets.length,
      valuedCount: buckets.filter((b) => b.displayedValue != null).length,
    };
  }).filter((t) => t.historicalCount > 0);

  const auth = s.aggregateAuthorisation?.totalAssets;
  const explained = round2(explainedFromComponents(tiers as HistoricalNode[]));
  const stored = s.totalAssets;

  let reconciliation: ReconciliationState;
  let unattributed: number | null = null;
  let unavailableReason: string | null = null;
  if (auth && auth.state === "CONTRADICTORY") {
    reconciliation = "CONTRADICTORY"; unavailableReason = auth.refusalReason;
  } else if (auth && !auth.assertable) {
    reconciliation = "UNAVAILABLE"; unavailableReason = auth.refusalReason;
  } else if (tiers.length === 0) {
    reconciliation = "UNAVAILABLE"; unavailableReason = "NO_COMPONENTS";
  } else {
    const r = classifyReconciliation({
      total: stored, explained,
      totalIsObserved: nw.provenance.basis === "observed",
      componentCount: tiers.length,
    });
    reconciliation = r.state; unattributed = r.remainder;
    if (r.state === "UNAVAILABLE") unavailableReason = "AGGREGATE_STALE";
    if (r.state === "CONTRADICTORY") unavailableReason = "AGGREGATE_IDENTITY_VIOLATED";
  }
  const assertable = reconciliation === "EXACT" || reconciliation === "PARTIALLY_ATTRIBUTED";

  return {
    nodeType: "lens", lens: "liquidity", id: "lens:liquidity", label: "Liquidity",
    dateISO, fromISO, toISO, currency,
    displayedValue: assertable ? round2(stored) : null,
    explainedValue: tiers.length > 0 ? explained : null,
    unattributedObservedAmount: unattributed,
    reconciliation, assertable, unavailableReason,
    provenance: {
      ...nw.provenance,
      note: "Cash now + Marketable + Illiquid. Borrowing capacity is not liquidity and is excluded.",
    },
    breadcrumb: [rootCrumb],
    components: tiers as HistoricalNode[],
    drilldown: { available: assertable && tiers.length > 0, reason: assertable ? null : unavailableReason },
    historicalCount: tiers.length,
    valuedCount: tiers.filter((t) => t.displayedValue != null).length,
    // Liquidity has no liability side at all — stating 0 would imply one exists.
    explainedAssets: tiers.length > 0 ? explained : null,
    explainedLiabilities: null,
  };
}

export { LIQUIDITY_TIERS };

export interface LensRootArgs {
  snapshot: Snapshot & { aggregateAuthorisation?: AggregateAuthorisationMap };
  lens: LensRoot;
  dateISO: string;
  fromISO: string;
  toISO: string;
  currency: string;
}

/**
 * Build a root node for one lens on one date.
 *
 * Returns null for a bucket-backed root — the caller resolves those by expanding
 * the bucket into accounts (see `reframeBucketAsRoot`), because a bucket root's
 * children are ACCOUNTS, and accounts require a database read this pure module
 * must not perform.
 */
export function buildLensRootNode(args: LensRootArgs): HistoricalLensNode | null {
  const { snapshot: s, lens, dateISO, fromISO, toISO, currency } = args;

  // ONE call. Every root is a projection of the same partition, which is what
  // makes two roots incapable of disagreeing about a shared bucket.
  const nw = buildNetWorthNode({ snapshot: s, dateISO, fromISO, toISO, currency });
  if (lens === "net-worth") return nw;

  const spec = AGGREGATE_ROOTS[lens];
  if (!spec) return null; // bucket-backed or liquidity — resolved by the binding

  const wanted = new Set<BucketKind>([...spec.adds, ...spec.subtracts]);
  const components: HistoricalBucketNode[] = nw.components
    .filter((c): c is HistoricalBucketNode => c.nodeType === "bucket" && wanted.has(c.bucketKind))
    // The root's OWN sign convention: a bucket that subtracts under Net Worth
    // may not subtract here, and vice versa. Assets has no subtrahend at all.
    .map((c) => ({ ...c, subtracts: spec.subtracts.includes(c.bucketKind) }))
    .sort((a, b) => order(spec, a.bucketKind) - order(spec, b.bucketKind));

  const rootCrumb: HistoricalCrumb = { id: `lens:${lens}`, label: spec.label, nodeType: "lens" };
  const rebased: HistoricalBucketNode[] = components.map((c) => ({
    ...(c as HistoricalBucketNode),
    breadcrumb: [rootCrumb, { id: c.id, label: c.label, nodeType: "bucket" as const }],
  }));

  const auth = s.aggregateAuthorisation?.[spec.aggregate];
  const stored = spec.total(s);
  const explained = round2(explainedFromComponents(rebased));

  let reconciliation: ReconciliationState;
  let unattributed: number | null = null;
  let unavailableReason: string | null = null;

  if (auth && auth.state === "CONTRADICTORY") {
    reconciliation = "CONTRADICTORY";
    unavailableReason = auth.refusalReason;
  } else if (auth && !auth.assertable) {
    reconciliation = "UNAVAILABLE";
    unavailableReason = auth.refusalReason;
  } else if (rebased.length === 0) {
    reconciliation = "UNAVAILABLE";
    unavailableReason = "NO_COMPONENTS";
  } else {
    const r = classifyReconciliation({
      total: stored,
      explained,
      totalIsObserved: nw.provenance.basis === "observed",
      componentCount: rebased.length,
    });
    reconciliation = r.state;
    unattributed = r.remainder;
    if (r.state === "UNAVAILABLE") unavailableReason = "AGGREGATE_STALE";
    if (r.state === "CONTRADICTORY") unavailableReason = "AGGREGATE_IDENTITY_VIOLATED";
  }

  const assertable = reconciliation === "EXACT" || reconciliation === "PARTIALLY_ATTRIBUTED";

  return {
    nodeType: "lens",
    lens,
    id: `lens:${lens}`,
    label: spec.label,
    dateISO, fromISO, toISO, currency,
    displayedValue: assertable ? round2(stored) : null,
    explainedValue: rebased.length > 0 ? explained : null,
    unattributedObservedAmount: unattributed,
    reconciliation,
    assertable,
    unavailableReason,
    provenance: {
      ...nw.provenance,
      // The root states its OWN formula. A reader who cannot see which terms are
      // included cannot tell a missing component from an excluded one.
      note: spec.formula,
    },
    breadcrumb: [rootCrumb],
    components: rebased,
    drilldown: { available: assertable && rebased.length > 0, reason: assertable ? null : unavailableReason },
    historicalCount: rebased.length,
    valuedCount: rebased.filter((c) => c.displayedValue != null).length,
    explainedAssets: round2(
      rebased.filter((c) => !c.subtracts && c.assertable && c.displayedValue != null)
        .reduce((n, c) => n + (c.displayedValue ?? 0), 0),
    ),
    explainedLiabilities: round2(
      rebased.filter((c) => c.subtracts && c.assertable && c.displayedValue != null)
        .reduce((n, c) => n + (c.displayedValue ?? 0), 0),
    ),
  };
}

function order(spec: { adds: BucketKind[]; subtracts: BucketKind[] }, k: BucketKind): number {
  const i = spec.adds.indexOf(k);
  return i >= 0 ? i : spec.adds.length + spec.subtracts.indexOf(k);
}

/**
 * Re-frame an already-expanded BUCKET as its own root.
 *
 * The value, the children and the reconciliation are the bucket's own — this
 * changes the FRAME, not the finances. What it does change is the breadcrumb
 * (the path now starts here) and the sign: `subtracts` describes a bucket's
 * relationship to Net Worth, and a root has no parent to subtract from. Debt as
 * a root is "what you owe", positive, not "−$X against your assets".
 */
export function reframeBucketAsRoot(
  bucket: HistoricalBucketNode,
  lens: LensRoot,
  label: string,
): HistoricalLensNode {
  const rootCrumb: HistoricalCrumb = { id: `lens:${lens}`, label, nodeType: "lens" };
  return {
    nodeType: "lens",
    lens,
    id: `lens:${lens}`,
    label,
    dateISO: bucket.dateISO, fromISO: bucket.fromISO, toISO: bucket.toISO,
    currency: bucket.currency,
    displayedValue: bucket.displayedValue,
    explainedValue: bucket.explainedValue,
    unattributedObservedAmount: bucket.unattributedObservedAmount,
    reconciliation: bucket.reconciliation,
    assertable: bucket.assertable,
    unavailableReason: bucket.unavailableReason,
    provenance: bucket.provenance,
    breadcrumb: [rootCrumb],
    components: bucket.components.map((c) => ({
      ...c,
      breadcrumb: [rootCrumb, { id: c.id, label: c.label, nodeType: c.nodeType }],
    })),
    drilldown: bucket.drilldown,
    series: bucket.series,
    historicalCount: bucket.historicalCount,
    valuedCount: bucket.valuedCount,
    // A bucket root is one side of the sheet, so only that side is explained.
    explainedAssets: bucket.subtracts ? null : bucket.explainedValue,
    explainedLiabilities: bucket.subtracts ? bucket.explainedValue : null,
  };
}

/** Display label for a root. The product's word, not the identity. */
export const LENS_ROOT_LABELS: Record<LensRoot, string> = {
  "net-worth": "Net worth",
  assets: "Assets",
  "liquid-net-worth": "Liquid net worth",
  investments: "Investments",
  crypto: "Crypto",
  cash: "Cash",
  savings: "Savings",
  debt: "Debt",
  liquidity: "Liquidity",
};
