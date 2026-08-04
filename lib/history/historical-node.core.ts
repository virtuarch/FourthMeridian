/**
 * lib/history/historical-node.core.ts
 *
 * V27-B — THE RECURSIVE HISTORICAL EXPLORATION CONTRACT.
 *
 * Pure: no Prisma, no DB, no clock, no network, no prices.
 *
 * ── What this is, and what it must never become ──────────────────────────────
 * A TRANSPORT AND COMPOSITION contract. It carries answers the canonical
 * authorities already produced, in one shape, so a lens root, a bucket, an
 * account and a holding can all be rendered by one component and reconciled by
 * one rule.
 *
 * It is NOT a valuation object. Nothing here prices, owns, replays, or decides
 * assertability. The moment this module computes a financial number it becomes
 * the god-object the perspective engine already refused once.
 *
 * ── Why discriminated types rather than one nullable bag ─────────────────────
 * A holding has no `heldCount` — it IS one holding. A lens root has no
 * `accountId`. Putting every field on one interface would leave half of them
 * permanently null for half the node types, and a reader could not tell
 * "meaningless here" from "unknown here" — which is precisely the distinction
 * this whole arc exists to preserve. So the shared meanings live on the base and
 * the type-specific facts live on the variants.
 *
 * ── Series are NOT part of composition ───────────────────────────────────────
 * A node answers "what was this on this date, and what made it up". A chart
 * answers "how did it move across the window". Those are different questions
 * with different costs — one date versus N — and bundling them would make every
 * composition request pay for a series it may not render. `series` is therefore
 * optional and populated only when a caller asks for it (V27-C/D).
 */

import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { ReconciliationState } from "@/lib/perspective-engine/reconciliation.core";

export type { ReconciliationState };

/** What a node represents. The tree is lens → bucket → account → holding. */
export const HISTORICAL_NODE_TYPES = ["lens", "bucket", "account", "holding"] as const;
export type HistoricalNodeType = (typeof HISTORICAL_NODE_TYPES)[number];

/**
 * Was the displayed value RECORDED, or COMPUTED from parts?
 *
 * The single most load-bearing flag in the contract: it decides whether an
 * unexplained difference may be stated as a remainder (recorded) or must refuse
 * (computed). See `classifyReconciliation`.
 */
export type ValueBasis = "observed" | "reconstructed";

/** One point on a node's own chart. Populated only when a caller asks. */
export interface HistoricalSeriesPoint {
  dateISO: string;
  /** Null where the node has no assertable value for that date — a real gap. */
  value:   number | null;
  basis:   ValueBasis;
  /** Present only when `value` is null. */
  unavailableReason?: string;
}

/** One breadcrumb step. Enough to re-navigate, and nothing more. */
export interface HistoricalCrumb {
  id:       string;
  label:    string;
  nodeType: HistoricalNodeType;
}

/**
 * Provenance, assembled from vocabularies that already exist. Deliberately NOT a
 * new five-value scale — `tier` is the canonical `CompletenessTier`.
 */
export interface HistoricalProvenance {
  basis: ValueBasis;
  tier:  CompletenessTier;
  /** Earliest / latest date this node can be supported at all. Null = unbounded. */
  supportedFromISO: string | null;
  supportedToISO:   string | null;
  /** Short, user-facing, name-free. The authority's own sentence. */
  note: string | null;
}

/** Everything every node type carries, with one meaning at every level. */
export interface HistoricalNodeBase {
  id:       string;
  nodeType: HistoricalNodeType;
  label:    string;

  /** The selected date, and the window INHERITED from the parent, untouched. */
  dateISO:  string;
  fromISO:  string;
  toISO:    string;
  currency: string;

  /** What the parent chart shows for this node. Null when nothing may be asserted. */
  displayedValue: number | null;
  /** Σ of the assertable children. Null when there are no children to sum. */
  explainedValue: number | null;
  /**
   * `displayedValue − explainedValue`, and ONLY when the displayed value was
   * RECORDED and the difference is positive.
   *
   * It is a subtraction, not an asset. It is NOT the real-assets residual (which
   * is a named component of the canonical arithmetic — see `bucketKind`), and it
   * is NOT a contradiction. Those three are kept apart deliberately: collapsing
   * any two of them would let a reader mistake an unexplained gap for a holding.
   */
  unattributedObservedAmount: number | null;

  reconciliation:    ReconciliationState;
  /** True for EXACT and PARTIALLY_ATTRIBUTED — a composition may be rendered. */
  assertable:        boolean;
  /** Coded, never prose. Present for UNAVAILABLE and CONTRADICTORY. */
  unavailableReason: string | null;

  provenance: HistoricalProvenance;
  breadcrumb: HistoricalCrumb[];

  /** The next level down. Empty when this node is a leaf at this depth. */
  components: HistoricalNode[];
  /** Whether a deeper level exists AT ALL for this node, and why not if it does not. */
  drilldown: { available: boolean; reason: string | null };

  /** Populated only when the caller asked for a series. */
  series?: HistoricalSeriesPoint[];
}

/**
 * Counts belong to nodes that HAVE children to count. A holding is one position;
 * `1 of 1` there would be noise dressed as coverage.
 */
export interface HistoricalCountable {
  /** How many children EXISTED on this date — the historical denominator. */
  historicalCount: number;
  /** How many of those carried a value. */
  valuedCount:     number;
}

// ── The four node types ───────────────────────────────────────────────────────

export interface HistoricalLensNode extends HistoricalNodeBase, HistoricalCountable {
  nodeType: "lens";
  /** Which lens root this is ("net-worth", "investments", …). */
  lens: string;
  /** B4 — the two sides, reported separately from the flat component list. */
  explainedAssets:      number | null;
  explainedLiabilities: number | null;
}

/**
 * A bucket is a component of the canonical partition (`classifyAccounts`), never
 * an invented grouping.
 */
export type BucketKind =
  | "investments" | "crypto" | "cash" | "savings" | "debt"
  /**
   * The REAL-ASSETS RESIDUAL. Part of the canonical arithmetic
   * (`computeSnapshotFields` folds it into totalAssets and netWorth) but with no
   * stored column, so it is recovered by subtraction. It is a genuine bucket —
   * NOT an unattributed remainder — and it must never be presented as an account
   * or a holding, because nothing here knows what it is composed of.
   */
  | "real-assets";

export interface HistoricalBucketNode extends HistoricalNodeBase, HistoricalCountable {
  nodeType: "bucket";
  bucketKind: BucketKind;
  /** True for liabilities — the value SUBTRACTS from its parent. */
  subtracts: boolean;
}

export interface HistoricalAccountNode extends HistoricalNodeBase, HistoricalCountable {
  nodeType: "account";
  accountId:   string;
  accountType: string;
  institution: string | null;
}

export interface HistoricalHoldingNode extends HistoricalNodeBase {
  nodeType: "holding";
  accountId:    string;
  /** THE identity, with accountId. Never the symbol — a ticker is reassignable. */
  instrumentId: string | null;
  /** Display only. Decides nothing. */
  symbol:       string | null;
  assetClass:   string;
  /** Selected-date quantity and unit price, as the valuation engine resolved them. */
  quantity:  number | null;
  unitPrice: number | null;
  /**
   * V27-D3 — the runs within the window where the position was actually held.
   *
   * More than one means sold-and-re-bought. A single from/to span cannot say
   * that, and drawing one across the gap would assert ownership during a period
   * when there was none. Optional: populated only by the holding authority.
   */
  ownershipEpisodes?: { fromISO: string; toISO: string }[];
}

export type HistoricalNode =
  | HistoricalLensNode
  | HistoricalBucketNode
  | HistoricalAccountNode
  | HistoricalHoldingNode;

// ── Helpers (shape only — no financial decisions) ─────────────────────────────

/** Does this node type carry counts? */
export function isCountable(node: HistoricalNode): node is
  HistoricalLensNode | HistoricalBucketNode | HistoricalAccountNode {
  return node.nodeType !== "holding";
}

/** Extend a breadcrumb by one step. Pure list construction. */
export function extendBreadcrumb(
  parent: readonly HistoricalCrumb[],
  step: HistoricalCrumb,
): HistoricalCrumb[] {
  return [...parent, step];
}

/**
 * The signed contribution a component makes to its parent's explained total.
 *
 * Liabilities SUBTRACT. They are not negative assets; they are the other side of
 * the sheet, and a bucket that forgets its sign turns debt into wealth.
 */
export function signedContribution(node: HistoricalNode): number {
  if (node.displayedValue == null) return 0;
  const subtracts = node.nodeType === "bucket" && node.subtracts;
  return subtracts ? -node.displayedValue : node.displayedValue;
}

/**
 * Σ of the children a parent may assert. A child the engine refused contributes
 * nothing — it is not counted as zero, it is not counted at all, and the
 * parent's reconciliation is what states the difference.
 */
export function explainedFromComponents(components: readonly HistoricalNode[]): number {
  return components
    .filter((c) => c.assertable && c.displayedValue != null)
    .reduce((n, c) => n + signedContribution(c), 0);
}
